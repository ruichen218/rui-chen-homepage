import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import '../../assets/counter.js';

const { createCounter, createIndexedStore, createMemoryStore, createDomRenderer,
  startBrowser, startLegacy, validConfig } = globalThis.RuiCounter;
const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const snapshot = (pv = 10, uv = 5, extra = {}) => ({
  pv, uv, counting_since: '2026-10-25T00:00:00.000Z',
  uv_counting_since: '2026-10-25T00:00:00.000Z', as_of: new Date(NOW).toISOString(),
  epoch: 'test-epoch', ...extra,
});
const response = body => ({ ok: true, async json() { return body; } });
const rejected = (status, error) => ({ ok: false, status, async json() { return { error }; } });
const tick = () => new Promise(resolve => setImmediate(resolve));

function clock() {
  let next = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async run(delay) {
      const found = [...timers].find(([, item]) => item.delay === delay);
      assert.ok(found, `Expected a timer with delay ${delay}`);
      timers.delete(found[0]);
      await found[1].fn();
      await tick();
    },
  };
}

function harness(overrides = {}) {
  const states = [];
  const timers = clock();
  const options = {
    apiBase: 'https://counter.example', store: createMemoryStore(),
    now: () => NOW, uuid: randomUUID, isOnline: () => true,
    render: value => states.push(structuredClone(value)),
    fetch: async () => response(snapshot()),
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    ...overrides,
  };
  return { counter: createCounter(options), options, states, timers };
}

test('first-ever concurrent tabs atomically share one durable visitor identity', async () => {
  const indexedDB = new IDBFactory();
  const stores = [0, 1].map(() => createIndexedStore(indexedDB, { uuid: randomUUID }));
  const events = [0, 1].map(() => ({ event_id: randomUUID(), created_at: new Date(NOW).toISOString(), path: '/rui-chen-homepage/' }));
  const results = await Promise.all(stores.map((store, i) => store.enqueue(events[i], NOW)));
  assert.equal(results[0].visitor_id, results[1].visitor_id);
  assert.match(results[0].visitor_id, /^[0-9a-f-]{36}$/);
  assert.equal((await stores[0].list(NOW)).length, 2);
});

test('a lost successful POST reply retries exactly the same event without incrementing twice', async () => {
  const store = createMemoryStore();
  const accepted = new Set();
  const submitted = [];
  let lost = false;
  const h = harness({ store, fetch: async (url, init) => {
    if (url.endsWith('/v1/stats')) return response(snapshot(accepted.size, 0));
    const visit = JSON.parse(init.body);
    submitted.push(visit);
    accepted.add(visit.event_id);
    if (!lost) { lost = true; throw new Error('Response was lost after commit'); }
    return response(snapshot(accepted.size, 0, { duplicate: true }));
  } });
  await h.counter.start();
  assert.equal((await store.list(NOW)).length, 1);
  await h.timers.run(1000);
  await h.counter.flush();
  assert.equal(submitted.length, 2);
  assert.deepEqual(submitted[0], submitted[1]);
  assert.equal(accepted.size, 1);
  assert.equal((await store.list(NOW)).length, 0);
  assert.equal(h.states.at(-1).snapshot.pv, 1);
  assert.equal(h.states.at(-1).status, 'fresh');
});

test('offline document reloads queue distinct PV events and flush safely after reconnect', async () => {
  const indexedDB = new IDBFactory();
  const store = createIndexedStore(indexedDB, { uuid: randomUUID });
  let online = false;
  const posted = [];
  let requests = 0;
  const fetch = async (url, init) => {
    requests++;
    if (url.endsWith('/v1/visits')) posted.push(JSON.parse(init.body));
    return response(snapshot(posted.length, posted.length ? 1 : 0));
  };
  const first = harness({ store, fetch, isOnline: () => online });
  const second = harness({ store, fetch, isOnline: () => online });
  await first.counter.start();
  await second.counter.start();
  assert.equal(requests, 0);
  assert.equal((await store.list(NOW)).length, 2);
  online = true;
  await first.counter.online();
  await second.counter.online();
  assert.equal(posted.length, 2);
  assert.notEqual(posted[0].event_id, posted[1].event_id);
  assert.equal(posted[0].visitor_id, posted[1].visitor_id);
  assert.equal((await store.list(NOW)).length, 0);
  // Repeated start/online calls (including a restored document) add no visit.
  await first.counter.start();
  await first.counter.online();
  assert.equal(posted.length, 2);
});

test('outages show only cached confirmed totals and stop after bounded retries', async () => {
  const store = createMemoryStore();
  const cached = snapshot(987, 123);
  await store.writeSnapshot(cached);
  let attempts = 0;
  const h = harness({ store, fetch: async (url) => {
    if (url.endsWith('/v1/visits')) attempts++;
    throw new Error('Service unavailable');
  } });
  await h.counter.start();
  for (const delay of [1000, 5000]) await h.timers.run(delay);
  assert.equal(attempts, 3);
  assert.equal(h.timers.timers.size, 0);
  assert.equal((await store.list(NOW)).length, 1);
  assert.equal(h.states.at(-1).status, 'cached');
  assert.deepEqual(h.states.at(-1).snapshot, cached);
  assert.ok(h.states.every(state => !state.snapshot || state.snapshot.pv === 987));
});

test('requests abort on timeout, retain queued event, and show unavailable without fake zero', async () => {
  const store = createMemoryStore();
  let active = 0;
  const h = harness({ store, fetch: async (_url, init) => {
    active++;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  } });
  const started = h.counter.start();
  await tick();
  assert.equal(active, 2);
  await h.timers.run(10000);
  await h.timers.run(10000);
  await started;
  assert.equal((await store.list(NOW)).length, 1);
  assert.equal(h.states.at(-1).status, 'unavailable');
  assert.equal(h.states.at(-1).snapshot, null);
});

for (const status of [400, 413]) {
  test(`a terminal ${status} event cannot block later valid visits`, async () => {
    const store = createMemoryStore();
    const badId = randomUUID();
    await store.enqueue({ event_id: badId, created_at: new Date(NOW - 1000).toISOString(), path: '/invalid' }, NOW);
    const submitted = [];
    const h = harness({ store, fetch: async (url, init) => {
      if (url.endsWith('/v1/stats')) return response(snapshot(10, 5));
      const visit = JSON.parse(init.body);
      submitted.push(visit);
      if (visit.event_id === badId) return rejected(status, 'invalid_event_time');
      return response(snapshot(11, 5));
    } });
    await h.counter.start();
    assert.equal(submitted.length, 2);
    assert.equal(submitted[0].event_id, badId);
    assert.equal(submitted[1].path, '/rui-chen-homepage/');
    assert.equal((await store.list(NOW)).length, 0);
    assert.equal(h.timers.timers.size, 0);
    assert.equal(h.states.at(-1).snapshot.pv, 11);
    assert.equal(h.states.at(-1).status, 'fresh');
  });
}

test('permanent origin configuration errors retain events without automatic retries', async () => {
  const store = createMemoryStore();
  let attempts = 0;
  const h = harness({ store, fetch: async (url) => {
    if (url.endsWith('/v1/visits')) attempts++;
    return rejected(403, 'forbidden_origin');
  } });
  await h.counter.start();
  assert.equal(attempts, 1);
  assert.equal((await store.list(NOW)).length, 1);
  assert.equal(h.timers.timers.size, 0);
  assert.equal(h.states.at(-1).status, 'unavailable');
});

for (const status of [429, 503]) {
  test(`HTTP ${status} remains retriable with the same event identity`, async () => {
    const submitted = [];
    const h = harness({ fetch: async (url, init) => {
      if (url.endsWith('/v1/stats')) return response(snapshot());
      submitted.push(JSON.parse(init.body));
      return submitted.length === 1 ? rejected(status, 'service_unavailable') : response(snapshot(11, 5));
    } });
    await h.counter.start();
    await h.timers.run(1000);
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted[0], submitted[1]);
    assert.equal(h.states.at(-1).status, 'fresh');
    assert.equal(h.timers.timers.size, 0);
  });
}

test('blocked IndexedDB falls back to in-memory PV with visitor_id null', async () => {
  const blockedDB = { open() {
    const request = {};
    queueMicrotask(() => request.onblocked());
    return request;
  } };
  let visit;
  const h = harness({
    store: createIndexedStore(blockedDB, { uuid: randomUUID }),
    fetch: async (url, init) => {
      if (url.endsWith('/v1/visits')) visit = JSON.parse(init.body);
      return response(snapshot(1, 0));
    },
  });
  await h.counter.start();
  assert.equal(visit.visitor_id, null);
  assert.equal(visit.path, '/rui-chen-homepage/');
  assert.equal(h.states.at(-1).status, 'fresh');
});

test('durable queue expires seven-day records and retains at most 100 visits', async () => {
  const store = createIndexedStore(new IDBFactory(), { uuid: randomUUID });
  const visit = (createdAt) => ({ event_id: randomUUID(), created_at: new Date(createdAt).toISOString(), path: '/rui-chen-homepage/' });
  const old = visit(NOW - 8 * 24 * 60 * 60 * 1000);
  await store.enqueue(old, NOW - 8 * 24 * 60 * 60 * 1000);
  for (let i = 0; i < 103; i++) await store.enqueue(visit(NOW + i), NOW + i);
  const pending = await store.list(NOW + 103);
  assert.equal(pending.length, 100);
  assert.ok(pending.every(item => item.event_id !== old.event_id));
  assert.equal(Date.parse(pending[0].created_at), NOW + 3);
});

test('late GET replies cannot replace newer POST totals', async () => {
  let releaseGET;
  const h = harness({ fetch: async (url) => {
    if (url.endsWith('/v1/stats')) return new Promise(resolve => { releaseGET = () => resolve(response(snapshot(9, 4))); });
    return response(snapshot(10, 5, { as_of: new Date(NOW + 1).toISOString() }));
  } });
  const started = h.counter.start();
  await tick();
  releaseGET();
  await started;
  assert.equal(h.states.at(-1).snapshot.pv, 10);
  assert.equal(h.states.at(-1).snapshot.uv, 5);
});

test('an older tab cannot overwrite a newer durable cache snapshot', async () => {
  const indexedDB = new IDBFactory();
  const first = createIndexedStore(indexedDB, { uuid: randomUUID });
  const second = createIndexedStore(indexedDB, { uuid: randomUUID });
  const newer = snapshot(20, 8, { as_of: new Date(NOW + 2000).toISOString() });
  await first.writeSnapshot(newer);
  await second.writeSnapshot(snapshot(19, 7));
  assert.deepEqual(await first.readSnapshot(), newer);
  // A deliberately changed database epoch may legitimately reset totals.
  const reset = snapshot(1, 1, { epoch: 'replacement-database', as_of: new Date(NOW + 3000).toISOString() });
  await second.writeSnapshot(reset);
  assert.deepEqual(await first.readSnapshot(), reset);
});

test('cached status, distinct PV/UV start dates, and browser UV caveat follow language', () => {
  const nodes = new Map();
  const document = {
    documentElement: { lang: 'en' },
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { hidden: true, textContent: '', title: '' });
      return nodes.get(selector);
    },
  };
  const render = createDomRenderer(document, '2026-10-25');
  render({ status: 'cached', snapshot: snapshot(1200, 44, { counting_since: '2026-10-01T00:00:00.000Z' }) });
  assert.equal(nodes.get('#homepage-views-value').textContent, '1,200');
  assert.equal(nodes.get('#homepage-counter-cached').hidden, false);
  assert.match(nodes.get('#homepage-counter-cached').textContent, /Last confirmed:/);
  assert.equal(nodes.get('#homepage-counter-note').textContent, 'Views since 2026-10-01; visitors since 2026-10-25');
  document.documentElement.lang = 'zh-CN';
  render();
  assert.match(nodes.get('#homepage-counter-cached').textContent, /上次确认/);
  assert.match(nodes.get('#homepage-counter-note').textContent, /浏览量自 2026-10-01 起；访客数自 2026-10-25 起/);
  assert.match(nodes.get('#homepage-uv').title, /浏览器/);
  assert.equal(nodes.get('#homepage-counter-error').hidden, true);
});

test('production guard prevents analytics requests from local and unrelated pages', () => {
  for (const location of [
    { protocol: 'http:', hostname: 'localhost', pathname: '/rui-chen-homepage/' },
    { protocol: 'https:', hostname: 'ruichen218.github.io', pathname: '/another-project/' },
    { protocol: 'https:', hostname: 'preview.example', pathname: '/rui-chen-homepage/' },
  ]) {
    assert.equal(startBrowser({ location, fetch() { throw new Error('Must not fetch'); } }), null);
  }
});

test('repeated initialization in the same document cannot submit an extra visit', async () => {
  const nodes = new Map();
  let posts = 0;
  const window = {
    location: { protocol: 'https:', hostname: 'ruichen218.github.io', pathname: '/rui-chen-homepage/' },
    RuiCounterConfig: { provider: 'self-hosted', apiBase: 'https://counter.example', countingSince: '2026-10-25' },
    navigator: { onLine: true }, indexedDB: new IDBFactory(), crypto: { randomUUID },
    document: {
      documentElement: { lang: 'en' },
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, { hidden: true, textContent: '', title: '' });
        return nodes.get(selector);
      },
    },
    MutationObserver: class { observe() {} },
    addEventListener(name) { assert.equal(name, 'online'); },
    async fetch(url) {
      if (url.endsWith('/v1/visits')) posts++;
      return response(snapshot(11, 5));
    },
  };
  const first = startBrowser(window);
  const second = startBrowser(window);
  assert.equal(first, second);
  await first.start();
  await first.flush();
  assert.equal(posts, 1);
});

test('legacy UV tooltip describes provider deduplication without inventing browser identity semantics', () => {
  const nodes = new Map();
  const document = {
    documentElement: { lang: 'en' },
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { hidden: true, textContent: '', title: '' });
      return nodes.get(selector);
    },
  };
  const render = createDomRenderer(document, '2026-10-25', 'busuanzi');
  render({ status: 'fresh', snapshot: snapshot() });
  assert.match(nodes.get('#homepage-uv').title, /provider’s rules/);
  assert.doesNotMatch(nodes.get('#homepage-uv').title, /browser identit/);
  document.documentElement.lang = 'zh-CN';
  render();
  assert.match(nodes.get('#homepage-uv').title, /计数服务的规则/);
  assert.doesNotMatch(nodes.get('#homepage-uv').title, /浏览器身份/);
});

test('self-hosted configuration rejects unsafe API URLs; no silent alternate provider', () => {
  assert.equal(validConfig({ provider: 'self-hosted', apiBase: 'https://counter.example', countingSince: '2026-10-25' }), true);
  for (const apiBase of ['', 'http://counter.example', 'https://secret@counter.example', 'https://counter.example?key=secret']) {
    assert.equal(validConfig({ provider: 'self-hosted', apiBase, countingSince: '2026-10-25' }), false);
  }
  assert.equal(validConfig(undefined), false);
});

test('explicit legacy mode preserves the single official POST and never retries an ambiguous failure', async () => {
  let requests = 0;
  const states = [];
  const timers = clock();
  await startLegacy({
    countingSince: '2026-10-25', render: state => states.push(state),
    window: {
      navigator: { onLine: true }, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
      async fetch(url, init) {
        requests++;
        assert.equal(url, 'https://cdn.busuanzi.cc/api.php');
        assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(init.body), { url: 'https://ruichen218.github.io/rui-chen-homepage/', referrer: '' });
        throw new Error('Ambiguous response loss');
      },
    },
  });
  assert.equal(requests, 1);
  assert.equal(timers.timers.size, 0);
  assert.equal(states.at(-1).status, 'unavailable');
});
