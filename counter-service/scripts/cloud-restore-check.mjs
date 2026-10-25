import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, requireLocalConfig, runWrangler, parseJsonOutput, fail } from './common.mjs';
import { validateSnapshot, sha256, TABLES } from '../maintenance/src/snapshot.js';
import { verifyBackup } from './verify-backup.mjs';

function quote(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string') return "'" + value.replaceAll("'", "''") + "'";
  throw new Error('Unsupported snapshot SQL value.');
}
function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('Unsupported snapshot identifier.');
  return '"' + value + '"';
}
export async function snapshotToSql(snapshot) {
  await validateSnapshot(snapshot);
  const sql = ['-- Private cloud snapshot. Restore into a NEW database, then verify before switching bindings.'];
  for (const item of snapshot.schema.filter(s => s.type === 'table')) sql.push(item.sql + ';');
  for (const table of TABLES) for (const row of snapshot.tables[table]) {
    const columns = Object.keys(row);
    sql.push(`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(',')}) VALUES (${columns.map(c => quote(row[c])).join(',')});`);
  }
  // Data is loaded before triggers to avoid counting the restored visits again.
  for (const item of snapshot.schema.filter(s => s.type !== 'table')) sql.push(item.sql + ';');
  // Only 0001 is supported by the version-1 snapshot validator. Rebuild Wrangler
  // migration bookkeeping so subsequent setup does not apply that schema twice.
  sql.push('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);');
  sql.push(`INSERT INTO d1_migrations(id,name,applied_at) VALUES(1,'0001_counter.sql',${quote(snapshot.created_at)});`);
  return sql.join('\n') + '\n';
}
export async function downloadAndVerifyCloudSnapshot() {
  const main = requireLocalConfig();
  const configPath = path.join(root, 'maintenance/wrangler.local.json');
  const config = readJson(configPath);
  if (config.account_id !== main.account_id || config.d1_databases.find(d => d.binding === 'SOURCE_DB')?.database_id !== main.d1_databases.find(d => d.binding === 'DB')?.database_id) throw new Error('Cloud archive belongs to a different counter.');
  const query = sql => {
    const result = parseJsonOutput(runWrangler(['d1', 'execute', 'ARCHIVE_DB', '--remote', '--json', '--config', configPath, '--command', sql], { quiet: true }));
    if (!Array.isArray(result) || result[0]?.success !== true || !Array.isArray(result[0].results)) throw new Error('Archive query did not return verified results.');
    return result[0].results;
  };
  const meta = query("SELECT snapshot_id,created_at,sha256,json_bytes,chunk_count FROM snapshots WHERE status='complete' ORDER BY day DESC LIMIT 1")[0];
  if (!meta) throw new Error('No complete cloud snapshot is available.');
  const chunks = query(`SELECT chunk_index,content FROM snapshot_chunks WHERE snapshot_id=${quote(meta.snapshot_id)} ORDER BY chunk_index`);
  if (chunks.length !== meta.chunk_count || chunks.some((c,i) => c.chunk_index !== i)) throw new Error('Cloud snapshot has missing or reordered chunks.');
  const json = chunks.map(c => c.content).join('');
  if (Buffer.byteLength(json) !== meta.json_bytes || await sha256(json) !== meta.sha256) throw new Error('Cloud snapshot checksum verification failed.');
  const snapshot = JSON.parse(json);
  const sql = await snapshotToSql(snapshot);
  const directory = path.join(root, 'private-backups');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stem = path.join(directory, 'cloud-' + new Date(meta.created_at).toISOString().replace(/[:.]/g,'-'));
  writeFileSync(stem + '.json', json, { mode: 0o600 });
  writeFileSync(stem + '.sql', sql, { mode: 0o600 });
  const restored = verifyBackup(stem + '.sql');
  writeFileSync(stem + '.verified.json', JSON.stringify({ verified_at: new Date().toISOString(), snapshot_id: meta.snapshot_id, sha256: meta.sha256, restored }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, restored, created_at: meta.created_at }));
  return { restored, snapshot };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await downloadAndVerifyCloudSnapshot(); } catch (error) { fail(error); }
}
