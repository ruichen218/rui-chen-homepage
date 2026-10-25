import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createMaintenanceWorker } from '../src/worker.js';
import { TABLES, createSnapshot, validateSnapshot, encodeSnapshot, decodeSnapshot, chunkUtf8, MAX_ROWS } from '../src/snapshot.js';

const mainMigration = readFileSync(new URL('../../migrations/0001_counter.sql', import.meta.url), 'utf8');
const archiveMigration = readFileSync(new URL('../migrations/0001_archive.sql', import.meta.url), 'utf8');
const NOW = '2026-10-25T12:00:00.000Z';
const SECRET = 'a-private-maintenance-secret-more-than-thirty-two-characters';
const SITE = 'rui-chen-homepage';

class D1Adapter {
  constructor(sql) {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys=ON');
    this.sqlite.exec(sql);
    this.executed = [];
    this.failAt = -1;
    this.onBatch = null;
  }
  prepare(sql) {
    const adapter = this;
    return { sql, parameters: [], bind(...parameters) { return { ...this, parameters }; },
      async first() { adapter.executed.push(sql); return adapter.sqlite.prepare(sql).get(...this.parameters) || null; } };
  }
  async batch(statements) {
    if (this.onBatch) await this.onBatch(statements);
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement, index) => {
        if (index === this.failAt) throw new Error('Private simulated SQLite outage');
        this.executed.push(statement.sql);
        const prepared = this.sqlite.prepare(statement.sql);
        if (prepared.columns().length) return { success: true, results: prepared.all(...statement.parameters), meta: { changes: 0 } };
        const value = prepared.run(...statement.parameters);
        return { success: true, results: [], meta: { changes: Number(value.changes) } };
      });
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  count(table) { return this.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; }
  close() { this.sqlite.close(); }
}

function visit(db, { visitor = 'a'.repeat(64), stamp = NOW, event = randomUUID(), day = stamp.slice(0, 10) } = {}) {
  const sql = `INSERT INTO events(site_id,event_id,path,visitor_hash,created_at,received_at,day)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(site_id,event_id) DO NOTHING`;
  db.sqlite.prepare(sql).run(SITE, event, '/rui-chen-homepage/', visitor, stamp, stamp, day);
  return { event, visitor, stamp, day };
}

function fixture(t, initial = NOW) {
  const SOURCE_DB = new D1Adapter(mainMigration);
  const ARCHIVE_DB = new D1Adapter(archiveMigration);
  t.after(() => { SOURCE_DB.close(); ARCHIVE_DB.close(); });
  let clock = new Date(initial);
  let mainHealthy = true;
  const requests = [];
  const env = { SOURCE_DB, ARCHIVE_DB, MAINTENANCE_SECRET: SECRET };
  const worker = createMaintenanceWorker({ now: () => new Date(clock), fetchImpl: async (url, init) => {
    requests.push({ url, ...init });
    const body = url.endsWith('/health') ? { ok: mainHealthy } : { pv: 4, uv: 0,
      counting_since: NOW, uv_counting_since: NOW, as_of: clock.toISOString(), epoch: 'epoch-one' };
    return Response.json(body, { status: mainHealthy ? 200 : 503 });
  } });
  return { SOURCE_DB, ARCHIVE_DB, env, worker, requests,
    setNow(value) { clock = new Date(value); }, setMainHealthy(value) { mainHealthy = value; },
    get(path = '/health', init = {}) { return worker.fetch(new Request('https://maintenance.example' + path, init), env); },
    admin(body = { backup: true }, token = SECRET) { return this.get('/admin/run', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
  };
}

async function storedSnapshot(archive, day) {
  const row = archive.sqlite.prepare('SELECT * FROM snapshots WHERE day=?').get(day);
  assert.ok(row);
  const chunks = archive.sqlite.prepare('SELECT content FROM snapshot_chunks WHERE snapshot_id=? ORDER BY chunk_index').all(row.snapshot_id);
  assert.equal(chunks.length, row.chunk_count);
  const json = chunks.map(chunk => chunk.content).join('');
  assert.equal(new TextEncoder().encode(json).byteLength, row.json_bytes);
  return { row, json, snapshot: await decodeSnapshot(json, row.sha256) };
}

function restore(snapshot) {
  const db = new DatabaseSync(':memory:');
  for (const schema of snapshot.schema.filter(row => row.type === 'table')) db.exec(schema.sql);
  for (const table of TABLES) for (const row of snapshot.tables[table]) {
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key]));
  }
  for (const schema of snapshot.schema.filter(row => row.type !== 'table')) db.exec(schema.sql);
  return db;
}

test('bootstrap snapshots real SQLite, hashes all bytes, and restores working idempotent counters', async t => {
  const f = fixture(t);
  visit(f.SOURCE_DB);
  visit(f.SOURCE_DB, { visitor: null });
  const response = await f.admin();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, last_check_at: NOW, last_backup_at: NOW });
  const { snapshot, row } = await storedSnapshot(f.ARCHIVE_DB, '2026-10-25');
  assert.equal(row.source_kind, 'bootstrap');
  const db = restore(snapshot);
  t.after(() => db.close());
  assert.deepEqual({ ...db.prepare('SELECT pv,uv FROM site_stats').get() }, { pv: 2, uv: 1 });
  const newEvent = randomUUID();
  const insert = db.prepare(`INSERT INTO events(site_id,event_id,path,visitor_hash,created_at,received_at,day)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(site_id,event_id) DO NOTHING`);
  const values = [SITE, newEvent, '/rui-chen-homepage/', 'b'.repeat(64), NOW, NOW, '2026-10-25'];
  insert.run(...values); insert.run(...values);
  assert.deepEqual({ ...db.prepare('SELECT pv,uv FROM site_stats').get() }, { pv: 3, uv: 2 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 3);
  assert.ok(f.SOURCE_DB.executed.every(sql => /^SELECT\b/i.test(sql.trim())), 'source binding is only read');
  assert.deepEqual(f.requests.map(request => [request.method, new URL(request.url).pathname]), [['GET', '/health'], ['GET', '/v1/stats']]);
});

test('service binding probes the main Worker with two GETs without invoking public fetch', async t => {
  const f = fixture(t);
  const requests = [];
  f.env.COUNTER_SERVICE = { async fetch(request) {
    requests.push(request);
    const url = new URL(request.url);
    return Response.json(url.pathname === '/health' ? { ok: true } : {
      pv: 0, uv: 0, counting_since: NOW, uv_counting_since: NOW, as_of: NOW, epoch: 'binding-epoch',
    });
  } };
  assert.equal((await f.admin()).status, 200);
  assert.equal(f.requests.length, 0, 'public fetch implementation was not used');
  assert.deepEqual(requests.map(request => [request.method, new URL(request.url).pathname]), [['GET', '/health'], ['GET', '/v1/stats']]);
  assert.ok(requests.every(request => request.redirect === 'manual'));
  assert.ok(requests.every(request => request.body === null));
  assert.equal(f.SOURCE_DB.count('events'), 0);
});

test('redirecting service binding fails the check without following while a backup still succeeds', async t => {
  const f = fixture(t);
  const requests = [];
  f.env.COUNTER_SERVICE = { async fetch(request) {
    requests.push(request);
    assert.equal(request.redirect, 'manual');
    return new Response(null, { status: 303, headers: { Location: 'https://other.example/untrusted' } });
  } };
  const response = await f.admin();
  assert.equal(response.status, 503);
  assert.equal(requests.length, 2, 'only the health and stats requests ran; redirects were not followed');
  assert.ok(requests.every(request => new URL(request.url).hostname.endsWith('.workers.dev')));
  assert.equal(f.requests.length, 0);
  const state = f.ARCHIVE_DB.sqlite.prepare('SELECT * FROM maintenance_state').get();
  assert.equal(state.last_check_ok, 0);
  assert.equal(state.last_backup_ok, 1);
  assert.equal(f.ARCHIVE_DB.count('snapshots'), 1);
  await storedSnapshot(f.ARCHIVE_DB, '2026-10-25');
});

test('scheduled first run backs up before 04:41 UTC, then one immutable snapshot each UTC day', async t => {
  const f = fixture(t, '2026-10-25T00:15:00.000Z');
  await f.worker.scheduled({}, f.env);
  const first = await storedSnapshot(f.ARCHIVE_DB, '2026-10-25');
  f.setNow('2026-10-25T12:15:00.000Z');
  visit(f.SOURCE_DB);
  await f.worker.scheduled({}, f.env);
  assert.equal((await storedSnapshot(f.ARCHIVE_DB, '2026-10-25')).row.sha256, first.row.sha256);
  f.setNow('2026-10-26T04:30:00.000Z');
  await f.worker.scheduled({}, f.env);
  assert.equal(f.ARCHIVE_DB.count('snapshots'), 1);
  f.setNow('2026-10-26T04:45:00.000Z');
  await f.worker.scheduled({}, f.env);
  assert.equal(f.ARCHIVE_DB.count('snapshots'), 2);
  assert.equal((await storedSnapshot(f.ARCHIVE_DB, '2026-10-26')).snapshot.tables.events.length, 1);
});

test('archive transaction failure rolls back metadata/chunks and preserves yesterday; retry succeeds', async t => {
  const f = fixture(t);
  await f.admin();
  const first = await storedSnapshot(f.ARCHIVE_DB, '2026-10-25');
  f.setNow('2026-10-26T12:00:00.000Z');
  // Only fail backup's multi-statement write, after metadata has been inserted.
  f.ARCHIVE_DB.onBatch = statements => { f.ARCHIVE_DB.failAt = statements.length > 3 ? 1 : -1; };
  assert.equal((await f.admin()).status, 503);
  assert.equal(f.ARCHIVE_DB.count('snapshots'), 1);
  assert.equal((await storedSnapshot(f.ARCHIVE_DB, '2026-10-25')).row.sha256, first.row.sha256);
  assert.equal((await f.get()).status, 503);
  f.ARCHIVE_DB.onBatch = null; f.ARCHIVE_DB.failAt = -1;
  assert.equal((await f.admin()).status, 200);
  assert.equal(f.ARCHIVE_DB.count('snapshots'), 2);
});

test('real source failure keeps API check timestamp and old backup, with no private error content', async t => {
  const f = fixture(t);
  await f.admin();
  f.setNow('2026-10-26T12:00:00.000Z');
  f.SOURCE_DB.failAt = 0;
  const response = await f.admin();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, last_check_at: '2026-10-26T12:00:00.000Z', last_backup_at: NOW });
  assert.equal(f.ARCHIVE_DB.count('snapshots'), 1);
  const row = f.ARCHIVE_DB.sqlite.prepare('SELECT * FROM maintenance_state').get();
  assert.equal(row.last_check_ok, 1); assert.equal(row.last_backup_ok, 0);
});

test('failed API probes do not prevent snapshots; health exposes only timestamps and stale state', async t => {
  const f = fixture(t);
  f.setMainHealthy(false);
  assert.equal((await f.admin()).status, 503);
  assert.equal(f.ARCHIVE_DB.count('snapshots'), 1);
  let row = f.ARCHIVE_DB.sqlite.prepare('SELECT * FROM maintenance_state').get();
  assert.equal(row.consecutive_failures, 1); assert.equal(row.last_backup_ok, 1);
  f.setMainHealthy(true);
  assert.equal((await f.admin()).status, 200);
  row = f.ARCHIVE_DB.sqlite.prepare('SELECT * FROM maintenance_state').get();
  assert.equal(row.consecutive_failures, 0);
  f.setNow('2026-10-25T12:46:00.000Z');
  let response = await f.get(); assert.equal(response.status, 503);
  assert.deepEqual(Object.keys(await response.json()).sort(), ['last_backup_at', 'last_check_at', 'ok']);
  f.setNow('2026-10-27T01:00:00.000Z');
  f.ARCHIVE_DB.sqlite.prepare('UPDATE maintenance_state SET last_check_at=?').run('2026-10-27T01:00:00.000Z');
  response = await f.get(); assert.equal(response.status, 503, 'backup older than 36 hours');
});

test('admin is authenticated, body bounded, replay safe, and no public route reads snapshots', async t => {
  const f = fixture(t);
  for (const path of ['/snapshots', '/admin/download', '/']) assert.equal((await f.get(path)).status, 404);
  assert.equal((await f.get('/admin/run')).status, 405);
  assert.equal((await f.admin({ backup: true }, 'wrong-token')).status, 401);
  assert.equal((await f.admin({ backup: true, extra: true })).status, 400);
  assert.equal((await f.admin({ backup: false })).status, 400);
  assert.equal((await f.admin({ backup: '界'.repeat(200) })).status, 400);
  assert.equal((await f.get('/health', { method: 'POST' })).status, 405);
  assert.equal(f.ARCHIVE_DB.count('snapshots'), 0);
  await f.admin(); await f.admin();
  assert.equal(f.ARCHIVE_DB.count('snapshots'), 1);
  delete f.env.MAINTENANCE_SECRET;
  assert.equal((await f.admin()).status, 401);
  assert.equal((await f.get()).status, 200, 'public health does not need or expose secret configuration');
});

test('retention keeps exactly newest thirty complete snapshots with corresponding chunks', async t => {
  const f = fixture(t);
  for (let index = 0; index < 32; index++) {
    f.setNow(new Date(Date.parse(NOW) + index * 86400000).toISOString());
    assert.equal((await f.admin()).status, 200);
  }
  assert.equal(f.ARCHIVE_DB.count('snapshots'), 30);
  assert.equal(f.ARCHIVE_DB.count('snapshot_chunks'), 30);
  assert.equal(f.ARCHIVE_DB.sqlite.prepare('SELECT MIN(day) AS day FROM snapshots').get().day, '2026-10-27');
  assert.equal(f.ARCHIVE_DB.sqlite.prepare(`SELECT COUNT(*) AS n FROM snapshot_chunks c LEFT JOIN snapshots s USING(snapshot_id) WHERE s.snapshot_id IS NULL`).get().n, 0);
});

test('unknown schema or no-op trigger fails closed before any archive mutation', async t => {
  const f = fixture(t);
  await f.admin();
  f.setNow('2026-10-26T12:00:00.000Z');
  f.SOURCE_DB.sqlite.exec('DROP TRIGGER first_lifetime_visitor; CREATE TRIGGER first_lifetime_visitor AFTER INSERT ON lifetime_visitors BEGIN SELECT 1; END;');
  assert.equal((await f.admin()).status, 503);
  assert.equal(f.ARCHIVE_DB.count('snapshots'), 1);
  await assert.rejects(createSnapshot(f.SOURCE_DB, NOW), /snapshot_invalid/);
});

test('membership mismatch is rejected even when row counts and aggregate UV match', async t => {
  const f = fixture(t);
  visit(f.SOURCE_DB);
  const snapshot = await createSnapshot(f.SOURCE_DB, NOW);
  snapshot.tables.daily_visitors[0].visitor_hash = 'b'.repeat(64);
  assert.throws(() => validateSnapshot(snapshot), /snapshot_invalid/);
});

test('historical PV is preserved and legitimate retained aggregates validate after pruning', async t => {
  const f = fixture(t);
  visit(f.SOURCE_DB, { stamp: '2026-09-01T12:00:00.000Z', day: '2026-09-01' });
  visit(f.SOURCE_DB, { visitor: 'b'.repeat(64) });
  f.SOURCE_DB.sqlite.exec("UPDATE site_stats SET history_pv=4; DELETE FROM events WHERE day='2026-09-01'; DELETE FROM daily_visitors WHERE day='2026-09-01';");
  const snapshot = await createSnapshot(f.SOURCE_DB, NOW);
  assert.equal(snapshot.tables.site_stats[0].pv, 2);
  assert.equal(snapshot.tables.site_stats[0].history_pv, 4);
  assert.equal(snapshot.tables.events.length, 1);
  assert.equal((await f.admin()).status, 200);
});

test('snapshot hash detects data, schema, site, and timestamp tampering', async t => {
  const f = fixture(t);
  visit(f.SOURCE_DB);
  const snapshot = await createSnapshot(f.SOURCE_DB, NOW);
  const encoded = await encodeSnapshot(snapshot);
  for (const transform of [
    value => { value.tables.site_stats[0].pv++; },
    value => { value.schema[0].sql += ' '; },
    value => { value.site_id = 'other'; },
    value => { value.created_at = '2026-10-26T12:00:00.000Z'; },
  ]) {
    const modified = structuredClone(snapshot); transform(modified);
    await assert.rejects(decodeSnapshot(JSON.stringify(modified), encoded.sha256), /snapshot_invalid/);
  }
  await assert.rejects(decodeSnapshot(encoded.json, '0'.repeat(64)), /snapshot_invalid/);
});

test('UTF-8 chunking preserves Chinese and supplementary characters at byte boundaries', () => {
  const text = '界😀abc'.repeat(30000);
  const chunks = chunkUtf8(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => new TextEncoder().encode(chunk).byteLength <= 65536));
  assert.ok(chunks.every(chunk => new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(chunk)) === chunk));
});

test('row guard and post-read LIMIT fail safely even if data grows between batches', async t => {
  const f = fixture(t);
  const originalBatch = f.SOURCE_DB.batch.bind(f.SOURCE_DB);
  let batches = 0;
  f.SOURCE_DB.batch = async statements => {
    batches++;
    if (batches === 1) return statements.map(() => ({ success: true, results: [{ n: 0 }] }));
    const results = await originalBatch(statements);
    results[2].results = Array.from({ length: MAX_ROWS + 1 }, () => ({}));
    return results;
  };
  await assert.rejects(createSnapshot(f.SOURCE_DB, NOW), /snapshot_invalid/);
  assert.ok(f.SOURCE_DB.executed.filter(sql => sql.includes('FROM sqlite_schema') || /^SELECT site_id/.test(sql)).every(sql => /LIMIT 10001$/.test(sql.trim())));
});

test('serialized byte capacity protects the archive before writes', async t => {
  const f = fixture(t);
  visit(f.SOURCE_DB);
  f.SOURCE_DB.sqlite.prepare('UPDATE site_stats SET history_source=?').run('界'.repeat(750000));
  await assert.rejects(createSnapshot(f.SOURCE_DB, NOW), /snapshot_capacity/);
  assert.equal((await f.admin()).status, 503);
  assert.equal(f.ARCHIVE_DB.count('snapshots'), 0);
});
