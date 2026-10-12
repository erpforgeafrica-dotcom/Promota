/**
 * server.smoke.mjs — boot the real server and exercise it over HTTP.
 *
 * Proves the wiring end to end without touching a database: static serving,
 * runtime config injection, the API route table, auth refusal, rate limiting
 * and that /healthz reports each dependency honestly.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log(ok ? `  PASS  ${label}` : `  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

// load .env into this process, and pass it on to the child
const env = { ...process.env };
try {
  for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^"|"$/g, '');
    if (!env[k]) env[k] = v;
  }
} catch { /* no .env */ }

// SESSION_SECRET is required for the API to run at all
env.SESSION_SECRET ||= 'smoke-secret-not-for-production';
env.WORKER_ENABLED = 'false';   // do not let the worker phone home during a smoke test
env.PORT = '8099';

const child = spawn(process.execPath, ['server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', d => { stderr += d.toString(); });

const BASE = 'http://127.0.0.1:8099';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function get(path, opts = {}) {
  const res = await fetch(BASE + path, { ...opts, signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text, headers: res.headers };
}

try {
  // wait for the listener
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1500) }); if (r.ok) { up = true; break; } }
    catch { /* not yet */ }
    await wait(250);
  }
  if (!up) throw new Error('server never became ready. stderr: ' + stderr.slice(0, 500));

  console.log('server smoke (no database writes)\n');

  /* ------------------------------------------------------------ static site */
  {
    const home = await get('/');
    check('GET / serves the site', home.status === 200 && /Promota/.test(home.text));
    check('GET / sends a CSP', /default-src 'self'/.test(home.headers.get('content-security-policy') || ''));
    check('GET / sends nosniff', home.headers.get('x-content-type-options') === 'nosniff');
    check('GET / sends frame-deny', home.headers.get('x-frame-options') === 'DENY');

    const legal = await get('/privacy.html');
    check('legal pages are served', legal.status === 200 && /Privacy Policy/.test(legal.text));
  }

  /* ------------------------------------------------------ runtime config */
  {
    const cfg = await get('/config.js');
    check('/config.js is served as javascript', /javascript/.test(cfg.headers.get('content-type') || ''));
    check('/config.js injects only a publishable key',
      /SUPABASE_ANON_KEY/.test(cfg.text) && !/sb_secret|FLWSECK|tlv__/.test(cfg.text),
      cfg.text.slice(0, 120));
  }

  /* ------------------------------------------------------------ healthcheck */
  {
    const h = await get('/healthz');
    check('/healthz is 200 with ok=true', h.status === 200 && h.body.ok === true);
    check('/healthz reports supabase configured', h.body.config === true, JSON.stringify(h.body.providers));
    check('/healthz reports termii configured', h.body.providers.termii === true);
    check('/healthz reports flutterwave configured', h.body.providers.flutterwave === true);
    check('/healthz reports sessions configured', h.body.auth === true);
    check('/healthz admits data is NOT ready',
      h.body.providers.data.ready === false && typeof h.body.providers.data.reason === 'string');
    check('/healthz leaks no secret', !/sb_secret|FLWSECK|tlv__|SESSION_SECRET/.test(h.text));
  }

  /* ------------------------------------------------------------ API routing */
  {
    const unknown = await get('/api/does-not-exist');
    check('an unknown /api path is 404', unknown.status === 404);

    const noAuth = await get('/api/me');
    check('/api/me without a session is 401', noAuth.status === 401, JSON.stringify(noAuth.body));

    const badToken = await get('/api/me', { headers: { authorization: 'Bearer forged.token.here' } });
    check('/api/me with a forged session is 401', badToken.status === 401);

    const badPhone = await get('/api/auth/otp/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '12345' }),
    });
    check('a malformed phone is 400, not 503', badPhone.status === 400, JSON.stringify(badPhone.body));

    const badJson = await get('/api/me', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    check('a non-JSON body is 400', badJson.status === 400);

    const hook = await get('/api/webhooks/flutterwave', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'verif-hash': 'wrong' },
      body: '{}',
    });
    check('the payout webhook rejects a bad signature', hook.status === 401);
  }

  /* --------------------------------------------------------- rate limiting */
  {
    let sawLimit = false;
    for (let i = 0; i < 90; i++) {
      const r = await get('/api/nope');
      if (r.status === 429) { sawLimit = true; break; }
    }
    check('the API rate limits a flood', sawLimit);
  }

  /* --------------------------------------------------------- method guard */
  {
    const post = await fetch(`${BASE}/styles.css`, { method: 'POST', signal: AbortSignal.timeout(8000) });
    check('a POST to a static path is 405', post.status === 405, `got ${post.status}`);
  }

  if (stderr.trim()) {
    console.log('\n  server stderr (first lines):');
    stderr.split('\n').slice(0, 5).forEach(l => console.log(`    ${l}`));
  }
} catch (e) {
  check('smoke run completed', false, String(e.message));
} finally {
  child.kill('SIGTERM');
  await wait(300);
  if (!child.killed) child.kill('SIGKILL');
}

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
console.log(`  SERVER SMOKE: ${fail === 0 ? 'ALL HOLD' : 'ATTENTION'}`);
process.exit(fail === 0 ? 0 : 1);