import { jwtVerify, SignJWT } from "jose";
import { CALLBACK_PATH, CLIENT_METADATA_PATH, clientMetadata } from "./app";
import { cookie, finishLogin, logout, readCookie, safeNext, secret, sessionUser, SignInError, startLogin } from "./auth";
import { publicUrl, splitList, type Env, type User } from "./env";
import { addDays, dateOf, dayStart, isDate, layoutDays } from "./events";
import { calendarCredentials, exchangeCode, GatewayError, normalizeGatewayUrl, startAuthorization } from "./gateway";
import { agendaPage, connectionsPage, CSS_PATH, CSS_TEXT, isColor, messagePage, signInPage, type PresetGateway } from "./pages";
import { readConnection } from "./sources";
import { deleteConnection, getConnection, listConnections, saveConnection, updateLook } from "./store";

const DAYS = 7;
const CONNECT_COOKIE = "cal_connect";
const CONNECT_TTL_SECONDS = 10 * 60;

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function htmlResponse(body: string, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS });
  for (const [k, v] of new Headers(extra)) headers.append(k, v);
  return new Response(body, { status, headers });
}

function redirect(location: string, extra: HeadersInit = {}): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const [k, v] of new Headers(extra)) headers.append(k, v);
  return new Response(null, { status: 302, headers });
}

// Forms post from this origin only (the session cookie is SameSite=Lax as well).
function sameOrigin(env: Env, request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null ? request.headers.get("sec-fetch-site") !== "cross-site" : origin === publicUrl(env);
}

function presets(env: Env): PresetGateway[] {
  return splitList(env.GATEWAYS).flatMap((entry) => {
    const [name, url] = entry.split("|").map((s) => s.trim());
    const origin = url ? normalizeGatewayUrl(url) : null;
    return name && origin ? [{ name, url: origin }] : [];
  });
}

function formText(form: FormData, name: string, max: number): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function agenda(env: Env, user: User, url: URL): Promise<Response> {
  const now = Date.now();
  const today = dateOf(now);
  const fromParam = url.searchParams.get("from");
  const from = isDate(fromParam) ? fromParam : today;
  const connections = await listConnections(env, user.id);
  const begin = dayStart(from);
  const end = dayStart(addDays(from, DAYS));
  const results = await Promise.all(connections.map((c) => readConnection(env, c, begin, end)));
  const days = layoutDays(
    results.flatMap((r) => r.events),
    from,
    DAYS,
    now,
  );
  return htmlResponse(agendaPage({ user, from, prev: addDays(from, -DAYS), next: addDays(from, DAYS), isThisWeek: from === today, days, results }));
}

async function startConnect(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const gateway = normalizeGatewayUrl(formText(form, "gateway", 300));
  const name = formText(form, "name", 40);
  const colorValue = formText(form, "color", 20);
  if (!gateway) return htmlResponse(messagePage("URL を確かめてください", "Heddleway の URL(https:// で始まるもの)を入れてください。", { href: "/connections", text: "接続の画面へ" }), 400);
  if (!name) return htmlResponse(messagePage("表示名を入れてください", "", { href: "/connections", text: "接続の画面へ" }), 400);
  const color = isColor(colorValue) ? colorValue : "teal";
  const start = await startAuthorization(env, gateway);
  const state = await new SignJWT({ state: start.state, verifier: start.verifier, gateway, name, color })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${CONNECT_TTL_SECONDS}s`)
    .sign(secret(env));
  return redirect(start.url, { "set-cookie": cookie(CONNECT_COOKIE, state, CONNECT_TTL_SECONDS) });
}

async function finishConnect(env: Env, user: User, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const clear = { "set-cookie": cookie(CONNECT_COOKIE, "", 0) };
  const back = { href: "/connections", text: "接続の画面へ" };
  const raw = readCookie(request, CONNECT_COOKIE);
  const pending = raw ? await jwtVerify(raw, secret(env)).then((r) => r.payload, () => null) : null;
  if (!pending || url.searchParams.get("state") !== pending.state) {
    return htmlResponse(messagePage("つなげませんでした", "時間がたちすぎたか、別の画面から始めた接続です。もう一度つないでください。", back), 400, clear);
  }
  const gateway = String(pending.gateway);
  const error = url.searchParams.get("error");
  if (error) {
    const detail =
      error === "access_denied"
        ? "許可されませんでした。"
        : `${url.searchParams.get("error_description") ?? error}(このアプリがその組織の Heddleway に登録されているか、管理者に確かめてください)`;
    return htmlResponse(messagePage("つなげませんでした", detail, back), 400, clear);
  }
  const code = url.searchParams.get("code");
  if (!code) return htmlResponse(messagePage("つなげませんでした", "認可コードがありません。", back), 400, clear);
  try {
    const tokens = await exchangeCode(env, gateway, code, String(pending.verifier));
    const { organization, credentials } = await calendarCredentials(gateway, tokens.accessToken);
    const credential = credentials[0];
    if (!credential) {
      return htmlResponse(
        messagePage("カレンダーの接続がありません", `${organization} の Heddleway の接続の画面で、Google Calendar か Microsoft Graph をつないでから、もう一度つないでください。`, back),
        400,
        clear,
      );
    }
    await saveConnection(env, user.id, {
      gateway,
      name: String(pending.name),
      color: String(pending.color),
      organization,
      service: credential.service,
      credentialId: credential.id,
      tokens,
    });
    return redirect("/connections?connected=1", clear);
  } catch (e) {
    const message = e instanceof GatewayError ? e.message : String(e);
    return htmlResponse(messagePage("つなげませんでした", message, back), 502, clear);
  }
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  // Public: the client metadata document the deployments read, and the styles.
  if (method === "GET" && pathname === CLIENT_METADATA_PATH) {
    return Response.json(clientMetadata(env), { headers: { "cache-control": "public, max-age=300" } });
  }
  if (method === "GET" && pathname === CSS_PATH) {
    return new Response(CSS_TEXT, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } });
  }
  if (method === "GET" && pathname === "/auth/login") return startLogin(env, safeNext(url.searchParams.get("next")));
  if (method === "GET" && pathname === "/auth/callback") {
    try {
      return await finishLogin(env, request);
    } catch (e) {
      const detail = e instanceof SignInError ? e.message : "サインインを確かめられませんでした";
      return htmlResponse(messagePage("サインインできませんでした", detail, { href: "/auth/login", text: "もう一度サインインする" }), 403);
    }
  }
  if (method === "POST" && pathname === "/auth/logout") return logout();

  const user = await sessionUser(env, request);
  if (!user) {
    if (method !== "GET") return new Response("sign in first", { status: 401 });
    return htmlResponse(signInPage(`${pathname}${url.search}`));
  }
  if (method === "POST" && !sameOrigin(env, request)) return new Response("cross-origin request refused", { status: 403 });

  if (method === "GET" && pathname === "/") return agenda(env, user, url);
  if (method === "GET" && pathname === "/connections") {
    const notice = url.searchParams.get("connected") ? "つなぎました。" : undefined;
    return htmlResponse(connectionsPage(user, await listConnections(env, user.id), presets(env), notice));
  }
  if (method === "POST" && pathname === "/connections/start") return startConnect(env, request);
  if (method === "GET" && pathname === CALLBACK_PATH) return finishConnect(env, user, request);

  const one = pathname.match(/^\/connections\/([0-9a-f-]{36})(\/delete)?$/);
  if (method === "POST" && one) {
    const existing = await getConnection(env, user.id, one[1]);
    if (!existing) return htmlResponse(messagePage("見つかりません", "", { href: "/connections", text: "接続の画面へ" }), 404);
    if (one[2]) {
      await deleteConnection(env, user.id, existing.id);
    } else {
      const form = await request.formData();
      const name = formText(form, "name", 40) || existing.name;
      const color = formText(form, "color", 20);
      await updateLook(env, user.id, existing.id, name, isColor(color) ? color : existing.color);
    }
    return redirect("/connections");
  }
  return htmlResponse(messagePage("ページがありません", ""), 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      console.error(JSON.stringify({ type: "error", message: e instanceof Error ? e.message : String(e) }));
      return htmlResponse(messagePage("エラーが起きました", "しばらくしてからもう一度開いてください。"), 500);
    }
  },
} satisfies ExportedHandler<Env>;
