-- =====================================================================
-- 0014_redemption_integrity.sql
--
-- Hardens the points -> data/cash redemption path. Three defects fixed,
-- all reachable from the live API:
--
--   1. REDEEM RACE (critical). redeem_points() read points_balance() and
--      inserted with no row lock, so two concurrent redemptions both
--      passed the balance check and the balance went negative. Fixed with
--      a per-profile advisory transaction lock at the top of the function
--      (taken before the balance read, so redemptions for one promoter
--      serialise) plus a balance-level negative guard.
--
--   2. MISSING PLAN (high). The outbox payload never carried the chosen
--      plan code, so every data redemption failed in the worker with
--      "planCode is required" AFTER the points were already debited. The
--      plan code is now persisted on the redemption row and forwarded.
--
--   3. REQUEST-SCOPED IDEMPOTENCY (high). The old key
--      redeem:<profile>:<kind>:<points>:<network> meant a legitimate
--      SECOND redemption of the same amount was treated as a replay and
--      silently returned the old row (no debit, no fulfilment). The new
--      key MUST include a per-request nonce supplied by the caller.
--
-- Requires 0008. Safe to run once; every statement is idempotent by
-- construction (add column if not exists / create or replace).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. the chosen plan code, persisted so the worker can fulfil
-- ---------------------------------------------------------------------
alter table redemptions add column if not exists plan_code text;

comment on column redemptions.plan_code is
  'Aggregator catalogue code chosen at request time (data redemptions only); '
  'forwarded to the provider by the worker. Null for cash.';

-- ---------------------------------------------------------------------
-- 2. redeem_points: advisory lock + plan code + nonce-scoped idempotency
-- ---------------------------------------------------------------------
-- Drop the 5-argument version first: with both present, a 5-arg call is
-- ambiguous ("function is not unique") because the 6-arg version has a
-- default. Only the 6-argument form is intended to survive.
drop function if exists redeem_points(uuid, redemption_kind, integer, text, text);

create or replace function redeem_points(
  p_profile   uuid,
  p_kind      redemption_kind,
  p_points    integer,
  p_idem      text,
  p_network   text default null,
  p_plan_code text default null
) returns uuid language plpgsql set search_path = public as $$
declare
  v_balance integer;
  v_min     integer;
  v_red     uuid;
begin
  if p_points is null or p_points <= 0 then
    raise exception 'redemption must spend a positive number of points'
      using errcode = 'check_violation';
  end if;

  -- Serialise every redemption for one promoter. Two concurrent calls can
  -- no longer both observe the same pre-debit balance: the second waits,
  -- re-reads, and is refused with 'insufficient points' if the first ate
  -- the balance. Held to the end of the transaction.
  perform pg_advisory_xact_lock(hashtextextended(p_profile::text, 0));

  if p_kind = 'cash' and not cash_unlocked(p_profile) then
    raise exception 'cash redemption is not unlocked at your level'
      using errcode = 'check_violation';
  end if;

  v_min := coalesce((select (value->>'v')::int from settings
             where key = case p_kind when 'cash' then 'redemption.cash_min_points'
                                    else 'redemption.data_min_points' end), 0);
  if p_points < v_min then
    raise exception 'minimum redemption is % points', v_min
      using errcode = 'check_violation';
  end if;

  if p_kind = 'data' and p_network is null then
    raise exception 'a data redemption needs a network'
      using errcode = 'check_violation';
  end if;

  if p_kind = 'data' and (p_plan_code is null or length(trim(p_plan_code)) = 0) then
    raise exception 'a data redemption needs a plan code'
      using errcode = 'check_violation';
  end if;

  -- Idempotent replay: a caller that retries with the SAME nonce gets the
  -- same redemption back, with no second debit and no second outbox row.
  -- The lookup is scoped to the CALLER's profile as well as the key: the API
  -- builds the key as redeem:<profile>:<nonce>, but the database must not
  -- hand one profile's redemption id to another that guesses a key.
  select id into v_red from redemptions
   where idempotency_key = p_idem and profile_id = p_profile;
  if found then
    return v_red;
  end if;

  if exists (select 1 from redemptions where idempotency_key = p_idem) then
    raise exception 'that idempotency key belongs to another redemption'
      using errcode = 'check_violation';
  end if;

  v_balance := points_balance(p_profile);
  if p_points > v_balance then
    raise exception 'insufficient points: have %, need %', v_balance, p_points
      using errcode = 'check_violation';
  end if;

  insert into redemptions (profile_id, kind, points_spent, network, plan_code, idempotency_key)
  values (p_profile, p_kind, p_points, p_network, p_plan_code, p_idem)
  on conflict (idempotency_key) do nothing;

  if not found then
    select id into v_red from redemptions where idempotency_key = p_idem;
    return v_red;  -- lost a benign race on the same nonce
  end if;

  insert into point_entries (profile_id, task_id, kind, points, idempotency_key, memo)
  values (p_profile, null, 'redemption', -p_points, p_idem,
          'Redeemed for ' || p_kind::text)
  on conflict (idempotency_key) do nothing;

  select id into v_red from redemptions where idempotency_key = p_idem;

  insert into outbox (topic, payload) values
    ('redemption.requested', jsonb_build_object(
       'redemption_id', v_red, 'profile_id', p_profile,
       'kind', p_kind, 'points', p_points,
       'network', p_network, 'plan_code', p_plan_code));

  return v_red;
end;
$$;

-- EXECUTE on a new function is granted to PUBLIC by default. Revoking only
-- from anon and authenticated leaves the PUBLIC grant in place, so the
-- function stays executable by every role. The house pattern (0003, 0006) is
-- `from public, anon, authenticated` plus an explicit grant to service_role
-- — without the service_role grant the API would lose access after the
-- revoke, so both halves are needed.
revoke execute on function redeem_points(uuid, redemption_kind, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function redeem_points(uuid, redemption_kind, integer, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------
-- 3. negative-balance guard — REDEMPTIONS ONLY
--
-- point_entries is an append-only ledger: it cannot itself hold a running
-- balance, so the guard is a deferred constraint trigger that re-validates
-- the affected profile's balance AFTER the row lands. Belt-and-braces on
-- top of the advisory lock, and it also catches a hand-run bad insert.
-- Row-level (not statement-level) so it works on every PostgreSQL,
-- including the PGlite build used for local verification.
--
-- SCOPE — WHY THIS FIRES ONLY ON 'redemption'.
-- The first version of this trigger fired on EVERY point_entries insert and
-- refused any insert that left the balance negative. That was wrong, and the
-- project's own points suite caught it: a reversal is a legitimate negative
-- entry. reverse_point_entry() mirrors a prior entry as kind='reversal',
-- and when the mirrored points have already been spent, the correct balance
-- after the correction is NEGATIVE — that negative number is the promoter's
-- debt, and it is how the ledger records it. A blanket guard therefore
-- forbids corrections (fraud clawbacks, bad-task reversals, refunds) and
-- breaks the documented model: "corrections are reversal entries, never
-- edits". db/points.test.mjs case 16 asserts exactly this outcome
-- (3650 - 3750 = -100).
--
-- So the guard is narrowed to the ONE case where a negative result is
-- genuinely illegal: a REDEMPTION. A redemption is a voluntary spend of
-- points; it may never take the balance below zero, and it may not spend
-- against an existing debt. Rewards ('task_reward','referral_reward',
-- 'views_bonus') are income and are always positive by constraint.
-- 'adjustment' and 'reversal' are corrections and are deliberately ALLOWED
-- to drive the balance negative, because that is the debt the correction
-- creates. The advisory lock plus the explicit balance check inside
-- redeem_points() remain the primary defence; this trigger is the
-- backstop for a hand-run insert that bypasses the function.
-- ---------------------------------------------------------------------
create or replace function assert_non_negative_balance()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Only redemptions must not overdraw. Corrections (reversal/adjustment)
  -- are allowed to drive the balance negative: that is the debt.
  if new.kind = 'redemption' and points_balance(new.profile_id) < 0 then
    raise exception 'points balance for % would go negative', new.profile_id
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists trg_point_entries_non_negative on point_entries;
drop trigger if exists trg_point_entries_redemption_non_negative on point_entries;

create constraint trigger trg_point_entries_redemption_non_negative
  after insert on point_entries
  deferrable initially deferred
  for each row
  execute function assert_non_negative_balance();
