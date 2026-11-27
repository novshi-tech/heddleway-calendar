import type { Env } from "./env";
import { fromGoogle, fromGraph, TIME_ZONE_OFFSET, type CalEvent, type GoogleEvent, type GraphEvent } from "./events";
import { calendarCredentials, GatewayError, issueToken, refresh, relayGet, type GatewayToken } from "./gateway";
import { setCredential, setProblem, updateTokens, type Connection } from "./store";

// Reading one connection's events for a range, when the page is opened (ADR 0001, decision 3).

const MAX_PAGES = 5;
// Refresh a little before the access token runs out.
const EARLY_MS = 60 * 1000;

async function accessToken(env: Env, c: Connection): Promise<string> {
  if (!c.tokens) throw new GatewayError("つなぎ直しが要ります", "reconnect");
  if (c.tokens.expiresAt - EARLY_MS > Date.now()) return c.tokens.accessToken;
  const tokens = await refresh(env, c.gateway, c.tokens.refreshToken);
  await updateTokens(env, c.id, tokens);
  c.tokens = tokens;
  return tokens.accessToken;
}

async function googleEvents(token: GatewayToken, c: Connection, from: number, to: number): Promise<CalEvent[]> {
  const out: CalEvent[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = new URLSearchParams({
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      timeZone: "Asia/Tokyo",
      fields: "nextPageToken,items(status,summary,eventType,transparency,start,end,attendees(self,responseStatus),location,htmlLink)",
    });
    if (pageToken) q.set("pageToken", pageToken);
    const body = (await relayGet(token, "calendar", `/calendar/v3/calendars/primary/events?${q}`)) as { items?: GoogleEvent[]; nextPageToken?: string };
    for (const item of body.items ?? []) {
      const e = fromGoogle(c.id, item);
      if (e) out.push(e);
    }
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

function localIso(ms: number): string {
  // Graph takes the range in the zone of the offset written; send Japan time with its offset.
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 19) + TIME_ZONE_OFFSET;
}

async function graphEvents(token: GatewayToken, c: Connection, from: number, to: number): Promise<CalEvent[]> {
  const out: CalEvent[] = [];
  const q = new URLSearchParams({
    startDateTime: localIso(from),
    endDateTime: localIso(to),
    $top: "200",
    $orderby: "start/dateTime",
    $select: "subject,isAllDay,isCancelled,isOrganizer,showAs,responseStatus,start,end,location,webLink",
  });
  let path: string | null = `/v1.0/me/calendarView?${q}`;
  for (let i = 0; i < MAX_PAGES && path; i++) {
    const body = (await relayGet(token, "graph", path, { prefer: 'outlook.timezone="Tokyo Standard Time"' })) as {
      value?: GraphEvent[];
      "@odata.nextLink"?: string;
    };
    for (const item of body.value ?? []) {
      const e = fromGraph(c.id, item);
      if (e) out.push(e);
    }
    const next = body["@odata.nextLink"];
    // The next link is on graph.microsoft.com; send it through the relay with the same path.
    path = next && next.startsWith("https://graph.microsoft.com/") ? next.slice("https://graph.microsoft.com".length) : null;
  }
  return out;
}

export interface SourceResult {
  connection: Connection;
  events: CalEvent[];
  error?: { message: string; kind: GatewayError["kind"] };
}

export async function readConnection(env: Env, c: Connection, from: number, to: number): Promise<SourceResult> {
  try {
    if (!c.credentialId || !c.service) throw new GatewayError("カレンダーの接続が見つかりません。つなぎ直してください", "reconnect");
    const access = await accessToken(env, c);
    const token = await issueToken(c.gateway, access, c.credentialId).catch(async (e) => {
      // The calendar may have been connected again at the gateway, under a new credential ID.
      if (!(e instanceof GatewayError) || e.kind !== "network") throw e;
      const { credentials } = await calendarCredentials(c.gateway, access);
      const same = credentials.find((cr) => cr.service === c.service);
      if (!same || same.id === c.credentialId) throw e;
      await setCredential(env, c.id, same.id);
      c.credentialId = same.id;
      return issueToken(c.gateway, access, same.id);
    });
    const events = c.service === "graph" ? await graphEvents(token, c, from, to) : await googleEvents(token, c, from, to);
    if (c.problem) await setProblem(env, c.id, null);
    return { connection: c, events };
  } catch (e) {
    const err = e instanceof GatewayError ? e : new GatewayError(e instanceof Error ? e.message : String(e), "network");
    if (err.kind === "reconnect" || err.kind === "refused") await setProblem(env, c.id, err.message).catch(() => {});
    return { connection: c, events: [], error: { message: err.message, kind: err.kind } };
  }
}
