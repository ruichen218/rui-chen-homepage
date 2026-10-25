import { createSnapshot, encodeSnapshot } from './snapshot.js';

const DEFAULT_MAIN_API = 'https://rui-chen-homepage-counter.cr20010218.workers.dev';
const CHECK_STALE_MS = 45 * 60000;
const BACKUP_STALE_MS = 36 * 3600000;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const safeError = () => new Error('maintenance_unavailable');

function mainBase(env) {
  const value = env.MAIN_API_BASE || DEFAULT_MAIN_API;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw safeError();
  return url.origin;
}

async function fetchJson(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // Workers supports manual/follow; redirect:error throws before sending.
    // Manual keeps a redirect visible so response.ok rejects it below.
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal, redirect: 'manual', cache: 'no-store' });
    if (!response.ok || Number(response.headers.get('Content-Length') || 0) > 4096) throw safeError();
    const reader = response.body?.getReader();
    if (!reader) throw safeError();
    let size = 0;
    const bytes = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw safeError(); }
      bytes.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const part of bytes) { body.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } finally { clearTimeout(timer); }
}

function validStats(stats) {
  return stats && Number.isSafeInteger(stats.pv) && stats.pv >= 0 && Number.isSafeInteger(stats.uv) &&
    stats.uv >= 0 && stats.uv <= stats.pv && typeof stats.epoch === 'string' && stats.epoch.length > 0 &&
    ['counting_since', 'uv_counting_since', 'as_of'].every(key => typeof stats[key] === 'string' && Number.isFinite(Date.parse(stats[key])));
}

async function state(db) {
  const row = await db.prepare('SELECT last_check_at,last_check_ok,consecutive_failures,last_backup_at,last_backup_ok FROM maintenance_state WHERE id=1').first();
  if (!row) throw safeError();
  return row;
}

function status(row, now) {
  const current = now.getTime();
  const fresh = (value, limit) => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    current >= Date.parse(value) - 60000 && current - Date.parse(value) <= limit;
  return {
    ok: row.last_check_ok === 1 && row.last_backup_ok === 1 && fresh(row.last_check_at, CHECK_STALE_MS) && fresh(row.last_backup_at, BACKUP_STALE_MS),
    last_check_at: row.last_check_at,
    last_backup_at: row.last_backup_at,
  };
}

async function checkMain(env, now, fetchImpl) {
  let ok = false;
  try {
    const base = mainBase(env);
    // Same-account workers.dev Workers communicate through a service binding.
    // This keeps probes in Cloudflare without attempting a disallowed public
    // Worker-to-Worker subrequest; the independent GitHub probe checks public TLS.
    const fetchMain = env.COUNTER_SERVICE?.fetch ?
      (url, init) => env.COUNTER_SERVICE.fetch(new Request(url, init)) : fetchImpl;
    const [health, stats] = await Promise.all([fetchJson(fetchMain, base + '/health'), fetchJson(fetchMain, base + '/v1/stats')]);
    ok = health?.ok === true && validStats(stats);
  } catch { /* Save only a boolean; response bodies and errors are not logged. */ }
  await env.ARCHIVE_DB.batch([env.ARCHIVE_DB.prepare(`UPDATE maintenance_state SET last_check_at=?,last_check_ok=?,
    consecutive_failures=CASE WHEN ?=1 THEN 0 ELSE consecutive_failures+1 END WHERE id=1`).bind(now, ok ? 1 : 0, ok ? 1 : 0)]);
  return ok;
}

async function backup(env, stamp, sourceKind) {
  const date = stamp.slice(0, 10);
  const existing = await env.ARCHIVE_DB.prepare("SELECT snapshot_id FROM snapshots WHERE day=? AND status='complete'").bind(date).first();
  if (existing) {
    // A replay may follow a previous temporary failure. The complete snapshot
    // is immutable and remains the day's first successful copy.
    await env.ARCHIVE_DB.batch([env.ARCHIVE_DB.prepare(`UPDATE maintenance_state SET last_backup_at=
      (SELECT created_at FROM snapshots WHERE snapshot_id=?),last_backup_ok=1 WHERE id=1`).bind(existing.snapshot_id)]);
    return;
  }
  const snapshot = await createSnapshot(env.SOURCE_DB, stamp);
  const encoded = await encodeSnapshot(snapshot);
  const id = crypto.randomUUID();
  const statements = [env.ARCHIVE_DB.prepare(`INSERT INTO snapshots
    (snapshot_id,day,created_at,sha256,json_bytes,chunk_count,source_kind,status) VALUES(?,?,?,?,?,?,?,'complete')
    ON CONFLICT(day) DO NOTHING`).bind(id, date, stamp, encoded.sha256, encoded.json_bytes, encoded.chunks.length, sourceKind)];
  // The WHERE guards make a concurrent second run an entirely harmless no-op:
  // it cannot attach chunks to the winning run's snapshot or replace its bytes.
  for (let index = 0; index < encoded.chunks.length; index++) {
    statements.push(env.ARCHIVE_DB.prepare(`INSERT INTO snapshot_chunks(snapshot_id,chunk_index,content)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM snapshots WHERE snapshot_id=?)`).bind(id, index, encoded.chunks[index], id));
  }
  statements.push(env.ARCHIVE_DB.prepare(`UPDATE maintenance_state SET last_backup_at=
    (SELECT created_at FROM snapshots WHERE day=? AND status='complete'),last_backup_ok=1 WHERE id=1`).bind(date));
  statements.push(env.ARCHIVE_DB.prepare(`DELETE FROM snapshot_chunks WHERE snapshot_id IN
    (SELECT snapshot_id FROM snapshots WHERE source_kind IN ('scheduled','bootstrap')
      ORDER BY day DESC LIMIT -1 OFFSET 30)`));
  statements.push(env.ARCHIVE_DB.prepare(`DELETE FROM snapshots WHERE snapshot_id IN
    (SELECT snapshot_id FROM snapshots WHERE source_kind IN ('scheduled','bootstrap')
      ORDER BY day DESC LIMIT -1 OFFSET 30)`));
  const result = await env.ARCHIVE_DB.batch(statements);
  if (result.some(item => !item.success)) throw safeError();
}

async function authorized(request, env) {
  const secret = env.MAINTENANCE_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256) return false;
  const header = request.headers.get('Authorization') || '';
  if (header.length > 300 || !header.startsWith('Bearer ')) return false;
  const encode = new TextEncoder();
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(secret)));
  const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(header.slice(7))));
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ actual[index];
  return difference === 0;
}

export function createMaintenanceWorker({ now = () => new Date(), fetchImpl = (...args) => fetch(...args) } = {}) {
  async function run(env, bootstrap = false) {
    const clock = now();
    const stamp = clock.toISOString();
    let checkOk = false;
    let backupOk = true;
    // These paths are independent: a failed API probe must not prevent a D1
    // snapshot, and a failed snapshot must not erase a successful API probe.
    try { checkOk = await checkMain(env, stamp, fetchImpl); } catch { checkOk = false; }
    const minute = clock.getUTCHours() * 60 + clock.getUTCMinutes();
    let firstBackup = false;
    try { firstBackup = !(await state(env.ARCHIVE_DB)).last_backup_at; } catch { /* The backup path also validates availability. */ }
    if (bootstrap || firstBackup || minute >= 4 * 60 + 41) {
      try { await backup(env, stamp, bootstrap ? 'bootstrap' : 'scheduled'); }
      catch {
        backupOk = false;
        try { await env.ARCHIVE_DB.batch([env.ARCHIVE_DB.prepare('UPDATE maintenance_state SET last_backup_ok=0 WHERE id=1')]); } catch { /* Safe failure, preserving previous snapshots. */ }
      }
    }
    const result = status(await state(env.ARCHIVE_DB), clock);
    return { result, success: checkOk && backupOk && result.ok };
  }
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/health') {
        if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
        try { const result = status(await state(env.ARCHIVE_DB), now()); return reply(result, result.ok ? 200 : 503); }
        catch { return reply({ ok: false, last_check_at: null, last_backup_at: null }, 503); }
      }
      if (url.pathname !== '/admin/run') return reply({ error: 'not_found' }, 404);
      if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
      if (!(await authorized(request, env))) return reply({ error: 'unauthorized' }, 401);
      if (url.search || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '') ||
          Number(request.headers.get('Content-Length') || 0) > 128) return reply({ error: 'invalid_request' }, 400);
      try {
        const reader = request.body?.getReader();
        if (!reader) return reply({ error: 'invalid_request' }, 400);
        let size = 0;
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 128) { await reader.cancel(); return reply({ error: 'invalid_request' }, 400); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!body || Object.keys(body).join(',') !== 'backup' || body.backup !== true) return reply({ error: 'invalid_request' }, 400);
      } catch { return reply({ error: 'invalid_request' }, 400); }
      try { const { result, success } = await run(env, true); return reply(result, success ? 200 : 503); }
      catch { return reply({ ok: false, last_check_at: null, last_backup_at: null }, 503); }
    },
    async scheduled(_controller, env) {
      const { success } = await run(env);
      if (!success) throw safeError();
    },
  };
}

export default createMaintenanceWorker();
