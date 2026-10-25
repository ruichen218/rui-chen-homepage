/* Rui Chen homepage counter. Configuration lives in counter-config.js. */
(() => {
  'use strict';

  const TTL = 7 * 24 * 60 * 60 * 1000;
  const MAX_PENDING = 100;
  const CANONICAL_PATH = '/rui-chen-homepage/';
  const PATHS = [CANONICAL_PATH, '/rui-chen-homepage', '/rui-chen-homepage/index.html'];
  const STARTED_KEY = '__ruiHomepageCounterStarted';
  const isCount = value => Number.isSafeInteger(value) && value >= 0;
  const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
  const isStartDate = value => isDate(value) || (typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)));

  function validSnapshot(value) {
    return !!value && isCount(value.pv) && isCount(value.uv) &&
      isStartDate(value.counting_since) && isStartDate(value.uv_counting_since) &&
      typeof value.as_of === 'string' && Number.isFinite(Date.parse(value.as_of)) &&
      typeof value.epoch === 'string' && value.epoch.length > 0 && value.epoch.length <= 100;
  }

  function validConfig(value) {
    if (!value || !isDate(value.countingSince)) return false;
    if (value.provider === 'busuanzi') return true;
    if (value.provider !== 'self-hosted' || typeof value.apiBase !== 'string') return false;
    try {
      const base = new URL(value.apiBase);
      return base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash;
    } catch (_) { return false; }
  }

  function createMemoryStore() {
    let pending = [];
    let cached = null;
    return {
      async enqueue(event, now) {
        pending = pending.filter(item => now - Date.parse(item.created_at) < TTL);
        // Without durable storage no browser identity is invented for UV.
        const visit = { ...event, visitor_id: null };
        pending.push(visit);
        pending = pending.slice(-MAX_PENDING);
        return visit;
      },
      async list(now) {
        pending = pending.filter(item => now - Date.parse(item.created_at) < TTL);
        return pending.slice();
      },
      async remove(id) { pending = pending.filter(item => item.event_id !== id); },
      async readSnapshot() { return cached; },
      async writeSnapshot(value) { cached = value; },
    };
  }

  function createIndexedStore(indexedDB, options = {}) {
    const uuid = options.uuid || (() => crypto.randomUUID());
    const databaseName = options.name || 'rui-homepage-counter-v1';
    const timeout = options.timeout || 2000;
    const schedule = options.setTimeout || setTimeout;
    const cancel = options.clearTimeout || clearTimeout;
    let databasePromise;

    function open() {
      if (databasePromise) return databasePromise;
      databasePromise = new Promise((resolve, reject) => {
        if (!indexedDB) { reject(new Error('Browser storage unavailable')); return; }
        let settled = false;
        const request = indexedDB.open(databaseName, 1);
        const timer = schedule(() => {
          settled = true;
          reject(new Error('Browser storage timed out'));
        }, timeout);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
          if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'event_id' });
        };
        request.onblocked = () => {
          if (settled) return;
          settled = true;
          cancel(timer);
          reject(new Error('Browser storage blocked'));
        };
        request.onerror = () => {
          if (settled) return;
          settled = true;
          cancel(timer);
          reject(request.error || new Error('Browser storage unavailable'));
        };
        request.onsuccess = () => {
          if (settled) { request.result.close(); return; }
          settled = true;
          cancel(timer);
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        };
      });
      return databasePromise;
    }

    async function transaction(stores, mode, perform) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('Browser storage failed'));
        perform(tx, value => { result = value; });
      });
    }

    return {
      async enqueue(event, now) {
        return transaction(['meta', 'pending'], 'readwrite', (tx, done) => {
          const meta = tx.objectStore('meta');
          const pending = tx.objectStore('pending');
          const identity = meta.get('visitor');
          identity.onsuccess = () => {
            const visitor = identity.result || uuid();
            if (!identity.result) meta.put(visitor, 'visitor');
            const visit = { ...event, visitor_id: visitor };
            const all = pending.getAll();
            all.onsuccess = () => {
              const live = [];
              all.result.forEach(item => {
                if (now - Date.parse(item.created_at) >= TTL) pending.delete(item.event_id);
                else live.push(item);
              });
              live.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
              while (live.length >= MAX_PENDING) pending.delete(live.shift().event_id);
              pending.put(visit);
              done(visit);
            };
          };
        });
      },
      async list(now) {
        return transaction(['pending'], 'readwrite', (tx, done) => {
          const pending = tx.objectStore('pending');
          const request = pending.getAll();
          request.onsuccess = () => {
            const live = [];
            request.result.forEach(item => {
              if (now - Date.parse(item.created_at) >= TTL) pending.delete(item.event_id);
              else live.push(item);
            });
            done(live.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)));
          };
        });
      },
      async remove(id) {
        return transaction(['pending'], 'readwrite', tx => { tx.objectStore('pending').delete(id); });
      },
      async readSnapshot() {
        return transaction(['meta'], 'readonly', (tx, done) => {
          const request = tx.objectStore('meta').get('snapshot');
          request.onsuccess = () => done(request.result || null);
        });
      },
      async writeSnapshot(value) {
        return transaction(['meta'], 'readwrite', tx => {
          const meta = tx.objectStore('meta');
          const request = meta.get('snapshot');
          request.onsuccess = () => {
            const previous = request.result;
            if (validSnapshot(previous) && (Date.parse(value.as_of) < Date.parse(previous.as_of) ||
                (value.epoch === previous.epoch && (value.pv < previous.pv || value.uv < previous.uv)))) return;
            meta.put(value, 'snapshot');
          };
        });
      },
    };
  }

  function createCounter(options) {
    const now = options.now || Date.now;
    const schedule = options.setTimeout || setTimeout;
    const cancel = options.clearTimeout || clearTimeout;
    const uuid = options.uuid || (() => crypto.randomUUID());
    const isOnline = options.isOnline || (() => navigator.onLine !== false);
    const retries = options.retryDelays || [1000, 5000];
    const apiBase = options.apiBase.replace(/\/$/, '');
    let store = options.store;
    let started = false;
    let ready;
    let activeFlush = null;
    let retryTimer = null;
    let retryIndex = 0;
    let snapshot = null;
    let confirmations = 0;

    function render(status) { options.render({ status, snapshot }); }
    function failure() { render(snapshot ? 'cached' : 'unavailable'); }

    async function accept(data) {
      if (!validSnapshot(data)) throw new Error('Invalid counter response');
      // Parallel GET and POST replies can arrive out of order. Never regress a
      // confirmed total within the same database epoch.
      if (snapshot && (Date.parse(data.as_of) < Date.parse(snapshot.as_of) ||
          (data.epoch === snapshot.epoch && (data.pv < snapshot.pv || data.uv < snapshot.uv)))) return;
      snapshot = {
        pv: data.pv, uv: data.uv, counting_since: data.counting_since,
        uv_counting_since: data.uv_counting_since, as_of: data.as_of, epoch: data.epoch,
      };
      confirmations++;
      render('fresh');
      try { await store.writeSnapshot(snapshot); } catch (_) { /* Counters remain server-confirmed. */ }
    }

    async function request(path, init = {}) {
      const controller = new AbortController();
      const timer = schedule(() => controller.abort(), options.requestTimeout || 10000);
      try {
        const response = await options.fetch(apiBase + path, {
          ...init, credentials: 'omit', mode: 'cors', cache: 'no-store',
          referrerPolicy: 'no-referrer', signal: controller.signal,
        });
        if (!response.ok) {
          let body;
          try { body = await response.json(); } catch (_) { /* Status is sufficient for retry policy. */ }
          const error = new Error('Counter request rejected');
          error.status = response.status;
          error.code = body && body.error;
          throw error;
        }
        const data = await response.json();
        if (!validSnapshot(data)) throw new Error('Invalid counter response');
        return data;
      } finally { cancel(timer); }
    }

    async function refreshStats() {
      if (!isOnline()) { failure(); return; }
      const before = confirmations;
      try { await accept(await request('/v1/stats')); }
      catch (_) { if (confirmations === before) failure(); }
    }

    function scheduleRetry() {
      if (!isOnline() || retryTimer !== null || retryIndex >= retries.length) return;
      retryTimer = schedule(() => {
        retryTimer = null;
        void flush();
      }, retries[retryIndex++]);
    }

    function flush() {
      if (activeFlush) return activeFlush;
      activeFlush = (async () => {
        await ready;
        if (!isOnline()) { failure(); return; }
        try {
          const pending = await store.list(now());
          for (const visit of pending) {
            if (!isOnline()) { failure(); return; }
            let data;
            try {
              data = await request('/v1/visits', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(visit),
              });
            } catch (error) {
              if (error.status === 400 || error.status === 413) {
                // The backend explicitly rejected this malformed/expired event;
                // it was not counted. Discard it so later valid visits can pass.
                await store.remove(visit.event_id);
                failure();
                continue;
              }
              if ([401, 403, 404, 405].includes(error.status)) {
                // Retrying a bad origin, route, or authentication configuration
                // cannot fix it. Keep events for a later corrected deployment.
                failure();
                return;
              }
              throw error;
            }
            // A lost reply keeps the event queued. The identical event_id makes
            // the next request safe even if the first already committed.
            await accept(data);
            await store.remove(visit.event_id);
          }
          retryIndex = 0;
          if (retryTimer !== null) { cancel(retryTimer); retryTimer = null; }
        } catch (_) {
          failure();
          scheduleRetry();
        }
      })().finally(() => { activeFlush = null; });
      return activeFlush;
    }

    async function initialize() {
      const event = { event_id: uuid(), created_at: new Date(now()).toISOString(), path: CANONICAL_PATH };
      try {
        const cached = await store.readSnapshot();
        if (validSnapshot(cached)) { snapshot = cached; render('cached'); }
        await store.enqueue(event, now());
      } catch (_) {
        // Failure to initialize storage never fabricates a persistent visitor.
        store = createMemoryStore();
        await store.enqueue(event, now());
      }
    }

    return {
      async start() {
        if (started) return ready;
        started = true;
        render('loading');
        ready = initialize();
        await ready;
        await Promise.allSettled([refreshStats(), flush()]);
      },
      async online() {
        if (!started) return;
        retryIndex = 0;
        if (retryTimer !== null) { cancel(retryTimer); retryTimer = null; }
        await ready;
        await Promise.allSettled([refreshStats(), flush()]);
      },
      flush,
    };
  }

  function createDomRenderer(document, provider = 'self-hosted') {
    const container = document.querySelector('#homepage-views');
    const status = document.querySelector('#homepage-counter-status');
    const loading = document.querySelector('#homepage-counter-loading');
    const error = document.querySelector('#homepage-counter-error');
    const cached = document.querySelector('#homepage-counter-cached');
    const pv = document.querySelector('#homepage-views-value');
    const uv = document.querySelector('#homepage-visitors-value');
    const pvItem = document.querySelector('#homepage-pv');
    const uvItem = document.querySelector('#homepage-uv');
    if ([container, status, loading, error, cached, pv, uv, pvItem, uvItem].some(value => !value)) return null;
    let latest = { status: 'loading', snapshot: null };

    function render(value = latest) {
      latest = value;
      const zh = document.documentElement.lang.toLowerCase().startsWith('zh');
      const data = value.snapshot;
      container.hidden = pvItem.hidden = uvItem.hidden = false;
      pv.textContent = data ? data.pv.toLocaleString('en-US') : '—';
      uv.textContent = data ? data.uv.toLocaleString('en-US') : '—';
      uvItem.title = provider === 'self-hosted'
        ? (zh ? '按浏览器身份去重；清除数据或更换浏览器后可能重复计入。' : 'Unique browser identities; clearing data or changing browsers can count again.')
        : (zh ? '按计数服务的规则去重，不等同于真实人数或设备数。' : 'Deduplicated according to the provider’s rules; not a count of people or devices.');
      loading.textContent = zh ? '加载中…' : 'Loading…';
      error.textContent = zh ? '统计暂不可用' : 'Statistics unavailable';
      loading.hidden = value.status !== 'loading';
      error.hidden = value.status !== 'unavailable';
      cached.hidden = value.status !== 'cached';
      status.hidden = value.status === 'fresh';
      if (data && value.status === 'cached') {
        const timestamp = new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
          dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin',
        }).format(new Date(data.as_of));
        cached.textContent = zh ? `上次确认：${timestamp}（柏林时间）；暂时无法更新` : `Last confirmed: ${timestamp} (Berlin); temporarily unable to update`;
      }
    }
    return render;
  }

  function startLegacy(options) {
    let requested = false;
    const render = options.render;
    render({ status: 'loading', snapshot: null });
    async function load() {
      if (requested) return;
      if (options.window.navigator.onLine === false) {
        render({ status: 'unavailable', snapshot: null });
        options.window.addEventListener('online', load, { once: true });
        return;
      }
      requested = true;
      const controller = new AbortController();
      const timer = options.window.setTimeout(() => controller.abort(), 15000);
      try {
        // Legacy provider has no event idempotency key. Never retry a request
        // whose server-side outcome is unknown.
        const response = await options.window.fetch('https://cdn.busuanzi.cc/api.php', {
          method: 'POST', credentials: 'omit', referrerPolicy: 'origin', signal: controller.signal,
          body: JSON.stringify({ url: 'https://ruichen218.github.io/rui-chen-homepage/', referrer: '' }),
        });
        if (!response.ok) throw new Error('Counter request failed');
        const data = await response.json();
        const values = ['busuanzi_site_pv', 'busuanzi_site_uv'].map(key => {
          const value = data && data[key];
          return typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)) ? Number(value) : NaN;
        });
        if (!values.every(isCount)) throw new Error('Invalid counter response');
        render({ status: 'fresh', snapshot: {
          pv: values[0], uv: values[1], counting_since: options.countingSince,
          uv_counting_since: options.countingSince, as_of: new Date().toISOString(), epoch: 'busuanzi',
        } });
      } catch (_) { render({ status: 'unavailable', snapshot: null }); }
      finally { options.window.clearTimeout(timer); }
    }
    return load();
  }

  function startBrowser(window) {
    const location = window.location;
    if (location.protocol !== 'https:' || location.hostname !== 'ruichen218.github.io' || !PATHS.includes(location.pathname)) return null;
    if (window[STARTED_KEY]) return window[STARTED_KEY].counter;
    const config = window.RuiCounterConfig;
    const render = createDomRenderer(window.document, config && config.provider);
    if (!render) return null;
    const started = { counter: null };
    window[STARTED_KEY] = started;
    const observer = new window.MutationObserver(() => render());
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    if (!validConfig(config)) { render({ status: 'unavailable', snapshot: null }); return null; }
    if (config.provider === 'busuanzi') {
      void startLegacy({ window, render, countingSince: config.countingSince });
      return null;
    }
    const counter = createCounter({
      apiBase: config.apiBase, fetch: window.fetch.bind(window), render,
      store: createIndexedStore(window.indexedDB, { uuid: () => window.crypto.randomUUID() }),
      uuid: () => window.crypto.randomUUID(), isOnline: () => window.navigator.onLine !== false,
    });
    window.addEventListener('online', () => { void counter.online(); });
    started.counter = counter;
    void counter.start();
    return counter;
  }

  globalThis.RuiCounter = Object.freeze({
    createCounter, createIndexedStore, createMemoryStore, createDomRenderer,
    startBrowser, startLegacy, validSnapshot, validConfig,
  });
  if (typeof window !== 'undefined' && window.document) startBrowser(window);
})();
