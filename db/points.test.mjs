#!/usr/bin/env node
/**
 * points.test.mjs — adversarial tests for the points / levels / referrals /
 * redemption model (migration 0008).
 *
 * Same discipline as ledger.test.mjs: every case in its own transaction,
 * accepts() commits, rejects() rolls back. The claim under test is always the
 * opposite of the happy path.
 *
 * RLS under a real anon/authenticated JWT is UNVERIFIED locally (PGlite's
 * superuser bypasses it) — venue: Supabase staging + JWTs, same as leads.
 */
import { withDb, migrate } from '../scripts/migrateUp.mjs';

let pass = 0, fail = 0, unverifiedCount = 0;
function check(label, ok, detail) {
  console.log(ok ? `  PASS  ${label}` : `  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}
function unverified(label, reason) {
  unverifiedCount++;
  console.log(`  UNVERIFIED  ${label}\n          -> ${reason}`);
}
// Each case runs inside its own SAVEPOINT so a refusal can never leak into the
// next case: a failed statement aborts the enclosing transaction, and a leaked
// abort would silently roll back (or commit) a later case's work.
async function rejects(db, label, sql, frag) {
  await db.exec('begin');
  await db.exec('savepoint sp_case');
  let err = null;
  try { await db.exec(sql); }
  catch (e) { err = e; }
  if (err) await db.exec('rollback to savepoint sp_case');
  await db.exec('release savepoint sp_case');
  await db.exec('commit');
  if (!err) { check(label, false, 'database ACCEPTED a write it must refuse'); return; }
  const msg = String(err.message || err);
  const ok = !frag || msg.toLowerCase().includes(frag.toLowerCase());
  check(label, ok, ok ? '' : `wrong reason (wanted "${frag}")\n          got: ${msg.split('\n')[0]}`);
}
async function accepts(db, label, sql) {
  await db.exec('begin');
  try {
    await db.exec('savepoint sp_case');
    await db.exec(sql);
    await db.exec('release savepoint sp_case');
    await db.exec('commit');
    check(label, true);
    return true;
  } catch (e) {
    try { await db.exec('rollback'); } catch { /* already unwound */ }
    check(label, false, String(e.message || e).split('\n')[0]);
    return false;
  }
}
async function scalar(db, sql) {
  const r = await db.query(sql);
  return r.rows[0]?.v;
}

/** Two authed promoters; one assigned a task worth 100 points. */
async function seed(db) {
  await db.exec(`
    insert into auth.users (id, email) values
      ('11111111-1111-1111-1111-111111111111', 'a@test.local'),
      ('22222222-2222-2222-2222-222222222222', 'b@test.local'),
      ('33333333-3333-3333-3333-333333333333', 'c@test.local');

    insert into profiles (id, role, state, display_name, phone_e164, phone_verified_at)
    values
      ('11111111-1111-1111-1111-111111111111','promoter','active','Ada','08030000001', now()),
      ('22222222-2222-2222-2222-222222222222','promoter','active','Bode','08030000002', now()),
      ('33333333-3333-3333-3333-333333333333','promoter','active','Chidi','08030000003', now());

    insert into campaigns (id, owner_id, title, brief, platform, objective, state,
                           budget_minor, price_per_outcome_minor, promoter_share_bp,
                           fraud_reserve_bp, margin_floor_bp, hold_hours)
    values ('44444444-4444-4444-4444-444444444444',
            '33333333-3333-3333-3333-333333333333',
            'Pilot campaign','brief','instagram','click','draft',
            10000000, 500, 4500, 500, 4000, 72);

    insert into tasks (id, campaign_id, state, caption, tracked_link, reward_minor,
                      points_awarded, assigned_to, assigned_at)
    values ('55555555-5555-5555-5555-555555555555',
            '44444444-4444-4444-4444-444444444444',
            'assigned','caption','https://t.example/1', 5000, 100,
            '11111111-1111-1111-1111-111111111111', now());
  `);
}

await withDb(async db => {
  await migrate(db, { quiet: true });
  await seed(db);

  /* ------------------------------------------------ 1. the ladder exists */
  {
    const n = await scalar(db, `select count(*)::int as v from levels`);
    check('levels ladder is seeded', n >= 6, `levels=${n}`);

    const gate = await scalar(db,
      `select count(*)::int as v from levels where level <= 3 and min_referrals <> 0`);
    check('the first three levels require zero referrals', gate === 0,
      `levels 1-3 with a referral gate: ${gate}`);

    const from = await scalar(db,
      `select (value->>'v')::int as v from settings where key = 'levels.referral_gate_from'`);
    check('the referral gate starts at the level the owner configured', from === 4, `from=${from}`);

    const cash = await scalar(db,
      `select (value->>'v')::int as v from settings where key = 'levels.cash_unlock_from'`);
    check('the cash unlock level is a setting, not a constant', cash >= 1, `from=${cash}`);
  }

  /* ------------------------------------------- 2. points are append-only */
  {
    await accepts(db, 'a task reward can be awarded',
      `select award_task_points('55555555-5555-5555-5555-555555555555')`);

    await rejects(db, 'UPDATE on a point entry is refused', `
      update point_entries set points = 999999
       where idempotency_key = 'task:55555555-5555-5555-5555-555555555555'`, 'append-only');

    await rejects(db, 'DELETE on a point entry is refused', `
      delete from point_entries
       where idempotency_key = 'task:55555555-5555-5555-5555-555555555555'`, 'append-only');
  }

  /* --------------------------------------------- 3. idempotency of award */
  {
    const first = await scalar(db,
      `select award_task_points('55555555-5555-5555-5555-555555555555') as v`);
    check('re-awarding the same task returns 0', first === 0, `got ${first}`);

    const bal = await scalar(db,
      `select points_balance('11111111-1111-1111-1111-111111111111') as v`);
    check('a task pays exactly once', bal === 100, `balance=${bal} (want 100)`);

    const rows = await scalar(db, `
      select count(*)::int as v from point_entries
       where idempotency_key = 'task:55555555-5555-5555-5555-555555555555'`);
    check('only one point entry exists for the task', rows === 1, `rows=${rows}`);
  }

  /* --------------------------------- 4. balance is derived, never stored */
  {
    const bal = await scalar(db,
      `select points_balance('11111111-1111-1111-1111-111111111111') as v`);
    check('points_balance sums entries (100 for one task)', bal === 100, `balance=${bal}`);
  }

  /* ------------------------------------------- 5. reward needs a task */
  {
    await rejects(db, 'a task reward with no task_id is refused', `
      insert into point_entries (profile_id, task_id, kind, points, idempotency_key)
      values ('11111111-1111-1111-1111-111111111111', null, 'task_reward', 100, 'orphan')`,
      'task_reward_attributable');

    await rejects(db, 'a zero-point entry is refused', `
      insert into point_entries (profile_id, task_id, kind, points, idempotency_key)
      values ('11111111-1111-1111-1111-111111111111',
              '55555555-5555-5555-5555-555555555555','task_reward',0,'zero')`,
      'point_entries_nonzero');

    await rejects(db, 'a negative-point task reward is refused', `
      insert into point_entries (profile_id, task_id, kind, points, idempotency_key)
      values ('11111111-1111-1111-1111-111111111111',
              '55555555-5555-5555-5555-555555555555','task_reward',-100,'neg')`,
      'rewards_positive');
  }

  /* ------------------------------ 6. awarding an unassigned task refuses */
  {
    await db.exec(`insert into tasks (id, campaign_id, state, caption, tracked_link, reward_minor)
      values ('66666666-6666-6666-6666-666666666666',
              '44444444-4444-4444-4444-444444444444','draft','c','https://t.example/2',5000)`);
    await rejects(db, 'points cannot be awarded for an unassigned task',
      `select award_task_points('66666666-6666-6666-6666-666666666666')`, 'not assigned');
  }

  /* ------------------------------------- 7. referrals need two profiles */
  {
    await rejects(db, 'a profile cannot refer itself', `
      insert into referrals (referrer_id, referee_id) values
        ('11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111')`,
      'referrals_no_self');

    await rejects(db, 'one referee cannot be referred twice', `
      insert into referrals (referrer_id, referee_id) values
        ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222');
      insert into referrals (referrer_id, referee_id) values
        ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222');`,
      'unique');

    await accepts(db, 'a valid referral is recorded', `
      insert into referrals (referrer_id, referee_id) values
        ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222')`);
  }

  /* ------------------------ 8. an invite alone earns nothing (anti-farming) */
  {
    const bal = await scalar(db,
      `select points_balance('11111111-1111-1111-1111-111111111111') as v`);
    check('an unqualified referral awards ZERO points', bal === 100, `balance=${bal} (want 100)`);

    const q = await scalar(db, `
      select count(*)::int as v from referrals
       where referrer_id = '11111111-1111-1111-1111-111111111111' and qualified_at is not null`);
    check('an unqualified referral is not counted', q === 0, `qualified=${q}`);
  }

  /* ---------------------------- 9. qualifying a referral pays points only */
  {
    await accepts(db, 'qualifying a referral succeeds',
      `select qualify_referral('22222222-2222-2222-2222-222222222222')`);

    const bal = await scalar(db,
      `select points_balance('11111111-1111-1111-1111-111111111111') as v`);
    check('referral points land for the REFERRER (100 + 300)', bal === 400, `balance=${bal}`);

    const again = await scalar(db,
      `select qualify_referral('22222222-2222-2222-2222-222222222222') as v`);
    check('re-qualifying the same referral returns 0', again === 0, `got ${again}`);

    const bal2 = await scalar(db,
      `select points_balance('11111111-1111-1111-1111-111111111111') as v`);
    check('referral points are paid once', bal2 === 400, `balance=${bal2}`);

    const cash = await scalar(db,
      `select count(*)::int as v from point_entries
        where profile_id = '11111111-1111-1111-1111-111111111111'
          and kind = 'referral_reward' and points < 0`);
    check('referral reward is positive (points, never negative cash)', cash === 0, `negative=${cash}`);
  }

  /* ------------------------------- 10. referee gains nothing from the invite */
  {
    const bal = await scalar(db,
      `select points_balance('22222222-2222-2222-2222-222222222222') as v`);
    check('the referee earns no points for being referred', bal === 0, `balance=${bal}`);
  }

  /* --------------------------------- 11. levels are gated by referrals */
  {
    const lvl = await scalar(db,
      `select level_for('11111111-1111-1111-1111-111111111111') as v`);
    check('250 points + 1 referral does not reach a referral-gated level', lvl < 4, `level=${lvl}`);

    // give the referrer enough points to hit level 4's threshold (4000)
    await accepts(db, 'bulk points can be added for the gate test', `
      insert into point_entries (profile_id, task_id, kind, points, idempotency_key)
      values ('11111111-1111-1111-1111-111111111111', null, 'adjustment', 3750, 'seed-adjust')`);

    const lvl2 = await scalar(db,
      `select level_for('11111111-1111-1111-1111-111111111111') as v`);
    check('4000 points but only 1 referral is still below level 4', lvl2 < 4, `level=${lvl2}`);

    const need = await scalar(db, `
      select referrals_needed as v from next_level_requirements('11111111-1111-1111-1111-111111111111')`);
    check('next_level_requirements reports the referral shortfall', need > 0, `needed=${need}`);
  }

  /* ---------------------------- 12. cash is locked until the level allows */
  {
    const unlocked = await scalar(db,
      `select cash_unlocked('11111111-1111-1111-1111-111111111111') as v`);
    check('cash is NOT unlocked below the configured level', unlocked === false, `unlocked=${unlocked}`);

    await rejects(db, 'cash redemption is refused below the unlock level', `
      select redeem_points('11111111-1111-1111-1111-111111111111','cash',10000,'redeem-cash-1')`,
      'not unlocked');
  }

  /* ------------------------------------ 13. data redemption rules hold */
  {
    await rejects(db, 'a data redemption without a network is refused', `
      select redeem_points('11111111-1111-1111-1111-111111111111','data',500,'redeem-d-0')`,
      'needs a network');

    await rejects(db, 'a redemption below the minimum is refused', `
      select redeem_points('11111111-1111-1111-1111-111111111111','data',10,'redeem-d-1','MTN')`,
      'minimum');

    await rejects(db, 'a redemption above the balance is refused', `
      select redeem_points('11130000-0000-0000-0000-000000000000','data',500,'redeem-d-2','MTN','MTN DATA - 1GB - MONTHLY')`,
      'insufficient points');

    await rejects(db, 'a zero-point redemption is refused', `
      select redeem_points('11111111-1111-1111-1111-111111111111','data',0,'redeem-d-3','MTN','MTN DATA - 1GB - MONTHLY')`,
      'positive');
  }

  /* ---------------------- 14. the balance actually falls on redemption */
  {
    await accepts(db, 'a valid data redemption is created', `
      select redeem_points('11111111-1111-1111-1111-111111111111','data',500,'redeem-d-ok','MTN','MTN DATA - 1GB - MONTHLY')`);

    const bal = await scalar(db,
      `select points_balance('11111111-1111-1111-1111-111111111111') as v`);
    // 100 task + 300 referral + 3750 adjustment = 4150, minus the 500 redeemed
    check('redeeming debits the points (4150 - 500 = 3650)', bal === 3650, `balance=${bal}`);

    const replay = await scalar(db, `
      select count(*)::int as v from redemptions where idempotency_key = 'redeem-d-ok'`);
    check('only one redemption row exists for that key', replay === 1, `rows=${replay}`);

    const bal2 = await scalar(db,
      `select points_balance('11111111-1111-1111-1111-111111111111') as v`);
    check('replaying the same redemption does not double-debit', bal2 === 3650, `balance=${bal2}`);
  }

  /* ---------------------------- 15. fulfilment needs provider evidence */
  {
    await rejects(db, 'a redemption cannot be marked fulfilled with no provider reference', `
      update redemptions set state = 'fulfilled'
       where idempotency_key = 'redeem-d-ok'`, 'fulfilled_has_ref');
  }

  /* ------------------------------------------- 16. reversal is additive */
  {
    const before = await scalar(db,
      `select points_balance('11111111-1111-1111-1111-111111111111') as v`);
    await accepts(db, 'reversing a point entry is allowed',
      `select reverse_point_entry(
         (select id from point_entries where idempotency_key = 'seed-adjust'), 'test reversal')`);
    const after = await scalar(db,
      `select points_balance('11111111-1111-1111-1111-111111111111') as v`);
    check('a reversal nets the balance back out', after === before - 3750,
      `before=${before} after=${after}`);

    const dup = await scalar(db, `
      select reverse_point_entry(
        (select id from point_entries where idempotency_key = 'seed-adjust'), 'again') as v`);
    check('re-reversing the same entry is a no-op', dup === 3750, `got ${dup}`);
  }

  /* ------------------------------------- 17. a reversal must point at one */
  {
    await rejects(db, 'a reversal with no target entry is refused', `
      insert into point_entries (profile_id, task_id, kind, points, idempotency_key)
      values ('11111111-1111-1111-1111-111111111111', null, 'reversal', -50, 'orphan-reversal')`,
      'reversal_shape');
  }

  /* --------------------------------- 18. rewards are capped by task value */
  {
    await db.exec(`update tasks set points_awarded = 250
      where id = '66666666-6666-6666-6666-666666666666'`);
    await db.exec(`update tasks set state = 'assigned', assigned_to = '22222222-2222-2222-2222-222222222222'
      where id = '66666666-6666-6666-6666-666666666666'`);

    await accepts(db, 'a second task awards its own value',
      `select award_task_points('66666666-6666-6666-6666-666666666666')`);
    const bal = await scalar(db,
      `select points_balance('22222222-2222-2222-2222-222222222222') as v`);
    check('the second promoter earns 250 for their own task', bal === 250, `balance=${bal}`);
  }

  /* ------------------------------- 19. referrals only pay once per pair */
  {
    await accepts(db, 'a referee can be qualified only via their first task', `
      insert into referrals (referrer_id, referee_id) values
        ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111')`);
    await accepts(db, 'that referral qualifies', `select qualify_referral('11111111-1111-1111-1111-111111111111')`);
    const bal = await scalar(db,
      `select points_balance('33333333-3333-3333-3333-333333333333') as v`);
    check('the new referrer earns exactly one referral award (300)', bal === 300, `balance=${bal}`);
  }

  /* ------------------------------------- 20. every promoter starts at L1 */
  {
    const fresh = await scalar(db,
      `select level_for('22222222-2222-2222-2222-222222222222') as v`);
    check('a promoter with points but no referrals sits at a low level', fresh >= 1, `level=${fresh}`);

    const zero = await scalar(db, `select points_balance('22222222-2222-2222-2222-222222222222') as v`);
    check('points are readable per profile', typeof zero === 'number', `balance=${zero}`);
  }

  /* ------------------------------------------- 21. RLS is on the new tables */
  for (const t of ['levels', 'point_entries', 'referrals', 'redemptions']) {
    const on = await scalar(db, `
      select count(*)::int as v from pg_tables
       where schemaname='public' and tablename='${t}' and rowsecurity`);
    check(`row level security is enabled on ${t}`, on === 1, `rowsecurity=${on}`);
  }

  /* ------------------ 22. a promoter cannot price their own task (0017) ---
   * `grant update on public.tasks to authenticated` plus the tasks_submit
   * policy let the ASSIGNED promoter update their own task row, including
   * points_awarded. Measured before the fix: as `authenticated`, an UPDATE
   * that set points_awarded = 999999 was ACCEPTED and the worker then paid
   * 999,999 points. The trigger is the only thing that can refuse it here,
   * so the case runs as the promoter with auth.uid() returning them. */
  {
    const TASK = '55555555-5555-5555-5555-555555555555';
    const before = await scalar(db, `select points_awarded as v from tasks where id = '${TASK}'`);

    await db.exec('begin');
    let refused = false;
    let detail = '';
    try {
      await db.exec(`
        create or replace function auth.uid() returns uuid language sql stable
          as $$ select '11111111-1111-1111-1111-111111111111'::uuid $$;
        set local role authenticated;
        update tasks set points_awarded = 999999 where id = '${TASK}';`);
    } catch (e) {
      refused = true;
      detail = String(e.message || e).split('\n')[0];
    }
    try { await db.exec('rollback'); } catch { /* already unwound */ }
    await db.exec(`create or replace function auth.uid() returns uuid
      language sql stable as $$ select null::uuid $$;`);

    check('a promoter cannot set their own task points', refused === true,
      refused ? '' : 'the UPDATE was ACCEPTED');
    check('the refusal names the platform-owned reason', /platform/i.test(detail), detail);

    const after = await scalar(db, `select points_awarded as v from tasks where id = '${TASK}'`);
    check('the task points are unchanged after the attempt', Number(after) === Number(before),
      `${before} -> ${after}`);
  }

  unverified('anon cannot read another promoter\'s points over HTTP',
    'PGlite superuser bypasses RLS. Venue: db/live.proof.mjs against Supabase staging with an authenticated JWT.');
  unverified('client cannot insert point_entries directly',
    'Table GRANTs are revoked from anon/authenticated; the policy itself is proven on staging with real JWTs.');
});

console.log(`\n  PASS ${pass}   FAIL ${fail}   UNVERIFIED ${unverifiedCount}`);
console.log(`  POINTS MODEL: ${fail === 0 ? 'ALL HOLD' : 'BREACHED'}`);
process.exit(fail === 0 ? 0 : 1);
