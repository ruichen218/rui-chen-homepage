import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { historySql } from '../scripts/import-history.mjs';
import { verifyBackup } from '../scripts/verify-backup.mjs';
import { parseJsonOutput, validStats, validApiBase } from '../scripts/common.mjs';

const migration = readFileSync(new URL('../migrations/0001_counter.sql', import.meta.url), 'utf8');
const stamp = '2026-10-25T12:00:00.000Z';
const uvSince = '2026-10-26T09:30:00.000Z';
const baseline = { pv: 123, since: '2026-10-25', asOf: stamp, uvSince };

test('history import is a one-time verified PV baseline; UV is never imported', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(migration);
  db.exec(historySql(baseline));
  let row = db.prepare('SELECT * FROM site_stats').get();
  assert.equal(row.history_pv, 123);
  assert.equal(row.pv, 0);
  assert.equal(row.uv, 0);
  assert.equal(row.history_source, 'busuanzi.cc');
  assert.equal(row.counting_since, '2026-10-25T00:00:00.000Z');
  assert.equal(row.history_as_of, stamp);
  assert.equal(row.uv_counting_since, uvSince);
  db.exec(historySql({ ...baseline, pv: 999 }));
  row = db.prepare('SELECT * FROM site_stats').get();
  assert.equal(row.history_pv, 123);
  assert.equal(row.uv_counting_since, uvSince);
  db.exec(`INSERT INTO events VALUES ('rui-chen-homepage','d74479bf-341a-4ecf-a769-f6948746bbac',
    '/rui-chen-homepage/',NULL,'${stamp}','${stamp}','2026-10-25')`);
  db.exec(historySql({ ...baseline, pv: 999 }));
  row = db.prepare('SELECT * FROM site_stats').get();
  assert.equal(row.pv + row.history_pv, 124);
  assert.equal(row.uv, 0);
});

test('history inputs reject invented negative/unsafe values, invalid dates, and SQL injection', () => {
  for (const pv of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => historySql({ ...baseline, pv }));
  }
  for (const since of ['2026-02-30', "2026-10-25';DROP TABLE site_stats;--", '2026-13-01']) {
    assert.throws(() => historySql({ ...baseline, since }));
  }
  assert.throws(() => historySql({ ...baseline, asOf: 'not a timestamp' }));
  assert.throws(() => historySql({ ...baseline, uvSince: undefined }), /UV start/);
  assert.throws(() => historySql({ ...baseline, uvSince: 'not a timestamp' }), /UV start/);
});

test('SQL backup restores all schema, aggregate counts, identities and idempotency', t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'rui-counter-backup-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'backup.sql');
  const triggerAt = migration.indexOf('CREATE TRIGGER');
  const schema = migration.slice(0, triggerAt);
  const triggers = migration.slice(triggerAt);
  const identity = 'a'.repeat(64);
  // D1/SQLite exports restore tables and data before re-creating triggers.
  const data = `INSERT INTO site_stats(site_id,pv,uv,history_pv,updated_at) VALUES('rui-chen-homepage',1,1,5,'${stamp}');
    INSERT INTO lifetime_visitors VALUES('rui-chen-homepage','${identity}','${stamp}');
    INSERT INTO daily_stats VALUES('rui-chen-homepage','2026-10-25',1,1,'${stamp}');
    INSERT INTO daily_visitors VALUES('rui-chen-homepage','2026-10-25','${identity}','${stamp}');
    INSERT INTO events VALUES('rui-chen-homepage','d74479bf-341a-4ecf-a769-f6948746bbac','/rui-chen-homepage/',
      '${identity}','${stamp}','${stamp}','2026-10-25');`;
  writeFileSync(file, schema + data + triggers);
  assert.deepEqual(verifyBackup(file), { tables: 5, sites: 1, pv: 6, uv: 1 });
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(file, 'utf8'));
  db.exec(`INSERT INTO events SELECT * FROM events WHERE 1 ON CONFLICT(site_id,event_id) DO NOTHING`);
  assert.equal(db.prepare('SELECT pv FROM site_stats').get().pv, 1);
});

test('backup checks reject incomplete schema and aggregate/membership mismatch', t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'rui-counter-invalid-backup-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'bad.sql');
  writeFileSync(file, 'CREATE TABLE other(x);');
  assert.throws(() => verifyBackup(file), /missing table/);
  writeFileSync(file, migration + `INSERT INTO site_stats(site_id,pv,uv,updated_at) VALUES('rui-chen-homepage',2,1,'${stamp}');`);
  assert.throws(() => verifyBackup(file), /consistency/);
});

test('backup verification rejects each missing counter trigger even when stored counts are consistent', t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'rui-counter-trigger-backup-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'missing-trigger.sql');
  for (const name of ['accepted_event', 'first_lifetime_visitor', 'first_daily_visitor']) {
    const withoutTrigger = migration.replace(new RegExp(`CREATE TRIGGER ${name}\\b[\\s\\S]*?END;`), '');
    assert.notEqual(withoutTrigger, migration);
    writeFileSync(file, withoutTrigger);
    assert.throws(() => verifyBackup(file), new RegExp(`required trigger ${name}`));
  }
});

test('backup verification exercises trigger behavior, not merely matching trigger names', t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'rui-counter-broken-trigger-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'broken-trigger.sql');
  for (const [name, table] of [
    ['accepted_event', 'events'],
    ['first_lifetime_visitor', 'lifetime_visitors'],
    ['first_daily_visitor', 'daily_visitors'],
  ]) {
    const broken = migration.replace(new RegExp(`CREATE TRIGGER ${name}\\b[\\s\\S]*?END;`),
      `CREATE TRIGGER ${name} AFTER INSERT ON ${table} BEGIN SELECT 1; END;`);
    assert.notEqual(broken, migration);
    writeFileSync(file, broken);
    assert.throws(() => verifyBackup(file), /write\/idempotency probe/);
  }
});

test('backup write probes roll back and preserve empty database totals', t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'rui-counter-empty-backup-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'empty.sql');
  writeFileSync(file, migration);
  assert.deepEqual(verifyBackup(file), { tables: 5, sites: 0, pv: 0, uv: 0 });
  assert.equal(readFileSync(file, 'utf8'), migration);
});

test('deployment helpers reject unsafe endpoints and incomplete readiness output', () => {
  assert.equal(validApiBase('https://counter.example/'), 'https://counter.example');
  for (const value of ['http://counter.example', 'https://user:password@counter.example', 'https://counter.example/api', 'https://counter.example/?token=x']) {
    assert.throws(() => validApiBase(value));
  }
  assert.equal(validStats({ pv: 0, uv: 0, counting_since: stamp, uv_counting_since: stamp, as_of: stamp, epoch: 'one' }), true);
  assert.equal(validStats({ pv: 3, uv: 1 }), false);
  assert.deepEqual(parseJsonOutput('banner\n{"loggedIn":false}'), { loggedIn: false });
  assert.deepEqual(parseJsonOutput('[{"uuid":"test"}]'), [{ uuid: 'test' }]);
  assert.throws(() => parseJsonOutput('not-json'));
});
