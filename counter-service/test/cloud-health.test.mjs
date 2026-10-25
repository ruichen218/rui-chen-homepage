import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCloudHealth, readCloudConfig } from '../scripts/cloud-health.mjs';

const NOW = Date.parse('2026-10-25T22:00:00.000Z');
const stats = { pv: 10, uv: 2, counting_since: '2026-10-25T00:00:00.000Z',
  uv_counting_since: '2026-10-25T20:32:19.345Z', as_of: new Date(NOW).toISOString(), epoch: 'test-epoch' };
const maintenance = () => ({ ok: true, last_check_at: new Date(NOW - 15 * 60000).toISOString(),
  last_backup_at: new Date(NOW - 24 * 3600000).toISOString() });
const response = value => ({ ok: true, async json() { return value; } });
const bodyFor = url => url.includes('maintenance') ? maintenance() : url.endsWith('/v1/stats') ? stats : { ok: true };

test('public checks make exactly three read-only GETs without authentication', async () => {
  const requests = [];
  const result = await checkCloudHealth({ env: {}, now: () => NOW,
    fetchImpl: async (url, init) => { requests.push({ url, init }); return response(bodyFor(url)); },
    wait: async () => { assert.fail('Healthy checks must not retry'); },
  });
  assert.equal(result.attempts, 1);
  assert.deepEqual(requests.map(item => item.url).sort(), [
    'https://rui-chen-homepage-counter.cr20010218.workers.dev/health',
    'https://rui-chen-homepage-counter.cr20010218.workers.dev/v1/stats',
    'https://rui-chen-counter-maintenance.cr20010218.workers.dev/health',
  ].sort());
  for (const { init } of requests) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, undefined);
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test('transient failures retry whole checks with ten-second spacing and recover', async () => {
  const waits = [];
  let checks = 0;
  const result = await checkCloudHealth({ env: {}, now: () => NOW,
    fetchImpl: async url => {
      if (url.includes('maintenance')) {
        checks++;
        if (checks < 3) return { ok: false, status: 503 };
      }
      return response(bodyFor(url));
    },
    wait: async ms => { waits.push(ms); },
  });
  assert.equal(result.attempts, 3);
  assert.deepEqual(waits, [10000, 10000]);
});

test('stale, missing, and future maintenance timestamps fail after three attempts', async () => {
  const scenarios = [
    { last_check_at: new Date(NOW - 45 * 60000).toISOString() },
    { last_backup_at: new Date(NOW - 36 * 3600000).toISOString() },
    { last_backup_at: null },
    { last_check_at: new Date(NOW + 24 * 3600000).toISOString() },
  ];
  for (const change of scenarios) {
    const waits = [];
    let requests = 0;
    await assert.rejects(checkCloudHealth({ env: {}, now: () => NOW,
      fetchImpl: async url => { requests++; return response(url.includes('maintenance') ? { ...maintenance(), ...change } : bodyFor(url)); },
      wait: async ms => { waits.push(ms); },
    }), /failed after 3 attempts: Maintenance/);
    assert.equal(requests, 9);
    assert.deepEqual(waits, [10000, 10000]);
  }
});

test('eight-second timeout signals abort without leaking native error details', async () => {
  const timeouts = [];
  let waits = 0;
  await assert.rejects(checkCloudHealth({ env: {}, now: () => NOW,
    timeoutSignal: ms => {
      timeouts.push(ms);
      const controller = new AbortController();
      queueMicrotask(() => controller.abort());
      return controller.signal;
    },
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('secret URL / access credential')), { once: true });
    }),
    wait: async ms => { waits++; assert.equal(ms, 10000); },
  }), error => {
    assert.match(error.message, /failed after 3 attempts/);
    assert.doesNotMatch(error.message, /secret URL|access credential/);
    return true;
  });
  assert.deepEqual(timeouts, Array(9).fill(8000));
  assert.equal(waits, 2);
});

test('URL overrides require HTTPS or explicitly enabled loopback development', () => {
  for (const value of ['http://localhost:8787', 'http://example.com', 'https://user:secret@example.com', 'https://example.com?token=secret']) {
    assert.throws(() => readCloudConfig({ COUNTER_API_BASE: value }), error => {
      assert.equal(error.message, 'Invalid counter API base configuration.');
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  }
  const local = readCloudConfig({ COUNTER_HEALTH_ALLOW_LOCALHOST: 'true',
    COUNTER_API_BASE: 'http://localhost:8787', COUNTER_MAINTENANCE_API_BASE: 'http://127.0.0.1:8788' });
  assert.deepEqual(local, { api: 'http://localhost:8787', maintenance: 'http://127.0.0.1:8788' });
  assert.throws(() => readCloudConfig({ COUNTER_HEALTH_ALLOW_LOCALHOST: 'true', COUNTER_API_BASE: 'http://example.com' }));
});
