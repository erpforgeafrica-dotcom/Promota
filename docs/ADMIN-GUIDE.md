# Promota — Admin / Operator Guide

Operator runbook for the Promota (OwoWorks) pilot. **Never paste secret values
into this file, into logs, or into chat — names only.**

---

## 1. Identity

| Item | Value |
|---|---|
| Git repo (canonical) | `https://github.com/erpforgeafrica-dotcom/OwoWorks` |
| Branch | `main` |
| Live URL (current deploy) | `https://gracious-peace-production-d056.up.railway.app` (service `gracious-peace`, project `attractive-rejoicing`) |
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
| `DATA_PROVIDER_API_KEY` / `DATA_PROVIDER_BASE_URL` / `DATA_PROVIDER_NAME` | data bundles (legacy adapter) | last resort in the failover order; **unset = that adapter is skipped** |
| `TWENTY5_PUBLIC_KEY` / `TWENTY5_API_KEY` | data bundles | first provider tried (`providers/twenty5.mjs`) |
| `VTU_USERNAME` / `VTU_PASSWORD` / `VTU_USER_PIN` | data bundles | second provider tried (`providers/vtung.mjs`) |
| `DATA_PROVIDER_ORDER` | optional | default `twenty5,vtung`; the failover order in `providers/dataManager.mjs` |
| `PAYOUT_ENCRYPTION_KEY` | payout accounts | 64 hex chars or base64 of 32 bytes; without it the key is derived from `SESSION_SECRET` and the API refuses to store an account when neither is usable |
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

- Migrations `0001`–`0016` under `db/migrations/` (plus a local-only auth stub):
  `0001_core`, `0002_leads`, `0003_access_control`, `0004_submit_lead`,
  `0005_fix_phone_normaliser`, `0006_secure_migration_ledger`,
  `0007_fix_submit_lead_oracle`, `0008_points_levels`,
  `0009_competitions_ambassadors`, `0010_flags`, `0011_audit_view`,
  `0012_close_the_loop`, `0013_login_rewards`, `0014_redemption_integrity`,
  `0015_views_evidence`, `0016_money_flows`.
- Apply locally: `npm run db:up` (PGlite scratch DB, gitignored).
- Apply remotely: `npm run db:remote` (adds an entry to the migration ledger).
- Never edit an applied migration in place — add a forward migration.

Business rules live in SQL (`redeem_points`, `points_balance`, `level_for`,
`cash_unlocked`, `award_task_points`, `submit_lead`, `claim_outbox_batch`). Keep
new rules there so the PGlite suite can prove them.

---

## 5. Verify

```powershell
npm test                 # client + API + image + DB + data-failover suites
                          # (307 checks, 5 of them marked UNVERIFIED)
npm run site             # static integrity
node api/server.smoke.mjs       # boots the real server, exercises HTTP
node scripts/verifyLive.mjs <url>   # deployed-site check (needs live env)
node db/live.proof.mjs   # live Supabase RLS proof (needs service creds)
```

---

## 6. Known gaps / open blockers (as of this review)

1. **The API is surfaced in the UI now.** OTP login and signup live on the
   landing page (`apps/web/index.html`); the promoter console is
   `apps/web/dashboard.html`; the campaign manager is `apps/web/business.html`;
   the admin console is `apps/web/admin.html`; the reviewer workspace is
   `apps/web/approval-queue.html`. Which paths have been proven against the
   live providers is recorded in `STATUS.md` and `PROOF/` — read those before
   quoting a number.
2. **A data aggregator exists; the credentials decide.** `providers/dataManager.mjs`
   tries twenty5, then vtung, then the legacy `DATA_PROVIDER_*` adapter. With
   no provider configured a redemption fails loudly and stays reversible.
3. **Cash payouts need Flutterwave merchant KYC + IP allow-list.** The
   beneficiary step is built: the dashboard's payout-account tab writes the
   encrypted account to `payout_accounts` (`providers/payoutCrypto.mjs`). What
   is missing is the merchant approval, the IP allow-list and a live transfer.
4. **Partner portal:** not built. The admin console and the campaign manager
   do exist.
5. **Legal/regulatory:** trademark + CAC + domain clearance for "Promota" not done;
   NDPA data-protection posture and anti-MLM/SEC position need owner sign-off.
6. **Historical proofs** (`PROOF/*`) predate HEAD `18f0bfb`; re-run for a current
   SHA before quoting them as current.

---

## 7. Operator contact

Replace with the real operator email before public launch:
`operator@example.com`
