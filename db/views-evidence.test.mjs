#!/usr/bin/env node
/**
 * views-evidence.test.mjs — adversarial tests for migration 0015.
 *
 * THE CLAIM UNDER TEST: a view count that the PROMOTER typed is not
 * evidence, and it must never pay points. The additive brackets
 * (500->50, 2000->100, 10000->200, 50000->400) mean a typed 50,000 used
 * to pay 750 points on a task worth 100. This suite proves that is closed,
 * and proves the legitimate paths still pay.
 *
 * Every case runs inside its own SAVEPOINT, exactly like points.test.mjs:
 * accepts() commits, rejects() rolls back, and a refused case can never
 * leak into the next one.
 */
import { withDb, migrate } from '../scripts/migrateUp.mjs';

let pass = 0, fail = 0;
function check(label, ok, detail) {
  console.log(ok ? `  PASS  ${label}` : `  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}
async function rejects(db, label, sql, frag) {
  await db.exec('begin');
  await db.exec('savepoint sp_case');
  let err = null;
  try { await db.exec(sql); } catch (e) { err = e; }
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

const P   = '11111111-1111-1111-1111-111111111111';
const C   = '44444444-4444-4444-4444-444444444444';
const T   = '55555555-5555-5555-5555-555555555555';
const T2  = '66666666-6666-6666-6666-666666666666';

await withDb(async (db) => {
  await migrate(db, { quiet: true });

  await db.exec(`
    insert into auth.users (id, email) values ('${P}', 'v@test.local');
    insert into profiles (id, role, state, display_name, phone_e164, phone_verified_at)
    values ('${P}', 'promoter', 'active', 'Ada', '08030000001', now());
    insert into campaigns (id, owner_id, title, brief, platform, objective, state,
                           budget_minor, price_per_outcome_minor, promoter_share_bp,
                           fraud_reserve_bp, margin_floor_bp, hold_hours)
    values ('${C}', '${P}', 'Views campaign', 'brief', 'instagram', 'click', 'review',
            10000000, 500, 4500, 500, 4000, 72);
    insert into tasks (id, campaign_id, state, caption, tracked_link, reward_minor,
                       points_awarded, assigned_to, assigned_at)
    values ('${T}', '${C}', 'assigned', 'caption', 'https://t.example/1', 5000, 100,
            '${P}', now()),
           ('${T2}', '${C}', 'assigned', 'caption2', 'https://t.example/2', 5000, 100,
            '${P}', now());
  `);

  /* ------------------------------- 1. provenance column and its constraint */
  console.log('\n[0015] provenance');
  const col = await scalar(db, `
    select count(*)::int as v from information_schema.columns
    where table_name='task_proofs' and column_name='views_source'`);
  check('task_proofs.views_source exists', col === 1, `count=${col}`);

  await rejects(db, 'a client-claimed count may not claim it was scraped', `
    insert into task_proofs (task_id, profile_id, platform, post_url, views, parsed, views_source)
    values ('${T}', '${P}', 'other', 'https://p.example/1', 50000, false, 'scraped')`,
    'task_proofs_scraped_needs_parse');

  await rejects(db, 'an unknown provenance is refused', `
    insert into task_proofs (task_id, profile_id, platform, post_url, views, parsed, views_source)
    values ('${T}', '${P}', 'other', 'https://p.example/1', 100, true, 'trust_me')`,
    'task_proofs_views_source_allowed');

  /* ------------------------- 2. a TYPED count pays nothing (the exploit) */
  console.log('\n[0015] a typed view count is not evidence');
  await accepts(db, 'a promoter can submit a typed view count', `
    insert into task_proofs (task_id, profile_id, platform, post_url, views, parsed, views_source)
    values ('${T}', '${P}', 'instagram', 'https://p.example/1', 50000, false, 'client_claimed')`);

  const award1 = await scalar(db, `select award_views_bonus('${T}') as v`);
  check('a typed 50,000-view count pays ZERO points', award1 === 0, `award=${award1}`);

  const bonus1 = await scalar(db, `select points_bonus as v from tasks where id='${T}'`);
  check('the unverified claim does NOT consume the task bonus (points_bonus stays null)',
    bonus1 === null, `points_bonus=${bonus1}`);

  const entries1 = await scalar(db, `
    select count(*)::int as v from point_entries
    where task_id='${T}' and kind='views_bonus'`);
  check('no views_bonus entry was written for a typed count', entries1 === 0, `rows=${entries1}`);

  /* ------------------- 3. a REVIEWER-supplied count DOES pay (the fix's
                          other half: the legitimate path still works) */
  console.log('\n[0015] a reviewer-supplied count pays');
  await accepts(db, 'a reviewer can correct the evidence row', `
    update task_proofs set views=50000, views_source='reviewer', verdict='approved'
    where task_id='${T}'`);

  const award2 = await scalar(db, `select award_views_bonus('${T}') as v`);
  check('a reviewer-confirmed 50,000 views pays the additive brackets (50+100+200+400=750)',
    award2 === 750, `award=${award2}`);

  const bonus2 = await scalar(db, `select points_bonus as v from tasks where id='${T}'`);
  check('the task records the bonus it paid', bonus2 === 750, `points_bonus=${bonus2}`);

  const entries2 = await scalar(db, `
    select count(*)::int as v from point_entries
    where task_id='${T}' and kind='views_bonus' and points=750`);
  check('exactly one views_bonus entry of 750 points was written', entries2 === 1, `rows=${entries2}`);

  const replay = await scalar(db, `select award_views_bonus('${T}') as v`);
  check('replaying the award returns the same 750 and pays nothing twice', replay === 750, `got ${replay}`);

  const entries3 = await scalar(db, `
    select count(*)::int as v from point_entries
    where task_id='${T}' and kind='views_bonus'`);
  check('still exactly one views_bonus entry after the replay', entries3 === 1, `rows=${entries3}`);

  /* ------------------------- 4. a genuinely SCRAPED count pays */
  console.log('\n[0015] a scraped count pays');
  await accepts(db, 'a scraped proof row is recorded', `
    insert into task_proofs (task_id, profile_id, platform, post_url, views, parsed, views_source)
    values ('${T2}', '${P}', 'telegram', 'https://t.me/c/1', 2000, true, 'scraped')`);

  const award3 = await scalar(db, `select award_views_bonus('${T2}') as v`);
  check('a scraped 2,000 views pays 50+100 = 150', award3 === 150, `award=${award3}`);

  /* ------------------------- 5. a task with no evidence pays nothing */
  console.log('\n[0015] no evidence, no bonus');
  await db.exec(`
    insert into tasks (id, campaign_id, state, caption, tracked_link, reward_minor,
                       points_awarded, assigned_to, assigned_at)
    values ('77777777-7777-7777-7777-777777777777', '${C}', 'assigned', 'c3',
            'https://t.example/3', 5000, 100, '${P}', now())`);
  const award4 = await scalar(db, `select award_views_bonus('77777777-7777-7777-7777-777777777777') as v`);
  check('a task with no proof row pays no views bonus', award4 === 0, `award=${award4}`);
  const bonus4 = await scalar(db, `select points_bonus as v from tasks where id='77777777-7777-7777-7777-777777777777'`);
  check('a task with no evidence keeps its bonus unconsumed', bonus4 === null, `points_bonus=${bonus4}`);

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
});
