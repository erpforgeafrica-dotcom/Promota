-- =====================================================================
-- 0018_task_policy_gate.sql
--
-- WHY THIS EXISTS
-- Promota sold engagement actions that every major platform prohibits
-- when they are bought: likes, comments, follows, subscribes, views,
-- channel joins and paid shares of a specific post. Meta's spam policy bans "selling, buying, or
-- exchanging for engagement"; TikTok bans the "trade of services that
-- artificially boost engagement"; YouTube's fake-engagement policy says
-- a brand that hires promoters can lose its channel for their violations;
-- X bans "compensating others to conduct account metric inflation"; and
-- FTC 16 CFR Part 465 bans buying or selling fake social-media indicators.
--
-- The fix is not a hidden link. Cloaking is itself a violation, and a paid
-- like is prohibited no matter how privately it is dispatched. The fix is
-- to stop selling the prohibited action and to sell only work a creator
-- may openly do:
--
--   content       an original, disclosed post / reel / short
--   distribution  the creator publishes brand-supplied content on their
--                 own channel with the platform's branded-content toggle
--   review        an honest review of a product the creator actually
--                 received (verified purchase, never sentiment-conditioned)
--
-- The gate lives in Postgres so no API path, admin script or future
-- client can create or claim a prohibited task by accident.
--
-- Existing rows are NOT deleted. Draft tasks whose action is prohibited
-- become policy_class = 'prohibited' and can no longer be claimed; tasks
-- already assigned keep their state machine and can still be approved and
-- paid, so no creator loses work already done.
--
-- Requires 0012 (claim_task), 0017 (function hardening).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The policy vocabulary. One function, used by the trigger, the claim
--    guard and the tests, so classification can never drift.
-- ---------------------------------------------------------------------
create or replace function current_task_policy_version() returns text
language sql immutable set search_path = public as $$ select '2026-10-26'::text $$;

create or replace function task_policy_class(p_action text) returns text
language sql immutable set search_path = public as $$
  select case lower(coalesce(nullif(btrim(p_action), ''), 'post'))
    when 'post'   then 'content'
    when 'repost' then 'distribution'
    when 'share'  then 'distribution'
    when 'review' then 'review'
    else 'prohibited'
  end
$$;

comment on function task_policy_class(text) is
  'Maps an action type to the only delivery classes Promota may sell: content, distribution, review. Everything else is prohibited paid engagement.';

-- ---------------------------------------------------------------------
-- 2. Columns on tasks
-- ---------------------------------------------------------------------
alter table tasks
  add column if not exists policy_class text,
  add column if not exists policy_version text,
  add column if not exists release_at timestamptz not null default now(),
  add column if not exists attribution_code text,
  add column if not exists review_verified_purchase boolean not null default false;

-- Backfill. A review without a verified purchase is not a review we may
-- sell, so it is classified prohibited rather than silently allowed.
update tasks
   set policy_class = case
         when task_policy_class(action_type) = 'review'
              and not coalesce(review_verified_purchase, false) then 'prohibited'
         else task_policy_class(action_type)
       end
 where policy_class is null;

update tasks
   set policy_version = current_task_policy_version()
 where policy_version is null;

update tasks
   set attribution_code = 'PM' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
 where attribution_code is null;

alter table tasks alter column policy_class set not null;
alter table tasks alter column policy_version set not null;

alter table tasks
  add constraint tasks_policy_class_valid
  check (policy_class in ('content', 'distribution', 'review', 'prohibited'));

create unique index if not exists tasks_attribution_code_key
  on tasks(attribution_code)
  where attribution_code is not null;

create index if not exists tasks_policy_release_idx
  on tasks(policy_class, release_at)
  where state = 'draft';

-- ---------------------------------------------------------------------
-- 3. Insert / update guard. New prohibited work is impossible; a review
--    must carry a verified-purchase attestation; every task gets a unique
--    attribution code so creators never have to post one shared link.
-- ---------------------------------------------------------------------
create or replace function guard_task_policy() returns trigger
language plpgsql set search_path = public as $$
begin
  new.policy_class := task_policy_class(new.action_type);

  if new.policy_class = 'prohibited' then
    raise exception 'action type % is prohibited: Promota does not sell likes, comments, follows, subscribes, views, paid shares of a specific post, or channel joins', new.action_type
      using errcode = 'check_violation';
  end if;

  if new.policy_class = 'review' and not coalesce(new.review_verified_purchase, false) then
    raise exception 'a review task requires a verified purchase' using errcode = 'check_violation';
  end if;

  if btrim(coalesce(new.disclosure_tag, '')) = '' then
    raise exception 'every paid task needs a disclosure tag' using errcode = 'check_violation';
  end if;

  if new.attribution_code is null then
    new.attribution_code := 'PM' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  end if;

  new.policy_version := current_task_policy_version();
  return new;
end;
$$;

drop trigger if exists tasks_policy_guard on tasks;
create trigger tasks_policy_guard
  before insert or update of action_type, review_verified_purchase, disclosure_tag on tasks
  for each row execute function guard_task_policy();

-- ---------------------------------------------------------------------
-- 4. Creator acknowledgement. A promoter accepts the delivery policy once
--    per version; claim_task() refuses until they do.
-- ---------------------------------------------------------------------
alter table profiles
  add column if not exists policy_ack_version text,
  add column if not exists policy_ack_at timestamptz;

create or replace function ack_task_policy(p_profile uuid, p_version text) returns void
language plpgsql set search_path = public as $$
begin
  if p_version is distinct from current_task_policy_version() then
    raise exception 'the creator delivery policy is version %, not %; reload before acknowledging',
      current_task_policy_version(), coalesce(p_version, '(none)')
      using errcode = 'check_violation';
  end if;

  update profiles
     set policy_ack_version = p_version,
         policy_ack_at = now(),
         updated_at = now()
   where id = p_profile;

  if not found then
    raise exception 'profile % does not exist', p_profile using errcode = 'check_violation';
  end if;
end;
$$;

revoke execute on function ack_task_policy(uuid, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Claim guard. Same signature as 0012 so api/routes.mjs keeps working.
--    Refusals are explicit so the dashboard can tell the creator what to
--    do instead of showing a generic failure.
-- ---------------------------------------------------------------------
create or replace function claim_task(p_task uuid, p_profile uuid) returns void
language plpgsql set search_path = public as $$
declare
  v_policy   text;
  v_version  text;
  v_campaign uuid;
  v_release  timestamptz;
begin
  select policy_class, policy_version, campaign_id, release_at
    into v_policy, v_version, v_campaign, v_release
    from tasks
   where id = p_task;

  if v_policy is null then
    raise exception 'task % is no longer available', p_task
      using errcode = 'unique_violation';
  end if;

  if v_policy = 'prohibited' then
    raise exception 'task % is not offered: paid engagement of this type is prohibited by platform policy', p_task
      using errcode = 'check_violation';
  end if;

  if v_policy = 'review' then
    if not exists (select 1 from tasks t where t.id = p_task and t.review_verified_purchase) then
      raise exception 'review task % needs a verified purchase before it can be claimed', p_task
        using errcode = 'check_violation';
    end if;
  end if;

  if btrim(coalesce((select disclosure_tag from tasks where id = p_task), '')) = '' then
    raise exception 'task % has no disclosure tag and cannot be claimed', p_task
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from profiles pr
     where pr.id = p_profile
       and pr.policy_ack_version = v_version
  ) then
    raise exception 'acknowledge the creator delivery policy (version %) before claiming', v_version
      using errcode = 'check_violation';
  end if;

  if v_release > now() then
    raise exception 'task % is not released yet', p_task
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from tasks t
     where t.campaign_id = v_campaign
       and t.assigned_to = p_profile
       and t.state in ('assigned', 'submitted', 'checking', 'held', 'approved', 'paid')
  ) then
    raise exception 'you already hold a task from this campaign; finish it before claiming another'
      using errcode = 'check_violation';
  end if;

  update tasks
     set state = 'assigned', assigned_to = p_profile,
         assigned_at = now(), updated_at = now()
   where id = p_task
     and state = 'draft'
     and policy_class <> 'prohibited'
     and release_at <= now()
     and exists (
       select 1 from campaigns c
        where c.id = tasks.campaign_id and c.state = 'live'
     );

  if not found then
    raise exception 'task % is no longer available', p_task
      using errcode = 'unique_violation';
  end if;

  insert into outbox(topic, payload)
    values ('task.claimed', jsonb_build_object('task_id', p_task, 'profile_id', p_profile));
end;
$$;

revoke execute on function claim_task(uuid, uuid) from anon, authenticated;

-- CREATE OR REPLACE resets a function's saved SET clauses (proven on PGlite:
-- proconfig came back null), so 0017's hardening is re-asserted here rather
-- than assumed. Same pin, same reason: a shadowed object in a caller's
-- search_path must not be able to redirect a claim write.
alter function public.claim_task(uuid, uuid) set search_path = public;
alter function public.ack_task_policy(uuid, text) set search_path = public;
alter function public.guard_task_policy() set search_path = public;
alter function public.task_policy_class(text) set search_path = public;
alter function public.current_task_policy_version() set search_path = public;
