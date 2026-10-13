# Promota — Admin / Operator Guide

Operator runbook for the Promota (OwoWorks) pilot. **Never paste secret values
into this file, into logs, or into chat — names only.**

---

## 1. Identity

| Item | Value |
|---|---|
| Git repo (canonical) | `https://github.com/erpforgeafrica-dotcom/OwoWorks` |
| Branch | `main` |
| Live URL (current deploy) | `https://web-production-045b1.up.railway.app` |
| Supabase project | `ykyvmgdruterzrmltquz` |
| Container | `Dockerfile` (node:22-alpine) + `railway.json` |

> **Deployment identity caveat:** `STATUS.md` and `PROOF/` were written when the
> remote was named `Promota`. The current git remote is `OwoWorks`. Confirm the
> Railway project/SHA you are deploying to before trusting historical proofs.

---

## 2. Environment variables (names only)

Set these as Railway service variables (or in a local `.env`, which is
gitignored):

| Variable | Required for | Notes |
|---|---|---|
| `SUPABASE_URL` | site config + API | injected into `/config.js` (public) |
| `SUPABASE_ANON_KEY` | site config (public) | publishable key only |
| `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | **server API** | trusted path; never expose |
| `SESSION_SECRET` | API sessions | signs 12h tokens; rotation logs users out |
| `SESSION_TTL_HOURS` | optional | default 12 |
| `TERMII_API_KEY` | OTP login, SMS notices | messaging/OTP provider only |
| `TERMII_SENDER_ID` | optional | default `Promota` |
| `FLUTTERWAVE_SECRET_KEY` | cash payouts | transfers only, not charges |
| `FLUTTERWAVE_WEBHOOK_SECRET` | webhook auth | webhooks fail closed if unset |
| `DATA_PROVIDER_API_KEY` / `DATA_PROVIDER_BASE_URL` / `DATA_PROVIDER_NAME` | data bundles | **unset = data redemptions park as failed** |
| `WORKER_ENABLED` | optional | `false` disables the in-process outbox worker |
| `PORT` / `HOST` | optional | default `8080` / `0.0.0.0` |
| `RATE_LIMIT_PER_MIN` | optional | default 60 per IP |

Missing `SUPABASE_URL` / `SUPABASE_ANON_KEY` makes the site report "not
connected" rather than faking a success.

---

## 3. Deploy

The image builds with Docker; no `npm install` runs (server + api + providers use
Node built-ins only).

```powershell
# local smoke of exactly what the container does
docker build -t promota .
docker run --rm -p 8080:8080 --env-file .env promota
```

> **Regression guard:** `npm test` now runs `scripts/checkImage.mjs`, which
> fails if the Dockerfile stops copying `api/` or `providers/`. A missing COPY
> is a *silent* failure — the build still succeeds and only the healthcheck
> fails. Keep that test.

Health: `GET /healthz` → `{ ok, config, auth, providers:{supabase,termii,flutterwave,sessions,data} }`.

---

## 4. Database

- Migrations `0001`–`0009` under `db/migrations/` (plus a local-only auth stub).
- Apply locally: `npm run db:up` (PGlite scratch DB, gitignored).
- Apply remotely: `npm run db:remote` (adds an entry to the migration ledger).
- Never edit an applied migration in place — add a forward migration.

Business rules live in SQL (`redeem_points`, `points_balance`, `level_for`,
`cash_unlocked`, `award_task_points`, `submit_lead`, `claim_outbox_batch`). Keep
new rules there so the PGlite suite can prove them.

---

## 5. Verify

```powershell
npm test                 # client + API + image + DB suites (~250 checks)
npm run site             # static integrity
node api/server.smoke.mjs       # boots the real server, exercises HTTP
node scripts/verifyLive.mjs <url>   # deployed-site check (needs live env)
node db/live.proof.mjs   # live Supabase RLS proof (needs service creds)
```

---

## 6. Known gaps / open blockers (as of this review)

1. **API not yet surfaced in the UI.** OTP login, tasks, redeem, referrals, and
   the outbox worker exist and are tested, but `apps/web/app.js` only calls the
   lead-capture RPCs. Wiring a promoter login/dashboard is the next build.
2. **No data aggregator.** Data redemptions fail loudly and stay reversible.
3. **Cash payouts need Flutterwave merchant KYC + IP allow-list**, and a
   beneficiary-collection step (collected at payout time; not yet built).
4. **Admin dashboard, campaign manager, partner portal:** schema ready, no UI/API.
5. **Legal/regulatory:** trademark + CAC + domain clearance for "Promota" not done;
   NDPA data-protection posture and anti-MLM/SEC position need owner sign-off.
6. **Historical proofs** (`PROOF/*`) predate HEAD `18f0bfb`; re-run for a current
   SHA before quoting them as current.

---

## 7. Operator contact

Replace with the real operator email before public launch:
`operator@example.com`
