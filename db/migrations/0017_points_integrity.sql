-- =====================================================================
-- 0017_points_integrity.sql
--
-- Three defects that are ALREADY APPLIED to the live database, so they are
-- fixed forward here rather than by editing 0008/0012/0013.
--
--   1. A PROMOTER COULD SET THEIR OWN TASK'S POINTS VALUE (critical,
--      reproduced). `grant update on public.tasks to authenticated` plus
--      the `tasks_submit` policy (assigned_to = auth.uid()) let the
--      ASSIGNED promoter update their own task row — including
--      points_awarded. Measured in PGlite: as `authenticated`,
--          update tasks set points_awarded = 999999 where id = <own task>
--      succeeded, and the worker then paid 999,999 points, which converts
--      straight into paid data bundles. The policy guards WHICH ROWS a
--      promoter may touch; nothing guarded WHICH COLUMNS.
--
--   2. `revoke execute on function ... from anon, authenticated` does NOT
--      remove the grant PostgreSQL gives every new function to PUBLIC.
--      Thirteen money functions were therefore still executable by PUBLIC.
--      The house pattern (0003, 0006) is `from public, anon, authenticated`
--      PLUS an explicit `grant execute ... to service_role` — without the
--      grant the API loses access after the revoke, so both halves travel
--      together.
--
--   3. The money functions had no pinned search_path, so a shadowed object
--      in a caller's search_path could redirect a write. `alter function
--      ... set search_path = public` pins it without rewriting a single
--      line of the function body.
--
-- Requires 0016.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. task point values belong to the platform
-- ---------------------------------------------------------------------
-- The trigger fires for every database role, so it cannot be side-stepped
-- by a privileged connection. The platform's own service-role writes are
-- allowed (PostgREST runs them as `service_role`), and a privileged local
-- role is allowed; everything else is refused. The `amplo.task_points_ok`
-- escape hatch matches the house pattern used by guard_role_change.
create or replace function guard_task_points() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.points_awarded is distinct from old.points_awarded
      or new.points_bonus is distinct from old.points_bonus)
     and current_setting('amplo.task_points_ok', true) is distinct from '1'
     and coalesce(current_setting('role', true), '') not in ('service_role','postgres','supabase_admin')
     and current_user not in ('service_role','postgres','supabase_admin')
  then
    raise exception 'task points are set by the platform, not by the promoter'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_points_guard on tasks;
create trigger tasks_points_guard
  before update of points_awarded, points_bonus on tasks
  for each row execute function guard_task_points();

comment on function guard_task_points() is
  'Refuses a change to tasks.points_awarded / tasks.points_bonus by anyone '
  'but the platform, so an assigned promoter cannot price their own task.';

-- ---------------------------------------------------------------------
-- 2. the money functions: PUBLIC no longer holds EXECUTE
--
-- Each function is revoked from PUBLIC and granted to service_role, which
-- is the role the API runs as. The read-only helpers (points_balance and
-- friends) are granted to authenticated as well, because the promoter's
-- own balance is theirs to read.
-- ---------------------------------------------------------------------
do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.award_task_points(uuid)',
    'public.qualify_referral(uuid)',
    'public.reverse_point_entry(uuid, text)',
    'public.fund_campaign_escrow(uuid, bigint, uuid, text, text)',
    'public.claim_task(uuid, uuid)',
    'public.award_task_points_networked(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', sig);
    execute format('grant execute on function %s to service_role', sig);
  end loop;
end $$;

-- The two login-reward functions are called by the API on the caller's
-- behalf, so they need service_role as well.
revoke execute on function public.checkin(uuid) from public, anon, authenticated;
grant execute on function public.checkin(uuid) to service_role;

revoke execute on function public.login_status(uuid) from public, anon, authenticated;
grant execute on function public.login_status(uuid) to service_role;

-- The read-only balance helpers: a signed-in promoter may read their own
-- balance, so authenticated keeps EXECUTE on them. anon does not.
revoke execute on function public.points_balance(uuid) from public, anon;
grant execute on function public.points_balance(uuid) to authenticated, service_role;

revoke execute on function public.level_for(uuid) from public, anon;
grant execute on function public.level_for(uuid) to authenticated, service_role;

revoke execute on function public.cash_unlocked(uuid) from public, anon;
grant execute on function public.cash_unlocked(uuid) to authenticated, service_role;

revoke execute on function public.qualified_referral_count(uuid) from public, anon;
grant execute on function public.qualified_referral_count(uuid) to authenticated, service_role;

revoke execute on function public.next_level_requirements(uuid) from public, anon;
grant execute on function public.next_level_requirements(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. pin the search_path of every money function
--
-- ALTER FUNCTION changes the setting without touching the body, so no
-- function logic is re-written here — the bodies stay exactly as the
-- earlier migrations wrote them.
-- ---------------------------------------------------------------------
alter function public.award_task_points(uuid) set search_path = public;
alter function public.qualify_referral(uuid) set search_path = public;
alter function public.reverse_point_entry(uuid, text) set search_path = public;
alter function public.points_balance(uuid) set search_path = public;
alter function public.level_for(uuid) set search_path = public;
alter function public.cash_unlocked(uuid) set search_path = public;
alter function public.qualified_referral_count(uuid) set search_path = public;
alter function public.next_level_requirements(uuid) set search_path = public;
alter function public.fund_campaign_escrow(uuid, bigint, uuid, text, text) set search_path = public;
alter function public.claim_task(uuid, uuid) set search_path = public;
alter function public.award_task_points_networked(uuid) set search_path = public;
alter function public.checkin(uuid) set search_path = public;
alter function public.login_status(uuid) set search_path = public;
alter function public.has_perm(text) set search_path = public;
alter function public.current_role_name() set search_path = public;
