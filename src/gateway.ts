import { APP_SCOPE, clientId, redirectUri } from "./app";
import { randomToken, s256 } from "./crypto";
import type { Env } from "./env";

// Talking to one Heddleway deployment as its OAuth client (Heddleway docs/adr/0008, decision 5:
// the same entrance as a stand). The access token reaches the deployment's MCP endpoint; the
// app asks it for a short-lived gateway token (issue_token) and calls the upstream calendar API
// through the REST relay with that token. Upstream tokens never come here.

const USER_AGENT = "heddleway-calendar";

export class GatewayError extends Error {
  constructor(
    message: string,
    // "reconnect": the grant is gone (expired, revoked, the app's registration removed);
    // "refused": the gateway refused the call (outside the app's ports, not registered);
    // "upstream": the calendar service answered with an error; "network": anything else.
    readonly kind: "reconnect" | "refused" | "upstream" | "network",
  ) {
    super(message);
  }
}

// An origin like https://gateway.example.com, or null when the input is not one.
export function normalizeGatewayUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

interface ServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
}

async function serverMetadata(gateway: string): Promise<ServerMetadata> {
  const res = await fetch(`${gateway}/.well-known/oauth-authorization-server`, { headers: { "user-agent": USER_AGENT } }).catch(() => null);
  if (res?.ok) {
    const m = (await res.json()) as Partial<ServerMetadata>;
    // Endpoints on another origin are not followed: the gateway's own endpoints only.
    if (m.authorization_endpoint && m.token_endpoint && new URL(m.authorization_endpoint).origin === gateway && new URL(m.token_endpoint).origin === gateway) {
      return { authorization_endpoint: m.authorization_endpoint, token_endpoint: m.token_endpoint };
    }
  }
  return { authorization_endpoint: `${gateway}/authorize`, token_endpoint: `${gateway}/oauth/token` };
}

export interface AuthorizationStart {
  url: string;
  state: string;
  verifier: string;
}

export async function startAuthorization(env: Env, gateway: string): Promise<AuthorizationStart> {
  const metadata = await serverMetadata(gateway);
  const state = randomToken();
  const verifier = randomToken();
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId(env));
  url.searchParams.set("redirect_uri", redirectUri(env));
  url.searchParams.set("scope", APP_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", `${gateway}/mcp`);
  return { url: url.href, state, verifier };
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  // Epoch milliseconds.
  expiresAt: number;
}

async function tokenRequest(env: Env, gateway: string, params: Record<string, string>): Promise<Tokens> {
  const metadata = await serverMetadata(gateway);
  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body: new URLSearchParams({ ...params, client_id: clientId(env), resource: `${gateway}/mcp` }),
  }).catch(() => {
    throw new GatewayError("ゲートウェイに届きませんでした", "network");
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = String(body.error ?? res.status);
    throw new GatewayError(`トークンを受け取れませんでした(${code})`, code === "invalid_grant" || res.status === 401 ? "reconnect" : "network");
  }
  if (typeof body.access_token !== "string") throw new GatewayError("トークンの応答に access_token がありません", "network");
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    // The provider rotates refresh tokens; keep the old one when none comes back.
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : params.refresh_token ?? "",
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export function exchangeCode(env: Env, gateway: string, code: string, verifier: string): Promise<Tokens> {
  return tokenRequest(env, gateway, { grant_type: "authorization_code", code, redirect_uri: redirectUri(env), code_verifier: verifier });
}

export function refresh(env: Env, gateway: string, refreshToken: string): Promise<Tokens> {
  if (!refreshToken) throw new GatewayError("つなぎ直しが要ります", "reconnect");
  return tokenRequest(env, gateway, { grant_type: "refresh_token", refresh_token: refreshToken });
}

// One MCP tool call. Heddleway's MCP endpoint is stateless and answers JSON (src/mcp.ts).
export async function callTool(gateway: string, accessToken: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${gateway}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }).catch(() => {
    throw new GatewayError("ゲートウェイに届きませんでした", "network");
  });
  if (res.status === 401) throw new GatewayError("ゲートウェイへの許可が切れています", "reconnect");
  if (!res.ok) throw new GatewayError(`ゲートウェイが ${res.status} を返しました`, "network");
  const message = (await res.json()) as {
    result?: { isError?: boolean; content?: { type: string; text?: string }[] };
    error?: { message?: string };
  };
  if (message.error) throw new GatewayError(message.error.message ?? "MCP のエラー", "network");
  const text = message.result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (message.result?.isError) {
    // An app whose registration is gone, or a service outside its ports.
    throw new GatewayError(text || `${name} が断られました`, /no longer registered|may not use/.test(text) ? "refused" : "network");
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface Credential {
  id: string;
  service: string;
  label?: string;
}

// The calendar credentials the app may use at this deployment (list_credentials is already
// narrowed to the app's services by the gateway).
export async function calendarCredentials(gateway: string, accessToken: string): Promise<{ organization: string; credentials: Credential[] }> {
  const listed = (await callTool(gateway, accessToken, "list_credentials", {})) as {
    gateway?: { organization?: string };
    credentials?: Credential[];
  };
  const credentials = (listed.credentials ?? []).filter((c) => c.service === "calendar" || c.service === "graph");
  return { organization: listed.gateway?.organization ?? new URL(gateway).hostname, credentials };
}

export interface GatewayToken {
  token: string;
  baseUrl: string;
}

export async function issueToken(gateway: string, accessToken: string, credentialId: string): Promise<GatewayToken> {
  const issued = (await callTool(gateway, accessToken, "issue_token", { credential_ids: [credentialId] })) as { token?: string; base_url?: string };
  if (!issued.token || !issued.base_url) throw new GatewayError("ゲートウェイのトークンを受け取れませんでした", "network");
  return { token: issued.token, baseUrl: issued.base_url.replace(/\/+$/, "") };
}

// A GET through the REST relay: `<base_url>/<service><path>`.
export async function relayGet(token: GatewayToken, service: string, path: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(`${token.baseUrl}/${service}${path}`, {
    headers: { authorization: `Bearer ${token.token}`, accept: "application/json", "user-agent": USER_AGENT, ...headers },
  }).catch(() => {
    throw new GatewayError("ゲートウェイに届きませんでした", "network");
  });
  const text = await res.text();
  if (!res.ok) {
    const short = text.slice(0, 300);
    if (res.status === 403 && /not allowed for the app|no longer registered/.test(text)) throw new GatewayError(`ゲートウェイが断りました: ${short}`, "refused");
    if (res.status === 401 && /reconnect|つなぎ直/.test(text)) throw new GatewayError("カレンダーの接続のつなぎ直しが要ります(ゲートウェイの接続の画面)", "upstream");
    throw new GatewayError(`カレンダーの API が ${res.status} を返しました: ${short}`, "upstream");
  }
  return JSON.parse(text);
}
