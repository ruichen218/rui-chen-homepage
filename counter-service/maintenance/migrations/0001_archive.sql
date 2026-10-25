-- This separate database contains snapshots and maintenance status only.
CREATE TABLE maintenance_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  last_check_at TEXT,
  last_check_ok INTEGER NOT NULL DEFAULT 0 CHECK (last_check_ok IN (0,1)),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_backup_at TEXT,
  last_backup_ok INTEGER NOT NULL DEFAULT 0 CHECK (last_backup_ok IN (0,1))
);
INSERT INTO maintenance_state(id) VALUES(1);

CREATE TABLE snapshots (
  snapshot_id TEXT PRIMARY KEY NOT NULL,
  day TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  json_bytes INTEGER NOT NULL CHECK (json_bytes > 0 AND json_bytes <= 2097152),
  chunk_count INTEGER NOT NULL CHECK (chunk_count > 0 AND chunk_count <= 32),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('scheduled','bootstrap')),
  status TEXT NOT NULL CHECK (status = 'complete')
);
CREATE TABLE snapshot_chunks (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 32),
  content TEXT NOT NULL,
  PRIMARY KEY(snapshot_id,chunk_index)
) WITHOUT ROWID;
