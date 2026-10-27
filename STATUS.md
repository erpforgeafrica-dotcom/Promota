# STATUS.md — verified state of the Promota repo

**Date:** 2026-10-07. **Rule:** nothing below is claimed without a passing check. Items that
cannot be proven here are marked UNVERIFIED with their proof venue, never passed.

## Where this code comes from

The system code is the audited, repaired output of the `amplo` build (8 commits, gate
41/0/0 GREEN): double-entry ledger with deferred-constraint enforcement, escrow-before-live,
task state machine with 24h auto-approve, payout eligibility, dispute lifecycle, RBAC with
trigger-guarded roles, typed settings, append-only audit, RLS policies. This repo rebrands it
as Promota and optimises the web surface; it does not re-prove the database.

## Verified now (local engine — PGlite/WASM, a real PostgreSQL build)

| Claim | Evidence |
|---|---|
| All seven migrations execute on real PostgreSQL | `node scripts/migrateUp.mjs` — 7 APPLIED (incl. 0007 oracle fix) |
| Core ledger invariants hold | `node db/ledger.test.mjs` — 56 PASS / 0 FAIL / 2 UNVERIFIED |
| Lead capture + `submit_lead` hold | `node db/leads.test.mjs` — 41 PASS / 0 FAIL / 1 UNVERIFIED |
| Abuse controls hold for every DB role | honeypot + consent freshness in trigger AND RLS |
| Referrals pay zero, count queue only | schema + `docs/LEAD-CAPTURE.md` §3 (anti-MLM rule) |
| `anon` cannot touch `leads` or the migration ledger | privilege tests in `db/leads.test.mjs` |
| Phone validation correct | `npm test` — 17 phone + client + 56 + 41 tests |
| Web surface passes integrity | `npm run site` |
| Palette accessible | every pair in `docs/BRAND.md` §2, WCAG 2.2 AA |
| Legal pages exist | `apps/web/terms.html`, `privacy.html`, `refund.html` |

Proof bundles: `PROOF/C1-lead-backend-live/` and `PROOF/C2-live-api-proof/` (manifests +
raw command output + artifact hashes), plus `PROOF/C3-railway-live/` for the deployment.

## Live Supabase project (connected and proven over HTTPS)

- Project `ykyvmgdruterzrmltquz`; credentials authenticate (`node scripts/dbProbe.mjs`).
- **All seven migrations `0001`–`0007` are applied live** (recorded in the ledger).
- `node db/live.proof.mjs` — **PASS 14 / FAIL 0 / UNVERIFIED 0 — LIVE API PROOF: ALL HOLD.**
  Proves over the real network, with the shipped publishable key: a visitor can submit a
  sign-up; a visitor cannot read, update or delete the sign-up list; a visitor cannot read
  the migration ledger; duplicates are refused (identical success shape); a signed-in account is also blocked from
  the sign-up list but can read shared campaign data; the row and its outbox event really
  exist. Every test row and account is deleted afterwards (204/204/200).
- Oracle fix `0007` verified: duplicate phone returns identical `{ok, referral_code, position, referred}` — no membership leak.

## Live deployment (Railway)

- Account `Engr.emmamickado@gmail.com`, workspace `m1ckad0's Projects` (confirmed by a live
  `railway whoami` on 2026-10-03). The earlier `sabistack.acad@gmail.com` workspace is on a
  trial that has hit its provision cap (2/2 projects, 5 services), so it could not host this app.
- Project `owoworks` (`60ac6fc7-c53d-4150-b419-5ca790e35a96`), service `web`, environment
  `production`; domain **https://web-production-045b1.up.railway.app**.
- Built from `Dockerfile` (node:22-alpine, **no npm install** — the server uses Node built-ins
  only) configured by `railway.json`. The server injects `window.PROMOTA` at runtime from the
  `SUPABASE_URL` / `SUPABASE_ANON_KEY` service variables, so no key is baked into the image or
  committed. Missing variables make the site report "not connected" instead of faking success.
- Strict CSP (`script-src 'self'`, `connect-src 'self' https://*.supabase.co`,
  `frame-ancestors 'none'`), `nosniff`, frame-deny, `referrer-policy: no-referrer`.
- Rate limiting on `/config.js` and `/healthz` endpoints (30 req/min/IP).
- `node scripts/verifyLive.mjs https://web-production-045b1.up.railway.app` —
  **PASS 19 / FAIL 0 — DEPLOY VERIFY: ALL HOLD** (static assets, runtime config matches the
  Supabase project, and a real visitor sign-up lands in the DB then is cleaned up).
  Evidence: `PROOF/C3-railway-live/`.

## Closed live findings

- The migration ledger `public.owoworks_schema_migrations` had inherited public grants
  (`anon[siud]`). `0006` revoked them and enabled RLS; live re-probe now shows
  `anon[----] auth[----]`. **Closed.**
- The web client used `Prefer: return=representation` on a direct `leads` insert, which
  needs SELECT that `anon` does not have. It now calls the single public action
  `submit_lead` (`apps/web/app.js`), proven live. **Closed.**
- `apps/web/config.js` now exists (gitignored, publishable key only, generated from `.env`),
  so the site is live-capable. **Closed.**
- Membership oracle in `submit_lead` fixed by `0007` — duplicate phone indistinguishable from new. **Closed.**
- RLS policies verified over HTTP on staging (14/0/0). **Closed.**
- Legal pages (Terms, Privacy, Refund) published. **Closed.**
- GitHub Actions CI/CD workflow created. **Closed.**
- Edge rate limiting added to server.mjs. **Closed.**

## Carry-over truth (from amplo, unchanged)

- **RLS policies verified over HTTP** by `db/live.proof.mjs` (see `PROOF/C2-live-api-proof/`).
- **Pre-launch `noindex`** per SEO-D1 (removal trigger documented in amplo `docs/SEO.md`).
- **PRD has 0 acceptance criteria; admin/roles/settings UI 0%; compliance map unsourced.**

## Blockers (owner actions)

1. Trademark + CAC + domain clearance for "Promota" (web prior-art done; legal clearance NOT done).
2. ~~`gh auth login` → create `erpforgeafrica-dotcom/owoworks` remote → push.~~ **DONE** — remote
   `erpforgeafrica-dotcom/Promota`, `main` pushed and verified on GitHub (HEAD `f9ecdd2`).
3. ~~Railway target account + deploy.~~ **DONE** — deployed to `Engr.emmamickado@gmail.com` /
   `m1ckad0's Projects` after the `sabistack.acad` trial hit its provision cap. Live URL verified
   (`PROOF/C3-railway-live/`).
4. Registered entity name/jurisdiction + PII-storage decision.
5. Termii API key for the SMS double opt-in worker.

## Identity export verification

| File | Expected | Measured |
|---|---|---|
| `apps/web/assets/identity/og-image.png` | 1200×630 | read back via sharp metadata |
| `apps/web/assets/identity/favicon-180.png` | 180×180 | read back via sharp metadata |
| `apps/web/assets/identity/banner-dark.png` / `banner-light.png` | 1600×480 | read back via sharp metadata |

## Platform-policy gate (2026-10-26)

Promota no longer sells paid likes, comments, follows, subscribes, views, paid
shares of a specific post or channel joins. The product sells disclosed content,
brand-content posts and verified-purchase reviews only. Enforcement is in Postgres (`0018_task_policy_gate.sql`),
the API (`api/business.mjs`, `api/routes.mjs`) and both consoles.

| Claim | Evidence |
|---|---|
| Policy gate holds locally | `node db/policy.test.mjs` � 35 PASS / 0 FAIL |
| Existing suites still hold | `npm test` chain � ledger 56/0, leads 41/0, points 59/0, redemption 13/0, views 17/0, api 90/0, providers 34/0 + 21/0, phone 17/0, lead 24/0, image 7/0 |
| Site integrity | `node scripts/checkSite.mjs` � 187 PASS / 0 FAIL (the 3 `?next=` false positives are fixed) |
| Live Supabase | **NOT APPLIED** � repo ships 18 migrations, live ledger max is 17. `predeploy-check` is NO-GO until `npm run db:remote` runs with owner approval. |
| Hostinger | **NOT REDEPLOYED** � pending the migration above. |

**Verdict:** the policy risk is closed in code. The live database and the Hostinger
deployment are the two owner-gated steps left. Report:
`audit/PROMOTA-PLATFORM-POLICY-REVIEW.md`; operating model:
`docs/CREATOR-DELIVERY-PROTOCOL.md`.
