import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  createWorker, berlinDay, hashVisitor, parseIso,
  MAX_EVENT_AGE_MS, MAX_FUTURE_SKEW_MS,
} from '../src/index.js';

const migration = readFileSync(new URL('../migrations/0001_counter.sql', import.meta.url), 'utf8');
const ORIGIN = 'https://ruichen218.github.io';
const NOW = '2026-10-25T12:00:00.000Z';
const SECRET = 'a-test-secret-with-at-least-thirty-two-characters';

// Runs the production migration and SQL against real SQLite. D1's batch API is
// represented by one SQLite transaction, including rollback after trigger work.
class D1Adapter {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(migration);
    this.executed = [];
    this.failAt = -1;
  }
  prepare(sql) {
    const adapter = this;
    return {
      sql, parameters: [],
      bind(...parameters) { return { ...this, parameters }; },
      async first() {
        adapter.executed.push(sql);
        return adapter.sqlite.prepare(sql).get(...this.parameters) || null;
      },
    };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement, index) => {
        if (index === this.failAt) throw new Error('Private test failure: secret SQL details');
        this.executed.push(statement.sql);
        const prepared = this.sqlite.prepare(statement.sql);
        if (prepared.columns().length) {
          return { success: true, results: prepared.all(...statement.parameters), meta: { changes: 0 } };
        }
        const result = prepared.run(...statement.parameters);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      });
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  count(table) { return this.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; }
  close() { this.sqlite.close(); }
}

function fixture(t, initial = NOW) {
  const DB = new D1Adapter();
  t.after(() => DB.close());
  let clock = new Date(initial);
  const worker = createWorker({ now: () => new Date(clock) });
  const env = { DB, VISITOR_SECRET: SECRET };
  return {
    DB, worker, env,
    setNow(value) { clock = new Date(value); },
    visit(overrides = {}) {
      return {
        event_id: randomUUID(), visitor_id: randomUUID(),
        created_at: clock.toISOString(), path: '/rui-chen-homepage/', ...overrides,
      };
    },
    request(path, init = {}) {
      return worker.fetch(new Request(`https://counter.example${path}`, init), env);
    },
    post(payload, extraHeaders = {}) {
      return this.request('/v1/visits', {
        method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(payload),
      });
    },
  };
}

async function result(response, expectedStatus = 200) {
  assert.equal(response.status, expectedStatus);
  return response.json();
}

test('empty stats and readiness are read-only, with exact CORS and cache policy', async t => {
  const f = fixture(t);
  const response = await f.request('/v1/stats', { headers: { Origin: ORIGIN } });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Vary'), 'Origin');
  assert.deepEqual(await result(response), {
    pv: 0, uv: 0, counting_since: '2026-10-25T00:00:00.000Z',
    uv_counting_since: '2026-10-25T00:00:00.000Z', as_of: NOW,
    epoch: 'rui-chen-homepage-v1',
  });
  assert.deepEqual(await result(await f.request('/health')), { ok: true });
  assert.equal(f.DB.count('site_stats'), 0);
  assert.ok(f.DB.executed.every(sql => /^SELECT\b/i.test(sql)));
});

test('one event updates PV, lifetime UV, daily UV and stores only the HMAC identity', async t => {
  const f = fixture(t);
  const visit = f.visit();
  const stats = await result(await f.post(visit));
  assert.equal(stats.pv, 1);
  assert.equal(stats.uv, 1);
  assert.equal(stats.duplicate, false);
  assert.equal(f.DB.count('events'), 1);
  assert.equal(f.DB.count('lifetime_visitors'), 1);
  assert.equal(f.DB.count('daily_visitors'), 1);
  const row = f.DB.sqlite.prepare('SELECT * FROM events').get();
  assert.equal(row.visitor_hash, await hashVisitor(visit.visitor_id, SECRET));
  assert.match(row.visitor_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(row.visitor_hash, visit.visitor_id);
  assert.equal(row.day, '2026-10-25');
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes(visit.visitor_id));
  const daily = f.DB.sqlite.prepare('SELECT * FROM daily_stats').get();
  assert.equal(daily.pv, 1);
  assert.equal(daily.uv, 1);
});

test('duplicate retries, including concurrent requests with changed identity, increment nothing twice', async t => {
  const f = fixture(t);
  const visit = f.visit();
  const responses = await Promise.all([f.post(visit), f.post(visit)]);
  const results = await Promise.all(responses.map(response => result(response)));
  assert.deepEqual(results.map(value => value.duplicate).sort(), [false, true]);
  const changed = await result(await f.post({ ...visit, visitor_id: randomUUID() }));
  assert.equal(changed.duplicate, true);
  assert.equal(changed.pv, 1);
  assert.equal(changed.uv, 1);
  assert.equal(f.DB.count('lifetime_visitors'), 1);
  assert.equal(f.DB.count('daily_visitors'), 1);
});

test('distinct interleaved events for one browser add PV but only one lifetime visitor', async t => {
  const f = fixture(t);
  const visitor = randomUUID();
  const visits = Array.from({ length: 8 }, () => f.visit({ visitor_id: visitor }));
  await Promise.all(visits.map(async visit => result(await f.post(visit))));
  const stats = await result(await f.request('/v1/stats'));
  assert.equal(stats.pv, 8);
  assert.equal(stats.uv, 1);
  assert.equal(f.DB.count('events'), 8);
  assert.equal(f.DB.count('daily_visitors'), 1);
});

test('retry across Berlin midnight preserves original day; next event counts a new daily UV', async t => {
  const f = fixture(t, '2026-10-24T21:59:59.000Z');
  const visit = f.visit();
  await result(await f.post(visit));
  f.setNow('2026-10-24T22:00:01.000Z');
  assert.equal((await result(await f.post(visit))).duplicate, true);
  assert.equal(f.DB.count('daily_stats'), 1);
  await result(await f.post(f.visit({ visitor_id: visit.visitor_id })));
  const rows = f.DB.sqlite.prepare('SELECT day, pv, uv FROM daily_stats ORDER BY day').all();
  assert.deepEqual(rows.map(row => ({ ...row })), [
    { day: '2026-10-24', pv: 1, uv: 1 }, { day: '2026-10-25', pv: 1, uv: 1 },
  ]);
  assert.equal((await result(await f.request('/v1/stats'))).uv, 1);
});

test('Berlin day handles summer/winter offsets and the repeated DST hour', () => {
  assert.equal(berlinDay(new Date('2026-07-01T22:00:00Z')), '2026-07-02');
  assert.equal(berlinDay(new Date('2026-12-01T22:30:00Z')), '2026-12-01');
  assert.equal(berlinDay(new Date('2026-12-01T23:00:00Z')), '2026-12-02');
  assert.equal(berlinDay(new Date('2026-10-25T00:30:00Z')), '2026-10-25');
  assert.equal(berlinDay(new Date('2026-10-25T01:30:00Z')), '2026-10-25');
});

test('daily attribution uses first acceptance, never client clock or a retry timestamp', async t => {
  const f = fixture(t);
  const visit = f.visit({ created_at: '2026-10-19T23:59:00.000Z' });
  await result(await f.post(visit));
  assert.equal(f.DB.sqlite.prepare('SELECT day FROM events').get().day, '2026-10-25');
  f.setNow('2026-10-26T12:00:00Z');
  await result(await f.post({ ...visit, created_at: '2026-10-26T12:00:00Z' }));
  assert.equal(f.DB.count('daily_stats'), 1);
  assert.equal(f.DB.sqlite.prepare('SELECT day FROM events').get().day, '2026-10-25');
});

test('null identity records PV without manufacturing unique visitors', async t => {
  const f = fixture(t);
  const visit = f.visit({ visitor_id: null });
  assert.equal((await result(await f.post(visit))).uv, 0);
  assert.equal((await result(await f.post({ ...visit, visitor_id: randomUUID() }))).uv, 0);
  assert.equal(f.DB.count('lifetime_visitors'), 0);
  assert.equal(f.DB.count('daily_visitors'), 0);
});

test('UUID normalization prevents case variants from bypassing deduplication', async t => {
  const f = fixture(t);
  const visit = f.visit();
  await result(await f.post({ ...visit, event_id: visit.event_id.toUpperCase(), visitor_id: visit.visitor_id.toUpperCase() }));
  assert.equal((await result(await f.post(visit))).duplicate, true);
  assert.equal((await result(await f.post(f.visit({ visitor_id: visit.visitor_id })))).uv, 1);
});

test('origin and method rules, preflights and local override do not admit unauthorized writes', async t => {
  const f = fixture(t);
  const bad = await f.post(f.visit(), { Origin: 'https://evil.example' });
  await result(bad, 403);
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
  await result(await f.request('/v1/visits', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.visit()),
  }), 403);
  const preflight = await f.request('/v1/visits', { method: 'OPTIONS', headers: {
    Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
  await result(await f.request('/v1/visits', { method: 'OPTIONS', headers: {
    Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-admin-token',
  } }), 400);
  await result(await f.request('/v1/stats', { method: 'POST', headers: { Origin: ORIGIN } }), 405);
  await result(await f.request('/admin/reset'), 404);
  assert.equal(f.DB.count('events'), 0);
  f.env.ALLOWED_ORIGIN = 'http://127.0.0.1:8788';
  await result(await f.post(f.visit(), { Origin: f.env.ALLOWED_ORIGIN }));
});

test('malformed bodies, invalid fields, timestamps and oversized UTF-8 bodies produce no writes', async t => {
  const f = fixture(t);
  for (const overrides of [
    { event_id: 'invalid' }, { visitor_id: undefined }, { visitor_id: 'invalid' },
    { created_at: '2026-02-30T12:00:00Z' }, { created_at: '2026-10-25' },
    { path: '/other/' }, { surprise: 'field' },
    { created_at: new Date(Date.parse(NOW) - MAX_EVENT_AGE_MS - 1).toISOString() },
    { created_at: new Date(Date.parse(NOW) + MAX_FUTURE_SKEW_MS + 1).toISOString() },
  ]) await result(await f.post(f.visit(overrides)), 400);
  for (const body of ['{', 'null', '[]', 'true']) {
    await result(await f.request('/v1/visits', {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body,
    }), 400);
  }
  await result(await f.request('/v1/visits', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' }, body: '{}',
  }), 400);
  await result(await f.request('/v1/visits', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: new Uint8Array([0xff]),
  }), 400);
  await result(await f.post({ ...f.visit(), padding: '界'.repeat(1000) }), 413);
  await result(await f.post(f.visit(), { 'Content-Length': '2049' }), 413);
  assert.equal(f.DB.count('site_stats'), 0);
  assert.equal(f.DB.count('events'), 0);
  // Invalid clocks on write requests never prevent this independent read route.
  await result(await f.request('/v1/stats'));
});

test('ISO offsets normalize and accepted clock boundaries are explicit', async t => {
  const f = fixture(t);
  assert.equal(parseIso('2026-10-25T13:00:00+01:00'), NOW);
  await result(await f.post(f.visit({ created_at: '2026-10-25T13:00:00+01:00' })));
  await result(await f.post(f.visit({ created_at: new Date(Date.parse(NOW) - MAX_EVENT_AGE_MS).toISOString() })));
  await result(await f.post(f.visit({ created_at: new Date(Date.parse(NOW) + MAX_FUTURE_SKEW_MS).toISOString() })));
});

test('rate limit applies only to writes and binding failures fail closed', async t => {
  const f = fixture(t);
  const keys = [];
  f.env.RATE_LIMITER = { async limit({ key }) { keys.push(key); return { success: false }; } };
  const response = await f.post(f.visit(), { 'CF-Connecting-IP': '192.0.2.10' });
  await result(response, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(keys.length, 1);
  await result(await f.request('/v1/stats'));
  assert.equal(keys.length, 1);
  f.env.RATE_LIMITER = { async limit() { throw new Error('Private limiter failure'); } };
  const body = await result(await f.post(f.visit()), 503);
  assert.ok(!JSON.stringify(body).includes('Private'));
  assert.equal(f.DB.count('events'), 0);
});

test('batch failure after trigger execution rolls back all state and exposes no internals', async t => {
  const f = fixture(t);
  f.DB.failAt = 2;
  const visit = f.visit();
  const body = await result(await f.post(visit), 503);
  assert.deepEqual(body, { error: 'service_unavailable', message: 'Statistics are temporarily unavailable.' });
  for (const table of ['site_stats', 'events', 'lifetime_visitors', 'daily_stats', 'daily_visitors']) {
    assert.equal(f.DB.count(table), 0, table);
  }
  f.DB.failAt = -1;
  const retry = await result(await f.post(visit));
  assert.equal(retry.pv, 1);
  assert.equal(retry.duplicate, false);
});

test('SQLite constraints roll back event and membership inserts on aggregate overflow', async t => {
  const f = fixture(t);
  await result(await f.post(f.visit()));
  f.DB.sqlite.prepare('UPDATE site_stats SET pv = ?').run(Number.MAX_SAFE_INTEGER);
  await result(await f.post(f.visit()), 503);
  assert.equal(f.DB.count('events'), 1);
  assert.equal(f.DB.count('lifetime_visitors'), 1);
  assert.equal(f.DB.count('daily_visitors'), 1);
  assert.equal((await result(await f.request('/v1/stats'))).pv, Number.MAX_SAFE_INTEGER);
});

test('direct INSERT OR IGNORE duplicates also leave all trigger counters unchanged', t => {
  const f = fixture(t);
  const values = ['rui-chen-homepage', randomUUID(), '/rui-chen-homepage/', 'a'.repeat(64), NOW, NOW, '2026-10-25'];
  const statement = f.DB.sqlite.prepare(`INSERT OR IGNORE INTO events
    (site_id,event_id,path,visitor_hash,created_at,received_at,day) VALUES(?,?,?,?,?,?,?)`);
  statement.run(...values);
  statement.run(...values);
  statement.run(values[0], randomUUID(), ...values.slice(2));
  const row = f.DB.sqlite.prepare('SELECT pv,uv FROM site_stats').get();
  assert.equal(row.pv, 2);
  assert.equal(row.uv, 1);
  assert.equal(f.DB.count('daily_visitors'), 1);
});

test('start labels persist and imported historical PV does not alter new UV', async t => {
  const f = fixture(t);
  f.env.SITE_STARTED_AT = '2026-10-25T11:30:00.000Z';
  await result(await f.post(f.visit()));
  f.env.SITE_STARTED_AT = '2026-10-26T00:00:00.000Z';
  f.DB.sqlite.prepare('UPDATE site_stats SET history_pv = ?, history_source = ?, history_as_of = ?')
    .run(37, 'busuanzi.cc snapshot', NOW);
  const stats = await result(await f.request('/v1/stats'));
  assert.equal(stats.pv, 38);
  assert.equal(stats.uv, 1);
  assert.equal(stats.counting_since, '2026-10-25T11:30:00.000Z');
  assert.equal(stats.uv_counting_since, '2026-10-25T11:30:00.000Z');
});

test('scheduled retention removes old events and daily identities without decrementing totals', async t => {
  const f = fixture(t);
  await result(await f.post(f.visit()));
  f.setNow('2026-11-26T12:00:00.000Z');
  await result(await f.post(f.visit()));
  await f.worker.scheduled({}, f.env);
  assert.equal(f.DB.count('events'), 1);
  assert.equal(f.DB.count('daily_visitors'), 1);
  assert.equal(f.DB.count('daily_stats'), 2);
  assert.equal(f.DB.count('lifetime_visitors'), 2);
  const stats = await result(await f.request('/v1/stats'));
  assert.equal(stats.pv, 2);
  assert.equal(stats.uv, 2);
});

test('unconfigured or failed dependencies yield safe 503s, while stats do not require visitor secrets', async t => {
  const f = fixture(t);
  delete f.env.VISITOR_SECRET;
  await result(await f.request('/v1/stats'));
  await result(await f.request('/health'), 503);
  await result(await f.post(f.visit()), 503);
  assert.equal(f.DB.count('events'), 0);
  delete f.env.DB;
  await result(await f.request('/v1/stats'), 503);
  await result(await f.request('/health'), 503);
});

test('health verifies schema readiness instead of reporting an empty unmigrated database healthy', async t => {
  const f = fixture(t);
  f.DB.sqlite.exec('DROP TABLE daily_visitors');
  await result(await f.request('/health'), 503);
});
