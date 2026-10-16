-- =====================================================================
-- 0011_audit_view.sql — read-only reconciliation view over audit_log
-- ---------------------------------------------------------------------
-- The blog promises an "append-only audit log even the owner cannot edit"
-- with a "72h dispute SLA". The log itself (0001_core.sql) is already
-- append-only via the audit_immutable trigger. This migration adds the
-- read side: a VIEW that slices the log by target, actor, action and date
-- so support/finance/admin can reconcile who did what, to which record,
-- and when — without ever touching the underlying table.
--
-- LAWS:
--   1. CREATE VIEW only. This file MUST NOT alter audit_log in any way:
--      no ALTER TABLE, no new trigger, no policy change on audit_log.
--   2. The view selects; it never inserts, updates or deletes.
--   3. Writes stay service_role only via the API (see api/admin.mjs audit()).
--      Direct client reads of audit rows remain governed by the audit_read
--      policy on audit_log itself; this view is consumed through the
--      GET /api/admin/audit endpoint, which re-checks the caller's role.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. audit_reconciliation — one row per audit_log row, plus a date facet
-- ---------------------------------------------------------------------
create or replace view audit_reconciliation as
select
  id,
  created_at,
  created_at::date            as action_date,
  actor_id,
  actor_role,
  action,
  target_type,
  target_id,
  before_state,
  after_state
from audit_log;

-- ---------------------------------------------------------------------
-- 2. grants — read-only, and only where the API needs it
-- ---------------------------------------------------------------------
-- The API reads through the service role, which bypasses RLS but still
-- needs the grant. Anonymous and authenticated clients get nothing here:
-- they reach this data only via GET /api/admin/audit after requireAdmin().
revoke all on audit_reconciliation from anon, authenticated;
