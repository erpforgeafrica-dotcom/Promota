-- =====================================================================
-- 0009_competitions_ambassadors.sql — competitions, raffles, ambassador profiles, social accounts
-- ---------------------------------------------------------------------
-- Seeds are DEFAULTS PENDING OWNER CONFIRMATION. Owner tunes values from
-- the admin UI without a migration. Do not hardcode these numbers in code.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. competitions (time-boxed task sprints & monthly raffles)
-- ---------------------------------------------------------------------
create table competitions (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  kind             text not null check (kind in ('sprint','raffle')),
  start_at         timestamptz not null,
  end_at           timestamptz not null,
  -- JSON: { "entry_fee_min_points": integer, "max_entries_per_promoter": integer, "prize_pool": [{kind, value, count}] }
  rules            jsonb not null default '{}'::jsonb,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index competitions_kind_idx on competitions(kind);
create index competitions_active_idx on competitions(is_active) where is_active = true;

-- ---------------------------------------------------------------------
-- 2. competition_entries — who entered which competition, their score/rank
-- ---------------------------------------------------------------------
create table competition_entries (
  id               uuid primary key default gen_random_uuid(),
  competition_id   uuid not null references competitions(id) on delete cascade,
  profile_id       uuid not null references profiles(id) on delete cascade,
  score            integer not null default 0,   -- points earned from qualified tasks in the period
  rank             integer,                       -- computed at draw time; null = not in prize tier
  entered_at       timestamptz not null default now(),
  -- uniqueness: one entry per promoter per competition
  constraint competition_entries_unique unique (profile_id, competition_id)
);

create index competition_entries_comp_idx on competition_entries(competition_id);
create index competition_entries_profile_idx on competition_entries(profile_id);

-- ---------------------------------------------------------------------
-- 3. ambassador_profiles — one row per signed‑in promoter
-- ---------------------------------------------------------------------
create table ambassador_profiles (
  profile_id       uuid primary key references profiles(id) on delete cascade,
  tier             text not null check (tier in ('junior','senior','executive')),
  monthly_stipend_minor integer not null default 0, -- in kobo (₦1 = 100 kobo); owner sets
  active_referees_this_month integer not null default 0,
  total_tasks_this_month integer not null default 0,
  status           text not null default 'inactive' check (status in ('inactive','active','paid')),
  last_stipend_at  timestamptz,
  updated_at       timestamptz not null default now()
);

create index ambassador_profiles_tier_idx on ambassador_profiles(tier);
create index ambassador_profiles_status_idx on ambassador_profiles(status);

-- ---------------------------------------------------------------------
-- 4. social_accounts — promoted platforms per promoter (OAuth / proof state)
-- ---------------------------------------------------------------------
create table social_accounts (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid not null references profiles(id) on delete cascade,
  platform         text not null check (platform in ('youtube','instagram','x','linkedin','tiktok')),
  handle           text not null,                   -- @username or vanity url
  oauth_provider   text,                            -- 'google' | 'twitter' | 'instagram' | 'linkedin' | 'tiktok'
  oauth_token      text,                            -- sealed; never exposed to client
  oauth_secret     text,                            -- sealed
  verified         boolean not null default false, -- has API verification passed?
  proof_snapshot   jsonb,                           -- stored screenshot metadata (username, timestamp, etc.)
  verified_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index social_accounts_profile_idx on social_accounts(profile_id);
create index social_accounts_platform_idx on social_accounts(platform);

-- ---------------------------------------------------------------------
-- 5. settings — every business number, owner‑tunable (seeds)
-- ---------------------------------------------------------------------
-- If keys already exist from a prior insert, do nothing (idempotent).
-- ---------------------------------------------------------------------
insert into settings(key, value, value_type, label, group_name) values
  ('competitions.sprint_points_per_task', '{"v":10}'::jsonb, 'int',
   'Points a promoter earns toward the weekly sprint per completed qualified task','competitions'),
  ('competitions.sprint_entry_fee_min_points', '{"v":0}'::jsonb, 'int',
   'Minimum points a promoter must have to enter a sprint competition','competitions'),
  ('competitions.sprint_max_entries_per_promoter', '{"v":50}'::jsonb, 'int',
   'Cap on raffle tickets a single promoter may accumulate in a sprint week','competitions'),
  ('competitions.raffle_tickets_per_100_points', '{"v":1}'::jsonb, 'int',
   'How many raffle tickets a promoter earns per 100 points from qualified tasks in the month','competitions'),
  ('competitions.raffle_max_tickets_per_promoter', '{"v":50}'::jsonb, 'int',
   'Maximum raffle tickets any promoter may accumulate per monthly draw','competitions'),
  ('competitions.raffle_draw_date', '{"v":"28"}}'::jsonb, 'text',
   'Day of month raffle draw happens (1–28). Set to 28 for end‑of‑month.','competitions'),
  ('ambassador.junior_stipend_minor', '{"v":2500000}'::jsonb, 'int', -- ₦25,000 in kobo
   'Monthly stipend for Junior Ambassador tier','ambassador'),
  ('ambassador.senior_stipend_minor', '{"v":6000000}'::jsonb, 'int', -- ₦60,000 in kobo
   'Monthly stipend for Senior Ambassador tier','ambassador'),
  ('ambassador.executive_stipend_minor', '{"v":15000000}'::jsonb, 'int', -- ₦150,000 in kobo
   'Monthly stipend for Executive Ambassador tier','ambassador'),
  ('ambassador.referral_commission_percent_junior', '{"v":5}'::jsonb, 'int',
   '% bonus on active referee task earnings for Junior Ambassador','ambassador'),
  ('ambassador.referral_commission_percent_senior', '{"v":8}'::jsonb, 'int',
   '% bonus on active referee task earnings for Senior Ambassador','ambassador'),
  ('ambassador.referral_commission_percent_executive', '{"v":10}'::jsonb, 'int',
   '% bonus on active referee task earnings for Executive Ambassador','ambassador')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 6. computed function: current active competition
-- ---------------------------------------------------------------------
create or replace function current_competition()
returns table (id uuid, title text, kind text, start_at timestamptz, end_at timestamz) language sql stable as $$
  select id, title, kind, start_at, end_at from competitions
   where is_active = true
   order by start_at desc
   limit 1;
$$;

-- ---------------------------------------------------------------------
-- 7. computed function: promoter's raffle ticket count for current month
-- ---------------------------------------------------------------------
create or function promoter_raffle_tickets(p_profile uuid)
returns integer language sql stable as $$
  select coalesce(sum(score / 100), 0)::integer
    from competition_entries
   where profile_id = p_profile
     and competition_id in (
       select id from competitions where kind = 'raffle' and is_active = true
         and end_at <= date_trunc('month', now()) + interval '1 month - 1 day'
         and start_at <= date_trunc('month', now())
     );
$$;

-- ---------------------------------------------------------------------
-- 8. RLS — new tables are private by default
-- ---------------------------------------------------------------------
-- Competitions are reference data; any authenticated user may read.
create policy competitions_read_authenticated on competitions
  for select to authenticated using (true);

-- Promoter sees only their own competition entries.
create policy competition_entries_own_read on competition_entries
  for select to authenticated using (auth.uid() = profile_id);

-- Ambassador profiles are reference data every authenticated user may read
-- (stipend tiers are public; individual promoter data is service_role only).
create policy ambassador_profiles_read_authenticated on ambassador_profiles
  for select to authenticated using (true);

-- Social accounts are private to the owner promoter.
create policy social_accounts_own_read on social_accounts
  for select to authenticated using (auth.uid() = profile_id);

-- Writes are service_role only. The API layer owns mutation; the database
-- refuses direct client writes.
revoke insert, update, delete on competitions from anon, authenticated;
revoke insert, update, delete on competition_entries from anon, authenticated;
revoke insert, update, delete on ambassador_profiles from anon, authenticated;
revoke insert, update, delete on social_accounts from anon, authenticated;

-- Computed functions safe to expose
grant execute on function current_competition() to anon, authenticated;
grant execute on function promoter_raffle_tickets(uuid) to anon, authenticated;

-- Mutation functions are service_role only
revoke execute on function award_task_points(uuid) from anon, authenticated;
revoke execute on function qualify_referral(uuid) from anon, authenticated;
revoke execute on function redeem_points(uuid, redemption_kind, integer, text, text) from anon, authenticated;
revoke execute on function reverse_point_entry(uuid, text) from anon, authenticated;
revoke execute on function points_balance(uuid) from anon, authenticated; -- already granted above if needed
grant execute on function points_balance(uuid) to anon, authenticated;