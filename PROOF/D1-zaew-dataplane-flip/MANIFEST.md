# PROOF / D1 — production data-plane flip: ykyv → zaew (promota.click)

**Task:** close the DB migration blocker (repo ships 20 migrations, live ledger was 17,
7 API routes returned HTTP 500) by flipping promota.click's production data plane to the
fully-migrated Supabase project.
**Date:** 2026-11-09 (Lagos evening; UTC 2026-11-09/10)
**Owner decision:** "Flip to zaew now (Recommended)" — answered in-session via the question tool.
**Result:** `/readyz` → **HTTP 200 `{ready:true, migrations:{repo:20, applied:20}}`**; route audit
**52 PASS / 1 FAIL** (the one FAIL is the known Termii OTP blocker, GAP-2, owner-side);
`node scripts/verifyLive.mjs https://promota.click` → **PASS 19 / FAIL 0 — DEPLOY VERIFY: ALL HOLD**.

## Target

| Field | Value |
|---|---|
| Production site | https://promota.click (Hostinger managed Node, auto-builds `main`) |
| Previous data plane | Supabase `ykyvmgdruterzrmltquz` — 17/20 migrations, 7 routes 500 |
| New data plane | Supabase `zaewhjzdoyaxsfjjxwqd` — migrations 0001–0020 applied, ledger 20/20, 36 public tables, 27 RLS-enabled |
| Env push | `node scripts/deploy-hostinger.mjs env` → `env applied:` with the CORE key list (names only), then `restart` |
| Rollback path | `.env.bak-ykyv-*` (local backup of the previous data plane; never committed) |

## What was proven (all over the public network)

- **Before:** `/readyz` → HTTP 503 (migration gap 17 vs 20); `/healthz` → 200 `ok:true`.
- After `env` + `restart`: `/readyz` → **HTTP 200**, `ready:true`, `supabase ok`, `flags ok`,
  `migrations {repo:20, applied:20}` — the repo's own readiness probe, not an agent claim.
- `/healthz` → 200 `ok:true` (providers unchanged: termii SMS, flutterwave, twenty5 data).
- `node scripts/audit-live.mjs https://promota.click` → **52 PASS / 1 FAIL**. Every route that
  previously returned HTTP 500 (`/api/tasks/mine`, `/api/policy`, `/api/v1/promotion/cards`,
  `/api/v1/promotion/cards/mine`, `/api/v1/promotion/pairs`, `/api/v1/admin/promotion/cards`,
  `/api/v1/admin/promotion/deliveries`) now returns the correct `401 sign in required`.
  The single FAIL is `POST /api/auth/otp/request` → 502 `termii: Country Inactive` — the
  pre-existing owner-side SMS blocker (GAP-2), unchanged by this flip.
- `node scripts/verifyLive.mjs https://promota.click` → **19 PASS / 0 FAIL**, including
  "deployed config matches this project" (runtime `/config.js` now carries the zaew URL and
  publishable key only), a real visitor sign-up landing in the database, the visitor blocked
  from reading the sign-up list, and the test row cleaned up.
- JWT session verification is unaffected by the flip: `api/session.mjs` verifies its own
  HMAC-SHA256 tokens keyed by `SESSION_SECRET` (unchanged), not Supabase JWKS.

## How the flip was done (no code changed — env only)

1. Schema first (owner-approved earlier the same evening): migrations 0001–0020 applied to
   `zaewhjzdoyaxsfjjxwqd` through the Supabase Management API using the owner-supplied PAT;
   migration ledger corrected to 20 true rows with repo-canonical checksums (evidence in the
   session compact §12; the predeploy gate then passed for the first time: `GO 4/4`).
2. Local `.env` patched to the zaew data plane (6 `SUPABASE_*` key names; backup `.env.bak-ykyv-*`).
3. `node scripts/predeploy-check.js` → **GO 4/4**; `npm test` → **EXIT 0, 19 suites, 0 FAIL**;
   `npm run site` → **187 PASS / 0 FAIL**.
4. `node scripts/deploy-hostinger.mjs env` → `env applied:` (CORE list, values never printed).
5. `node scripts/deploy-hostinger.mjs restart` → "restart requested".
6. `/readyz` polled → HTTP 200 with `migrations:{repo:20,applied:20}`.
7. Route audit + `verifyLive.mjs` as above.

## Files

| File | Meaning |
|---|---|
| `01-readyz-before.txt` | Pre-flip `/readyz` 503 + `/healthz` 200 (ykyv still serving) |
| `02-readyz-after.txt` | Post-flip `/readyz` HTTP 200, migrations 20/20 |
| `03-healthz-after.txt` | Post-flip `/healthz` HTTP 200 |
| `04-env-push.txt` | `deploy-hostinger.mjs env` + `restart` output (key names only) |
| `05-route-audit.txt` | Raw `node scripts/audit-live.mjs https://promota.click` (52/1) |
| `06-deploy-verify.txt` | Raw `node scripts/verifyLive.mjs https://promota.click` (19/0) |

## Reproduce

```powershell
Invoke-WebRequest -Uri "https://promota.click/readyz" -UseBasicParsing
Invoke-WebRequest -Uri "https://promota.click/healthz" -UseBasicParsing
node scripts/audit-live.mjs https://promota.click
node scripts/verifyLive.mjs https://promota.click
```

## Known remaining blocker (stated, not hidden)

`POST /api/auth/otp/request` → 502 `could not send the code: termii sms/otp/send:
Country Inactive` — the Termii account has the Nigeria country inactive and no approved
sender id. Owner action: activate Termii Nigeria + sender, or supply `BULKSMS_API_TOKEN`
(the BulkSMS switch is already shipped and the deploy env list already carries its keys).
Until then, phone sign-in — the only login path — cannot issue codes in production.
