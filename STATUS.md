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
6. Reset the live Postgres password (Supabase dashboard → Project Settings →
   Database → Reset database password). The password in
   `C:\Users\pc\sabisupabase.txt.txt` returns `28P01` on both pooler ports, so
   `npm run db:remote` cannot apply `0018`–`0020` and the promotion routes stay
   at HTTP 500 until it does.

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
| Live Supabase | **NOT APPLIED** — repo ships 20 migrations (`0001`–`0020`), live ledger max was 17 at the last probe. `predeploy-check` is NO-GO until `npm run db:remote` runs with owner approval. |
| Hostinger | **REDEPLOYED 2026-11-04** — builds on `b8e41a5` completed; `/`, `/healthz` and `/admin.html` return 200 and an owner session verifies against `/api/me` and `/api/admin/stats`. |

**Verdict:** the policy risk is closed in code. The live database and the Hostinger
deployment are the two owner-gated steps left. Report:
`audit/PROMOTA-PLATFORM-POLICY-REVIEW.md`; operating model:
`docs/CREATOR-DELIVERY-PROTOCOL.md`.

## Mutual promotion engine — "Promote You" (2026-11-03)

Members can now promote each other: a member publishes a promo card, two members
agree a pair, each delivers one disclosed post on the other's behalf, a reviewer
approves each side, and both are paid in points. Business rules, caps, the
deadline and point minting live in Postgres; the API never computes a point
value.

| Claim | Evidence |
|---|---|
| Migrations apply on real PostgreSQL | `node scripts/migrateUp.mjs` — 21 migration(s) applied, including `0019_promotion_point_kinds.sql` and `0020_mutual_promotion.sql` |
| Rule matrix holds | `node db/mutual-promotion.test.mjs` — 56 PASS / 0 FAIL / 2 UNVERIFIED |
| Routes are registered and session-gated | `node api/api.test.mjs` — 110 PASS / 0 FAIL, including every promotion route |
| Full gate | `npm test` — EXIT 0 (ledger 56/0, leads 41/0, points 59/0, policy 39/0, redemption 13/0, views 17/0, mutual promotion 56/0, api 110/0, image 7/0, providers 34/0 + 21/0) |
| Site integrity | `npm run site` — 187 PASS / 0 FAIL |
| Product and rules | `docs/PROMOTION-MUTUAL.md` |
| Live Supabase | **NOT APPLIED** — `0019`/`0020` are not on the live database; `npm run db:remote` needs the live Postgres password (owner action) |
| Deployment | **DEPLOYED, but the promotion routes 500 until the DB catches up** — `/api/v1/promotion/cards` and `/api/v1/promotion/pairs` return HTTP 500 `internal error` on the live 17-migration database |

The two UNVERIFIED cases are RLS proofs that need real JWTs (anonymous read of
another member's pair, and browser write denial); their venue is
`npm run db:live` against the staged project.

**Verdict:** the feature is complete in `main` and proven locally. Live remains
owner-blocked on the database password.

## UI wiring gates (2026-11-09)

The promotion and KYC APIs were complete but no page called them, and
`landing.js` returned early on pages without the auth modal, which silently
killed the mobile menu, the mobile theme toggle and the FAQ accordion on
`about.html` and `contact.html`. Both classes are now caught by the test gate.

| Claim | Evidence |
|---|---|
| Every UI call has a server route | `npm run audit:ui` — 5 PASS / 0 FAIL (64 distinct calls, 13 scripts) |
| Every launch-critical route has a page caller | `npm run audit:ui` — 14 routes checked (KYC basic/identity, promotion cards/pairs/deliveries, admin review + expiry) |
| Every page-script element lookup has a target | `npm run audit:dom` — 2 PASS / 0 FAIL (11 pages, 10 scripts, 252 refs) |
| A missing id fails the gate | negative run with a probe id in `kyc.js` — 1 FAIL, exit 1, then restored |
| Landing nav works without the auth modal | browser run on `about.html`/`contact.html`: `#menu-btn` toggles `#mobile-menu` (`open:true`, `aria-expanded:true`), `#themeBtnMenu` flips `data-theme` both ways, zero page errors |
| Sign-in modal still opens | browser run on `index.html`: click `[data-auth="login"]` → `#modal.hidden === false`; Escape closes |
| Full gate | `npm test` EXIT 0; `npm run site` 187 PASS / 0 FAIL |

## Owner/admin bootstrap and live verification (2026-11-04)

The live project had zero auth users and zero profiles, so no admin could exist.
One owner identity was bootstrapped through the Supabase admin API: auth user
`owner@promota.click`, profile `6e7ffa7c-33cb-4f73-b9ff-03229b070449`, role
`owner`, state `active`. The profile row was inserted with role `owner`
directly — the guard trigger only blocks role UPDATEs, so every later role
change still has to go through `assign_role()`.

| Claim | Evidence |
|---|---|
| Owner token accepted by the deployed API | `/api/me` → 200 `role=owner`; `/api/admin/stats` → 200 (live, 2026-11-04T04:00Z) |
| Browser login link works | headless Chromium `--dump-dom` on `/admin.html#token=…`: `#app` visible, `#gate` hidden, `#whoami` = owner, token absent from the rendered DOM |
| Fragment handoff is tested | `node apps/web/auth.test.mjs` — 12 PASS / 0 FAIL (owner/admin/support adopted; promoter refused; expired and malformed refused) |
| Credential storage | `C:\Users\pc\.config\opencode\vault\PROMOTA-ADMIN-LOGIN.md` (outside the repo, never printed) |
| Leaked token is dead | a token minted before the `SESSION_SECRET` rotation now returns 401 on `/api/me` |

The account is permanent; the link is a 12-hour session. Passwordless OTP login
lands on this profile only once `profiles.phone_e164` holds an owner-controlled
number.

| 2026-11-06 — oral-log permanence |
|---|

- `profiles.phone_e164` now holds an owner-controlled number (masked
  `+234…1733`): applied by service-key PATCH with an in-line readback
  verification, 2026-11-06, owner-approved in chat. Role was not touched; the
  role guard trigger only fires on role updates.
- Termii OTP sign-in from that number now issues a session for the OWNER
  profile instead of creating a new promoter (route resolves the profile by
  `phone_e164=eq.`).
- A fresh owner session was minted from the current `SESSION_SECRET` and
  verified live: `GET /api/me` → 200 `role=owner`. The re-minted one-tap link
  (12 h) is stored only in `C:\Users\pc\.config\opencode\vault\PROMOTA-ADMIN-LOGIN.md`
  and supersedes the expired 2026-11-04 link. Numbers and passwords are
  masked here; the vault file is the credential venue.
- **Owner confirmed the enhancement-plan decisions in chat (2026-11-06)**:
  A-1..A-7 in `docs/ENHANCEMENT-PLAN-20261103.md` §3, with the scope note that
  challenge/competition prize pools are FIXED per event and 60/40 applies to
  promoting content generated from a competition. No decision now blocks
  Phase 1; only the deployment unblock (#DB password or SQL bundle) remains.
