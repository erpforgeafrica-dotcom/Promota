-- =====================================================================
-- 0010_flags.sql — feature flags (kill-switches the app reads without a library).
-- ---------------------------------------------------------------------
-- A flag is one row: key, enabled, payload. Reads are a plain SELECT, so any
-- client — SQL, PostgREST, a shell probe — can check a flag with no helper:
--
--   select enabled, payload from flags where key = 'kati_enabled';
--
-- Seeds are DEFAULTS PENDING OWNER CONFIRMATION. Owner flips them from the
-- admin UI without a migration. Do not hardcode these values in code.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. flags — one row per kill-switch
-- ---------------------------------------------------------------------
create table flags (
  key        text    primary key,
  enabled    boolean not null default false,
  payload    jsonb   not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. seeds — payouts stay on; Kati data delivery stays OFF until the owner
--    wires DATA_PROVIDER_* and flips kati_enabled. Idempotent.
-- ---------------------------------------------------------------------
insert into flags(key, enabled, payload) values
  ('payouts_enabled', true,  '{"v":true}'::jsonb),
  ('kati_enabled',    false, '{"v":false}'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 3. RLS — flags are reference data; any authenticated user may read.
-- ---------------------------------------------------------------------
alter table flags enable row level security;

create policy flags_read_authenticated on flags
  for select to authenticated using (true);

-- Writes are service_role only. The API layer owns mutation; the database
-- refuses direct client writes.
revoke insert, update, delete on flags from anon, authenticated;
