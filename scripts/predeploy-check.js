#!/usr/bin/env node
/**
 * predeploy-check.js — deploy gate. Fails the build before Railway does.
 *
 *   (a) required env NAMES present (presence only — values are never printed)
 *   (b) repo migration count matches the database's max applied version,
 *       but ONLY when the DB is reachable; otherwise warn-and-skip
 *   (c) the CSP snapshot in server.mjs still contains script-src 'self'
 *
 * Exit 0 when green (or DB-unreachable with a warning), non-zero on failure.
 * Node built-ins only: the Dockerfile runs no `npm install`.
 */
const { readdirSync, readFileSync, existsSync } = require('node:fs');
const { join, dirname } = require('node:path');

const ROOT = join(dirname(__filename), '..');

let pass = 0, fail = 0, warnings = 0;
const ok = (label) => { pass++; console.log(`  PASS  ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
};
const warn = (label, detail) => {
  warnings++;
  console.log(`  WARN  ${label}${detail ? `\n          -> ${detail}` : ''}`);
};

/* Load .env keys as a fallback so a local run behaves like Railway, where
 * these arrive as real environment variables. Only NAMES are ever reported. */
function loadDotEnv() {
  const found = [];
  try {
    const p = join(ROOT, '.env');
    if (!existsSync(p)) return found;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line || /^\s*#/.test(line)) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      if (!k) continue;
      if (!process.env[k]) {
        process.env[k] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
        found.push(k);
      }
    }
  } catch { /* no .env — Railway provides real env vars */ }
  return found;
}

/* ------------------------------------------------------------ (a) env names */
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'FLUTTERWAVE_SECRET_KEY',
  'TERMII_API_KEY',
  'SESSION_SECRET',
];

loadDotEnv();
{
  const missing = REQUIRED_ENV.filter((n) => !String(process.env[n] || '').trim());
  if (missing.length === 0) ok(`required env names present (${REQUIRED_ENV.length}/${REQUIRED_ENV.length})`);
  else bad('required env names present', `missing: ${missing.join(', ')}`);
}

/* ------------------------------------------------- (b) migration parity */
function repoMigrationCount() {
  return readdirSync(join(ROOT, 'db', 'migrations'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .length;
}

async function checkMigrations() {
  const repoCount = repoMigrationCount();
  const base = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!base || !key) {
    warn('migration parity skipped', 'database is not reachable from here (no service credential in env)');
    return;
  }
  let res;
  try {
    res = await fetch(
      `${base.replace(/\/+$/, '')}/rest/v1/owoworks_schema_migrations?select=filename`,
      {
        method: 'GET',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      }
    );
  } catch (e) {
    warn('migration parity skipped', `database is not reachable: ${String(e.message || e).slice(0, 120)}`);
    return;
  }
  if (!res.ok) {
    bad('migration parity', `ledger query answered HTTP ${res.status} — database is reachable but the ledger is not`);
    return;
  }
  let rows;
  try {
    rows = await res.json();
  } catch {
    bad('migration parity', 'ledger query returned a body that is not JSON');
    return;
  }
  const versions = (Array.isArray(rows) ? rows : [])
    .map((r) => (/^(\d{4})_/.exec(r && r.filename ? String(r.filename) : '') || [])[1])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const applied = versions.length ? Math.max(...versions) : 0;
  if (applied === repoCount) ok(`migration parity (repo ${repoCount}, database max ${applied})`);
  else bad('migration parity', `repo ships ${repoCount} migration(s) but the database max is ${applied}`);
}

/* ---------------------------------------------------------- (c) CSP snapshot */
{
  let src = '';
  try {
    src = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  } catch (e) {
    bad('CSP snapshot', `could not read server.mjs: ${String(e.message || e).slice(0, 120)}`);
  }
  if (src && src.includes("script-src 'self'")) ok("CSP snapshot still contains script-src 'self'");
  else if (src) bad('CSP snapshot', "server.mjs no longer contains script-src 'self'");
}

async function main() {
  await checkMigrations();
  console.log(`\n  PASS ${pass}   WARN ${warnings}   FAIL ${fail}`);
  console.log(`  PREDEPLOY CHECK: ${fail === 0 ? 'GO' : 'NO-GO'}`);
  // exitCode (not process.exit): process.exit with live sockets trips a
  // libuv assertion on Windows and masks the real code.
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(`  FAIL  predeploy check crashed: ${String(e.message || e).slice(0, 200)}`);
  process.exitCode = 1;
});
