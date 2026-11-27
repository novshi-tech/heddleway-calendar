import { publicUrl, type Env } from "./env";

// This tool is a Heddleway "app" (Heddleway docs/adr/0008). Its client ID is the URL of the
// client metadata document below; the document carries the app's definition, which an admin of
// each deployment reads and approves at /admin/apps. Only the ports listed here get through.

export const APP_NAME = "heddleway-calendar";
export const APP_SCOPE = `app:${APP_NAME}`;
export const CLIENT_METADATA_PATH = "/client.json";
export const CALLBACK_PATH = "/connections/callback";

// Read only, and only the main calendar of the signed-in user (docs/adr/0002, decision 4).
export const PORTS = [
  { service: "calendar", method: "GET", path: "^/calendar/v3/calendars/primary/events$" },
  { service: "graph", method: "GET", path: "^/v1\\.0/me/calendarView$" },
] as const;

export const EXAMPLES = {
  allow: [
    "GET calendar /calendar/v3/calendars/primary/events?timeMin=2026-12-01T00:00:00Z&singleEvents=true",
    "GET graph /v1.0/me/calendarView?startDateTime=2026-12-01T00:00:00&endDateTime=2026-12-08T00:00:00",
  ],
  deny: [
    "POST calendar /calendar/v3/calendars/primary/events",
    "GET calendar /calendar/v3/calendars/someone@example.com/events",
    "GET graph /v1.0/me/messages",
    "GET graph /v1.0/users/someone@example.com/calendarView",
    "GET gmail /gmail/v1/users/me/messages",
  ],
};

export const APP_DESCRIPTION =
  "あなたのメインのカレンダー(Google Calendar・Microsoft 365 の予定表)の予定を読み、ほかの組織の予定と並べて 1 つの画面に出します。予定の中身は保存せず、書き込みもしません。";

export function clientId(env: Env): string {
  return `${publicUrl(env)}${CLIENT_METADATA_PATH}`;
}

export function redirectUri(env: Env): string {
  return `${publicUrl(env)}${CALLBACK_PATH}`;
}

export function clientMetadata(env: Env): Record<string, unknown> {
  return {
    client_id: clientId(env),
    client_name: "Heddleway Calendar",
    client_uri: publicUrl(env),
    redirect_uris: [redirectUri(env)],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: APP_SCOPE,
    heddleway_app: {
      name: APP_NAME,
      description: APP_DESCRIPTION,
      ports: PORTS,
      examples: EXAMPLES,
    },
  };
}
