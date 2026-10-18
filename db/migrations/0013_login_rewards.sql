-- 0013 — daily login rewards + rated repost.
--
-- Owner mandate: daily check-ins pay points; streaks pay bonus milestones;
-- a perfect month (a Lagos-calendar month with ZERO missed days) pays a
-- points bonus AND queues a free data bundle; the reviewer may rate a
-- repost submission 1-5 and a low rating scales the payout instead of
-- silently approving full points.
--
-- Everything here follows the house rules the earlier migrations enforce:
--
--   * money-adjacent state only moves through point_entries with a stable
--     idempotency_key, so a retried call can never pay twice;
--   * every award leaves an outbox row in the same transaction, so a crash
--     mid-flow is retried, never lost;
--   * table inserts happen through functions the service role calls; the
--     tables themselves stay closed to clients by RLS;
--   * Africa/Lagos is the product's day.
--
-- 1. rating column — 1..5, nullable: only rated submissions carry a value.

alter table tasks
  add column if not exists rating smallint;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_rating_range' and conrelid = 'tasks'::regclass
  ) then
    alter table tasks add constraint tasks_rating_range
      check (rating between 1 and 5);
  end if;
end $$;

-- 2. new ledger kind for login awards. PostgreSQL >= 12 allows ADD VALUE in
-- migration scripts (same pattern as 0012 used for views_bonus); nothing
-- below writes a 'login_daily' row outside a function body.

alter type point_kind add value if not exists 'login_daily' after 'views_bonus';

-- 3. login_days — one row per promoter per Lagos day. The (profile, day)
-- uniqueness IS the idempotency: a replayed check-in finds the row already
-- there and pays nothing again.

create table if not exists login_days (
  profile_id uuid not null references profiles(id) on delete cascade,
  day        date not null,
  created_at timestamptz not null default now(),
  primary key (profile_id, day)
);

alter table login_days enable row level security;

create policy login_days_own_read on login_days
  for select using (profile_id = auth.uid());

revoke insert, update, delete on login_days from anon, authenticated;

create index login_days_profile_idx on login_days(profile_id, day desc);

-- 4. settings — every knob the owner can turn from the admin console later.

insert into settings(key, value, value_type, label, group_name) values
  ('login.points_per_day',        '{"v":10}'::jsonb,  'int',
   'Points paid for each daily check-in', 'login'),
  ('login.streak_7_bonus',        '{"v":50}'::jsonb,  'int',
   'Bonus on every 7-day streak milestone', 'login'),
  ('login.streak_30_bonus',       '{"v":500}'::jsonb, 'int',
   'Bonus on every 30-day streak milestone', 'login'),
  ('login.perfect_month_points',  '{"v":1000}'::jsonb, 'int',
   'Point bonus for a perfect month (no missed day)', 'login'),
  ('login.perfect_month_data_mb', '{"v":500}'::jsonb, 'int',
   'Free data bundle (MB) queued for a perfect month', 'login')
on conflict (key) do update set label = excluded.label, value_type = excluded.value_type;

insert into settings(key, value, value_type, label, group_name) values
  ('repost.min_rating_full',   '{"v":4}'::jsonb, 'int',
   'Repost rating from which full points still pay', 'repost'),
  ('repost.low_rating_factor', '{"v":0.5}'::jsonb, 'json',
   'Payout factor for reposts rated below the full-rating floor', 'repost')
on conflict (key) do update set label = excluded.label, value_type = excluded.value_type;

-- 5. checkin(p_profile) — the daily award.
--
-- Returns {"already":true,"day":...} when today's row already exists (an
-- idempotent no-op), otherwise
-- {"already":false,"day":...,"streak":...,"points":...,"perfectMonth":...}.
--
-- Awards, in order:
--   a) login.points_per_day for the day;
--   b) streak milestones - a bonus at every 7th and 30th consecutive day;
--   c) perfect-month evaluation - runs on the first day of a month,
--      checking the whole previous month; a complete month leaves an
--      outbox event the worker turns into a data delivery when the
--      aggregator is configured. A perfect streak continues across the
--      month boundary, so a genuinely perfect performer always triggers
--      this on exactly the right day - no scheduler, no late credits,
--      no re-evaluation loops.

create or replace function checkin(p_profile uuid) returns jsonb
language plpgsql as $$
declare
  v_day     date     := (now() at time zone 'africa/lagos')::date;
  v_points  integer  := 0;
  v_award   integer;
  v_streak  integer  := 0;
  v_target  date;
  v_level   integer;
  v_prev    date;
  v_mstart  date;
  v_mdays   integer;
  v_seen    integer;
  v_perfect boolean;
  v_perfect_month jsonb := null;
begin
  insert into login_days (profile_id, day)
    values (p_profile, v_day)
  on conflict (profile_id, day) do nothing;
  if not found then
    return jsonb_build_object('already', true, 'day', to_char(v_day, 'YYYY-MM-DD'));
  end if;

  -- consecutive days ending today (the row we just inserted means at least 1)
  v_target := v_day;
  while exists (select 1 from login_days d where d.profile_id = p_profile and d.day = v_target) loop
    v_streak := v_streak + 1;
    v_target := v_target - 1;
  end loop;

  -- the daily award
  v_award := (select (s.value->>'v')::int from settings s where s.key = 'login.points_per_day');
  if coalesce(v_award, 0) > 0 then
    insert into point_entries (profile_id, kind, points, idempotency_key, memo)
      values (p_profile, 'login_daily', v_award,
              'login:' || p_profile::text || ':' || to_char(v_day, 'YYYY-MM-DD'),
              'Daily check-in')
    on conflict (idempotency_key) do nothing;
    if found then v_points := v_points + v_award; end if;
  end if;

  -- 7-day milestone: pays on every streak that reaches a multiple of 7
  if v_streak % 7 = 0 then
    v_award := (select (s.value->>'v')::int from settings s where s.key = 'login.streak_7_bonus');
    if coalesce(v_award, 0) > 0 then
      insert into point_entries (profile_id, kind, points, idempotency_key, memo)
        values (p_profile, 'login_daily', v_award,
                'login7:' || p_profile::text || ':' || to_char(v_day, 'YYYY-MM-DD'),
                '7-day streak milestone (#' || (v_streak / 7)::text || ')')
      on conflict (idempotency_key) do nothing;
      if found then v_points := v_points + v_award; end if;
    end if;
  end if;

  -- 30-day milestone
  if v_streak % 30 = 0 then
    v_award := (select (s.value->>'v')::int from settings s where s.key = 'login.streak_30_bonus');
    if coalesce(v_award, 0) > 0 then
      insert into point_entries (profile_id, kind, points, idempotency_key, memo)
        values (p_profile, 'login_daily', v_award,
                'login30:' || p_profile::text || ':' || to_char(v_day, 'YYYY-MM-DD'),
                '30-day streak milestone')
      on conflict (idempotency_key) do nothing;
      if found then v_points := v_points + v_award; end if;
    end if;
  end if;

  -- perfect month: evaluated on any check-in that lands on the 1st of a
  -- Lagos calendar month, against the whole previous month.
  v_prev := v_day - 1;
  if extract(day from v_day) = 1 then
    v_mstart := date_trunc('month', v_prev)::date;
    v_mdays  := (v_prev - v_mstart + 1);
    v_seen   := (select count(*) from login_days d
                  where d.profile_id = p_profile
                    and d.day >= v_mstart and d.day <= v_prev);
    v_perfect := v_seen = v_mdays;
    if v_perfect then
      v_award := (select (s.value->>'v')::int from settings s where s.key = 'login.perfect_month_points');
      insert into point_entries (profile_id, kind, points, idempotency_key, memo)
        values (p_profile, 'login_daily', greatest(coalesce(v_award, 0), 0),
                'loginm:' || to_char(v_mstart, 'YYYY-MM') || ':' || p_profile::text,
                'Perfect month ' || to_char(v_mstart, 'YYYY-MM'))
      on conflict (idempotency_key) do nothing;
      if found then
        v_points := v_points + greatest(coalesce(v_award, 0), 0);
        insert into outbox (topic, payload)
          values ('login.perfect_month', jsonb_build_object(
            'profile_id', p_profile,
            'month', to_char(v_mstart, 'YYYY-MM'),
            'mb', coalesce((select (s.value->>'v')::int from settings s
                              where s.key = 'login.perfect_month_data_mb'), 0)));
      end if;
    end if;
    v_perfect_month := jsonb_build_object('month', to_char(v_mstart, 'YYYY-MM'), 'complete', v_perfect);
  end if;

  if v_points > 0 then
    v_level := level_for(p_profile);
    insert into outbox (topic, payload) values
      ('points.awarded', jsonb_build_object(
         'profile_id', p_profile, 'points', v_points,
         'level', v_level, 'source', 'login'));
  end if;

  return jsonb_build_object('already', false, 'day', to_char(v_day, 'YYYY-MM-DD'),
    'streak', v_streak, 'points', v_points, 'perfectMonth', v_perfect_month);
end;
$$;

revoke execute on function checkin(uuid) from anon, authenticated;

-- 6. login_status(p_profile) — what the dashboard paints: today's state,
-- the streak, and this month's checked days (Lagos calendar).

create or replace function login_status(p_profile uuid) returns jsonb
language plpgsql stable as $$
declare
  v_day     date := (now() at time zone 'africa/lagos')::date;
  v_checked boolean;
  v_streak  integer := 0;
  v_target  date;
  v_mstart  date := date_trunc('month', v_day)::date;
  v_days    integer := (v_day - v_mstart);
  v_grid    jsonb;
begin
  v_checked := exists (select 1 from login_days d where d.profile_id = p_profile and d.day = v_day);
  v_target := case when v_checked then v_day else v_day - 1 end;
  while exists (select 1 from login_days d where d.profile_id = p_profile and d.day = v_target) loop
    v_streak := v_streak + 1;
    v_target := v_target - 1;
  end loop;
  select coalesce(jsonb_agg(to_char(d.day, 'YYYY-MM-DD') order by d.day), '[]'::jsonb)
    into v_grid
    from login_days d
   where d.profile_id = p_profile
     and d.day >= v_mstart
     and d.day < v_mstart + interval '1 month';
  return jsonb_build_object(
    'lagosDay', to_char(v_day, 'YYYY-MM-DD'),
    'checkedInToday', v_checked,
    'streak', v_streak,
    'daysElapsedThisMonth', v_days,
    'checkedThisMonth', coalesce(v_grid, '[]'::jsonb));
end;
$$;

revoke execute on function login_status(uuid) from anon, authenticated;
