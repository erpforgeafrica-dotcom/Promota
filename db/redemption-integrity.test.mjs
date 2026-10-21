#!/usr/bin/env node
/**
 * redemption-integrity.test.mjs — adversarial tests for migration 0014.
 *
 * Every claim is the OPPOSITE of the happy path: the new constraints must
 * REFUSE. Runs against PGlite (real PostgreSQL), same discipline as
 * points.test.mjs — each case in its own savepoint, accepts() commits,
 * rejects() rolls back.
 *
 * The concurrency claim (two simultaneous redemptions cannot both pass the
 * balance check) is proven structurally: the function takes a per-profile
 * advisory transaction lock BEFORE reading the balance, and the deferred
 * constraint trigger refuses any insert that would leave a negative balance.
 * PGlite here is single-connection, so the true two-session interleaving is
 * UNVERIFIED locally; the lock + guard are the mechanism, and the guard is
 * exercised directly below.
 */
import { withDb, migrate } from '../scripts/migrateUp.mjs';

let pass = 0, fail = 0;
function check(label, ok, detail) {
  console.log(ok ? `  PASS  ${label}` : `  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}
async function scalar(db, sql) {
  const r = await db.query(sql);
  return r.rows?.[0] ? Object.values(r.rows[0])[0] : undefined;
}
async function accepts(db, label, sql) {
  await db.exec('begin'); await db.exec('savepoint sp');
  try { await db.exec(sql); await db.exec('release sp'); await db.exec('commit'); check(label, true); }
  catch (e) { await db.exec('rollback'); check(label, false, e.message); }
}
async function rejects(db, label, sql, frag) {
  await db.exec('begin'); await db.exec('savepoint sp');
  try { await db.exec(sql); await db.exec('rollback'); check(label, false, 'was accepted but should be refused'); }
  catch (e) {
    await db.exec('rollback');
    const ok = !frag || e.message.includes(frag);
    check(label, ok, ok ? undefined : `expected "${frag}" got "${e.message}"`);
  }
}

await withDb(async (db) => {
  await migrate(db);
  const P = '11111111-1111-1111-1111-111111111111';

  // Fixture: one authed promoter with a spendable balance. An 'adjustment'
  // entry is the sanctioned non-redemption credit path.
  await db.exec(`
    insert into auth.users (id, email) values ('${P}', 'ri@test.local');
    insert into profiles (id, role, state, display_name, phone_e164, phone_verified_at)
    values ('${P}', 'promoter', 'active', 'Redemption Test', '08030000009', now());
    insert into point_entries (profile_id, task_id, kind, points, idempotency_key, memo)
    values ('${P}', null, 'adjustment', 5000, 'ri-seed', 'test seed balance')
    on conflict (idempotency_key) do nothing;`);

  console.log('\n[0014] plan_code column exists');
  const col = await scalar(db, `
    select count(*)::int from information_schema.columns
    where table_name = 'redemptions' and column_name = 'plan_code'`);
  check('redemptions.plan_code is present', col === 1, `count=${col}`);

  console.log('\n[0014] a data redemption now REQUIRES a plan code');
  await rejects(db, 'data redemption with null plan_code is refused', `
    select redeem_points('${P}','data',500,'ri-noplan','MTN')`,
    'needs a plan code');
  await rejects(db, 'data redemption with blank plan_code is refused', `
    select redeem_points('${P}','data',500,'ri-blankplan','MTN','   ')`,
    'needs a plan code');

  console.log('\n[0014] nonce-scoped idempotency');
  await accepts(db, 'a data redemption with a plan code is created', `
    select redeem_points('${P}','data',500,'ri-a','MTN','MTN DATA - 110MB - DAILY PLAN')`);
  const planStored = await scalar(db, `
    select plan_code from redemptions where idempotency_key = 'ri-a'`);
  check('the plan code was persisted on the redemption', planStored === 'MTN DATA - 110MB - DAILY PLAN', `got ${planStored}`);

  const evt = await scalar(db, `
    select payload->>'plan_code' from outbox
    where topic='redemption.requested' and payload->>'redemption_id' = (select id::text from redemptions where idempotency_key='ri-a')`);
  check('the outbox event carries the plan code', evt === 'MTN DATA - 110MB - DAILY PLAN', `got ${evt}`);

  await accepts(db, 'replaying the SAME nonce is idempotent (no throw)', `
    select redeem_points('${P}','data',500,'ri-a','MTN','MTN DATA - 110MB - DAILY PLAN')`);
  const rowsForNonce = await scalar(db, `
    select count(*)::int from redemptions where idempotency_key = 'ri-a'`);
  check('replay produced exactly one redemption row', rowsForNonce === 1, `count=${rowsForNonce}`);
  const outboxForNonce = await scalar(db, `
    select count(*)::int from outbox where topic='redemption.requested'
      and payload->>'redemption_id' = (select id::text from redemptions where idempotency_key='ri-a')`);
  check('replay produced exactly one outbox event', outboxForNonce === 1, `count=${outboxForNonce}`);

  const balBefore = Number(await scalar(db, `select points_balance('${P}')`));
  await accepts(db, 'a NEW nonce for the same amount is a genuine second redemption', `
    select redeem_points('${P}','data',500,'ri-b','MTN','MTN DATA - 110MB - DAILY PLAN')`);
  const balAfter = Number(await scalar(db, `select points_balance('${P}')`));
  check('the second redemption actually debited points', balAfter === balBefore - 500, `before=${balBefore} after=${balAfter}`);

  console.log('\n[0014] negative balance is impossible');
  const bal = Number(await scalar(db, `select points_balance('${P}')`));
  await rejects(db, 'a redemption above the balance is still refused', `
    select redeem_points('${P}','data',${bal + 1},'ri-over','MTN','MTN DATA - 110MB - DAILY PLAN')`,
    'insufficient points');

  // The guard itself: hand-insert a debit that exceeds the balance.
  // The guard itself: hand-insert a debit that exceeds the balance. The
  // constraint trigger is DEFERRED, so the refusal surfaces at COMMIT — the
  // case commits explicitly and expects the commit to fail.
  await db.exec('begin');
  try {
    await db.exec(`
      insert into point_entries (profile_id, task_id, kind, points, idempotency_key, memo)
      values ('${P}', null, 'redemption', -(select points_balance('${P}') + 1000), 'ri-guard', 'forced negative')`);
    await db.exec('commit');
    check('a raw negative-balance insert is refused by the trigger', false, 'commit succeeded but should have been refused');
  } catch (e) {
    await db.exec('rollback');
    check('a raw negative-balance insert is refused by the trigger', e.message.includes('negative'), e.message);
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
});
