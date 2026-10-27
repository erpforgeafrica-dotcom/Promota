#!/usr/bin/env node
/**
 * policy.test.mjs — the platform-policy gate (migration 0018).
 *
 * The claim under test: Promota cannot sell paid engagement (likes,
 * comments, follows, subscribes, views, channel joins, shared-link
 * reposts), cannot offer a review without a verified purchase, cannot
 * dispatch work before a creator acknowledges the delivery policy, and
 * cannot let one creator hold two tasks from the same campaign.
 *
 * Same discipline as points.test.mjs: every case in its own SAVEPOINT so
 * a refusal cannot leak into the next case.
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

const OWNER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const B = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CAMP = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const T_CONTENT = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const T_REVIEW = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const T_SECOND = '11111111-2222-3333-4444-555555555555';
const T_FUTURE = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const T_LEGACY = 'bbbbbbbb-cccc-cccc-dddd-eeeeeeeeeeee';

async function seed(db) {
  await db.exec(`
    insert into auth.users (id, email) values
      ('${OWNER}', 'brand@test.local'),
      ('${A}', 'ada@test.local'),
      ('${B}', 'bode@test.local');

    insert into profiles (id, role, state, display_name, phone_e164, phone_verified_at)
    values
      ('${OWNER}', 'business', 'active', 'Brand', '08030000010', now()),
      ('${A}', 'promoter', 'active', 'Ada', '08030000011', now()),
      ('${B}', 'promoter', 'active', 'Bode', '08030000012', now());

    insert into campaigns (id, owner_id, title, brief, platform, objective, state,
                           budget_minor, price_per_outcome_minor, promoter_share_bp,
                           fraud_reserve_bp, margin_floor_bp, hold_hours)
    values ('${CAMP}', '${OWNER}', 'Policy campaign', 'brief', 'instagram', 'click', 'draft',
            10000000, 500, 7000, 500, 0, 72);

    insert into tasks (id, campaign_id, state, caption, tracked_link, reward_minor,
                       action_type, review_verified_purchase)
    values
      ('${T_CONTENT}', '${CAMP}', 'draft', 'Post the launch',
       'https://brand.example/launch', 5000, 'post', false),
      ('${T_REVIEW}', '${CAMP}', 'draft', 'Review the product',
       'https://brand.example/review', 5000, 'review', true),
      ('${T_SECOND}', '${CAMP}', 'draft', 'Second post',
       'https://brand.example/two', 5000, 'post', false),
      ('${T_FUTURE}', '${CAMP}', 'draft', 'Future post',
       'https://brand.example/future', 5000, 'post', false);

    update tasks set release_at = now() + interval '7 days' where id = '${T_FUTURE}';

    -- simulate a row that predates the gate: the trigger is disabled only
    -- for this insert, so legacy data can be exercised honestly.
    alter table tasks disable trigger tasks_policy_guard;
    insert into tasks (id, campaign_id, state, caption, tracked_link, reward_minor,
                       action_type, policy_class, policy_version)
    values ('${T_LEGACY}', '${CAMP}', 'draft', 'Like the post',
            'https://brand.example/like', 5000, 'like', 'prohibited', '2026-10-26');
    alter table tasks enable trigger tasks_policy_guard;
  `);
}

await withDb(async db => {
  await migrate(db, { quiet: true });
  await seed(db);

  /* ------------------------------------------------ 1. classification */
  {
    const cases = [
      ['post', 'content'],
      ['repost', 'distribution'],
      ['share', 'distribution'],
      ['review', 'review'],
      ['like', 'prohibited'],
      ['comment', 'prohibited'],
      ['follow', 'prohibited'],
      ['subscribe', 'prohibited'],
      ['view', 'prohibited'],
      ['join_channel', 'prohibited'],
    ];
    for (const [action, want] of cases) {
      const got = await scalar(db, `select task_policy_class('${action}') as v`);
      check(`${action} is classified ${want}`, got === want, `got ${got}`);
    }
  }

  /* --------------------------------- 2. new prohibited work is impossible */
  {
    await rejects(db, 'a new like task is refused', `
      insert into tasks (campaign_id, state, caption, tracked_link, reward_minor, action_type)
      values ('${CAMP}', 'draft', 'Like this', 'https://brand.example/x', 5000, 'like')`,
      'prohibited');

    await rejects(db, 'a new follow task is refused', `
      insert into tasks (campaign_id, state, caption, tracked_link, reward_minor, action_type)
      values ('${CAMP}', 'draft', 'Follow this', 'https://brand.example/y', 5000, 'follow')`,
      'prohibited');

    await rejects(db, 'changing a task to a prohibited action is refused', `
      update tasks set action_type = 'follow' where id = '${T_SECOND}'`,
      'prohibited');
  }

  /* ------------------------------------- 3. reviews need a real purchase */
  {
    await rejects(db, 'a review without a verified purchase is refused', `
      insert into tasks (campaign_id, state, caption, tracked_link, reward_minor, action_type)
      values ('${CAMP}', 'draft', 'Review it', 'https://brand.example/r', 5000, 'review')`,
      'verified purchase');

    const reviewClass = await scalar(db,
      `select policy_class as v from tasks where id = '${T_REVIEW}'`);
    check('a verified-purchase review is allowed', reviewClass === 'review', `got ${reviewClass}`);
  }

  /* ------------------------------------ 4. every task gets a unique code */
  {
    const row = (await db.query(
      `select policy_class, attribution_code, policy_version from tasks where id = '${T_CONTENT}'`
    )).rows[0];
    check('a new post is classified content', row.policy_class === 'content', row.policy_class);
    check('a new task gets its own attribution code', /^PM[A-F0-9]{12}$/.test(row.attribution_code || ''),
      String(row.attribution_code));
    check('a new task records the policy version', row.policy_version === '2026-10-26', row.policy_version);

    const dup = await scalar(db, `
      select count(*)::int as v from (
        select attribution_code from tasks
         where attribution_code is not null
         group by attribution_code having count(*) > 1
      ) d`);
    check('attribution codes are unique', dup === 0, `duplicates=${dup}`);
  }

  /* --------------------------------------- 5. disclosure is mandatory */
  {
    await rejects(db, 'a task with no disclosure tag is refused', `
      insert into tasks (campaign_id, state, caption, tracked_link, reward_minor,
                         action_type, disclosure_tag)
      values ('${CAMP}', 'draft', 'No tag', 'https://brand.example/n', 5000, 'post', '')`,
      'disclosure');
  }

  /* --------------------------------- 6. acknowledgement gates claiming */
  {
    await rejects(db, 'claiming before acknowledging the policy is refused',
      `select claim_task('${T_CONTENT}', '${A}')`, 'acknowledge');

    await rejects(db, 'acknowledging a stale policy version is refused',
      `select ack_task_policy('${A}', '2020-01-01')`, 'version');

    await accepts(db, 'a creator can acknowledge the current policy',
      `select ack_task_policy('${A}', '2026-10-26')`);

    const ack = await scalar(db,
      `select policy_ack_version as v from profiles where id = '${A}'`);
    check('the acknowledgement is recorded on the profile', ack === '2026-10-26', ack);
  }

  /* ------------------------------- 7. legacy prohibited work is blocked */
  {
    await rejects(db, 'a legacy like task cannot be claimed',
      `select claim_task('${T_LEGACY}', '${A}')`, 'prohibited');

    const state = await scalar(db,
      `select state as v from tasks where id = '${T_LEGACY}'`);
    check('the legacy task stays in draft (data is kept, not deleted)', state === 'draft', state);
  }

  /* --------------------------- 8. dispatch: release, one per campaign */
  {
    await db.exec(`
      alter table campaigns disable trigger campaigns_must_be_funded;
      update campaigns set state = 'live' where id = '${CAMP}';
      alter table campaigns enable trigger campaigns_must_be_funded;
    `);

    await accepts(db, 'a disclosed content task can be claimed once acknowledged',
      `select claim_task('${T_CONTENT}', '${A}')`);

    const row = (await db.query(
      `select state, assigned_to, attribution_code from tasks where id = '${T_CONTENT}'`
    )).rows[0];
    check('the claim is assigned to the creator', row.state === 'assigned' && row.assigned_to === A,
      `${row.state}/${row.assigned_to}`);
    check('the claimed task keeps its attribution code', /^PM/.test(row.attribution_code || ''),
      String(row.attribution_code));

    await rejects(db, 'a creator cannot hold two tasks from the same campaign',
      `select claim_task('${T_SECOND}', '${A}')`, 'already hold');

    await accepts(db, 'a second creator can acknowledge the policy',
      `select ack_task_policy('${B}', '2026-10-26')`);

    await rejects(db, 'an unreleased task cannot be claimed',
      `select claim_task('${T_FUTURE}', '${B}')`, 'not released');

    await accepts(db, 'a different creator can claim the second task',
      `select claim_task('${T_SECOND}', '${B}')`);
  }

  /* ------------------------------- 9. payout of completed work still works */
  {
    await db.exec(`
      update tasks
         set state = 'assigned', assigned_to = '${A}', assigned_at = now(),
             points_awarded = 100
       where id = '${T_LEGACY}';
    `);

    await accepts(db, 'work already assigned under the old policy can still be paid',
      `select award_task_points('${T_LEGACY}')`);

    const bal = await scalar(db, `select points_balance('${A}') as v`);
    check('the legacy payout lands in the creator balance', Number(bal) === 100, `balance=${bal}`);
  }

  /* ------------------- 10. the 0017 hardening survives the rewrite */
  {
    /* CREATE OR REPLACE FUNCTION drops a function's saved SET clauses. The
       rewrite of claim_task() must therefore re-pin search_path, or 0018
       would quietly undo 0017's security fix. */
    const pinned = (await db.query(`
      select proname, proconfig
        from pg_proc
       where proname in ('claim_task', 'ack_task_policy', 'guard_task_policy')
    `)).rows;
    for (const fn of pinned) {
      check(`${fn.proname} keeps a pinned search_path`,
        Array.isArray(fn.proconfig) && fn.proconfig.includes('search_path=public'),
        JSON.stringify(fn.proconfig));
    }
    check('all three hardened functions exist', pinned.length === 3, `found ${pinned.length}`);
  }
});

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
console.log(`  POLICY GATE: ${fail === 0 ? 'ALL HOLD' : 'BREACHED'}`);
process.exit(fail === 0 ? 0 : 1);
