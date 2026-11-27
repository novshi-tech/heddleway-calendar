import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { randomToken, s256 } from "./crypto";
import { publicUrl, splitList, type Env, type User } from "./env";

// The owner signs in to this tool itself with OIDC (docs/adr/0002, decision 3). Only the
// addresses in ALLOWED_EMAILS get in. The connections to the Heddleway deployments belong to
// the signed-in user.

interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const metadataCache = new Map<string, Promise<OidcMetadata>>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function discover(issuer: string): Promise<OidcMetadata> {
  let cached = metadataCache.get(issuer);
  if (!cached) {
    cached = fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`).then(async (res) => {
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
      return (await res.json()) as OidcMetadata;
    });
    cached.catch(() => metadataCache.delete(issuer));
    metadataCache.set(issuer, cached);
  }
  return cached;
}

function remoteJwks(uri: string) {
  let set = jwksCache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, set);
  }
  return set;
}

export class SignInError extends Error {}

export function admit(env: Env, claims: JWTPayload): User {
  const allowed = splitList(env.ALLOWED_EMAILS).map((e) => e.toLowerCase());
  if (allowed.length === 0) throw new SignInError("ALLOWED_EMAILS is not set");
  let email: string;
  let id: string;
  if (env.IDP_TYPE === "google") {
    if (claims.email_verified !== true) throw new SignInError("email not verified");
    email = String(claims.email ?? "");
    id = `google_${claims.sub}`;
  } else if (env.IDP_TYPE === "entra") {
    const tid = String(claims.tid ?? "");
    const oid = String(claims.oid ?? "");
    if (!tid || !oid) throw new SignInError("missing tid/oid claim");
    email = String(claims.email ?? claims.preferred_username ?? "");
    id = `entra_${tid}_${oid}`;
  } else {
    throw new SignInError(`unsupported IDP_TYPE: ${env.IDP_TYPE}`);
  }
  if (!email || !allowed.includes(email.toLowerCase())) throw new SignInError("this account may not use this tool");
  return { id, email, name: String(claims.name ?? email) };
}

const SESSION_COOKIE = "cal_session";
const LOGIN_COOKIE = "cal_login";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_TTL_SECONDS = 10 * 60;

export function secret(env: Env): Uint8Array {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(env.SESSION_SECRET);
}

export function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// Only same-site paths, so the login cannot be used as an open redirect.
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

export async function startLogin(env: Env, next: string): Promise<Response> {
  const metadata = await discover(env.OIDC_ISSUER);
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.OIDC_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${publicUrl(env)}/auth/callback`);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", await s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  const allowed = splitList(env.ALLOWED_EMAILS);
  if (allowed.length === 1) url.searchParams.set("login_hint", allowed[0]);

  const login = await new SignJWT({ state, nonce, verifier, next: safeNext(next) })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${LOGIN_TTL_SECONDS}s`)
    .sign(secret(env));
  return new Response(null, {
    status: 302,
    headers: { location: url.href, "set-cookie": cookie(LOGIN_COOKIE, login, LOGIN_TTL_SECONDS) },
  });
}

export async function finishLogin(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const raw = readCookie(request, LOGIN_COOKIE);
  if (!raw) throw new SignInError("login expired");
  const { payload: login } = await jwtVerify(raw, secret(env)).catch(() => {
    throw new SignInError("login expired");
  });
  if (url.searchParams.get("state") !== login.state) throw new SignInError("state mismatch");
  const code = url.searchParams.get("code");
  if (!code) throw new SignInError("no code");

  const metadata = await discover(env.OIDC_ISSUER);
  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${publicUrl(env)}/auth/callback`,
      code_verifier: String(login.verifier),
      client_id: env.OIDC_CLIENT_ID,
      client_secret: env.OIDC_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new SignInError(`token exchange failed: ${res.status}`);
  const { id_token } = (await res.json()) as { id_token?: string };
  if (!id_token) throw new SignInError("no id_token in token response");
  const { payload } = await jwtVerify(id_token, remoteJwks(metadata.jwks_uri), {
    issuer: metadata.issuer,
    audience: env.OIDC_CLIENT_ID,
  });
  if (payload.nonce !== login.nonce) throw new SignInError("nonce mismatch");
  const user = admit(env, payload);

  const session = await new SignJWT({ name: user.name, email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret(env));
  const headers = new Headers({ location: safeNext(String(login.next ?? "/")) });
  headers.append("set-cookie", cookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS));
  headers.append("set-cookie", cookie(LOGIN_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

export function logout(): Response {
  return new Response(null, { status: 302, headers: { location: "/", "set-cookie": cookie(SESSION_COOKIE, "", 0) } });
}

export async function sessionUser(env: Env, request: Request): Promise<User | null> {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, secret(env));
    if (!payload.sub) return null;
    const email = String(payload.email ?? "");
    // Removing an address from ALLOWED_EMAILS ends its sessions too.
    if (!splitList(env.ALLOWED_EMAILS).some((e) => e.toLowerCase() === email.toLowerCase())) return null;
    return { id: payload.sub, email, name: String(payload.name ?? email) };
  } catch {
    return null;
  }
}
