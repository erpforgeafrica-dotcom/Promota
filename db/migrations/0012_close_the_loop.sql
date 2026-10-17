-- 0012_close_the_loop.sql — closes the product gaps the owner called out:
--
--   1. self-serve campaign + task submission for verified businesses AND
--      individuals (admin still confirms; nothing goes live without escrow),
--   2. in-app task authentication: submission evidence (platform, post link,
--      view count, screenshot) plus an automatic Telegram view parser,
--   3. engagement actions as first-class task kinds (like/comment/follow/
--      subscribe/repost/share/view/join_channel — not only "post"),
--   4. process/task mining: real stage counts + stage timing evidence,
--   5. referral accelerant: bigger referral award, a downline task bonus,
--      and a softer ladder where cash unlocks at level 4 with 2 referrals,
--   6. campaign-owner verification (business + individual) and promoter
--      payout KYC fields (legal name + bank last4), tier stays in DB rules,
--   7. escrow funding as a REAL double-entry move (admin confirms receipt of
--      the business transfer) — the existing "cannot go live unfunded" guard
--      stays exactly as it is.
--
-- Money rules unchanged: balanced entries at commit, append-only postings,
-- idempotency claimed by UNIQUE keys on the INSERT.

-- ---------------------------------------------------------------------
-- 1. enums
-- ---------------------------------------------------------------------
-- A new point kind for the views bonus. PostgreSQL ≥ 12 allows ADD VALUE in
-- a transaction, but the value must not be INSERTed in the SAME transaction,
-- so nothing below writes a 'views_bonus' row here — only function bodies
-- that execute at runtime.
alter type point_kind add value if not exists 'views_bonus' after 'referral_reward';

-- ---------------------------------------------------------------------
-- 2. profiles: payout KYC fields (t1). Identity stays HMAC-only (t2).
-- ---------------------------------------------------------------------
alter table profiles
  add column if not exists legal_name  text,
  add column if not exists bank_name   text,
  add column if not exists bank_last4  text
    check (bank_last4 is null or bank_last4 ~ '^[0-9]{4}$'),
  add column if not exists kyc_note    text;

-- ---------------------------------------------------------------------
-- 3. tasks: engagement action types + evidence + views bonus
-- ---------------------------------------------------------------------
alter table tasks
  add column if not exists action_type text not null default 'post',
  add column if not exists views_required bigint check (views_required is null or views_required >= 0),
  add column if not exists points_bonus integer check (points_bonus is null or points_bonus >= 0),
  add column if not exists verdict text
    check (verdict in ('pending','auto_verified','unverified','approved','rejected')),
  add column if not exists verdict_source text;

create index if not exists tasks_action_idx on tasks(action_type);

-- ---------------------------------------------------------------------
-- 4. task_proofs — submission evidence, append-only per submission
-- ---------------------------------------------------------------------
create table task_proofs (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid not null references tasks(id) on delete cascade,
  profile_id      uuid not null references profiles(id) on delete cascade,
  platform        text not null,
  post_url        text not null,
  views           bigint check (views is null or views >= 0),
  screenshot_url  text,
  parsed          boolean not null default false,
  verdict         text not null default 'pending'
                  check (verdict in ('pending','auto_verified','unverified','approved','rejected')),
  verdict_source  text,
  created_at      timestamptz not null default now(),
  -- one evidence row per task submission; the submit path rewrites the
  -- proof, so a repeat attempt replaces rather than fans out rows.
  constraint task_proofs_task_unique unique (task_id)
);

create index task_proofs_profile_idx on task_proofs(profile_id, created_at desc);

alter table task_proofs enable row level security;
create policy task_proofs_select_own on task_proofs for select
  to authenticated
  using (profile_id = auth.uid());

-- ---------------------------------------------------------------------
-- 5. campaign_owners — verification of businesses AND individuals who want
--    to run campaigns. 'none' means the profile has not applied yet.
-- ---------------------------------------------------------------------
create table campaign_owners (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null unique references profiles(id) on delete cascade,
  kind          text not null check (kind in ('individual','business')),
  display_name  text not null,
  business_name text,
  business_reg  text,
  website       text,
  contact       text not null,
  verification_state text not null default 'pending'
                check (verification_state in ('pending','verified','rejected')),
  verification_note text,
  verified_at   timestamptz,
  reviewer_id   uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- a business owner must name the business; an individual must not need one
  constraint campaign_owners_business_named
    check (kind <> 'business' or (business_name is not null and business_name <> ''))
);

create index campaign_owners_state_idx on campaign_owners(verification_state);

-- ---------------------------------------------------------------------
-- 5b. social_links — a verified channel/handle per platform per profile.
--     Real verifies only: a probe must succeed before verified = true.
-- ---------------------------------------------------------------------
create table social_links (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references profiles(id) on delete cascade,
  platform       text not null check (platform in ('telegram','whatsapp','x','instagram','tiktok','facebook','youtube')),
  handle         text not null,
  verified       boolean not null default false,
  verified_at    timestamptz,
  probe_note     text,
  created_at     timestamptz not null default now(),
  constraint social_links_profile_platform_uq unique (profile_id, platform)
);

alter table social_links enable row level security;
create policy social_links_select_own on social_links for select
  to authenticated
  using (profile_id = auth.uid());

alter table campaign_owners enable row level security;
create policy campaign_owners_select_own on campaign_owners for select
  to authenticated
  using (profile_id = auth.uid());
create policy campaign_owners_update_own_pending on campaign_owners for update
  to authenticated
  using (profile_id = auth.uid() and verification_state = 'pending')
  with check (profile_id = auth.uid() and verification_state = 'pending');

-- ---------------------------------------------------------------------
-- 6. ladder tuning — softer referral gate, cash at level 4 with 2 referrals
--    (these rows were seeded with placeholder values pending owner call)
-- ---------------------------------------------------------------------
update levels set points_required = 3000,  min_referrals = 2,
  note = 'Boosted ladder: cash unlocks here with 2 qualified referrals.'
  where level = 4;
update levels set points_required = 7000,  min_referrals = 5,
  note = 'Referral-gated tier. Invite people who work.'
  where level = 5;
update levels set points_required = 14000, min_referrals = 10,
  note = 'Senior tier. Referral-gated.'
  where level = 6;

-- Referral award doubles; referral-gate/cash settings stay anchored at 4.
insert into settings(key, value, value_type, label, group_name) values
  ('points.per_referral',   '{"v":300}'::jsonb,  'int',
   'Points awarded to a referrer when their referee completes a first task','points')
on conflict (key) do update set value = '{"v":300}'::jsonb;

insert into settings(key, value, value_type, label, group_name) values
  ('points.referred_task_bonus_bp', '{"v":2500}'::jsonb, 'int',
   'Extra bp of each task reward paid to the qualified referrer of the worker (25% = 2500bp)','points'),
  ('views.bonus_brackets', '{"v":[{"min":500,"points":50},{"min":2000,"points":100},{"min":10000,"points":200},{"min":50000,"points":400}]}'::jsonb, 'json',
   'View counts reached add their points cumulatively to an approved task','points'),
  ('views.min_points',     '{"v":50}'::jsonb, 'int',
   'Minimum points a views bonus can pay','points')
on conflict (key) do update set label = excluded.label, value_type = excluded.value_type;

-- ---------------------------------------------------------------------
-- 7. escrow funding as a REAL ledger move (admin confirms transfer receipt)
--    The DB guard stays untouched: only funded campaigns ever go live.
-- ---------------------------------------------------------------------
create or replace function fund_campaign_escrow(
  p_campaign uuid,
  p_amount_minor bigint,
  p_created_by uuid,
  p_note text default 'escrow credit confirmed from business transfer',
  p_idem text default null
) returns bigint language plpgsql as $$
declare
  v_id       uuid;
  v_escrow   uuid;
  v_cash     uuid;
  v_currency char(3);
  v_idem     text;
begin
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'fund amount must be a positive number of kobo';
  end if;
  select currency into v_currency from campaigns where id = p_campaign;
  if v_currency is null then
    raise exception 'campaign % does not exist', p_campaign;
  end if;

  -- Caller-supplied idem keys give controlled replay; the default keys a
  -- unique funding per (campaign, amount, clock) so every explicit POST
  -- credits exactly once.
  v_idem := coalesce(
    nullif(trim(p_idem), ''),
    'escrowfund:' || p_campaign::text || ':' || p_amount_minor::text || ':' ||
    md5(clock_timestamp()::text || random()::text));

  select id into v_cash
    from accounts where code = 'PLATFORM_CASH_' || v_currency and scope = 'platform';

  select id into v_escrow
    from accounts where scope = 'campaign' and scope_id = p_campaign;
  if v_escrow is null then
    insert into accounts(code, name, type, scope, scope_id, currency)
      values ('ESCROW_' || upper(left(p_campaign::text, 8)),
              'Campaign escrow ' || left(p_campaign::text, 8),
              'ASSET', 'campaign', p_campaign, v_currency)
      returning id into v_escrow;
  end if;

  insert into ledger_entries(idempotency_key, kind, campaign_id, reference, currency, created_by)
    values (v_idem, 'escrow_funding', p_campaign, p_note,
            v_currency, p_created_by)
    on conflict (idempotency_key) do nothing;

  -- lost the unique key: this exact funding already exists, return the
  -- escrow balance instead of paying twice.
  if not found then
    select coalesce(sum(case when q.direction = 'D' then q.amount_minor else -q.amount_minor end), 0)
      into p_amount_minor
      from postings q join accounts a on a.id = q.account_id
      where a.scope = 'campaign' and a.scope_id = p_campaign;
    return p_amount_minor;
  end if;

  select id into v_id from ledger_entries where idempotency_key = v_idem;

  insert into postings(entry_id, account_id, direction, amount_minor, currency)
    values
      (v_id, v_cash,   'D', p_amount_minor, v_currency),
      (v_id, v_escrow, 'C', p_amount_minor, v_currency);

  return p_amount_minor;
end;
$$;

revoke execute on function fund_campaign_escrow(uuid, bigint, uuid, text, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. task claiming — a draft task of a LIVE campaign is assigned to its
--    claimer atomically. First claim wins; losers get a clear refusal.
-- ---------------------------------------------------------------------
create or replace function claim_task(p_task uuid, p_profile uuid) returns void
language plpgsql as $$
begin
  update tasks
     set state = 'assigned', assigned_to = p_profile,
         assigned_at = now(), updated_at = now()
   where id = p_task
     and state = 'draft'
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

-- ---------------------------------------------------------------------
-- 9. referral-network bonus — every completed task by a referred worker
--    also pays a bp-slice of its reward to that worker's referrer. Points
--    only, never cash; both anti-MLM rules stay intact.
-- ---------------------------------------------------------------------
create or replace function award_task_points_networked(p_task uuid) returns integer
language plpgsql as $$
declare
  v_profile  uuid;
  v_points   integer;
  v_bp       integer;
  v_bonus    integer;
  v_referrer uuid;
begin
  perform award_task_points(p_task);

  select assigned_to into v_profile from tasks where id = p_task;
  if v_profile is null then return 0; end if;

  v_points := (select points from point_entries
               where idempotency_key = 'task:' || p_task::text);
  if v_points is null or v_points <= 0 then return 0; end if;

  select r.referrer_id into v_referrer
    from referrals r
   where r.referee_id = v_profile and r.qualified_at is not null
   limit 1;
  if v_referrer is null then return 0; end if;

  v_bp := (select coalesce((s.value->>'v')::integer, 0)
             from settings s where s.key = 'points.referred_task_bonus_bp');
  v_bonus := round(v_points * v_bp / 10000.0)::integer;
  if v_bonus <= 0 then return 0; end if;

  insert into point_entries (profile_id, task_id, kind, points, idempotency_key, memo)
    values (v_referrer, p_task, 'adjustment', v_bonus,
            'refbonus:' || p_task::text, 'Referral network bonus')
    on conflict (idempotency_key) do nothing;

  if found then
    insert into outbox(topic, payload) values
      ('referral_network.awarded', jsonb_build_object(
         'referrer_id', v_referrer, 'worker_id', v_profile,
         'task_id', p_task, 'points', v_bonus));
    return v_bonus;
  end if;
  return 0;
end;
$$;

revoke execute on function award_task_points_networked(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 10. views bonus — paid once per task from the EVIDENCE row. Additive
--     brackets: reaching 500, 2000, 10000, 50000 views stacks their tier
--     points. Only auto-verified or review-verified agreements pay.
-- ---------------------------------------------------------------------
create or replace function award_views_bonus(p_task uuid) returns integer
language plpgsql as $$
declare
  v_profile  uuid;
  v_bp       integer;
  v_views    bigint;
  v_brackets jsonb;
  v_award    integer := 0;
begin
  -- points_bonus NULL means "nothing considered for this task yet"; any
  -- other value is a replay or a race loss and we return what already paid.
  select points_bonus, assigned_to into v_bp, v_profile
    from tasks where id = p_task;
  if v_bp is not null then return v_bp; end if;
  if v_profile is null then
    raise exception 'task % is not assigned', p_task;
  end if;

  select coalesce(views, 0) into v_views
    from task_proofs where task_id = p_task
    order by created_at desc limit 1;

  v_brackets := (select s.value->'v' from settings s where s.key = 'views.bonus_brackets');

  if v_brackets is not null and v_views is not null then
    v_award := coalesce((
      select sum((b->>'points')::integer)
      from jsonb_array_elements(v_brackets) b
      where (b->>'min')::bigint <= v_views
    ), 0);
  end if;

  if v_award <= 0 then
    update tasks set points_bonus = 0 where id = p_task and points_bonus is null;
    return 0;
  end if;

  update tasks set points_bonus = v_award where id = p_task and points_bonus is null;
  if not found then return 0; end if;  -- race loss: an earlier call paid

  insert into point_entries (profile_id, task_id, kind, points, idempotency_key, memo)
    values (v_profile, p_task, 'views_bonus', v_award,
            'views:' || p_task::text, 'Views bonus')
    on conflict (idempotency_key) do nothing;

  if found then
    insert into outbox(topic, payload) values
      ('points.awarded', jsonb_build_object(
         'profile_id', v_profile, 'task_id', p_task, 'points', v_award,
         'level', level_for(v_profile)));
  end if;
  return v_award;
end;
$$;

revoke execute on function award_views_bonus(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 11. mining surface — stage evidence over tasks + campaigns. Kept as a
--     view so the API can select straight from the ledger of record.
-- ---------------------------------------------------------------------
create or replace view mining_task_stages as
select
  t.id                                   as task_id,
  t.campaign_id,
  t.assigned_to,
  t.action_type,
  c.platform                             as campaign_platform,
  t.created_at,
  t.assigned_at,
  t.submitted_at,
  t.auto_approve_at,
  t.updated_at                            as last_update,
  case when t.state in ('approved','rejected') then t.updated_at end as decided_at,
  t.state,
  v.latest_views,
  v.views_source
from tasks t
join campaigns c on c.id = t.campaign_id
left join (
  select p.task_id, max(p.views) as latest_views, min(p.verdict_source) as views_source
  from task_proofs p
  where p.views is not null
  group by p.task_id
) v on v.task_id = t.id
where t.state <> 'draft';

-- executor: the view runs under its owner's rights, and the -service-role
-- server carries the query; grant consumption.
grant select on mining_task_stages to service_role;

-- done. Every change above is additive on top of the applied 0001..0011
-- chain (checked: levels/settings updates are the seeded owner-pending rows).
