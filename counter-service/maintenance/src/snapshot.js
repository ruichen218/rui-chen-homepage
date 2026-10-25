// Canonical counter schema: fail closed if a later migration needs a new snapshot format.
const EXPECTED_SCHEMA = [
  {
    "type": "index",
    "name": "daily_visitors_first_seen_at",
    "tbl_name": "daily_visitors",
    "sql": "CREATE INDEX daily_visitors_first_seen_at ON daily_visitors(first_seen_at)"
  },
  {
    "type": "index",
    "name": "events_received_at",
    "tbl_name": "events",
    "sql": "CREATE INDEX events_received_at ON events(received_at)"
  },
  {
    "type": "table",
    "name": "daily_stats",
    "tbl_name": "daily_stats",
    "sql": "CREATE TABLE daily_stats (\n  site_id TEXT NOT NULL,\n  day TEXT NOT NULL,\n  pv INTEGER NOT NULL DEFAULT 0 CHECK (pv >= 0 AND pv <= 9007199254740991),\n  uv INTEGER NOT NULL DEFAULT 0 CHECK (uv >= 0 AND uv <= pv),\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY (site_id, day)\n) WITHOUT ROWID"
  },
  {
    "type": "table",
    "name": "daily_visitors",
    "tbl_name": "daily_visitors",
    "sql": "CREATE TABLE daily_visitors (\n  site_id TEXT NOT NULL,\n  day TEXT NOT NULL,\n  visitor_hash TEXT NOT NULL CHECK (length(visitor_hash) = 64),\n  first_seen_at TEXT NOT NULL,\n  PRIMARY KEY (site_id, day, visitor_hash)\n) WITHOUT ROWID"
  },
  {
    "type": "table",
    "name": "events",
    "tbl_name": "events",
    "sql": "CREATE TABLE events (\n  site_id TEXT NOT NULL CHECK (site_id = 'rui-chen-homepage'),\n  event_id TEXT NOT NULL CHECK (length(event_id) = 36),\n  path TEXT NOT NULL CHECK (path = '/rui-chen-homepage/'),\n  visitor_hash TEXT CHECK (visitor_hash IS NULL OR length(visitor_hash) = 64),\n  created_at TEXT NOT NULL,\n  received_at TEXT NOT NULL,\n  day TEXT NOT NULL,\n  PRIMARY KEY (site_id, event_id)\n) WITHOUT ROWID"
  },
  {
    "type": "table",
    "name": "lifetime_visitors",
    "tbl_name": "lifetime_visitors",
    "sql": "CREATE TABLE lifetime_visitors (\n  site_id TEXT NOT NULL,\n  visitor_hash TEXT NOT NULL CHECK (length(visitor_hash) = 64),\n  first_seen_at TEXT NOT NULL,\n  PRIMARY KEY (site_id, visitor_hash)\n) WITHOUT ROWID"
  },
  {
    "type": "table",
    "name": "site_stats",
    "tbl_name": "site_stats",
    "sql": "CREATE TABLE site_stats (\n  site_id TEXT PRIMARY KEY NOT NULL CHECK (site_id = 'rui-chen-homepage'),\n  pv INTEGER NOT NULL DEFAULT 0 CHECK (pv >= 0 AND pv <= 9007199254740991),\n  uv INTEGER NOT NULL DEFAULT 0 CHECK (uv >= 0 AND uv <= pv),\n  history_pv INTEGER NOT NULL DEFAULT 0 CHECK (history_pv >= 0 AND pv + history_pv <= 9007199254740991),\n  history_source TEXT,\n  history_as_of TEXT,\n  counting_since TEXT NOT NULL DEFAULT '2026-10-25T00:00:00.000Z',\n  uv_counting_since TEXT NOT NULL DEFAULT '2026-10-25T00:00:00.000Z',\n  epoch TEXT NOT NULL DEFAULT 'rui-chen-homepage-v1',\n  updated_at TEXT NOT NULL\n)"
  },
  {
    "type": "trigger",
    "name": "accepted_event",
    "tbl_name": "events",
    "sql": "CREATE TRIGGER accepted_event AFTER INSERT ON events\nBEGIN\n  INSERT INTO site_stats(site_id, pv, uv, updated_at)\n  VALUES (NEW.site_id, 1, 0, NEW.received_at)\n  ON CONFLICT(site_id) DO UPDATE SET\n    pv = site_stats.pv + 1, updated_at = NEW.received_at;\n\n  INSERT INTO daily_stats(site_id, day, pv, uv, updated_at)\n  VALUES (NEW.site_id, NEW.day, 1, 0, NEW.received_at)\n  ON CONFLICT(site_id, day) DO UPDATE SET\n    pv = daily_stats.pv + 1, updated_at = NEW.received_at;\n\n  INSERT INTO lifetime_visitors(site_id, visitor_hash, first_seen_at)\n  SELECT NEW.site_id, NEW.visitor_hash, NEW.received_at\n  WHERE NEW.visitor_hash IS NOT NULL\n  ON CONFLICT(site_id, visitor_hash) DO NOTHING;\n\n  INSERT INTO daily_visitors(site_id, day, visitor_hash, first_seen_at)\n  SELECT NEW.site_id, NEW.day, NEW.visitor_hash, NEW.received_at\n  WHERE NEW.visitor_hash IS NOT NULL\n  ON CONFLICT(site_id, day, visitor_hash) DO NOTHING;\nEND"
  },
  {
    "type": "trigger",
    "name": "first_daily_visitor",
    "tbl_name": "daily_visitors",
    "sql": "CREATE TRIGGER first_daily_visitor AFTER INSERT ON daily_visitors\nBEGIN\n  UPDATE daily_stats SET uv = uv + 1\n  WHERE site_id = NEW.site_id AND day = NEW.day;\nEND"
  },
  {
    "type": "trigger",
    "name": "first_lifetime_visitor",
    "tbl_name": "lifetime_visitors",
    "sql": "CREATE TRIGGER first_lifetime_visitor AFTER INSERT ON lifetime_visitors\nBEGIN\n  UPDATE site_stats SET uv = uv + 1 WHERE site_id = NEW.site_id;\nEND"
  }
];

export const TABLES = Object.freeze(['site_stats', 'events', 'lifetime_visitors', 'daily_stats', 'daily_visitors']);
export const MAX_ROWS = 10000;
// Leave room for at most three boundary bytes per UTF-8 chunk, so even a
// snapshot consisting mostly of multibyte characters fits in 32 chunks.
export const MAX_JSON_BYTES = 2 * 1024 * 1024 - 128;
export const SITE_ID = 'rui-chen-homepage';
const COLUMNS = {
  site_stats: ['site_id', 'pv', 'uv', 'history_pv', 'history_source', 'history_as_of', 'counting_since', 'uv_counting_since', 'epoch', 'updated_at'],
  events: ['site_id', 'event_id', 'path', 'visitor_hash', 'created_at', 'received_at', 'day'],
  lifetime_visitors: ['site_id', 'visitor_hash', 'first_seen_at'],
  daily_stats: ['site_id', 'day', 'pv', 'uv', 'updated_at'],
  daily_visitors: ['site_id', 'day', 'visitor_hash', 'first_seen_at'],
};
const encoder = new TextEncoder();
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
const normalizeSql = value => value.trim().replace(/\s+/g, ' ').replace(/;$/, '');
const fail = () => { throw new Error('snapshot_invalid'); };
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && iso(value + 'T00:00:00.000Z');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const key = (...values) => JSON.stringify(values);
function berlinDay(stamp) {
  return dayFormatter.format(new Date(stamp));
}

function checkSchema(schema) {
  if (!Array.isArray(schema) || schema.length !== EXPECTED_SCHEMA.length) fail();
  const actual = new Map();
  for (const row of schema) {
    if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== 'name,sql,tbl_name,type' ||
        typeof row.sql !== 'string' || actual.has(row.name)) fail();
    actual.set(row.name, row);
  }
  for (const expected of EXPECTED_SCHEMA) {
    const row = actual.get(expected.name);
    if (!row || row.type !== expected.type || row.tbl_name !== expected.tbl_name ||
        normalizeSql(row.sql) !== normalizeSql(expected.sql)) fail();
  }
}

// Check memberships and retained event identities, not only table row counts.
// The main Worker removes old events/memberships after 30 days but preserves all
// daily aggregates. Therefore exact event/membership equality applies to recent
// complete days; older rows must still be subsets of the persistent aggregates.
export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || snapshot.site_id !== SITE_ID || !iso(snapshot.created_at) ||
      Object.keys(snapshot).sort().join(',') !== 'created_at,schema,site_id,tables,version') fail();
  checkSchema(snapshot.schema);
  if (!snapshot.tables || Object.keys(snapshot.tables).sort().join(',') !== [...TABLES].sort().join(',')) fail();
  for (const table of TABLES) {
    const rows = snapshot.tables[table];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail();
    const expectedKeys = [...COLUMNS[table]].sort().join(',');
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== expectedKeys || row.site_id !== SITE_ID) fail();
    }
  }
  const { site_stats: sites, events, lifetime_visitors: lifetime, daily_stats: daily, daily_visitors: memberships } = snapshot.tables;
  if (sites.length > 1 || (!sites.length && (events.length || lifetime.length || daily.length || memberships.length))) fail();
  const site = sites[0];
  if (site && (!integer(site.pv) || !integer(site.uv) || !integer(site.history_pv) || !integer(site.pv + site.history_pv) ||
      site.uv > site.pv || !iso(site.counting_since) || !iso(site.uv_counting_since) || !iso(site.updated_at) ||
      typeof site.epoch !== 'string' || !site.epoch || site.epoch.length > 128 ||
      !(site.history_source === null || typeof site.history_source === 'string') ||
      !(site.history_as_of === null || iso(site.history_as_of)))) fail();
  const lifeMap = new Map();
  for (const row of lifetime) {
    if (!hash(row.visitor_hash) || !iso(row.first_seen_at) || lifeMap.has(row.visitor_hash)) fail();
    lifeMap.set(row.visitor_hash, row);
  }
  if (site && site.uv !== lifeMap.size) fail();
  const dailyMap = new Map();
  let allDailyPv = 0;
  for (const row of daily) {
    if (!day(row.day) || !integer(row.pv) || !integer(row.uv) || row.uv > row.pv || !iso(row.updated_at) || dailyMap.has(row.day)) fail();
    dailyMap.set(row.day, { row, pv: 0, eventHashes: new Set(), memberHashes: new Set() });
    allDailyPv += row.pv;
    if (!integer(allDailyPv)) fail();
  }
  if (site && allDailyPv !== site.pv) fail();
  const memberKeys = new Set();
  for (const row of memberships) {
    const entry = dailyMap.get(row.day);
    const memberKey = key(row.day, row.visitor_hash);
    if (!entry || !hash(row.visitor_hash) || !iso(row.first_seen_at) || !lifeMap.has(row.visitor_hash) ||
        memberKeys.has(memberKey) || berlinDay(row.first_seen_at) !== row.day) fail();
    memberKeys.add(memberKey);
    entry.memberHashes.add(row.visitor_hash);
  }
  const eventKeys = new Set();
  for (const row of events) {
    const entry = dailyMap.get(row.day);
    if (!entry || typeof row.event_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.event_id) ||
        eventKeys.has(row.event_id) || row.path !== '/rui-chen-homepage/' || !iso(row.created_at) || !iso(row.received_at) ||
        berlinDay(row.received_at) !== row.day || !(row.visitor_hash === null || hash(row.visitor_hash)) ||
        (row.visitor_hash !== null && !lifeMap.has(row.visitor_hash))) fail();
    eventKeys.add(row.event_id);
    entry.pv++;
    if (row.visitor_hash !== null) entry.eventHashes.add(row.visitor_hash);
  }
  const recentDay = berlinDay(new Date(Date.parse(snapshot.created_at) - 29 * 86400000).toISOString());
  for (const [date, entry] of dailyMap) {
    if (entry.pv > entry.row.pv || entry.memberHashes.size > entry.row.uv) fail();
    if (date >= recentDay && (entry.pv !== entry.row.pv || entry.memberHashes.size !== entry.row.uv ||
        entry.eventHashes.size !== entry.memberHashes.size || [...entry.eventHashes].some(value => !entry.memberHashes.has(value)))) fail();
  }
  return snapshot;
}

export async function createSnapshot(source, createdAt) {
  if (!source?.prepare || !source?.batch || !iso(createdAt)) throw new Error('snapshot_unavailable');
  // A cheap first guard avoids transferring obviously oversized tables. The
  // authoritative rows still have LIMITs because a visit may race this guard.
  const sizes = await source.batch(TABLES.map(table => source.prepare(`SELECT COUNT(*) AS n FROM ${table}`)));
  if (sizes.some(result => !result.success || !integer(result.results?.[0]?.n) || result.results[0].n > MAX_ROWS)) {
    throw new Error('snapshot_capacity');
  }
  const statements = [source.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND tbl_name IN ('site_stats','events','lifetime_visitors','daily_stats','daily_visitors')
    ORDER BY type,name LIMIT 10001`), ...TABLES.map(table =>
    source.prepare(`SELECT ${COLUMNS[table].join(',')} FROM ${table} ORDER BY ${COLUMNS[table].filter(column => ['site_id', 'event_id', 'visitor_hash', 'day'].includes(column)).join(',')} LIMIT 10001`))];
  // D1 batch runs all reads within one transaction, so the snapshot cannot mix
  // counters from before a visit with memberships from after that visit.
  const results = await source.batch(statements);
  if (results.length !== statements.length || results.some(result => !result.success || !Array.isArray(result.results))) {
    throw new Error('snapshot_unavailable');
  }
  const snapshot = { version: 1, site_id: SITE_ID, created_at: createdAt,
    schema: results[0].results, tables: Object.fromEntries(TABLES.map((table, index) => [table, results[index + 1].results])) };
  validateSnapshot(snapshot);
  if (encoder.encode(JSON.stringify(snapshot)).byteLength > MAX_JSON_BYTES) throw new Error('snapshot_capacity');
  return snapshot;
}

export async function sha256(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function chunkUtf8(text, maxBytes = 65536) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error('invalid_chunk_size');
  const bytes = encoder.encode(text);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks = [];
  for (let start = 0; start < bytes.byteLength;) {
    let end = Math.min(start + maxBytes, bytes.byteLength);
    while (end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  return chunks;
}

export async function encodeSnapshot(snapshot) {
  validateSnapshot(snapshot);
  const json = JSON.stringify(snapshot);
  const json_bytes = encoder.encode(json).byteLength;
  if (json_bytes > MAX_JSON_BYTES) throw new Error('snapshot_capacity');
  const chunks = chunkUtf8(json);
  if (chunks.length > 32) throw new Error('snapshot_capacity');
  return { json, sha256: await sha256(json), json_bytes, chunks };
}

export async function decodeSnapshot(json, expectedHash) {
  if (typeof json !== 'string' || !hash(expectedHash) || encoder.encode(json).byteLength > MAX_JSON_BYTES ||
      await sha256(json) !== expectedHash) fail();
  return validateSnapshot(JSON.parse(json));
}
