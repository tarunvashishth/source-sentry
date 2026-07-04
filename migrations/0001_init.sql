-- Migration number: 0001
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  css_selector TEXT,
  check_interval_minutes INTEGER NOT NULL DEFAULT 60,
  status TEXT NOT NULL DEFAULT 'active',
  last_checked_at TEXT,
  last_changed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sources_user ON sources(user_id);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  content_hash TEXT NOT NULL,
  content_text TEXT NOT NULL,
  http_status INTEGER,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_snapshots_source ON snapshots(source_id, fetched_at);

CREATE TABLE changes (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  old_snapshot_id TEXT,
  new_snapshot_id TEXT NOT NULL,
  diff_text TEXT NOT NULL,
  summary TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  details TEXT NOT NULL DEFAULT '[]',
  summary_source TEXT NOT NULL DEFAULT 'heuristic',
  added_lines INTEGER NOT NULL DEFAULT 0,
  removed_lines INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_changes_user ON changes(user_id, created_at);
CREATE INDEX idx_changes_source ON changes(source_id, created_at);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_channels_user ON channels(user_id);

-- Dev-only scratch state (fixture version, webhook sink) so local testing
-- survives isolate restarts. Unused in production.
CREATE TABLE dev_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
