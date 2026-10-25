-- Only the Worker writes these tables. Browser identities are site-scoped HMACs.
-- Each accepted event, its memberships, and all counter updates commit together.
CREATE TABLE site_stats (
  site_id TEXT PRIMARY KEY NOT NULL CHECK (site_id = 'rui-chen-homepage'),
  pv INTEGER NOT NULL DEFAULT 0 CHECK (pv >= 0 AND pv <= 9007199254740991),
  uv INTEGER NOT NULL DEFAULT 0 CHECK (uv >= 0 AND uv <= pv),
  history_pv INTEGER NOT NULL DEFAULT 0 CHECK (history_pv >= 0 AND pv + history_pv <= 9007199254740991),
  history_source TEXT,
  history_as_of TEXT,
  counting_since TEXT NOT NULL DEFAULT '2026-10-25T00:00:00.000Z',
  uv_counting_since TEXT NOT NULL DEFAULT '2026-10-25T00:00:00.000Z',
  epoch TEXT NOT NULL DEFAULT 'rui-chen-homepage-v1',
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  site_id TEXT NOT NULL CHECK (site_id = 'rui-chen-homepage'),
  event_id TEXT NOT NULL CHECK (length(event_id) = 36),
  path TEXT NOT NULL CHECK (path = '/rui-chen-homepage/'),
  visitor_hash TEXT CHECK (visitor_hash IS NULL OR length(visitor_hash) = 64),
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (site_id, event_id)
) WITHOUT ROWID;
CREATE INDEX events_received_at ON events(received_at);

CREATE TABLE lifetime_visitors (
  site_id TEXT NOT NULL,
  visitor_hash TEXT NOT NULL CHECK (length(visitor_hash) = 64),
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (site_id, visitor_hash)
) WITHOUT ROWID;

CREATE TABLE daily_stats (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  pv INTEGER NOT NULL DEFAULT 0 CHECK (pv >= 0 AND pv <= 9007199254740991),
  uv INTEGER NOT NULL DEFAULT 0 CHECK (uv >= 0 AND uv <= pv),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, day)
) WITHOUT ROWID;

CREATE TABLE daily_visitors (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  visitor_hash TEXT NOT NULL CHECK (length(visitor_hash) = 64),
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (site_id, day, visitor_hash)
) WITHOUT ROWID;
CREATE INDEX daily_visitors_first_seen_at ON daily_visitors(first_seen_at);

-- Triggers run only for rows actually inserted. A duplicate event cannot add PV,
-- add another visitor, move to another day, or overwrite its original identity.
CREATE TRIGGER accepted_event AFTER INSERT ON events
BEGIN
  INSERT INTO site_stats(site_id, pv, uv, updated_at)
  VALUES (NEW.site_id, 1, 0, NEW.received_at)
  ON CONFLICT(site_id) DO UPDATE SET
    pv = site_stats.pv + 1, updated_at = NEW.received_at;

  INSERT INTO daily_stats(site_id, day, pv, uv, updated_at)
  VALUES (NEW.site_id, NEW.day, 1, 0, NEW.received_at)
  ON CONFLICT(site_id, day) DO UPDATE SET
    pv = daily_stats.pv + 1, updated_at = NEW.received_at;

  INSERT INTO lifetime_visitors(site_id, visitor_hash, first_seen_at)
  SELECT NEW.site_id, NEW.visitor_hash, NEW.received_at
  WHERE NEW.visitor_hash IS NOT NULL
  ON CONFLICT(site_id, visitor_hash) DO NOTHING;

  INSERT INTO daily_visitors(site_id, day, visitor_hash, first_seen_at)
  SELECT NEW.site_id, NEW.day, NEW.visitor_hash, NEW.received_at
  WHERE NEW.visitor_hash IS NOT NULL
  ON CONFLICT(site_id, day, visitor_hash) DO NOTHING;
END;

CREATE TRIGGER first_lifetime_visitor AFTER INSERT ON lifetime_visitors
BEGIN
  UPDATE site_stats SET uv = uv + 1 WHERE site_id = NEW.site_id;
END;

CREATE TRIGGER first_daily_visitor AFTER INSERT ON daily_visitors
BEGIN
  UPDATE daily_stats SET uv = uv + 1
  WHERE site_id = NEW.site_id AND day = NEW.day;
END;
