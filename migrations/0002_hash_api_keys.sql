-- Migration number: 0002
-- Store a SHA-256 hash of the API key instead of the raw, usable secret.
-- SQLite/D1 can't ALTER TABLE ... DROP COLUMN a UNIQUE-constrained column directly,
-- so this rebuilds the table. Pre-launch (no real users beyond local dev testing),
-- so losing the old plaintext key on rebuild is expected and fine.
-- Disable FK enforcement for the rebuild (drop + rename) so sources/channels' FK
-- reference to users(id) doesn't trip mid-migration; D1 restores the pragma per-connection.
PRAGMA foreign_keys = OFF;
CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  api_key_hash TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO users_new (id, email, api_key_hash, plan, created_at)
  SELECT id, email, api_key, plan, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
