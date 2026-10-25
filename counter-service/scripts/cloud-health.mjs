import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_API = 'https://rui-chen-homepage-counter.cr20010218.workers.dev';
const DEFAULT_MAINTENANCE = 'https://rui-chen-counter-maintenance.cr20010218.workers.dev';
const REQUEST_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 10000;
const MAX_ATTEMPTS = 3;
const CHECK_MAX_AGE_MS = 45 * 60 * 1000;
const BACKUP_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const FUTURE_CLOCK_GRACE_MS = 5 * 60 * 1000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const validTime = value => typeof value === 'string' && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));

class CloudHealthError extends Error {}

function apiOrigin(value, label, allowLocalhost) {
  try {
    const url = new URL(value);
    const localDev = allowLocalhost && url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!localDev && url.protocol !== 'https:') || url.username || url.password ||
        url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch (_) {
    // Configuration may contain credentials by mistake. Never echo the URL.
    throw new CloudHealthError(`Invalid ${label} API base configuration.`);
  }
}

export function readCloudConfig(env = process.env) {
  const allowLocalhost = env.COUNTER_HEALTH_ALLOW_LOCALHOST === 'true';
  return {
    api: apiOrigin(env.COUNTER_API_BASE || DEFAULT_API, 'counter', allowLocalhost),
    maintenance: apiOrigin(env.COUNTER_MAINTENANCE_API_BASE || DEFAULT_MAINTENANCE, 'maintenance', allowLocalhost),
  };
}

function validateStats(data) {
  if (!data || !['pv', 'uv'].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0) ||
      !['counting_since', 'uv_counting_since', 'as_of'].every(key => validTime(data[key])) ||
      typeof data.epoch !== 'string' || !data.epoch) {
    throw new CloudHealthError('Counter statistics response is invalid.');
  }
}

function validateFreshness(value, maximumAge, now, label) {
  if (!validTime(value)) throw new CloudHealthError(`Maintenance ${label} timestamp is missing or invalid.`);
  const age = now - Date.parse(value);
  if (age < -FUTURE_CLOCK_GRACE_MS || age >= maximumAge) {
    throw new CloudHealthError(`Maintenance ${label} timestamp is stale or implausibly in the future.`);
  }
}

export async function checkCloudHealth({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  wait = sleep,
  timeoutSignal = ms => AbortSignal.timeout(ms),
  onRetry = () => {},
} = {}) {
  const config = readCloudConfig(env);

  async function getJson(base, route, label) {
    try {
      const response = await fetchImpl(base + route, {
        method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: timeoutSignal(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const status = Number.isInteger(response.status) ? response.status : 'error';
        throw new CloudHealthError(`${label} returned HTTP ${status}.`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof CloudHealthError) throw error;
      // Native errors and remote response bodies can expose URLs/credentials.
      throw new CloudHealthError(`${label} request failed (network, timeout, or invalid JSON).`);
    }
  }

  let failure;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const [health, stats, maintenance] = await Promise.all([
        getJson(config.api, '/health', 'Counter health'),
        getJson(config.api, '/v1/stats', 'Counter statistics'),
        getJson(config.maintenance, '/health', 'Maintenance health'),
      ]);
      if (health?.ok !== true) throw new CloudHealthError('Counter health response is not ready.');
      validateStats(stats);
      if (maintenance?.ok !== true) throw new CloudHealthError('Maintenance health response is not ready.');
      const checkedAt = now();
      validateFreshness(maintenance.last_check_at, CHECK_MAX_AGE_MS, checkedAt, 'last check');
      validateFreshness(maintenance.last_backup_at, BACKUP_MAX_AGE_MS, checkedAt, 'last backup');
      return { attempts: attempt, pv: stats.pv, uv: stats.uv,
        last_check_at: maintenance.last_check_at, last_backup_at: maintenance.last_backup_at };
    } catch (error) {
      failure = error;
      if (attempt < MAX_ATTEMPTS) {
        onRetry(attempt);
        await wait(RETRY_DELAY_MS);
      }
    }
  }
  throw new CloudHealthError(`Cloud checks failed after ${MAX_ATTEMPTS} attempts: ${failure.message}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkCloudHealth({ onRetry: attempt => console.error(`Cloud health check ${attempt}/${MAX_ATTEMPTS} failed; retrying in 10 seconds.`) });
    console.log('Counter API, statistics, maintenance checks, and backup freshness passed. No visits were recorded.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
