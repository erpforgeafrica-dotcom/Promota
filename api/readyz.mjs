/**
 * readyz.mjs — readiness probe for deploy safety.
 *
 * /healthz answers "is the process up and what is configured" (its exact
 * shape is frozen: railway.json + api/server.smoke.mjs depend on it).
 * ready() answers the stricter question "is this instance ready to serve
 * traffic": Supabase is reachable, the flags table is readable, and the
 * database has every migration the repo ships.
 *
 * Output carries no secrets: only booleans, counts and truncated reasons.
 * Env var VALUES are never read here, let alone returned.
 */
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sb from './supabase.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'db', 'migrations');

/** Production migrations: NNNN_*.sql at the top level (local/ stubs excluded). */
export function repoMigrations() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const versions = files.map((f) => Number(f.slice(0, 4)));
  return { count: files.length, max: versions.length ? Math.max(...versions) : 0 };
}

const reasonOf = (e) => String(e?.message || e || 'unknown').slice(0, 200);

/**
 * Readiness check. Never throws: every dependency failure is a
 * { ok: false, reason } check, not an exception.
 */
export async function ready() {
  let repo = { count: 0, max: 0 };
  let repoError = null;
  try {
    repo = repoMigrations();
  } catch (e) {
    // db/migrations is absent from minimal images: report not-ready, never throw.
    repoError = reasonOf(e);
  }
  const checks = {
    supabase: { ok: false },
    flags: { ok: false },
    migrations: repoError
      ? { ok: false, repo: 0, reason: `repo migrations unreadable: ${repoError}` }
      : { ok: false, repo: repo.count },
  };

  if (!sb.configured()) {
    const reason = 'supabase is not configured';
    checks.supabase = { ok: false, reason };
    checks.flags = { ok: false, reason };
    checks.migrations = { ok: false, repo: repo.count, reason };
    return { ready: false, checks };
  }

  // Supabase ping: one cheap read against a core table that exists since 0001.
  try {
    await sb.select('settings', 'select=key&limit=1');
    checks.supabase = { ok: true };
  } catch (e) {
    checks.supabase = { ok: false, reason: reasonOf(e) };
  }

  // Flags table readable (service_role bypasses RLS; a missing 0010 reads as not-ready).
  try {
    await sb.select('flags', 'select=key&limit=1');
    checks.flags = { ok: true };
  } catch (e) {
    checks.flags = { ok: false, reason: reasonOf(e) };
  }

  // Applied migrations: max applied version must equal the repo's migration count
  // (numbering is contiguous 0001..NNNN, so max == count when fully applied).
  try {
    const rows = await sb.select('owoworks_schema_migrations', 'select=filename');
    const versions = (rows || [])
      .map((r) => (/^(\d{4})_/.exec(r?.filename || '') || [])[1])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    const applied = versions.length ? Math.max(...versions) : 0;
    checks.migrations = applied === repo.count
      ? { ok: true, repo: repo.count, applied }
      : {
          ok: false,
          repo: repo.count,
          applied,
          reason: `database is at migration ${applied}, repo ships ${repo.count}`,
        };
  } catch (e) {
    checks.migrations = { ok: false, repo: repo.count, reason: reasonOf(e) };
  }

  const isReady = checks.supabase.ok && checks.flags.ok && checks.migrations.ok;
  return { ready: isReady, checks };
}
