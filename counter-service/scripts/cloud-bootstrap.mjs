import { readFileSync } from 'node:fs';
import path from 'node:path';
import { root, readJson, writePrivateJson, requireLocalConfig, validApiBase, fail } from './common.mjs';

try {
  const main = requireLocalConfig();
  const manifestPath = path.join(root, 'maintenance/deployment.local.json');
  const manifest = readJson(manifestPath);
  if (manifest.account_id !== main.account_id || manifest.source_database_id !== main.d1_databases.find(d => d.binding === 'DB')?.database_id) throw new Error('Cloud maintenance belongs to a different counter setup.');
  const base = validApiBase(manifest.apiBase);
  const secret = readFileSync(path.join(root, 'private-secrets/maintenance-secret.txt'), 'utf8').trim();
  if (secret.length < 32) throw new Error('Invalid private maintenance secret.');
  const response = await fetch(base + '/admin/run', {
    method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup: true }), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('Cloud bootstrap did not pass (HTTP ' + response.status + ').');
  const healthResponse = await fetch(base + '/health', { signal: AbortSignal.timeout(15000), cache: 'no-store' });
  const health = await healthResponse.json();
  if (!healthResponse.ok || health.ok !== true || !Number.isFinite(Date.parse(health.last_check_at)) || !Number.isFinite(Date.parse(health.last_backup_at))) throw new Error('The cloud check and backup did not pass readiness.');
  writePrivateJson(manifestPath, { ...manifest, bootstrap_verified_at: new Date().toISOString() });
  console.log(JSON.stringify({ ok: true, last_check_at: health.last_check_at, last_backup_at: health.last_backup_at }));
} catch (error) { fail(error); }
