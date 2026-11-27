import { open, seal } from "./crypto";
import type { Env } from "./env";
import type { Tokens } from "./gateway";

export interface Connection {
  id: string;
  userId: string;
  gateway: string;
  name: string;
  color: string;
  position: number;
  organization: string | null;
  service: string | null;
  credentialId: string | null;
  tokens: Tokens | null;
  problem: string | null;
}

interface Row {
  id: string;
  user_id: string;
  gateway: string;
  name: string;
  color: string;
  position: number;
  organization: string | null;
  service: string | null;
  credential_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  problem: string | null;
}

async function fromRow(env: Env, row: Row): Promise<Connection> {
  let tokens: Tokens | null = null;
  if (row.access_token && row.refresh_token) {
    try {
      tokens = {
        accessToken: await open(env.SESSION_SECRET, row.access_token),
        refreshToken: await open(env.SESSION_SECRET, row.refresh_token),
        expiresAt: row.expires_at ?? 0,
      };
    } catch {
      // SESSION_SECRET changed: the connection has to be made again.
      tokens = null;
    }
  }
  return {
    id: row.id,
    userId: row.user_id,
    gateway: row.gateway,
    name: row.name,
    color: row.color,
    position: row.position,
    organization: row.organization,
    service: row.service,
    credentialId: row.credential_id,
    tokens,
    problem: row.problem,
  };
}

export async function listConnections(env: Env, userId: string): Promise<Connection[]> {
  const { results } = await env.DB.prepare("SELECT * FROM connections WHERE user_id = ? ORDER BY position, created_at").bind(userId).all<Row>();
  return Promise.all(results.map((r) => fromRow(env, r)));
}

export async function getConnection(env: Env, userId: string, id: string): Promise<Connection | null> {
  const row = await env.DB.prepare("SELECT * FROM connections WHERE user_id = ? AND id = ?").bind(userId, id).first<Row>();
  return row ? fromRow(env, row) : null;
}

export interface NewConnection {
  gateway: string;
  name: string;
  color: string;
  organization: string;
  service: string;
  credentialId: string;
  tokens: Tokens;
}

// Connecting a deployment again replaces its grant and keeps its place in the list.
export async function saveConnection(env: Env, userId: string, c: NewConnection): Promise<void> {
  const now = Date.now();
  const access = await seal(env.SESSION_SECRET, c.tokens.accessToken);
  const refreshToken = await seal(env.SESSION_SECRET, c.tokens.refreshToken);
  await env.DB.prepare(
    `INSERT INTO connections (id, user_id, gateway, name, color, position, organization, service, credential_id, access_token, refresh_token, expires_at, problem, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(position), 0) + 1 FROM connections WHERE user_id = ?2), ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?12)
     ON CONFLICT (user_id, gateway) DO UPDATE SET name = excluded.name, color = excluded.color, organization = excluded.organization,
       service = excluded.service, credential_id = excluded.credential_id, access_token = excluded.access_token,
       refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, problem = NULL, updated_at = excluded.updated_at`,
  )
    .bind(crypto.randomUUID(), userId, c.gateway, c.name, c.color, c.organization, c.service, c.credentialId, access, refreshToken, c.tokens.expiresAt, now)
    .run();
}

export async function updateTokens(env: Env, id: string, tokens: Tokens): Promise<void> {
  await env.DB.prepare("UPDATE connections SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE id = ?")
    .bind(await seal(env.SESSION_SECRET, tokens.accessToken), await seal(env.SESSION_SECRET, tokens.refreshToken), tokens.expiresAt, Date.now(), id)
    .run();
}

export async function setProblem(env: Env, id: string, problem: string | null): Promise<void> {
  await env.DB.prepare("UPDATE connections SET problem = ? WHERE id = ? AND problem IS NOT ?").bind(problem, id, problem).run();
}

export async function updateLook(env: Env, userId: string, id: string, name: string, color: string): Promise<void> {
  await env.DB.prepare("UPDATE connections SET name = ?, color = ?, updated_at = ? WHERE user_id = ? AND id = ?").bind(name, color, Date.now(), userId, id).run();
}

export async function deleteConnection(env: Env, userId: string, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM connections WHERE user_id = ? AND id = ?").bind(userId, id).run();
}

export async function setCredential(env: Env, id: string, credentialId: string): Promise<void> {
  await env.DB.prepare("UPDATE connections SET credential_id = ?, updated_at = ? WHERE id = ?").bind(credentialId, Date.now(), id).run();
}
