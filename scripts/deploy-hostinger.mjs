#!/usr/bin/env node
/* deploy-hostinger.mjs — Promota → Hostinger managed hosting (promota.click)
 *
 * The Hostinger API token is NOT stored in the repository. It lives in the
 * owner's machine file below (label line "EngrhostingerPromotatoken", secret
 * line 2). This path is the single hardcoded reference for regular access.
 * Never commit, print, or echo the token value.
 *
 * Actions:
 *   node scripts/deploy-hostinger.mjs deploy     configure settings + env, start build, watch to terminal state
 *   node scripts/deploy-hostinger.mjs env        (re)apply .env to Hostinger build env
 *   node scripts/deploy-hostinger.mjs status     website, git installation, build settings, builds, env keys
 *   node scripts/deploy-hostinger.mjs logs <uuid>
 *   node scripts/deploy-hostinger.mjs restart
 * Flags:
 *   --no-watch          POST the build and exit without polling
 *   HOSTINGER_KEY_FILE  override the token file path (default below)
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FILE = process.env.HOSTINGER_KEY_FILE || 'C:\\Users\\pc\\HOSTINGER API KEY.txt';
const BASE = 'https://developers.hostinger.com/api/hosting/v1';
const USER = 'u515553672';
const DOMAIN = 'promota.click';
const INSTALLATION_UUID = '01a16c1d-7a43-70fc-a943-10885016dd9e';
const Owner = 'erpforgeafrica-dotcom';
const REPO = 'Promota';
const BRANCH = 'main';
const ENTRY_FILE = 'server.mjs';
const NODE_VERSION = 22;
const SITE = `${BASE}/accounts/${USER}/websites/${DOMAIN}`;

function token() {
  const lines = readFileSync(TOKEN_FILE, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l.length >= 20);
  if (!lines.length) throw new Error(`No usable token line found in "${TOKEN_FILE}"`);
  return lines[lines.length - 1];
}

const AUTH = () => ({ 'Authorization': `Bearer ${token()}`, 'Accept': 'application/json' });
async function api(method, path, body) {
  const res = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, {
    method,
    headers: { ...AUTH(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${method} ${path}`);
    console.error(JSON.stringify(json, null, 1).slice(0, 4000));
    throw new Error(`request failed (${res.status})`);
  }
  return json;
}

function parseDotEnv() {
  const raw = readFileSync(join(ROOT, '.env'), 'utf8');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) { console.log(`skip non-uppercase env key: ${key}`); continue; }
    env[key] = value;
  }
  return env;
}

const CORE = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET', 'SESSION_TTL_HOURS', 'PAYOUT_ENCRYPTION_KEY',
  'WORKER_ENABLED', 'RATE_LIMIT_PER_MIN', 'TRUST_PROXY_HOPS',
  'FLUTTERWAVE_PUBLIC_KEY', 'FLUTTERWAVE_SECRET_KEY', 'FLUTTERWAVE_ENCRYPTION_KEY',
  'FLUTTERWAVE_WEBHOOK_SECRET', 'FLUTTERWAVE_BASE_URL',
  'TERMII_API_KEY', 'TERMII_BASE_URL', 'TERMII_SENDER_ID',
  'TWENTY5_API_KEY', 'TWENTY5_BASE_URL', 'TWENTY5_SPEC_URL', 'TWENTY5_PUBLIC_KEY',
  'VTU_BASE_URL', 'VTU_AUTH_URL', 'VTU_USERNAME', 'VTU_PASSWORD', 'VTU_USER_PIN'];

async function putEnv() {
  const env = parseDotEnv();
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET', 'PAYOUT_ENCRYPTION_KEY'];
  const missing = required.filter(k => !env[k]);
  if (missing.length) throw new Error('.env missing required keys: ' + missing.join(', '));
  const env_vars = {};
  for (const k of CORE) if (env[k] !== undefined) env_vars[k] = env[k];
  env_vars.TRUST_PROXY_HOPS = env_vars.TRUST_PROXY_HOPS || '1';
  const payload = { env_vars: Object.entries(env_vars).map(([key, value]) => ({ key, value })) };
  await api('PUT', '/accounts/' + USER + '/websites/' + DOMAIN + '/nodejs/builds/settings/env', payload);
  console.log('env applied:', Object.keys(env_vars).join(', '));
}

async function putSettings() {
  await api('PUT', '/accounts/' + USER + '/websites/' + DOMAIN + '/nodejs/builds/settings', {
    node_version: NODE_VERSION,
    app_type: 'other',
    root_directory: '.',
    output_directory: '.',
    build_script: '',
    entry_file: ENTRY_FILE,
    package_manager: 'npm',
  });
  console.log(`settings applied: node ${NODE_VERSION}, entry ${ENTRY_FILE}, app other`);
}

async function startBuild() {
  const commit = await latestMainSha();
  const body = {
    node_version: NODE_VERSION,
    app_type: 'other',
    root_directory: '.',
    output_directory: '.',
    build_script: '',
    entry_file: ENTRY_FILE,
    package_manager: 'npm',
    source_type: 'git',
    source_options: {
      owner: Owner,
      repository: REPO,
      branch: BRANCH,
      installation_uuid: INSTALLATION_UUID,
      commit,
    },
  };
  const res = await api('POST', '/accounts/' + USER + '/websites/' + DOMAIN + '/nodejs/builds', body);
  const build = res.data || res;
  console.log('build started:', build.uuid || res.uuid || JSON.stringify(res).slice(0, 200));
  return build.uuid || res.uuid;
}

async function latestMainSha() {
  const url = `https://api.github.com/repos/${Owner}/${REPO}/branches/${BRANCH}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
  if (!res.ok) return null;
  const j = await res.json();
  return j.commit && j.commit.sha;
}

async function watch(uuid) {
  const terminus = ['ready', 'done', 'success', 'failed', 'error', 'aborted', 'cancelled'];
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 12000));
    const build = await api('GET', '/accounts/' + USER + '/websites/' + DOMAIN + '/nodejs/builds/' + uuid);
    const b = build.data || build;
    const status = b.status || b.state || 'unknown';
    console.log(`build ${uuid} status: ${status}`);
    if (terminus.includes(status)) {
      if (['failed', 'error', 'aborted', 'cancelled'].includes(status)) {
        const logs = await api('GET', '/accounts/' + USER + '/websites/' + DOMAIN + '/nodejs/builds/' + uuid + '/logs');
        const t = typeof logs === 'string' ? logs : JSON.stringify(logs);
        console.log('--- build log tail ---');
        console.log(t.split(/\r?\n/).slice(-60).join('\n'));
        process.exitCode = 1;
      }
      return;
    }
  }
  console.log('watch timeout — check logs with: node scripts/deploy-hostinger.mjs logs ' + uuid);
}

const [action, ...rest] = process.argv.slice(2);
if (!action || ['help', '--help'].includes(action)) {
  console.log('usage: node scripts/deploy-hostinger.mjs deploy|env|status|logs <uuid>|restart [--no-watch]');
  process.exit(0);
}
try {
  if (action === 'deploy') {
    const watchFlag = !process.argv.includes('--no-watch');
    await putEnv();
    await putSettings();
    const uuid = await startBuild();
    if (watchFlag && uuid) await watch(uuid);
  } else if (action === 'env') {
    await putEnv();
  } else if (action === 'status') {
    const website = await api('GET', '/websites');
    console.log('websites:', JSON.stringify(website).slice(0, 600));
    try {
      const git = await api('GET', '/git/installations');
      console.log('git installations:', JSON.stringify(git).slice(0, 400));
    } catch (e) { console.log('git installations: unavailable'); }
    for (const path of ['/nodejs/builds/settings', '/nodejs/builds', '/nodejs/builds/settings/env']) {
      const j = await api('GET', SITE + path);
      const redacted = path.endsWith('/env')
        ? (j.data || j || []).map(e => e.key || e).join(', ')
        : JSON.stringify(j).slice(0, 500);
      console.log(path, redacted);
    }
  } else if (action === 'logs' && rest[0]) {
    const logs = await api('GET', '/accounts/' + USER + '/websites/' + DOMAIN + '/nodejs/builds/' + rest[0] + '/logs');
    const t = typeof logs === 'string' ? logs : JSON.stringify(logs, null, 1);
    console.log(t.slice(-8000));
  } else if (action === 'restart') {
    await api('POST', '/accounts/' + USER + '/websites/' + DOMAIN + '/nodejs/server/restart', {});
    console.log('restart requested');
  } else {
    console.log('unknown action', action);
    process.exitCode = 1;
  }
} catch (e) {
  console.error('deployment failed:', e.message);
  process.exit(1);
}
