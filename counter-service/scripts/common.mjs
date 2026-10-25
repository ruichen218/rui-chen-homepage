import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const localConfig = path.join(root, 'wrangler.local.json');
export const deploymentFile = path.join(root, 'deployment.local.json');

export function runWrangler(args, { input, quiet = false, allowFailure = false } = {}) {
  const cli = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: 'utf8', input,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG_PATH: path.join(root, '.wrangler/logs') },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0 && !allowFailure) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`Wrangler command failed: ${args.slice(0, 3).join(' ')}`);
  }
  return result.stdout || '';
}

export function parseJsonOutput(output) {
  const text = output.trim();
  try { return JSON.parse(text); } catch (_) { /* Older CLI versions print a banner. */ }
  for (let index = 0; index < text.length; index++) {
    if (!['{', '['].includes(text[index])) continue;
    try { return JSON.parse(text.slice(index)); } catch (_) { /* Continue to JSON body. */ }
  }
  throw new Error('The deployment tool did not return valid JSON.');
}

export function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
export function writePrivateJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}
export function requireLocalConfig() {
  if (!existsSync(localConfig)) throw new Error('Run npm run setup after logging in to Cloudflare.');
  const config = readJson(localConfig);
  if (!/^[0-9a-f]{32}$/i.test(config.account_id || '')) throw new Error('The local configuration has no pinned Cloudflare account. Run setup after login.');
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== config.account_id) {
    throw new Error('The Cloudflare account differs from the saved deployment; no operation was performed.');
  }
  const db = config.d1_databases?.find(item => item.binding === 'DB');
  if (!db || !/^[0-9a-f-]{36}$/i.test(db.database_id) || /^0+-0+-0+-0+-0+$/.test(db.database_id)) {
    throw new Error('The local deployment has no real D1 database binding.');
  }
  return config;
}
export function validStats(data) {
  return data && ['pv', 'uv'].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0) &&
    ['counting_since', 'uv_counting_since', 'as_of'].every(key => Number.isFinite(Date.parse(data[key]))) &&
    typeof data.epoch === 'string' && data.epoch.length > 0;
}
export function validApiBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('The production API must be an HTTPS origin without credentials or a path.');
  }
  return url.origin;
}
export async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
  if (!response.ok) throw new Error(`Request returned HTTP ${response.status}.`);
  return response.json();
}
export function fail(error) { console.error(error.message); process.exitCode = 1; }
