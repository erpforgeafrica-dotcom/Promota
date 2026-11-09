#!/usr/bin/env node
/**
 * audit-ui-wiring.mjs — do the pages actually reach the API they claim to?
 *
 * Static, offline, no credentials. It reads the route table and the frontend
 * bundle and answers three questions that are otherwise invisible:
 *
 *   1. DEAD CALL  — the UI calls a path the server does not route.
 *   2. ORPHAN API — the server routes a path no page ever calls.
 *   3. DEAD PAGE  — a page links or redirects to a file that does not exist.
 *
 * Plus: every `<button>` in the HTML that has neither a `data-*` hook, an
 * inline handler, nor a matching id/class listener in the page's script.
 *
 * Exit 1 when a DEAD CALL or DEAD PAGE is found: those are launch blockers.
 * ORPHAN APIs and unbound buttons are reported but do not fail the gate — an
 * endpoint can be legitimately internal.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'apps', 'web');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  PASS  ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}${d ? `\n          -> ${d}` : ''}`); };
const info = (m, d) => console.log(`  NOTE  ${m}${d ? `\n          -> ${d}` : ''}`);

/* ------------------------------------------------------------ route table */
/* A call is dead when neither the exact table nor the path-parameter table
 * accepts it. The dynamic table is exported by api/routes.mjs for exactly this
 * check — guessing the families by hand is what hid the admin/promotion routes. */
const routesMod = await import('../api/routes.mjs');
const exactRoutes = routesMod.routes || routesMod.ROUTES || {};
const keys = exactRoutes instanceof Map ? [...exactRoutes.keys()] : Object.keys(exactRoutes);
const routes = new Set(keys.map((k) => {
  const [, method, path] = /^([A-Z]+)\s+(.*)$/.exec(k) || [];
  return `${method} ${path}`.replace(/\/+$/, '');
}));
/* Patterns server.mjs resolves itself. It cannot be imported here without
 * booting an HTTP listener, so its task-action table is mirrored and named. */
const SERVER_PATTERNS = [
  { method: 'POST', re: /^\/api\/tasks\/[0-9a-f-]{36}\/(?:claim|submit)$/i },
];
const dynamic = [
  ...(routesMod.dynamicRoutes || []).map((r) => ({ method: r.method, re: r.re })),
  ...SERVER_PATTERNS,
];

/* ------------------------------------------------------- frontend sources */
const jsFiles = readdirSync(WEB).filter((f) => f.endsWith('.js') && !f.endsWith('.test.mjs'));
const htmlFiles = readdirSync(WEB).filter((f) => f.endsWith('.html'));

/* --------------------------------------------------------------- scanning
 * The previous version scanned one line at a time and defaulted the method to
 * GET, so a POST written across several lines (`api('/x', {\n  method: 'POST'`)
 * and a concatenated path (`'/api/users/' + id + '/suspend'`) both came out as
 * `GET /api/users/` — 7 false "dead call" defects. These helpers read a whole
 * call with balanced brackets, resolve literal + `${}` + `+` concatenation, and
 * read the method from the same call. */

/* A single scanner for the three things that can hide a bracket or a quote: a
 * string/template, a comment, or a regex literal. Regexes matter — escaping
 * code such as `.replace(/["'<>&]/g, '')` used to be read as the start of a
 * string, which blanked the rest of the file and reported whole pages as
 * having zero API calls. */
const REGEX_AFTER = '([{=,:;!&|?+-*%~^<>';

function skipRegex(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j + 1;
    else if (c === '\n') return j; // an unterminated literal stops at the line end
  }
  return src.length;
}

/** True when a `/` at `i` starts a regex literal rather than a division. */
function regexAt(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  if (REGEX_AFTER.includes(src[j])) return true;
  return /\b(?:return|typeof|case|in|of|do|else|yield|delete|void|instanceof|new|throw)$/
    .test(src.slice(Math.max(0, j - 10), j + 1));
}

/** End index of the string / comment / regex starting at `i`, or -1. */
function skipAtom(src, i) {
  const c = src[i];
  if (c === "'" || c === '"' || c === '`') return skipQuoted(src, i);
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl < 0 ? src.length : nl;
  }
  if (c === '/' && src[i + 1] === '*') {
    const close = src.indexOf('*/', i + 2);
    return close < 0 ? src.length : close + 2;
  }
  if (c === '/' && regexAt(src, i)) return skipRegex(src, i);
  return -1;
}

/** Blank out comments, string bodies and regex literals, preserving offsets. */
function mask(src) {
  const out = src.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  for (let i = 0; i < src.length; i++) {
    const end = skipAtom(src, i);
    if (end <= i) continue;
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') blank(i + 1, end - 1);
    else blank(i, end);
    i = end - 1;
  }
  return out.join('');
}

/** Index just past the closing quote of the string starting at `i`. */
function skipQuoted(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (q === '`' && c === '$' && src[j + 1] === '{') { j = skipBraces(src, j + 1); continue; }
    if (c === q) return j + 1;
    j++;
  }
  return src.length;
}

/** Index just past the `}` that closes the `{` at `i`, skipping atoms. */
function skipBraces(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const end = skipAtom(src, j);
    if (end > j) { j = end - 1; continue; }
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return src.length;
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const end = skipAtom(src, i);
    if (end > i) { i = end - 1; continue; }
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Split an expression on top-level `+`. */
function splitPlus(expr) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < expr.length; i++) {
    const end = skipAtom(expr, i);
    if (end > i) { i = end - 1; continue; }
    const c = expr[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '+' && depth === 0) { parts.push(expr.slice(start, i)); start = i + 1; }
  }
  parts.push(expr.slice(start));
  return parts;
}

/** The value of a single string/template literal chunk, or null for an expression. */
function literalOf(chunk) {
  const s = chunk.trim();
  if (s.length < 2) return null;
  const q = s[0];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  if (s[s.length - 1] !== q && !(q === '`' && s.includes('${'))) return null;
  // A quoted value is literal only when the quote closes at the very end.
  const close = skipQuoted(s, 0);
  if (close !== s.length) return null;
  const inner = s.slice(1, -1);
  return q === '`' ? inner.replace(/\$\{[^}]*\}/g, ':id') : inner;
}

/**
 * Resolve the first argument of an api()/fetch() call to a route path.
 * Literals concatenate; a dynamic segment lands where the literal ended in `/`;
 * a dynamic suffix on a non-slash literal is a query string and is dropped.
 */
function resolvePath(expr) {
  const chunks = splitPlus(expr);
  let path = '';
  for (const chunk of chunks) {
    const lit = literalOf(chunk);
    if (lit === null) {
      if (path.endsWith('/')) path += ':id';
      continue;
    }
    path += lit;
  }
  path = path.split('?')[0].split('#')[0];
  return path.startsWith('/') ? path.replace(/\/{2,}/g, '/').replace(/\/+$/, '') : null;
}

function extractCalls(file, src) {
  const bare = mask(src);
  const found = [];
  const re = /(?<![\w$])(?:api|fetch)\s*\(/g;
  let m;
  while ((m = re.exec(bare))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;
    const args = src.slice(open + 1, close);
    const path = resolvePath(splitFirstArg(args));
    if (!path) continue;
    const method = (/\bmethod\s*:\s*['"]([A-Z]+)['"]/.exec(args) || [null, 'GET'])[1];
    found.push({ method, path });
  }
  return found;
}

/** The text before the first top-level comma of an argument list. */
function splitFirstArg(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const end = skipAtom(args, i);
    if (end > i) { i = end - 1; continue; }
    const c = args[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) return args.slice(0, i);
  }
  return args;
}

const calls = new Map(); // "METHOD /path" -> Set(files)
for (const file of jsFiles) {
  const extracted = extractCalls(file, readFileSync(join(WEB, file), 'utf8'));
  if (process.env.AUDIT_UI_DEBUG) console.error(`         ${file}: ${extracted.length} calls${extracted.length ? ` (${extracted.map((c) => `${c.method} ${c.path}`).join(', ')})` : ''}`);
  for (const call of extracted) {
    const key = `${call.method} ${call.path}`;
    if (!calls.has(key)) calls.set(key, new Set());
    calls.get(key).add(file);
  }
}

/* A call is dead when no route matches it, allowing :id for any segment and
 * the two dynamic families the router resolves by pattern (tasks/:id, blog/:slug). */
/** A concrete id for testing a regex that expects a UUID (the UI path has `:id`). */
const SAMPLE_ID = '00000000-0000-4000-8000-000000000000';

function matchesRoute(key) {
  if (routes.has(key)) return true;
  const [method, path] = key.split(' ');
  for (const r of routes) {
    const parts = r.split(' ');
    if (parts[0] !== method) continue;
    const a = path.split('/');
    const b = parts[1].split('/');
    if (a.length !== b.length) continue;
    if (a.every((seg, i) => seg === b[i] || seg === ':id' || b[i].startsWith(':') || b[i] === '<slug>')) return true;
  }
  // The path-parameter routes the router resolves by regex (admin ids, ...).
  const concrete = path.replace(/:id/g, SAMPLE_ID);
  if (dynamic.some((r) => r.method === method && r.re.test(concrete))) return true;
  return false;
}

/* `/rest/v1/rpc/x` is not a Promota route: it is a direct PostgREST call to a
 * database function, which is the only public write path for lead capture. It
 * is proven against db/migrations instead of the router — a call to a function
 * no migration defines is a dead call, and an `execute` grant is the strongest
 * offline proof that the function exists. */
const MIGRATIONS = join(ROOT, 'db', 'migrations');
const migrationSql = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n');

const rpcCalls = [...calls.keys()].filter((k) => /^\w+ \/rest\/v1\/rpc\//.test(k));
const rpcMissing = [];
for (const key of rpcCalls) {
  const fn = key.split('/').pop();
  const defined = new RegExp(`(?:function|procedure)\\s+(?:public\\.)?"?${fn}"?\\s*\\(`, 'i').test(migrationSql);
  const granted = new RegExp(`grant\\s+execute\\s+on\\s+function\\s+(?:public\\.)?"?${fn}"?\\s*\\(`, 'i').test(migrationSql);
  if (!defined && !granted) rpcMissing.push(key);
}

const dead = [...calls.keys()].filter((k) => !k.includes('/rest/v1/rpc/') && !matchesRoute(k));
if (rpcCalls.length === 0) {
  ok('no direct PostgREST RPC calls from the UI');
} else if (rpcMissing.length === 0) {
  ok(`every direct PostgREST RPC exists in db/migrations (${rpcCalls.map((k) => k.split('/').pop()).join(', ')})`);
} else {
  bad('UI calls a PostgREST RPC no migration defines',
    rpcMissing.map((d) => `${d}  <- ${[...calls.get(d)].join(', ')}`).join('\n             '));
}
if (process.env.AUDIT_UI_DEBUG) {
  console.error(`  DEBUG  ${calls.size} calls, ${routes.size} routes`);
  for (const k of [...calls.keys()].sort()) console.error(`         call ${k}`);
}
const used = new Set();
for (const k of calls.keys()) {
  const [m, p] = k.split(' ');
  for (const r of routes) {
    const parts = r.split(' ');
    if (parts[0] !== m) continue;
    const a = p.split('/'), b = parts[1].split('/');
    if (a.length === b.length && a.every((s, i) => s === b[i] || s === ':id' || b[i].startsWith(':'))) used.add(r);
  }
  if (dynamic.some((r) => r.method === m && r.re.test(p.replace(/:id/g, SAMPLE_ID)))) used.add(`DYNAMIC ${m} ${p}`);
}

if (dead.length === 0) ok(`every UI call has a server route (${calls.size} distinct calls, ${jsFiles.length} scripts)`);
else bad('UI calls a path the server does not route', dead.map((d) => `${d}  <- ${[...calls.get(d)].join(', ')}`).join('\n             '));

const orphans = [...routes].filter((r) => !used.has(r));
if (orphans.length === 0) ok('every server route is called by some page');
else info(`${orphans.length} route(s) with no page caller (internal / admin / partner use)`, orphans.join(', '));

/* ------------------------------------------------- required page callers */
/* The dead-call check only proves the paths exist. It cannot see a feature
 * whose endpoint was built but whose page never wired it — that is exactly how
 * the KYC tier forms and the whole mutual-promotion flow sat unreachable. These
 * routes are on the launch path: a page must call each of them. */
const REQUIRED_CALLERS = [
  'POST /api/v1/kyc/basic',
  'POST /api/v1/kyc/identity',
  'GET /api/v1/promotion/cards',
  'POST /api/v1/promotion/cards',
  'GET /api/v1/promotion/cards/mine',
  'GET /api/v1/promotion/pairs',
  'POST /api/v1/promotion/pairs',
  'POST /api/v1/promotion/pairs/:id/accept',
  'POST /api/v1/promotion/pairs/:id/deliver',
  'GET /api/v1/admin/promotion/cards',
  'POST /api/v1/admin/promotion/cards/:id/review',
  'GET /api/v1/admin/promotion/deliveries',
  'POST /api/v1/admin/promotion/deliveries/:id/review',
  'POST /api/v1/admin/promotion/expire',
];
const uncalled = REQUIRED_CALLERS.filter((k) => !calls.has(k));
if (uncalled.length === 0) {
  ok(`every launch-critical route has a page caller (${REQUIRED_CALLERS.length} checked)`);
} else {
  bad('a launch-critical route has no page caller',
    uncalled.map((k) => `${k} — no page calls it`).join('\n             '));
}

/* ------------------------------------------------------------- dead pages */
const pageLinks = new Map();
for (const file of htmlFiles) {
  const src = readFileSync(join(WEB, file), 'utf8');
  for (const m of src.matchAll(/(?:href|action|content="0;url=)\s*=?\s*["']?([a-z0-9._-]+\.html)/gi)) {
    const target = m[1];
    if (!pageLinks.has(target)) pageLinks.set(target, new Set());
    pageLinks.get(target).add(file);
  }
}
const missingPages = [...pageLinks.keys()].filter((p) => !existsSync(join(WEB, p)));
if (missingPages.length === 0) ok(`every internal page link resolves (${pageLinks.size} targets)`);
else bad('a page links to a file that does not exist', missingPages.map((p) => `${p}  <- ${[...pageLinks.get(p)].join(', ')}`).join('\n             '));

/* ---------------------------------------------------------- dead buttons */
let unbound = 0;
const unboundDetail = [];
for (const html of htmlFiles) {
  const base = html.replace(/\.html$/, '');
  const jsPath = [join(WEB, `${base}.js`), join(WEB, 'app.js'), join(WEB, 'landing.js')]
    .filter((p, i, arr) => existsSync(p) && arr.indexOf(p) === i);
  const script = jsPath.map((p) => readFileSync(p, 'utf8')).join('\n');
  const src = readFileSync(join(WEB, html), 'utf8');
  for (const m of src.matchAll(/<button\b([^>]*)>/gi)) {
    const attrs = m[1];
    if (/\bon[a-z]+\s*=/.test(attrs)) continue;           // inline handler
    if (/\bdata-[a-z-]+=/.test(attrs)) continue;          // data hook
    const id = (/\bid\s*=\s*["']([^"']+)["']/.exec(attrs) || [])[1];
    const cls = (/(?:class)\s*=\s*["']([^"']+)["']/.exec(attrs) || [])[1];
    if (id && new RegExp(`getElementById\\(['"]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(script)) continue;
    if (cls && cls.split(/\s+/).some((c) => c && new RegExp(`(querySelector(All)?\\(['"][^'"]*\\.${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b|classList|closest\\(['"]\\.${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`).test(script))) continue;
    unbound++;
    unboundDetail.push(`${html}: <button ${attrs.trim().slice(0, 60)}>`);
  }
}
if (unbound === 0) ok('every <button> is bound to a handler or a data hook');
else info(`${unbound} button(s) with no visible binding (verify by hand)`, unboundDetail.slice(0, 25).join('\n             '));

console.log(`\n  ${pass} PASS   ${fail} FAIL`);
console.log(`  UI WIRING: ${fail === 0 ? 'PASS' : 'FAIL'}`);
process.exitCode = fail === 0 ? 0 : 1;
