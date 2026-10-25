import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function verifyCounterWrites(db) {
  const site = 'rui-chen-homepage';
  const event = randomUUID();
  const identity = randomBytes(32).toString('hex');
  const stamp = new Date().toISOString();
  const day = stamp.slice(0, 10);
  const siteRow = () => db.prepare('SELECT pv,uv,history_pv FROM site_stats WHERE site_id=?').get(site);
  const dailyRow = () => db.prepare('SELECT pv,uv FROM daily_stats WHERE site_id=? AND day=?').get(site, day);
  const counts = () => ['site_stats', 'events', 'lifetime_visitors', 'daily_stats', 'daily_visitors']
    .map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  const failure = () => { throw new Error('Backup counter triggers failed the write/idempotency probe.'); };
  db.exec('BEGIN');
  try {
    const beforeSite = siteRow() || { pv: 0, uv: 0, history_pv: 0 };
    const beforeDay = dailyRow() || { pv: 0, uv: 0 };
    const hadSite = !!siteRow();
    const hadDay = !!dailyRow();
    const beforeCounts = counts();
    const statement = db.prepare(`INSERT INTO events
      (site_id,event_id,path,visitor_hash,created_at,received_at,day)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(site_id,event_id) DO NOTHING`);
    const values = [site, event, '/rui-chen-homepage/', identity, stamp, stamp, day];
    statement.run(...values);
    const insertedSite = siteRow();
    const insertedDay = dailyRow();
    if (!insertedSite || !insertedDay ||
        insertedSite.pv !== beforeSite.pv + 1 || insertedSite.uv !== beforeSite.uv + 1 ||
        insertedSite.history_pv !== beforeSite.history_pv ||
        insertedDay.pv !== beforeDay.pv + 1 || insertedDay.uv !== beforeDay.uv + 1 ||
        !db.prepare('SELECT 1 FROM lifetime_visitors WHERE site_id=? AND visitor_hash=?').get(site, identity) ||
        !db.prepare('SELECT 1 FROM daily_visitors WHERE site_id=? AND day=? AND visitor_hash=?').get(site, day, identity)) {
      failure();
    }
    const afterCounts = counts();
    const expectedIncrements = [hadSite ? 0 : 1, 1, 1, hadDay ? 0 : 1, 1];
    if (afterCounts.some((value, index) => value !== beforeCounts[index] + expectedIncrements[index])) failure();
    statement.run(...values);
    if (JSON.stringify(siteRow()) !== JSON.stringify(insertedSite) ||
        JSON.stringify(dailyRow()) !== JSON.stringify(insertedDay) ||
        counts().some((value, index) => value !== afterCounts[index])) failure();
  } finally {
    // The probe must never become part of a restored backup or reported totals.
    db.exec('ROLLBACK');
  }
}

export function verifyBackup(file) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(file, 'utf8'));
    for (const table of ['site_stats', 'events', 'lifetime_visitors', 'daily_stats', 'daily_visitors']) {
      if (!db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name=?").get(table)) {
        throw new Error(`Backup is missing table ${table}.`);
      }
    }
    for (const [trigger, table] of [
      ['accepted_event', 'events'],
      ['first_lifetime_visitor', 'lifetime_visitors'],
      ['first_daily_visitor', 'daily_visitors'],
    ]) {
      const row = db.prepare("SELECT tbl_name FROM sqlite_schema WHERE type='trigger' AND name=?").get(trigger);
      if (!row || row.tbl_name !== table) throw new Error(`Backup is missing required trigger ${trigger}.`);
    }
    const stats = db.prepare('SELECT pv,uv,history_pv FROM site_stats').all();
    const memberships = db.prepare('SELECT COUNT(*) AS n FROM lifetime_visitors').get().n;
    if (stats.some(row => !Number.isSafeInteger(row.pv + row.history_pv) || row.pv < row.uv || row.uv < 0) ||
        stats.reduce((sum, row) => sum + row.uv, 0) !== memberships) throw new Error('Backup statistics failed consistency checks.');
    verifyCounterWrites(db);
    return { tables: 5, sites: stats.length, pv: stats.reduce((sum, row) => sum + row.pv + row.history_pv, 0),
      uv: memberships };
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(verifyBackup(process.argv[2]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
