const SITE_ID = 'rui-chen-homepage';
const CANONICAL_PATH = '/rui-chen-homepage/';
const DEFAULT_ORIGIN = 'https://ruichen218.github.io';
const DEFAULT_STARTED_AT = '2026-10-25T00:00:00.000Z';
const DEFAULT_EPOCH = 'rui-chen-homepage-v1';
const MAX_BODY_BYTES = 2048;
const MAX_EVENT_AGE_MS = 8 * 24 * 60 * 60 * 1000; // Seven-day queue plus one-day clock grace.
const MAX_FUTURE_SKEW_MS = 15 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATS_SQL = `SELECT pv + history_pv AS pv, uv, counting_since,
  uv_counting_since, epoch FROM site_stats WHERE site_id = ?`;
const berlinFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
});

class PublicError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseIso(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      hour > 23 || minute > 59 || second > 59) return null;
  if (match[8] !== 'Z') {
    const [offsetHour, offsetMinute] = match[8].slice(1).split(':').map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function berlinDay(date) {
  const parts = Object.fromEntries(berlinFormatter.formatToParts(date)
    .filter(part => ['year', 'month', 'day'].includes(part.type))
    .map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function settings(env) {
  const startedAt = parseIso(env.SITE_STARTED_AT || DEFAULT_STARTED_AT);
  if (!startedAt) throw new Error('Invalid start-date configuration');
  const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
  if (new URL(allowedOrigin).origin !== allowedOrigin) throw new Error('Invalid origin configuration');
  return { startedAt, allowedOrigin };
}

function validSecret(env) {
  return typeof env.VISITOR_SECRET === 'string' && env.VISITOR_SECRET.length >= 32;
}

async function hashVisitor(visitorId, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key,
    encoder.encode(`${SITE_ID}\0${visitorId}`));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readPayload(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new PublicError(400, 'invalid_request', 'A JSON request body is required.');
  }
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new PublicError(Number(length) > MAX_BODY_BYTES ? 413 : 400,
      'invalid_request', 'The request body is invalid or too large.');
  }
  if (!request.body) throw new PublicError(400, 'invalid_request', 'A JSON request body is required.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new PublicError(413, 'invalid_request', 'The request body is too large.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError(400, 'invalid_request', 'The request body is not valid JSON.');
  } finally {
    reader.releaseLock();
  }
}

function validateVisit(payload, now) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).some(key => !['event_id', 'visitor_id', 'created_at', 'path'].includes(key)) ||
      typeof payload.event_id !== 'string' || !UUID.test(payload.event_id) ||
      !(payload.visitor_id === null || (typeof payload.visitor_id === 'string' && UUID.test(payload.visitor_id))) ||
      payload.path !== CANONICAL_PATH) {
    throw new PublicError(400, 'invalid_request', 'The visit fields are invalid.');
  }
  const createdAt = parseIso(payload.created_at);
  if (!createdAt || now.getTime() - Date.parse(createdAt) > MAX_EVENT_AGE_MS ||
      Date.parse(createdAt) - now.getTime() > MAX_FUTURE_SKEW_MS) {
    throw new PublicError(400, 'invalid_event_time', 'The event time is invalid or outside the accepted window.');
  }
  return {
    eventId: payload.event_id.toLowerCase(),
    visitorId: payload.visitor_id === null ? null : payload.visitor_id.toLowerCase(),
    createdAt,
  };
}

function statsBody(row, config, now, duplicate) {
  const value = row || {
    pv: 0, uv: 0, counting_since: config.startedAt,
    uv_counting_since: config.startedAt, epoch: DEFAULT_EPOCH,
  };
  if (!Number.isSafeInteger(value.pv) || value.pv < 0 ||
      !Number.isSafeInteger(value.uv) || value.uv < 0 ||
      !parseIso(value.counting_since) || !parseIso(value.uv_counting_since) ||
      typeof value.epoch !== 'string' || !value.epoch) throw new Error('Invalid stored statistics');
  const body = {
    pv: value.pv, uv: value.uv,
    counting_since: value.counting_since, uv_counting_since: value.uv_counting_since,
    as_of: now.toISOString(), epoch: value.epoch,
  };
  if (duplicate !== undefined) body.duplicate = duplicate;
  return body;
}

function headersFor(request, allowedOrigin) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin',
  });
  if (request.headers.get('Origin') === allowedOrigin) headers.set('Access-Control-Allow-Origin', allowedOrigin);
  return headers;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

function createWorker({ now = () => new Date() } = {}) {
  return {
    async fetch(request, env) {
      let responseHeaders = headersFor(request, DEFAULT_ORIGIN);
      try {
        const config = settings(env);
        responseHeaders = headersFor(request, config.allowedOrigin);
        const origin = request.headers.get('Origin');
        if (origin !== null && origin !== config.allowedOrigin) {
          throw new PublicError(403, 'forbidden_origin', 'This origin is not allowed.');
        }
        const path = new URL(request.url).pathname;
        const methods = path === '/v1/visits' ? ['POST'] :
          ['/v1/stats', '/health'].includes(path) ? ['GET'] : null;
        if (!methods) throw new PublicError(404, 'not_found', 'This endpoint does not exist.');
        if (request.method === 'OPTIONS') {
          if (origin !== config.allowedOrigin ||
              !methods.includes(request.headers.get('Access-Control-Request-Method'))) {
            throw new PublicError(403, 'forbidden_origin', 'This preflight request is not allowed.');
          }
          const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') || '')
            .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
          if (requestedHeaders.some(value => value !== 'content-type')) {
            throw new PublicError(400, 'invalid_request', 'The requested headers are not allowed.');
          }
          responseHeaders.set('Access-Control-Allow-Methods', `${methods.join(', ')}, OPTIONS`);
          responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type');
          responseHeaders.set('Access-Control-Max-Age', '600');
          return new Response(null, { status: 204, headers: responseHeaders });
        }
        if (!methods.includes(request.method)) {
          responseHeaders.set('Allow', [...methods, 'OPTIONS'].join(', '));
          throw new PublicError(405, 'method_not_allowed', 'This method is not allowed.');
        }
        if (!env.DB) throw new Error('Database is not configured');
        if (path === '/health') {
          const readiness = await env.DB.prepare(`SELECT COUNT(*) AS ready FROM sqlite_master
            WHERE type = 'table' AND name IN
            ('site_stats', 'events', 'lifetime_visitors', 'daily_stats', 'daily_visitors')`).first();
          if (readiness?.ready !== 5) throw new Error('Database schema is not ready');
          if (!validSecret(env)) throw new Error('Visitor secret is not configured');
          return json({ ok: true }, 200, responseHeaders);
        }
        if (path === '/v1/stats') {
          const row = await env.DB.prepare(STATS_SQL).bind(SITE_ID).first();
          return json(statsBody(row, config, now()), 200, responseHeaders);
        }
        if (origin !== config.allowedOrigin) {
          throw new PublicError(403, 'forbidden_origin', 'A permitted origin is required.');
        }
        if (!validSecret(env)) throw new Error('Visitor secret is not configured');
        if (env.RATE_LIMITER) {
          const result = await env.RATE_LIMITER.limit({
            key: `${SITE_ID}:${request.headers.get('CF-Connecting-IP') || 'unknown'}`,
          });
          if (!result.success) {
            responseHeaders.set('Retry-After', '60');
            throw new PublicError(429, 'rate_limited', 'Please retry later.');
          }
        }
        const payload = await readPayload(request);
        const acceptedAt = now();
        const visit = validateVisit(payload, acceptedAt);
        const visitorHash = visit.visitorId === null ? null :
          await hashVisitor(visit.visitorId, env.VISITOR_SECRET);
        const results = await env.DB.batch([
          env.DB.prepare(`INSERT INTO site_stats
            (site_id, counting_since, uv_counting_since, epoch, updated_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(site_id) DO NOTHING`)
            .bind(SITE_ID, config.startedAt, config.startedAt, DEFAULT_EPOCH, acceptedAt.toISOString()),
          env.DB.prepare(`INSERT INTO events
            (site_id, event_id, path, visitor_hash, created_at, received_at, day)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(site_id, event_id) DO NOTHING`)
            .bind(SITE_ID, visit.eventId, CANONICAL_PATH, visitorHash,
              visit.createdAt, acceptedAt.toISOString(), berlinDay(acceptedAt)),
          env.DB.prepare(STATS_SQL).bind(SITE_ID),
        ]);
        const row = results[2].results[0];
        if (!row) throw new Error('Statistics were not returned');
        return json(statsBody(row, config, now(), results[1].meta.changes === 0), 200, responseHeaders);
      } catch (error) {
        if (error instanceof PublicError) {
          return json({ error: error.code, message: error.message }, error.status, responseHeaders);
        }
        // Do not log request bodies, raw identities, IP addresses, or DB errors.
        return json({ error: 'service_unavailable', message: 'Statistics are temporarily unavailable.' },
          503, responseHeaders);
      }
    },

    async scheduled(_controller, env) {
      const cutoff = new Date(now().getTime() - RETENTION_MS).toISOString();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM events WHERE received_at < ?').bind(cutoff),
        env.DB.prepare('DELETE FROM daily_visitors WHERE first_seen_at < ?').bind(cutoff),
      ]);
    },
  };
}

export {
  createWorker, berlinDay, hashVisitor, validateVisit, parseIso,
  MAX_BODY_BYTES, MAX_EVENT_AGE_MS, MAX_FUTURE_SKEW_MS, SITE_ID, CANONICAL_PATH,
};
export default createWorker();
