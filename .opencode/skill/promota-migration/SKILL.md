---
name: promota-migration
description: "How to add a forward-only Postgres migration to the Promota repo safely: never edit an applied migration, verify the applied count against the repo, keep the PGlite suites green, and get the grants, RLS, search_path and advisory-lock details right. Use when adding or changing anything in db/migrations/."
metadata:
  project: promota
---

The procedure for changing the Promota schema (`C:\Users\pc\owoworks\db\migrations`).
The schema is where Promota's business rules live; a migration is therefore a
product change, not plumbing.

## The one rule

**Never edit a migration that has already been applied.**

Applied migrations are recorded in `public.owoworks_schema_migrations`. The
repository currently ships `0001_core.sql` through `0016_money_flows.sql`,
contiguous and four-digit numbered. If you edit file 0014 after it is
applied, the file and the live database now describe different schemas and
nobody will notice until something breaks in production.

A fix is always a new file with the next unused number.

## Before you write it

1. **Decide where the rule belongs.** If it can be a constraint, a trigger or
   a function, it belongs in SQL. `api/supabase.mjs` states the house rule:
   business rules are not implemented in JavaScript, so the PGlite suite can
   prove them without a server.
2. **Check the existing migrations.** `0003_access_control.sql` owns the
   privilege baseline. `0014_redemption_integrity.sql` owns redemption
   safety. `0016_money_flows.sql` owns the money-in and money-out tables.
   Extend the right place rather than duplicating a rule.
3. **Confirm the naming.** `NNNN_snake_case_name.sql`, four digits, matched by
   the loader in `scripts/migrations.mjs`. `api/readyz.mjs` counts files with
   `/^\d{4}_.*\.sql$/` and compares that count with the maximum applied
   version — a non-contiguous or misnamed file breaks the readiness check.

## The shape of a good migration

Every migration in this repo opens with a comment block that says, in plain
words, what defect it fixes and why. Example, from `0014_redemption_integrity.sql`:

```
-- 1. REDEEM RACE (critical). redeem_points() read points_balance() and
--    inserted with no row lock, so two concurrent redemptions both passed
--    the balance check and the balance went negative. Fixed with a
--    per-profile advisory transaction lock at the top of the function ...
```

Write that block first. If you cannot state the defect in plain words, you do
not yet understand the change.

Then, for each statement:

- **Re-runnable.** The migration is applied to fresh databases and to
  existing ones. Use `add column if not exists`, `create table if not exists`,
  `create or replace function`, `drop ... if exists` before a
  `create trigger`, `drop function if exists` before replacing a function
  whose signature changed.
- **Fully schema-qualified** where ambiguity is possible: `public.points_balance(...)`,
  `public.owoworks_schema_migrations`. The functions in `0014` drop the
  5-argument `redeem_points` first, because with both present a 5-argument
  call is ambiguous and the function is "not unique".
- **Commented where the reason is not obvious.** Match the density of the
  existing files — they explain the defect, not the syntax.

## The privilege checklist

Every new table, function, view or sequence needs its privileges decided in
the same migration. Forgetting this is the most common defect in this repo.

```sql
-- the browser must not touch it
revoke all on public.<new_table> from anon, authenticated;

-- the browser may read it (only if a policy actually constrains the rows)
grant select on public.<new_table> to authenticated;

-- a privileged function: close it to EVERYONE including PUBLIC
revoke execute on function public.<fn>(<signature>)
  from public, anon, authenticated;

-- the service-role API is the only caller
grant execute on function public.<fn>(<signature>) to service_role;

-- schema objects
revoke create on schema public from anon, authenticated;
```

Two traps, both of which have been real defects here:

- **Omitting `from public` in a `revoke execute`.** PostgreSQL grants
  `EXECUTE` on every new function to `PUBLIC` by default. Revoking only from
  `anon, authenticated` leaves the function callable by anyone. Always write
  `from public, anon, authenticated`.
- **Revoking without granting.** A function with no `grant ... to
  service_role` cannot be called by the API either. If the API calls it, the
  grant is part of the migration.

## RLS for a new table

```sql
alter table public.<new_table> enable row level security;

-- a promoter sees their own row
create policy <t>_own_read on public.<new_table>
  for select to authenticated using (auth.uid() = profile_id);

-- an admin reads everything, but only while active
create policy <t>_admin_read on public.<new_table>
  for select to authenticated
  using (exists (select 1 from profiles p
                  where p.id = auth.uid()
                    and p.role in ('admin','owner','finance')
                    and p.state = 'active'));
```

Copy the shape from `0016_money_flows.sql`. Note the `p.state = 'active'`
condition: a suspended admin must lose access.

## `security definer` functions

```sql
create or replace function public.<fn>(<signature>)
returns <type>
language plpgsql
security definer
set search_path = public
as $$ ... $$;

revoke execute on function public.<fn>(<signature>) from public, anon, authenticated;
grant execute on function public.<fn>(<signature>) to service_role;
```

`set search_path = public` is mandatory: without it a caller can shadow an
object name. `security definer` without the grant/revoke pair is a hole, and
with the grant but without `from public` in the revoke is still a hole.

## Money and concurrency

- Serialise per-entity money operations with a transaction-scoped advisory
  lock taken **before** the read it protects:

  ```sql
  perform pg_advisory_xact_lock(hashtextextended(p_profile::text, 0));
  ```

  That is the pattern from `redeem_points()` in `0014`.
- Use a `deferrable initially deferred` constraint trigger for a cross-row
  invariant that must be evaluated at commit.
- Idempotency is a `UNIQUE` constraint plus `on conflict do nothing`, never
  an application-level check. Money keys are request-scoped: see
  `redeem:<profile>:<nonce>` and the defect that motivated it in `0014`.
- A correction is a reversal entry, never an edit. `point_entries` and the
  double-entry tables are append-only.

## Verify before you claim

```powershell
node scripts/migrateUp.mjs              # applies every migration to a local PGlite db
node db/ledger.test.mjs                  # adversarial invariant suite
node db/leads.test.mjs
node db/points.test.mjs
node db/redemption-integrity.test.mjs
node db/views-evidence.test.mjs
npm test                                 # the whole chain, exit 0
```

A new migration needs a new test that asserts the database **refuses** the
bad write. Write it in the matching `db/*.test.mjs` using the repo's
`rejects(db, label, sql, expectFragment)` helper, which also checks that the
write was refused *for the expected reason*.

### The limit of the local suite

PGlite runs as superuser and superusers bypass RLS, so no local test can
fire an RLS policy. RLS is proven over the network with real
anon/authenticated JWTs: `node db/live.proof.mjs`. Say "RLS is unverified
locally" rather than implying local proof.

## Apply and confirm the applied count

```powershell
npm run db:remote     # apply to the live Supabase project
npm run db:probe      # reachability and state
```

Then confirm the applied count. The repo ships N migration files; the live
ledger's maximum applied version must equal N. The running instance reports
this itself:

```
GET /readyz -> { ready, checks: { migrations: { ok, repo: N, applied: N } } }
```

If `applied` is behind `repo`, the deploy is not ready — the image is newer
than the database. Fix the database first; the code waits.

## Related

- `.opencode/skill/promota-money-flow/SKILL.md` — the money path this
  migration must not break
- `.opencode/agent/promota-db-engineer.md` — the role that owns these files
- `.opencode/skill/promota-release/SKILL.md` — step 3 of the release
