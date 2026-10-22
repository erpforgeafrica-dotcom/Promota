---
name: promota-release
description: "The end-to-end Promota release procedure: local verification, commit, push, Railway deploy, live endpoint and live feature check, then documentation. Use when shipping a change to the owoworks repo, when asked to deploy/redeploy/promote Promota, or when asked to release."
metadata:
  project: promota
---

The release procedure for Promota (`C:\Users\pc\owoworks`). Follow it in
order. Steps 1 to 5 are mandatory and non-skippable; step 6 needs the owner's
confirmation of the Railway account; step 7 is what most releases skip and
must not.

The gate that decides whether the release may continue is the
`promota-release-gate` agent. This skill is the procedure it sits inside.

## Step 0 — Know what you are shipping

Read `AGENTS.md`. Then read the diff you are about to release. If the diff
touches `point_entries`, `redemptions`, `payout_accounts`, `campaign_payments`,
`ledger_entries` or the outbox, the money path is in scope: load the
`promota-money-flow` skill and make sure
`promota-money-path-auditor` has reviewed it before you get here.

State in one line what is being shipped. If you cannot, you are not ready.

## Step 1 — Local verification

```powershell
npm test
npm run site
node scripts/checkImage.mjs
node scripts/predeploy-check.js
```

`npm test` must exit 0. Record the per-suite counts — they go into the
changelog and the audit:

```
phone 17/0 | lead 24/0 | API 48/0 | image 7/0 | ledger 56/0 | leads 41/0 |
points 56/0 | dataManager <n>/<n>
```

If the change touches points, redemption or payout, also run:

```powershell
node db/points.test.mjs
node db/redemption-integrity.test.mjs
node db/ledger.test.mjs
```

**Nothing ships with a failing suite.** A test that must be weakened to go
green is a rejected release, not a fix.

## Step 2 — The release gate

Hand the change to `promota-release-gate`. It runs two independent passes —
the specialist reviews and its own fresh verification — and returns a
signed-off checklist with commands, results and labels. Both passes must
agree. A disagreement is a NO-GO, not a discussion.

Carry its checklist forward verbatim into step 7. Do not rewrite it.

## Step 3 — Migrations, if any

A new migration must be applied **before** the new code is deployed, so the
previous release keeps working against the new schema. Migrations are
forward-only; an applied migration is never edited.

```powershell
node scripts/migrateUp.mjs     # local PGlite, applies everything
npm run db:remote              # the live Supabase project
npm run db:probe               # confirm reachability and applied state
```

Then confirm the live database and the repo agree, using the running
instance's readiness probe (`api/readyz.mjs`): `checks.migrations.ok` is true
only when the maximum applied version equals the number of migration files
the repo ships.

Do not apply a migration to the live database before the gate has passed.

## Step 4 — Commit and push

Stage only the files that belong to this change. Review the staged diff
before committing — `git status`, `git diff --staged`, `git log --oneline -10`.

- Commit message style: the repo's existing history. A short imperative
  subject line, a body that states what changed and what was verified.
- Never commit `.env`, `apps/web/config.js`, any `*.key` or `*.pem`, or a
  secret value pasted into a diff. `.gitignore` already covers these; the
  job is to make sure nothing slipped past it.
- Never use `git push --force`, `git reset --hard` or `git clean` without
  the owner asking in this conversation.
- Push to the branch the deploy watches.

## Step 5 — The Railway identity gate

Before **any** state-changing Railway command:

1. The owner names the account in this conversation.
2. `railway whoami` is run live, in this session, and the returned identity
   is that account.
3. Only then: `railway up`, `railway variables set`, `railway domain`, a
   rollback, or a redeploy.

Never infer the account from memory, from `STATUS.md`, or from a previous
session. `STATUS.md` records the account used for a past deployment; that
is a record, not a permission. If the owner has not named an account, ask —
do not deploy to whichever one the CLI happens to be logged into.

Read-only Railway commands (`railway whoami`, `railway status`, `railway logs`)
are fine without the gate.

## Step 6 — Deploy and watch it come up

```powershell
railway up
railway logs --deployment
```

Then check the deployed service, in this order:

1. `GET /healthz` — the shape is frozen: `{ ok, config, auth, providers }`.
   It must return `ok: true` and report the providers you expect.
2. `GET /readyz` — `{ ready, checks: { supabase, flags, migrations } }`.
   All three checks must be `ok: true`. If `checks.migrations` reports
   `database is at migration N, repo ships M`, the deploy is not ready —
   stop and fix the migration state.
3. The build log must show a successful image build. The image ships
   `apps/web`, `server.mjs`, `api`, `providers` and `db/migrations`; if the
   build log shows a container that exits at boot with
   `ERR_MODULE_NOT_FOUND`, the Dockerfile is missing a `COPY`.

## Step 7 — The live feature check (not just HTTP 200)

A page that returns 200 is not a page that works. Load the
`promota-ui-verify` skill and prove the real path against the deployed
service: the page loads with the runtime config injected, a session can be
established, and one real feature path completes. For the lead-capture
surface the canonical proof is:

```powershell
node scripts/verifyLive.mjs https://web-production-045b1.up.railway.app
```

It loads the deployed site, checks the runtime `/config.js` against the
Supabase project, submits a real visitor sign-up and cleans it up.

**The outbox rule applies to the release itself:** nothing is marked
delivered that was not actually delivered. An outbox row reaches `delivered`
only when its handler ran to completion against the provider — not when the
event was merely queued, not when the redemption was parked as `processing`
or `failed`, and not when a provider said "2xx" without confirming. The same
rule governs this release: the deploy is not done until the live feature
check has actually run and reported its result. A deploy that was started
and not verified is `UNKNOWN`, never "shipped".

## Step 8 — Document it

Hand it to `promota-docs-keeper`:

- `CHANGELOG.md` — one entry for this change, dated, stating what changed and
  which checks passed with their counts.
- `STATUS.md` — the verified-state rows are updated with the date and the
  actual result. Anything you could not prove is `UNVERIFIED` with a named
  venue.
- `README.md` — if the "What is actually wired today" section changed, it
  changed here.
- `audit/SPRINT22-CURRENT-REVIEW.md` — only via the `promota-audit` skill.
- `PROOF/` — append the raw output of the live checks as a new bundle. Never
  edit raw output that was captured earlier.

## Step 9 — Report

Report, in this order:

1. What was released, in one line.
2. The commands you ran and their actual results — counts and exit codes.
3. The live check: what you loaded, what you did, what came back.
4. The release gate's checklist and its posture (GO / NO-GO, per surface).
5. **What was not done**, and why. Limitations are recorded, not hidden. A
   limitation that is stated is a controlled risk; a limitation that is
   hidden is a defect.

## Traps this repo has actually hit

These are not hypotheticals. Each one cost a session.

1. **A tracked file referencing an untracked file breaks the build, not the
   test.** `npm test` runs against the working tree, so a local green says
   nothing about the repository. Before deploying, run
   `git ls-files --others --exclude-standard` and compare it with the paths
   `package.json`, the `Dockerfile` and CI refer to. A GitHub-sourced build
   fails where the local run passed.
2. **The Railway CLI session is global mutable state.** Another agent on the
   same machine can re-link `~/.railway/config.json` mid-session. Run
   `railway whoami` **immediately** before every state-changing command, not
   once at the start. If the account changed, stop and restore it — never act
   on the account that appears.
3. **Apply the migrations before deploying the code that needs them.** The
   readiness probe then reports `"database is at migration 17, repo ships
   13"` for the short window in between. That 503 is the gate working: it
   names the exact mismatch instead of crashing on a missing column.
4. **A push to `main` does not necessarily build.** The Promota service has
   no commit-status reporting on GitHub, so "pushed" is not "deployed".
   Verify with the live URL, not with the push.
5. **`revoke execute on function f() from anon, authenticated` does not
   revoke.** PostgreSQL grants EXECUTE to `PUBLIC` on every new function.
   Always `from public, anon, authenticated` **and**
   `grant execute on function f() to service_role`, in the same migration.
6. **Never edit an applied migration.** `0014`–`0016` were still unapplied
   and could be corrected in place; `0008`, `0012` and `0013` were applied
   and were fixed forward in `0017`. Check `/readyz` (repo vs applied) before
   deciding which side of that line a file is on.

## Rollback

If the live check fails:

1. Do not leave a broken release running. `railway logs --deployment` first,
   to capture the failure as evidence.
2. Roll back the deployment (`railway rollback`, or redeploy the previous
   good image) — a forward fix is a new change, not a rollback.
3. If a migration caused it, roll the migration back **with a new forward
   migration**. Never edit an applied one.
4. Record what happened in `CHANGELOG.md` and the audit file, including the
   failed check's output.

## Related

- `promota-migration` — adding a forward-only migration
- `promota-money-flow` — the points/redemption/payout map
- `promota-ui-verify` — proving the live UI works
- `promota-audit` — the house review format
- `.opencode/ORCHESTRATION.md` — the runbook and the hard stop conditions
