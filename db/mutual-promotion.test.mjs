#!/usr/bin/env node
/**
 * mutual-promotion.test.mjs -- adversarial tests for 0020_mutual_promotion.
 *
 * The claim under test is "two members can promote each other and both are
 * paid exactly once, and no other path mints a point". Every case tries to
 * break that: self-promotion, duplicate pairs, the wrong accepter, promoting
 * your own card, a delivery before acceptance, a second delivery, a promoter
 * reviewing their own work, a replay, a rejection, and the caps.
 *
 * Same discipline as the other PGlite suites: each refusal runs in its own
 * SAVEPOINT so an aborted transaction can never roll back or commit a later
 * case, and every happy path is followed by a balance read rather than a
 * promise that a write "worked".
 *
 * RLS under a real anon/authenticated JWT is UNVERIFIED locally (PGlite's
 * superuser bypasses it) -- venue: Supabase staging + JWTs, as with leads.
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

async function scalar(db, sql) {
  const r = await db.query(sql);
  return r.rows[0]?.v;
}

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const A     = 'bbbbbbbb-0000-4000-8000-000000000002';
const B     = 'cccccccc-0000-4000-8000-000000000003';
const C     = 'dddddddd-0000-4000-8000-000000000004';
const D     = 'eeeeeeee-0000-4000-8000-000000000005';

const CA_ACTIVE = '11111111-0000-4000-8000-0000000000a1';
const CA_DRAFT  = '11111111-0000-4000-8000-0000000000a2';
const CA_REVIEW = '11111111-0000-4000-8000-0000000000a3';
const CA_REJECT = '11111111-0000-4000-8000-0000000000a4';
const CB_ACTIVE = '22222222-0000-4000-8000-0000000000b1';
const CC_ACTIVE = '33333333-0000-4000-8000-0000000000c1';
const CD_ACTIVE = '44444444-0000-4000-8000-0000000000d1';

async function seed(db) {
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ADMIN}', 'admin@test.local'),
      ('${A}', 'ada@test.local'),
      ('${B}', 'bode@test.local'),
      ('${C}', 'chidi@test.local'),
      ('${D}', 'dara@test.local');

    insert into profiles (id, role, state, display_name, phone_e164, phone_verified_at)
    values
      ('${ADMIN}', 'admin',    'active', 'Reviewer', '08030000020', now()),
      ('${A}',     'promoter', 'active', 'Ada',      '08030000021', now()),
      ('${B}',     'promoter', 'active', 'Bode',     '08030000022', now()),
      ('${C}',     'promoter', 'active', 'Chidi',    '08030000023', now()),
      ('${D}',     'promoter', 'active', 'Dara',     '08030000024', now());

    insert into promo_cards (id, owner_id, kind, state, title, summary, link_url)
    values
      ('${CA_ACTIVE}', '${A}', 'creator', 'review', 'Ada the designer',
       'I design logos and flyers for small businesses in Lagos.',
       'https://ada.example/portfolio'),
      ('${CB_ACTIVE}', '${B}', 'business', 'review', 'Bode Autos',
       'We sell verified spare parts with a one-year fitting guarantee.',
       'https://bodeautos.example'),
      ('${CC_ACTIVE}', '${C}', 'person', 'review', 'Chidi speaks',
       'I speak about youth careers at schools and community events.',
       'https://chidi.example/talks'),
      ('${CD_ACTIVE}', '${D}', 'person', 'review', 'Dara makes music',
       'I produce afrobeats instrumentals for upcoming artists.',
       'https://dara.example/beats');

    insert into promo_cards (id, owner_id, kind, state, title, summary, link_url)
    values
      ('${CA_DRAFT}', '${A}', 'creator', 'draft', 'Ada motion reel',
       'A short motion reel for my design studio, not submitted yet.',
       'https://ada.example/reel'),
      ('${CA_REVIEW}', '${A}', 'creator', 'review', 'Ada brand kit',
       'A downloadable brand kit for small businesses, awaiting review.',
       'https://ada.example/kit'),
      ('${CA_REJECT}', '${A}', 'creator', 'review', 'Ada mystery offer',
       'A card that a reviewer will reject during the test run.',
       'https://ada.example/mystery');

    -- the three live cards go through the same activation path a real card
    -- does; nothing is born active
    select review_promo_card('${CA_ACTIVE}', '${ADMIN}', true, 'seed approval');
    select review_promo_card('${CB_ACTIVE}', '${ADMIN}', true, 'seed approval');
    select review_promo_card('${CC_ACTIVE}', '${ADMIN}', true, 'seed approval');
    select review_promo_card('${CD_ACTIVE}', '${ADMIN}', true, 'seed approval');
  `);
}

const balance = (db, id) => scalar(db,
  `select coalesce(sum(points),0)::int as v from point_entries where profile_id = '${id}'`);

const entries = (db, id, kind) => scalar(db,
  `select count(*)::int as v from point_entries
    where profile_id = '${id}' and kind = '${kind}'`);

await withDb(async db => {
  await migrate(db, { quiet: true });
  await seed(db);

  /* ------------------------------------------------- 1. card moderation */
  {
    await rejects(db, 'a promoter cannot approve a promotion card', `
      select review_promo_card('${CA_REVIEW}', '${A}', true, 'self approve')`,
      'missing task.review permission');

    const state = await scalar(db,
      `select review_promo_card('${CA_REVIEW}', '${ADMIN}', true, 'clear offer') as v`);
    check('an admin can activate a card in review', state === 'active', `got ${state}`);

    const row = (await db.query(
      `select state, approved_by, approved_at from promo_cards where id = '${CA_REVIEW}'`
    )).rows[0];
    check('activation records who approved and when',
      row.state === 'active' && row.approved_by === ADMIN && row.approved_at != null,
      JSON.stringify(row));

    const rejected = await scalar(db,
      `select review_promo_card('${CA_REJECT}', '${ADMIN}', false, 'link is not a real offer') as v`);
    check('an admin can reject a card in review', rejected === 'rejected', `got ${rejected}`);

    await rejects(db, 'a second review of the same card is refused', `
      select review_promo_card('${CA_REVIEW}', '${ADMIN}', true, 'again')`,
      'only a card in review');

    await rejects(db, 'a card with an http link is refused', `
      insert into promo_cards (owner_id, kind, state, title, summary, link_url)
      values ('${B}', 'person', 'review', 'Insecure offer',
              'This link is plain http and must be refused.', 'http://bode.example')`,
      'link_https');

    await rejects(db, 'a card with a one-word title is refused', `
      insert into promo_cards (owner_id, kind, state, title, summary, link_url)
      values ('${B}', 'person', 'review', 'Hi',
              'This summary is long enough but the title is not.', 'https://bode.example/x')`,
      'title_len');

    await rejects(db, 'a card cannot be born active', `
      insert into promo_cards (owner_id, kind, state, title, summary, link_url, approved_by, approved_at)
      values ('${B}', 'person', 'active', 'Instant card',
              'This card tries to skip moderation entirely.', 'https://bode.example/y',
              '${ADMIN}', now())`,
      'draft or review');
  }

  /* ------------------------------------------------------- 2. proposals */
  let pairAB;
  {
    await rejects(db, 'a member cannot promote their own card', `
      select propose_promo_pair('${A}', '${CA_ACTIVE}', '${CA_ACTIVE}')`,
      'yourself');

    await rejects(db, 'a member cannot offer someone else\'s card as their own', `
      select propose_promo_pair('${A}', '${CB_ACTIVE}', '${CC_ACTIVE}')`,
      'own promotion card');

    await rejects(db, 'a draft card cannot be offered', `
      select propose_promo_pair('${A}', '${CA_DRAFT}', '${CB_ACTIVE}')`,
      'must be approved');

    await rejects(db, 'a card still in review cannot be offered', `
      select propose_promo_pair('${B}', '${CB_ACTIVE}', '${CA_REJECT}')`,
      'not active');

    pairAB = await scalar(db,
      `select propose_promo_pair('${A}', '${CA_ACTIVE}', '${CB_ACTIVE}') as v`);
    check('a valid invitation creates a proposed pair', typeof pairAB === 'string' && pairAB.length === 36,
      String(pairAB));

    const row = (await db.query(
      `select state, profile_a, profile_b, proposed_by from promo_pairs where id = '${pairAB}'`
    )).rows[0];
    check('the pair records both members and the proposer',
      row.state === 'proposed' && row.profile_a === A && row.profile_b === B && row.proposed_by === A,
      JSON.stringify(row));

    await rejects(db, 'a second open pair with the same member is refused', `
      select propose_promo_pair('${A}', '${CA_ACTIVE}', '${CB_ACTIVE}')`,
      'already have an open promotion pair');
  }

  /* ---------------------------------------------------- 3. acceptance */
  {
    await rejects(db, 'the proposer cannot accept their own invitation', `
      select accept_promo_pair('${pairAB}', '${A}')`,
      'only the invited member');

    await rejects(db, 'a stranger cannot accept the invitation', `
      select accept_promo_pair('${pairAB}', '${C}')`,
      'only the invited member');

    await db.exec(`select accept_promo_pair('${pairAB}', '${B}')`);

    const row = (await db.query(
      `select state, accepted_at, delivery_deadline from promo_pairs where id = '${pairAB}'`
    )).rows[0];
    check('the invited member can accept and the clock starts',
      row.state === 'active' && row.accepted_at != null && row.delivery_deadline != null,
      JSON.stringify(row));

    const hours = await scalar(db, `
      select round(extract(epoch from (delivery_deadline - accepted_at)) / 3600)::int as v
        from promo_pairs where id = '${pairAB}'`);
    check('the delivery window matches the setting (72h)', Number(hours) === 72, `got ${hours}`);

    await rejects(db, 'a pair cannot be accepted twice', `
      select accept_promo_pair('${pairAB}', '${B}')`,
      'not awaiting acceptance');
  }

  /* ------------------------------------- 4. deliveries and their refusals */
  let deliveryA;
  {
    await rejects(db, 'a stranger cannot deliver on the pair', `
      select submit_promo_delivery('${pairAB}', '${C}', 'instagram',
        'https://instagram.com/p/stranger', 'ad', '{}'::jsonb)`,
      'not part of this promotion pair');

    await rejects(db, 'a plain http post URL is refused', `
      select submit_promo_delivery('${pairAB}', '${A}', 'instagram',
        'http://instagram.com/p/old', 'ad', '{}'::jsonb)`,
      'https');

    await rejects(db, 'an unsupported platform is refused', `
      select submit_promo_delivery('${pairAB}', '${A}', 'myspace',
        'https://myspace.com/p/1', 'ad', '{}'::jsonb)`,
      'platform_valid');

    await rejects(db, 'a delivery without a disclosure is refused', `
      select submit_promo_delivery('${pairAB}', '${A}', 'instagram',
        'https://instagram.com/p/nodisclosure', null, '{}'::jsonb)`,
      'disclosure is required');

    deliveryA = await scalar(db, `
      select submit_promo_delivery('${pairAB}', '${A}', 'instagram',
        'https://instagram.com/p/ada-promotes-bode', 'ad',
        '{"views": 120, "note": "story and feed post"}'::jsonb) as v`);
    check('a compliant delivery is accepted', typeof deliveryA === 'string' && deliveryA.length === 36,
      String(deliveryA));

    const row = (await db.query(
      `select card_id, profile_id, state from promo_deliveries where id = '${deliveryA}'`
    )).rows[0];
    check('the delivery promotes the PARTNER card, by construction',
      row.card_id === CB_ACTIVE && row.profile_id === A && row.state === 'submitted',
      JSON.stringify(row));

    await rejects(db, 'a member cannot deliver twice on one pair', `
      select submit_promo_delivery('${pairAB}', '${A}', 'tiktok',
        'https://tiktok.com/@ada/2', 'ad', '{}'::jsonb)`,
      'already delivered');

    await rejects(db, 'a promotion delivery cannot be inserted directly', `
      insert into promo_deliveries (pair_id, profile_id, card_id, platform, post_url, disclosure)
      values ('${pairAB}', '${C}', '${CA_ACTIVE}', 'x', 'https://x.com/c', 'ad')`,
      'not part of this promotion pair');
  }

  /* ------------------------------------------------ 5. first approval */
  {
    await rejects(db, 'a promoter cannot review their own delivery', `
      select review_promo_delivery('${deliveryA}', '${A}', true, null)`,
      'missing task.review permission');

    const res = await scalar(db,
      `select review_promo_delivery('${deliveryA}', '${ADMIN}', true, null) as v`);
    check('an admin approval returns the approved state and the base points',
      res?.state === 'approved' && Number(res?.points) === 100, JSON.stringify(res));

    check('the delivering member is paid exactly 100 points', Number(await balance(db, A)) === 100,
      `balance ${await balance(db, A)}`);
    check('the partner is not paid before delivering', Number(await balance(db, B)) === 0,
      `balance ${await balance(db, B)}`);
    check('the reward is booked as promotion_reward', Number(await entries(db, A, 'promotion_reward')) === 1,
      `entries ${await entries(db, A, 'promotion_reward')}`);

    const replay = await scalar(db,
      `select review_promo_delivery('${deliveryA}', '${ADMIN}', true, null) as v`);
    check('a replayed approval is reported, not re-paid',
      replay?.replayed === true && Number(await balance(db, A)) === 100, JSON.stringify(replay));
  }

  /* --------------------------- 6. the mutual promise: both sides paid */
  let deliveryB;
  {
    deliveryB = await scalar(db, `
      select submit_promo_delivery('${pairAB}', '${B}', 'x',
        'https://x.com/bode/status/1', 'sponsored', '{}'::jsonb) as v`);

    const res = await scalar(db,
      `select review_promo_delivery('${deliveryB}', '${ADMIN}', true, null) as v`);
    check('the second approval completes the pair and pays the mutual bonus',
      res?.pair_state === 'completed' && Number(res?.mutual_bonus_each) === 250
        && Number(res?.mutual_bonus_total) === 500,
      JSON.stringify(res));

    check('member A ends on 350 (100 reward + 250 bonus)', Number(await balance(db, A)) === 350,
      `balance ${await balance(db, A)}`);
    check('member B ends on 350 (100 reward + 250 bonus)', Number(await balance(db, B)) === 350,
      `balance ${await balance(db, B)}`);

    const pair = (await db.query(
      `select state, completed_at from promo_pairs where id = '${pairAB}'`
    )).rows[0];
    check('the pair is completed and stamped', pair.state === 'completed' && pair.completed_at != null,
      JSON.stringify(pair));

    const replay = await scalar(db,
      `select review_promo_delivery('${deliveryB}', '${ADMIN}', true, null) as v`);
    check('a replayed second approval cannot double the bonus',
      replay?.replayed === true && Number(await balance(db, A)) === 350 && Number(await balance(db, B)) === 350,
      JSON.stringify(replay));

    const bonusKey = await scalar(db, `
      select count(*)::int as v from point_entries
       where kind = 'promotion_bonus' and idempotency_key like 'promo_mutual:${pairAB}:%'`);
    check('exactly two mutual bonus entries exist for the pair', Number(bonusKey) === 2,
      `got ${bonusKey}`);

    const events = await scalar(db, `
      select count(*)::int as v from outbox
       where topic = 'promotion.mutual_completed' and payload->>'pair_id' = '${pairAB}'`);
    check('exactly one mutual-completed event was emitted', Number(events) === 1, `got ${events}`);
  }

  /* ------------------------------------- 7. rejection mints nothing */
  {
    const pairBC = await scalar(db,
      `select propose_promo_pair('${B}', '${CB_ACTIVE}', '${CC_ACTIVE}') as v`);

    await rejects(db, 'a delivery on a proposed pair is refused', `
      select submit_promo_delivery('${pairBC}', '${B}', 'instagram',
        'https://instagram.com/p/too-early', 'ad', '{}'::jsonb)`,
      'not active');

    await db.exec(`select accept_promo_pair('${pairBC}', '${C}')`);
    const deliveryC = await scalar(db, `
      select submit_promo_delivery('${pairBC}', '${C}', 'tiktok',
        'https://tiktok.com/@chidi/1', 'ad', '{}'::jsonb) as v`);

    await rejects(db, 'a rejection without a reason is refused', `
      select review_promo_delivery('${deliveryC}', '${ADMIN}', false, '')`,
      'reason');

    const res = await scalar(db,
      `select review_promo_delivery('${deliveryC}', '${ADMIN}', false,
        'the post does not show the partner card') as v`);
    check('an admin rejection returns zero points', res?.state === 'rejected' && Number(res?.points) === 0,
      JSON.stringify(res));
    check('the rejected member is paid nothing', Number(await balance(db, C)) === 0,
      `balance ${await balance(db, C)}`);

    const pair = (await db.query(
      `select state from promo_pairs where id = '${pairBC}'`)).rows[0];
    check('a rejected side does not complete the pair', pair.state === 'active', pair.state);

    const auditRows = await scalar(db, `
      select count(*)::int as v from audit_log where action = 'promotion.delivery.reject'
        and target_id = '${deliveryC}'`);
    check('the rejection is in the append-only audit log', Number(auditRows) === 1, `got ${auditRows}`);
  }

  /* ------------------------------------------------------ 8. caps */
  let pairAB2;
  let pairAC;
  {
    await db.exec(`update settings set value = '{"v":2}'::jsonb where key = 'promotion.max_active_pairs'`);

    pairAB2 = await scalar(db,
      `select propose_promo_pair('${A}', '${CA_ACTIVE}', '${CB_ACTIVE}') as v`);
    check('a member under the cap can open a pair', typeof pairAB2 === 'string' && pairAB2.length === 36,
      String(pairAB2));

    pairAC = await scalar(db,
      `select propose_promo_pair('${A}', '${CA_ACTIVE}', '${CC_ACTIVE}') as v`);
    check('a second pair is allowed up to the cap', typeof pairAC === 'string' && pairAC.length === 36,
      String(pairAC));

    await rejects(db, 'the proposer open-pair cap is enforced', `
      select propose_promo_pair('${A}', '${CA_ACTIVE}', '${CD_ACTIVE}')`,
      'open promotion pairs');

    await rejects(db, 'the invited member is protected by the same cap', `
      select propose_promo_pair('${D}', '${CD_ACTIVE}', '${CB_ACTIVE}')`,
      'partner already holds');

    await db.exec(`update settings set value = '{"v":3}'::jsonb where key = 'promotion.max_active_pairs'`);

    // A has sent three invitations (A->B, A->B again, A->C) in this run.
    await db.exec(`update settings set value = '{"v":3}'::jsonb where key = 'promotion.max_proposals_per_week'`);
    await rejects(db, 'the weekly invitation cap is enforced', `
      select propose_promo_pair('${A}', '${CA_ACTIVE}', '${CD_ACTIVE}')`,
      'weekly promotion invitation limit');
    await db.exec(`update settings set value = '{"v":10}'::jsonb where key = 'promotion.max_proposals_per_week'`);
  }

  /* ------------------------------------------- 9. expiry housekeeping */
  {
    await db.exec(`select accept_promo_pair('${pairAB2}', '${B}')`);
    // no delivery arrived; move the clock past the deadline
    await db.exec(`update promo_pairs set delivery_deadline = now() - interval '1 hour'
                    where id = '${pairAB2}'`);

    const expired = await scalar(db, `select expire_promo_pairs() as v`);
    check('an accepted pair past its deadline expires', Number(expired) === 1, `got ${expired}`);

    const state = await scalar(db,
      `select state::text as v from promo_pairs where id = '${pairAB2}'`);
    check('the expired pair is marked expired', state === 'expired', String(state));

    const stillProposed = await scalar(db,
      `select state::text as v from promo_pairs where id = '${pairAC}'`);
    check('a proposed pair without a deadline is untouched by the sweep',
      stillProposed === 'proposed', String(stillProposed));

    const again = await scalar(db, `select expire_promo_pairs() as v`);
    check('a second sweep changes nothing', Number(again) === 0, `got ${again}`);
  }

  unverified('anon cannot read another member\'s promotion pair over HTTP',
    'PGlite superuser bypasses RLS. Venue: db/live.proof.mjs against Supabase staging with real JWTs.');
  unverified('the browser cannot write promo_pairs or promo_deliveries directly',
    'Table GRANTs are revoked from anon/authenticated; the policy is proven on staging with real JWTs.');
});

console.log(`\n  PASS ${pass}   FAIL ${fail}   UNVERIFIED ${unverifiedCount}`);
console.log(`  MUTUAL PROMOTION: ${fail === 0 ? 'ALL HOLD' : 'BREACHED'}`);
process.exit(fail === 0 ? 0 : 1);
