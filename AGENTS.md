# AGENTS.md — Promota (repo `owoworks`)

Read this file before touching anything in this repository. It is the contract
for every agent and every human working here. It is deliberately short: the
procedures live in `.opencode/skill/`, the remits live in `.opencode/agent/`,
and this file states only what is true of the whole product.

## What Promota is

Promota is a two-sided promotion marketplace for Nigeria. Businesses fund
campaigns into escrow; promoters do real social work (post, reel, view,
comment) from their own accounts with disclosure; the platform verifies the
work and pays in mobile data first and cash as the promoter levels up.

- Brand law and voice: `docs/BRAND.md`. Tone is plain and honest — no
  marketing fluff, no claim that is not backed by a check.
- Verified state of the world: `STATUS.md`. Proof bundles: `PROOF/`.
- Current audit: `audit/SPRINT22-CURRENT-REVIEW.md`.

## Stack, as it actually is

| Layer | Reality |
|---|---|
| Runtime | Node 22, ESM (`"type": "module"`), **zero runtime dependencies** — Node built-ins only |
| API | `api/` — a hand-rolled router in `server.mjs` + `api/routes.mjs`, no framework |
| Data | PostgreSQL on Supabase, reached over PostgREST by `api/supabase.mjs` with the service-role key |
| Security | Row Level Security in Postgres; the browser holds the publishable key and is stopped by RLS |
| Frontend | `apps/web/` — vanilla JS/HTML/CSS, no build step, no framework, no bundler |
| Deploy | `Dockerfile` (`node:22-alpine`, no `npm install`) + `railway.json`, healthcheck `/healthz` |
| Tests | Plain `node` scripts with a hand-rolled harness. No test framework. |

## The five invariants

These are not style preferences. A change that breaks one of them is a
regression, not a style question.

1. **Never report success that did not happen.** A redemption or payout is
   fulfilled only on provider-side confirmation. A provider saying "2xx" is
   not confirmation. A webhook is not confirmation — the Flutterwave webhook
   re-verifies the transfer by id (`api/routes.mjs`, `flw.verifyTransfer`).
2. **Points are minted only by Postgres functions.** `points_balance`,
   `award_task_points_networked`, `award_views_bonus`, `qualify_referral`,
   `redeem_points`, `reverse_point_entry`. Never compute or add points in
   JavaScript.
3. **Every money/points action is idempotent and auditable.** An idempotency
   key on every money write, a `point_entries` row that is append-only, and an
   `audit_log` entry for admin and money actions. A retry must never double
   pay, and a correction is a reversal entry, never an edit.
4. **RLS is the security boundary.** JS must never bypass it with the
   service-role key for a read the browser could do itself. The service-role
   key is for writes the browser must not perform, not for convenience reads.
5. **Evidence before claims.** Every claim of "done", "fixed" or "working"
   cites a command that was run and its output. If the check could not be
   run, the state is `UNVERIFIED` with a named proof venue — never "passed".

Two operational rules carry the same weight:

- **Nothing is marked delivered that was not actually delivered**
  (`api/worker.mjs`). The outbox row goes to `delivered` only after the
  provider confirmed. `pending` is not failure; `unknown` is not success.
- **Never edit an applied migration.** `db/migrations/NNNN_*.sql` are recorded
  in `public.owoworks_schema_migrations`. Fix forward with a new numbered file.

## The test command

```powershell
npm test
```

That is the gate. It runs, in order: `apps/web/phone.test.mjs`,
`apps/web/lead.test.mjs`, `api/api.test.mjs`, `scripts/checkImage.mjs`,
`db/ledger.test.mjs`, `db/leads.test.mjs`, `db/points.test.mjs`,
`providers/dataManager.test.mjs` — the last three on real PostgreSQL via
PGlite. Exit code 0 means the whole chain passed.

Other commands that matter:

| Command | What it proves |
|---|---|
| `npm run site` | Page integrity: anchors, assets, SEO basics, theme switch, a11y tokens |
| `npm run db:test` | The three PGlite suites only (ledger, leads, points) |
| `npm run db:up` | Applies `db/migrations` to a local PGlite database |
| `npm run db:remote` | Applies migrations to the live Supabase project |
| `npm run db:probe` | Live Supabase reachability |
| `npm run db:live` | `db/live.proof.mjs` — RLS proven over HTTPS with real JWTs |
| `node scripts/checkImage.mjs` | The Docker image ships everything `server.mjs` imports |
| `node scripts/verifyLive.mjs <url>` | The deployed site actually works end to end |
| `node scripts/predeploy-check.js` | Deploy gate: env names, migration parity, CSP snapshot |

`api/server.smoke.mjs` and `providers/providers.smoke.mjs` need live provider
credentials and are deliberately **not** in `npm test` so CI stays offline and
deterministic.

## File layout

```
apps/web/          vanilla JS frontend: landing, lead form, dashboard, admin,
                   approval queue, legal pages (terms/privacy/refund)
api/               routes.mjs (route table), supabase.mjs (PostgREST client),
                   worker.mjs (outbox + auto-approve sweeper), readyz.mjs,
                   session.mjs, admin.mjs, promoter.mjs, business.mjs,
                   social.mjs, mining.mjs, checkin.mjs
providers/         termii.mjs (SMS/OTP), flutterwave.mjs (bank transfers),
                   data.mjs + dataManager.mjs (data-bundle failover matrix),
                   twenty5.mjs, vtung.mjs, payoutCrypto.mjs
db/migrations/     forward-only 0001..0016 — the place business rules live
db/*.test.mjs      PGlite suites (ledger, leads, points, redemption-integrity,
                   views-evidence)
scripts/           migrateUp.mjs, migrateRemote.mjs, migrations.mjs, checkImage.mjs,
                   checkSite.mjs, serve.mjs, verifyLive.mjs, predeploy-check.js
audit/             the house review format: SPRINT22-CURRENT-REVIEW.md is canonical
docs/              BRAND.md, USER-GUIDE.md, ADMIN-GUIDE.md, REWARDS.md, LOTTERY.md
server.mjs         HTTP server: static site, /api, rate limiting, CSP headers
Dockerfile         node:22-alpine, copies apps/web + server.mjs + api + providers
                   + db/migrations, runs as USER node, EXPOSE 8080
railway.json       DOCKERFILE builder, healthcheck /healthz, ON_FAILURE x5
```

## Tables that carry money and points

`point_entries` (append-only ledger of points), `redemptions` (points in,
value out), `payout_accounts` (encrypted beneficiary details),
`campaign_payments` (money in, with provider reference), `ledger_entries` /
`postings` / `accounts` (double-entry ledger), `outbox` (the event queue),
`audit_log` (append-only admin trail), `settings` (typed platform settings),
`flags` (runtime toggles such as `kati_enabled`), `profiles`, `tasks`,
`task_proofs`, `campaigns`, `referrals`, `levels`, `leads`,
`owoworks_schema_migrations`.

## House rules

1. **No invented data.** Never fabricate a row, an id, an amount, a provider
   reference, a view count, a test result or a document. If it was not
   observed, it is `UNKNOWN`.
2. **No silent failures.** A caught error that is swallowed is a bug. Either
   handle it, record it in the `audit_log` / `outbox.last_error` / a
   `failure_reason` column, or let it throw.
3. **Surgical changes.** Touch only what the task needs. No drive-by
   refactors, no reformatting, no dependency additions (the image installs
   nothing). Match the file's existing style and comment density.
4. **Never edit an applied migration.** Add the next `NNNN_*.sql`.
5. **Never commit secrets.** `.env`, `apps/web/config.js` and `*.key` are
   gitignored. The only browser-safe key is the publishable one, injected at
   runtime by `server.mjs`. Never print a key value — cite the path and the
   variable name.
6. **Business rules live in SQL.** If a rule can be enforced by a constraint,
   trigger or function in Postgres, it goes there — not in `api/*.mjs`. That
   is what lets the PGlite suites prove it without a server.
7. **New behaviour ships with a test.** Every change to behaviour lands with
   a case in the repo's own harness, and `npm test` stays green.
8. **Do not overstate.** `README.md` has a "what is actually wired today"
   section for a reason. Keep the docs honest; a stale doc is a defect.
9. **Never run a destructive git command** (`reset --hard`, `clean`, `push
   --force`) without the owner asking in this conversation.

## The agent and skill catalogue

Everything in `.opencode/` is project-scoped and belongs to this repo.

| Agent | Remit | Loaded from |
|---|---|---|
| `promota-orchestrator` | Decomposition, specialist selection, evidence gate | `.opencode/agent/promota-orchestrator.md` |
| `promota-backend-engineer` | `api/`, `providers/`, PostgREST, idempotency, outbox | `.opencode/agent/promota-backend-engineer.md` |
| `promota-frontend-engineer` | `apps/web/`, CSP-safe vanilla JS, accessibility | `.opencode/agent/promota-frontend-engineer.md` |
| `promota-db-engineer` | `db/migrations/`, RLS, grants, forward-only changes | `.opencode/agent/promota-db-engineer.md` |
| `promota-money-path-auditor` | Highest priority: false success and points-mint paths | `.opencode/agent/promota-money-path-auditor.md` |
| `promota-security-reviewer` | RLS holes, grants, filter injection, secret hygiene | `.opencode/agent/promota-security-reviewer.md` |
| `promota-test-engineer` | The repo's own harness; new behaviour ships with a test | `.opencode/agent/promota-test-engineer.md` |
| `promota-devops-engineer` | Docker image, Railway, CI, healthz/readyz, deploy checks | `.opencode/agent/promota-devops-engineer.md` |
| `promota-release-gate` | The "done" authority; two independent passes must agree | `.opencode/agent/promota-release-gate.md` |
| `promota-docs-keeper` | Keeps README/STATUS/docs/audit true to the code | `.opencode/agent/promota-docs-keeper.md` |

| Skill | Use it when | Loaded from |
|---|---|---|
| `promota-release` | Shipping: verify → commit → push → deploy → live check → docs | `.opencode/skill/promota-release/SKILL.md` |
| `promota-migration` | Adding a forward-only DB migration safely | `.opencode/skill/promota-migration/SKILL.md` |
| `promota-money-flow` | Touching points, redemption or payout | `.opencode/skill/promota-money-flow/SKILL.md` |
| `promota-audit` | Running a review in the house format | `.opencode/skill/promota-audit/SKILL.md` |
| `promota-ui-verify` | Verifying the live deployed UI, not just HTTP 200 | `.opencode/skill/promota-ui-verify/SKILL.md` |

| Command | What the owner runs | Loaded from |
|---|---|---|
| `/promota-ship` | The full release pipeline | `.opencode/command/promota-ship.md` |
| `/promota-audit` | Fresh audit; rewrites `audit/SPRINT22-CURRENT-REVIEW.md` | `.opencode/command/promota-audit.md` |
| `/promota-money-check` | Money-path review only | `.opencode/command/promota-money-check.md` |

The runbook that ties them together — the expert-agent loop, the escalation
path, the hard stop conditions and the open-source patterns this is based on
— is `.opencode/ORCHESTRATION.md`. Read it before running the orchestrator on
anything that touches money.
