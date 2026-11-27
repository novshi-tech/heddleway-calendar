-- One row per (user, Heddleway deployment). Only the grant and what is needed to call the
-- calendar are kept; events are read when the page is opened and never stored (ADR 0001, decision 3).
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gateway TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  organization TEXT,
  service TEXT,
  credential_id TEXT,
  -- Encrypted with a key derived from SESSION_SECRET (src/crypto.ts).
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  -- The last error that needs the owner (reconnect, refused); cleared by a successful read.
  problem TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, gateway)
);
