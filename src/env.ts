export interface Env {
  DB: D1Database;
  // Public origin of this Worker, without a trailing slash. It is also the start of the client ID.
  PUBLIC_URL: string;
  // The owner signs in to this tool with OIDC (docs/adr/0002, decision 3). "google" or "entra".
  IDP_TYPE: string;
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;
  // Comma-separated email addresses allowed to sign in. Required.
  ALLOWED_EMAILS: string;
  // Offered on the connections page, comma-separated "name|https://gateway.example.com".
  GATEWAYS?: string;
  // Signs the session and the sign-in state, and (derived) encrypts the stored tokens.
  SESSION_SECRET: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function publicUrl(env: Env): string {
  return env.PUBLIC_URL.replace(/\/+$/, "");
}
