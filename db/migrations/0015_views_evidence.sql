-- =====================================================================
-- 0015_views_evidence.sql
--
-- Closes a points-farming exploit in the views bonus.
--
-- THE DEFECT (P0-2).
-- submitTask() accepts a client-supplied `views` number and stores it on
-- task_proofs. award_views_bonus() then paid the additive bracket on that
-- number with NO check on how it was obtained. The brackets are additive:
--
--     500 -> 50, 2000 -> 100, 10000 -> 200, 50000 -> 400
--
-- so a promoter who simply typed views=50000 earned 50+100+200+400 = 750
-- points for a task worth 100, with no evidence at all. Only Telegram was
-- really verified (the t.me/s page scrape), and that was optional.
--
-- THE FIX.
-- Every view count now carries its provenance in task_proofs.views_source:
--
--   'scraped'       - read from the platform's public page (t.me/s). Real.
--   'reviewer'      - read by a human reviewer from the submitted proof.
--   'client_claimed'- the promoter typed it. NOT evidence.
--
-- award_views_bonus() pays ONLY on 'scraped' and 'reviewer'. A
-- 'client_claimed' count pays nothing.
--
-- The other half of the fix is that an unverified claim must not CONSUME
-- the task's one-shot bonus. points_bonus IS NULL means "nothing considered
-- for this task yet"; so when the evidence is unverified we return 0 and
-- deliberately leave points_bonus NULL. A reviewer who later supplies a
-- verified count can still award the bonus (POST /api/admin/tasks/:id/views).
--
-- The 'scraped' source is constrained to require parsed = true, so a row
-- cannot claim it was scraped without the parse flag.
--
-- Requires 0012 (award_views_bonus) and 0014 (point_entries trigger).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. provenance
-- ---------------------------------------------------------------------
alter table task_proofs add column if not exists views_source text;

comment on column task_proofs.views_source is
  'Provenance of the view count: scraped (read from the platform''s public '
  'page), reviewer (read by a human from the proof), client_claimed (the '
  'promoter typed it - NOT evidence and never paid).';

alter table task_proofs drop constraint if exists task_proofs_views_source_allowed;
alter table task_proofs add constraint task_proofs_views_source_allowed
  check (views_source is null or views_source in ('scraped','reviewer','client_claimed'));

-- 'scraped' is only true when the parse actually happened.
alter table task_proofs drop constraint if exists task_proofs_scraped_needs_parse;
alter table task_proofs add constraint task_proofs_scraped_needs_parse
  check (views_source <> 'scraped' or parsed = true);

-- ---------------------------------------------------------------------
-- 2. backfill, honestly classified
--
-- NOTHING is upgraded to a verified source.
--
-- The old submit path stored `views: views ?? parsedViews` — the number the
-- promoter TYPED won, and `parsed` was set from the scrape. So a historical
-- row can carry parsed = true (the scrape worked) and still hold the
-- promoter's typed number. The stored value cannot be told apart from a
-- typed one, so no historical row may be labelled 'scraped': doing so would
-- re-grant the exact points-farming exploit this migration closes.
--
-- Every historical row with a number is therefore 'client_claimed', which
-- pays nothing. Only rows written AFTER this migration carry a real
-- provenance, because the API now records it.
-- ---------------------------------------------------------------------
update task_proofs set views_source = 'client_claimed'
 where views_source is null and views is not null;

update task_proofs set views_source = 'client_claimed'
 where views_source is null and parsed = true and views is null;

-- ---------------------------------------------------------------------
-- 3. award_views_bonus: pay only on verified evidence
-- ---------------------------------------------------------------------
create or replace function award_views_bonus(p_task uuid) returns integer
language plpgsql set search_path = public as $$
declare
  v_profile  uuid;
  v_bp       integer;
  v_views    bigint;
  v_source   text;
  v_brackets jsonb;
  v_min      bigint;
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

  -- The NEWEST proof row is the one that counts — not the newest VERIFIED
  -- row. Picking the newest verified row let an old reviewer-approved row
  -- outrank a newer submission.
  select coalesce(tp.views, 0), tp.views_source into v_views, v_source
    from task_proofs tp
   where tp.task_id = p_task
   order by tp.created_at desc limit 1;

  if v_source is null or v_source not in ('scraped','reviewer') then
    -- No verified evidence. Pay nothing, and do NOT consume the task's
    -- one-shot bonus: points_bonus stays NULL so a reviewer can still
    -- award it later by approving the task with a view count.
    return 0;
  end if;

  -- The evidence has to clear the platform's own threshold before any
  -- bracket applies. Without this, a single verified view already paid.
  -- The bonus is NOT consumed here: a reviewer who later supplies a real
  -- count must still be able to award it.
  v_min := coalesce((select (s.value->>'v')::bigint from settings s
                       where s.key = 'views.min_points'), 0);
  if v_views < v_min then
    return 0;
  end if;

  v_brackets := (select s.value->'v' from settings s where s.key = 'views.bonus_brackets');

  if v_brackets is not null and v_views is not null then
    v_award := coalesce((
      select sum((b->>'points')::integer)
      from jsonb_array_elements(v_brackets) b
      where (b->>'min')::bigint <= v_views
    ), 0);
  end if;

  if v_award <= 0 then
    -- Verified evidence, but below the lowest bracket: this task is now
    -- considered and pays no bonus.
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

-- EXECUTE is granted to PUBLIC on every new function; the revoke has to name
-- public explicitly or the grant survives. service_role keeps the access the
-- API needs.
revoke execute on function award_views_bonus(uuid) from public, anon, authenticated;
grant execute on function award_views_bonus(uuid) to service_role;
