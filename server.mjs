#!/usr/bin/env node
/**
 * Promota production web + API server.
 *
 * Serves the static site in apps/web and injects window.PROMOTA at runtime
 * from environment variables (SUPABASE_URL, SUPABASE_ANON_KEY). Nothing is
 * baked into the image, so the same build works in every environment and no
 * backend key is ever committed. The key it serves is the publishable key,
 * which is public by design: database grants and row-level security are the
 * enforcement for the browser, and the API below is the trusted path.
 *
 * It also hosts the JSON API under /api. The API holds the service-role key
 * and is the ONLY writer of money-adjacent rows; the browser is stopped by RLS,
 * exactly as db/live.proof.mjs proves over HTTPS.
 *
 * Zero dependencies on purpose: the Dockerfile runs no `npm install`, so this
 * uses nothing but Node built-ins.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes, submitTask } from './api/routes.mjs';
import { ready as checkReady } from './api/readyz.mjs';
import * as worker from './api/worker.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WWW = join(ROOT, 'apps', 'web');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const START_WORKER = process.env.WORKER_ENABLED !== 'false';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || '').trim();
const CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const CACHEABLE = new Set(['.png', '.webp', '.svg', '.ico']);

/* ------------------------------------------------------------- rate limiting */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 60);
const rateBuckets = new Map();

function clientIp(req) {
  return req.headers['x-real-ip']
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

/** Sliding window per IP. Returns retry-after seconds when throttled. */
function rateLimited(ip) {
  const now = Date.now();
  const cut = now - RATE_WINDOW_MS;
  const hits = (rateBuckets.get(ip) || []).filter(t => t > cut);
  if (hits.length >= RATE_MAX) {
    rateBuckets.set(ip, hits);
    return Math.ceil((hits[0] + RATE_WINDOW_MS - now) / 1000);
  }
  hits.push(now);
  rateBuckets.set(ip, hits);
  // opportunistic cleanup so the map cannot grow without bound
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (!v.some(t => t > cut)) rateBuckets.delete(k);
    }
  }
  return 0;
}

/* ------------------------------------- tighter budgets for hot poll paths */
/**
 * Per-path override on top of rateLimited: status/poll endpoints are cheap to
 * call and expensive to fan out, so dashboards that poll them get a tighter
 * budget (requests/min per IP). Paths absent from this map keep the default
 * RATE_MAX behaviour unchanged.
 */
const POLL_BUDGETS = {
  '/api/mining/status': 20,
  '/api/mining/traces': 20,
  '/api/zapia/status': 20,
  '/api/zapia/candidates': 20,
};
const pollBuckets = new Map();

/** Tighter sliding window for hot poll paths. Unknown paths return 0 (no extra limit). */
function pollLimited(ip, path) {
  const max = POLL_BUDGETS[path];
  if (!max) return 0;
  const now = Date.now();
  const cut = now - RATE_WINDOW_MS;
  const key = `${ip} ${path}`;
  const hits = (pollBuckets.get(key) || []).filter(t => t > cut);
  if (hits.length >= max) {
    pollBuckets.set(key, hits);
    return Math.ceil((hits[0] + RATE_WINDOW_MS - now) / 1000);
  }
  hits.push(now);
  pollBuckets.set(key, hits);
  // opportunistic cleanup so the map cannot grow without bound
  if (pollBuckets.size > 5000) {
    for (const [k, v] of pollBuckets) {
      if (!v.some(t => t > cut)) pollBuckets.delete(k);
    }
  }
  return 0;
}

/* ------------------------------------------------------------------- headers */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://*.supabase.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': CSP,
  'permissions-policy': 'geolocation=(), camera=(), microphone=()',
};

function runtimeConfigBody() {
  const cfg = { SUPABASE_URL, SUPABASE_ANON_KEY };
  return '/* Injected at runtime by server.mjs. Publishable key only. */\n'
    + 'window.PROMOTA = ' + JSON.stringify(cfg) + ';\n';
}

function send(res, status, headers, body, headOnly) {
  res.writeHead(status, headers);
  return headOnly ? res.end() : res.end(body);
}

const json = (res, status, obj, headOnly) => send(
  res, status,
  { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  JSON.stringify(obj),
  headOnly,
);

/* --------------------------------------------------------------- body parsing */
const MAX_BODY = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------- routing */
/**
 * Exact routes first, then a small pattern table for /api/tasks/:id/submit.
 * Kept explicit rather than clever: there are ten endpoints.
 */
const PATTERNS = [
  { method: 'POST', re: /^\/api\/tasks\/([0-9a-f-]{36})\/submit$/i, handler: submitTask, params: ['id'] },
];

async function handleApi(req, res, url) {
  const headOnly = req.method === 'HEAD';

  // Validate the body BEFORE routing: a POST with a non-JSON body is a
  // client error (400) even when the path itself is unknown.
  let body = null;
  let raw = '';
  if (req.method === 'POST') {
    raw = await readBody(req);
    if (raw) {
      try { body = JSON.parse(raw); }
      catch { return json(res, 400, { error: 'body must be JSON' }, headOnly); }
    } else body = {};
    req.body = body;
  }

  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];

  const pattern = PATTERNS.find(p => p.method === req.method && p.re.test(url.pathname));
  const matched = handler
    ? { fn: handler, params: {} }
    : pattern
      ? {
          fn: pattern.handler,
          params: Object.fromEntries(
            pattern.re.exec(url.pathname).slice(1).map((v, i) => [pattern.params[i], v])
          ),
        }
      : null;

  if (!matched) return json(res, 404, { error: 'no such endpoint' }, headOnly);

  try {
    const result = await matched.fn(req, matched.params, raw);
    if (!result || typeof result.status !== 'number') {
      return json(res, 500, { error: 'handler returned no response' }, headOnly);
    }
    return json(res, result.status, result.body, headOnly);
  } catch (e) {
    // never leak a stack trace or a key to the caller
    console.error('[api]', req.method, url.pathname, '->', String(e.message || e).slice(0, 300));
    return json(res, 500, { error: 'internal error' }, headOnly);
  }
}

/* --------------------------------------------------------------------- server */
const server = createServer(async (req, res) => {
  const headOnly = req.method === 'HEAD';
  try {
    const url = new URL(req.url, 'http://localhost');

    // the API is throttled harder than static reads
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname === '/readyz') {
      const ip = clientIp(req);
      const retry = rateLimited(ip) || pollLimited(ip, url.pathname);
      if (retry) {
        return json(res, 429, { error: 'slow down' }, headOnly);
      }
      res.setHeader('X-RateLimit-Remaining', String(RATE_MAX));
      if (url.pathname === '/readyz' && (req.method === 'GET' || req.method === 'HEAD')) {
        const result = await checkReady();
        return json(res, result.ready ? 200 : 503, result, headOnly);
      }
      return handleApi(req, res, url);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405,
        { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' },
        '405 Method Not Allowed', headOnly);
    }

    let rel = decodeURIComponent(url.pathname);

    if (rel === '/config.js') {
      const body = Buffer.from(runtimeConfigBody(), 'utf8');
      return send(res, 200, { ...SECURITY_HEADERS, 'content-type': 'text/javascript; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' }, body, headOnly);
    }

    if (rel === '/' || rel.endsWith('/')) rel += 'index.html';

    const target = normalize(join(WWW, rel));
    if (target !== WWW && !target.startsWith(WWW + sep)) {
      return send(res, 403, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }, '403 Forbidden', headOnly);
    }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      return send(res, 404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }, '404 Not Found', headOnly);
    }

    const ext = extname(target).toLowerCase();
    const body = await readFile(target);
    return send(res, 200, {
      ...SECURITY_HEADERS,
      'content-type': TYPES[ext] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': CACHEABLE.has(ext) ? 'public, max-age=86400' : 'no-cache',
    }, body, headOnly);
  } catch (err) {
    return send(res, 500, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }, '500 Internal Server Error', headOnly);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`promota web+api listening on http://${HOST}:${PORT} (supabase configured: ${CONFIGURED})`);
  if (START_WORKER) worker.start();
  else console.log('[worker] disabled via WORKER_ENABLED=false');
});