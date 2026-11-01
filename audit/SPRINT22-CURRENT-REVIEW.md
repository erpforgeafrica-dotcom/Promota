# Promota — Current Review (HEAD 13036da)

**Date:** 2026-10-31 · **Repo:** `C:\Users\pc\owoworks` · **Branch:** `main`
**HEAD:** `13036da75e159d26930a3fdd4aabdde03f146908` (== `origin/main`, live `git ls-remote`)
**Remote:** `erpforgeafrica-dotcom/Promota`

This supersedes the prior audit written at `2b03c9e`-era trees. Method: read-only source
inspection of every hot path (routes, worker, business, payouts, providers, migrations,
consoles), fresh runs of the full gate chain in this session (`npm test`, `npm run site`,
`predeploy-check`, `db/live.proof.mjs`, `verifyLive.mjs`), live GET-only probes of
promota.click and the Railway fallback URL, a purpose-built self-cleaning oracle
cross-check against live Supabase (7/0), and cross-comparison of the API route table
(47 exact + 13 dynamic) against every console fetch path. Labels: OBSERVED / TESTED /
INFERRED / UNKNOWN.

## What changed since the prior audit (closed items)

| Prior finding | Status now |
|---|---|
| Platform policy: product must not sell paid likes/comments/follows/subscribes/views/shares/joins | `CLOSED` in code — API 422 refusal (`business.mjs:279-287`), actionType allowlist (`business.mjs:288-289`), disclosure tag required (`business.mjs:291-292`), review needs verifiedPurchase (`business.mjs:294-295`); consoles offer ONLY post/repost/share/review (`business.js:53-58`); Postgres gate `0018` TESTED green locally (`npm test` policy suite 39/0). DB-level enforcement is NOT yet applied to the LIVE database (see TC-F1). |
| Local PGlite suites drift/gaps | `CLOSED` — full chain 418 PASS / 0 FAIL this session (12 suites incl. policy 39/0, redemption-integrity 13/0, views-evidence 17/0, dataManager 34/0, payoutCrypto 21/0). |
| Money-path false-success class (F-01 outbox lineage) | `CLOSED` — outbox worker converges pending→verify→delivered only on provider-side confirmation; webhook paths re-verify by transfer id (`routes.mjs:503,532`); provider failover never reports success on UNKNOWN (`dataManager.test.mjs` 34/0). |
| Landing/lead path | `CLOSED` — `verifyLive.mjs https://promota.click` 19/0 ALL HOLD today, real sign-up round-trip + cleanup. |

## Findings (this review)

| ID | Sev | Finding | Evidence | Label |
|---|---|---|---|---|
| TC-F1 | CRITICAL | **Live Supabase migration parity is broken: the live production database does not have `0018_task_policy_gate`, so the DB-level policy defense is absent in production** while API/UI layers enforce it. `predeploy-check` is NO-GO and future deploys (which expect parity) can misbehave. | `node scripts/predeploy-check.js` → FAIL migration parity "repo ships 18 migration(s) but the database max is 17" (run 2026-10-31); README claims "refused in Postgres, in the API and in both consoles" (`README.md:55-60`) | TESTED |
| TC-F2 | HIGH | **No refund/cancel product path exists for a funded campaign.** `refunded` exists as a legal state (`0008_points_levels.sql:40`, `0016_money_flows.sql:56`) and `business.js:90` can *display* it, but no SQL function sets it, no API route/handler offers it, and neither `admin.html` nor `business.html` has a refund/cancel affordance. A campaigner who funds the wrong amount has money stuck in escrow with only out-of-product (manual SQL) correction. | repo-wide grep `refund` → only state domains + display; zero handlers/routes | TESTED |
| TC-F3 | HIGH | **`db/live.proof.mjs` section 2 is stale:** it still expects the pre-0007 behavior (`ok:false` + "already on the list") for duplicate sign-ups, while the shipped 0007 contract is an identical SUCCESS shape. The live DB behaves CORRECTLY per 0007 — cross-check proves byte-identical duplicate shape, same code/position/referred, exactly one row, cleaned 204 — but the repo's own live proof gate false-fails on correct behavior and could mask a REAL breach in noise. | `live.proof.mjs:103-106` (blame: unchanged since 66cb2f1 2026-10-02) vs duplicate cross-check 7 PASS / 0 FAIL on live Supabase today; local leads suite "SAME success shape for a known number" PASS | TESTED |
| TC-F4 | MEDIUM | README overstates the live posture: "refused in Postgres, in the API and in both consoles" is true for the REPO DB, not for the LIVE DB until TC-F1 closes. Exact claim: `README.md:55-60`. | TC-F1 evidence | TESTED |
| TC-F5 | MEDIUM | `AGENTS.md` states "forward-only 0001..0016" — the repo ships 18 migration files (we count `db/migrations/*.sql` = 18, max `0018_task_policy_gate.sql`). Contract doc is stale. | `AGENTS.md` layout section vs directory census | TESTED |
| TC-F6 | MEDIUM | `DEPLOYED_STATE.md` presents Railway `https://web-production-045b1.up.railway.app` as live fallback ("parallel/fallback production target") — today it answers EDGE 404 `{"status":"error","code":404,"message":"Application not found","request_id":...}` on `/healthz` and `/`. No app is routed there; the fallback is dead. | curl probes 2026-10-31 | TESTED |
| TC-F7 | LOW | `DEPLOYED_STATE.md` feature matrix still lists Admin/Promoter/Business dashboards as "0% BUILT / ❌" — all three consoles are built, wired and route-covered today. Matrix is stale (legacy truth from 2026-10-07 era). | route coverage in `npm test` API suite (90/0) + consoles present in `apps/web` | TESTED |
| TC-F8 | LOW | Provider plan refresh is never-throwing by design; a failed background refresh silently keeps serving the cached catalogue (stale-tolerant, never wiped). Acceptable — noted for observability. | `dataManager.mjs:181-203` | OBSERVED |
| TC-F9 | LOW | `server.mjs` rate limiting applies to `/config.js` and `/healthz` (30 req/min/IP per prior status); no per-endpoint budget on OTP request — Termii cost exposure on OTP spam is bounded only by Termii account limits. | `server.mjs` (rate-limit block) vs `routes.mjs` requestOtp (no extra limiter) | INFERRED |
| TC-F10 | MEDIUM | **The deploy gate can fail open:** when the live DB is temporarily unreachable, `predeploy-check.js` catches the fetch error, skips parity with a WARN, and still prints the top-level banner `PREDEPLOY CHECK: GO` — a transient network error converts a hard gate (TC-F1) into a PASS banner, so a deploy could run with unknown migration parity. Observed live during this audit's continuous run (attempt 1 of 3). | `scripts/predeploy-check.js:92-95` (catch → warn → continue; the fail counter stays 0) vs lines 112-113 (fail path); observed output "migration parity skipped → PREDEPLOY CHECK: GO" 2026-10-31 | TESTED |

## Fixes applied this session

None to code — this was a zero-mutation audit (corridor rule §5: fixes require owner
approval). The ONLY tree change this session was audit files themselves (this file).
Two temporary self-cleaning probes were run against live systems and left no residue.

## Fresh evidence

| Command | Result |
|---|---|
| `npm test` | EXIT 0 — phone 17/0, lead 24/0, API 90/0, image 7/0, ledger 56/0 (2 UNVERIFIED: live-JWT venue), leads 41/0 (1 UNVERIFIED), points 59/0 (2 UNVERIFIED), policy 39/0, redemption-integrity 13/0, views-evidence 17/0, dataManager 34/0, payoutCrypto 21/0 → **418 PASS / 0 FAIL / 5 UNVERIFIED** |
| `node db/live.proof.mjs` | 13 PASS / 1 FAIL — the FAIL is TC-F3 (stale expectation; live behavior proven correct by cross-check below). RLS boundary, migration-ledger secrecy, session flows, event queueing all PASS. Cleanup 204/204/200. |
| oracle cross-check (temp script, deleted) | **7 PASS / 0 FAIL** — duplicate submit_lead returns the SAME referral_code, SAME position, byte-identical canonified shape, exactly ONE lead row on live Supabase → designed 0007 contract holds live |
| `node scripts/predeploy-check.js` (first pass ~21:1x) | EXIT 1 — env 5/5 PASS, CSP snapshot PASS, **migration parity FAIL (repo 18 vs live 17) → NO-GO** |
| `node scripts/predeploy-check.js` (continuous run, 3 attempts) | attempt 1: transient `fetch failed` → parity SKIPPED → banner printed **GO** (silent-failure pattern, logged as TC-F10); attempts 2+3 reached the DB cleanly: parity **FAIL repo 18 vs live 17 → NO-GO twice consecutively** — TC-F1 re-verified live |
| `node db/live.proof.mjs` (full second run) | **13 PASS / 1 FAIL** — the 1 FAIL is the known-stale TC-F3 duplicate expectation (live returns the designed 0007 identical-success shape); RLS boundary, session flows, outbox queueing, admin visibility, PII hygiene all PASS live; cleanup 204/204/200 (no residue) |
| `Select-String refund api/*.mjs` | **0 matches** — TC-F2 fresh seal: no refund handler exists in the API layer |
| source reads (Team-A absorb) | `api/checkin.mjs` — SQL-side idempotent daily award, active-profile gate, errors surfaced; `api/mining.mjs` — read-only process analytics (does NOT mint points), admin/support/finance see platform scope, promoter own scope; `api/social.mjs` — `connect` saves handles honestly unverified except Telegram t.me probe, env names only (no secret leak), and nothing in SQL/API pays on social_links (0012 defines table + own-select policy only) → social connect is not a points/abuse vector |
| `node scripts/verifyLive.mjs https://promota.click` | **19 PASS / 0 FAIL — DEPLOY VERIFY: ALL HOLD** (real sign-up + cleanup) |
| `npm run site` | EXIT 0 — 187 PASS / 0 FAIL (11 pages: about, admin, approval-queue, blog, business, contact, dashboard, index, privacy, refund, terms) |
| curl probes | `promota.click/healthz` 200 `{ok:true, config:true, auth:true, providers:{supabase,termii,flutterwave,sessions all true, data ready twenty5+vtung}}`; root 200 with strict CSP (`script-src 'self'`, `connect-src 'self' https://*.supabase.co`, `frame-ancestors 'none'`), `x-frame-options: DENY`, `referrer-policy: no-referrer`; Railway fallback 404 EDGE ("Application not found") |
| route-table cross-comparison | every console fetch path (auth, dashboard claim/submit/policy/redeem/checkin/earnings/referrals/plans/me, business owner/campaigns/payment-link/payments, kyc payout-account, admin stats/users/tasks/campaigns/settings/owners/kyc/plugins/audit/mining) resolves to the exact or dynamic route table — no mismatch found |

## Release posture

- **Lead capture + landing (promota.click):** GO today — deploy-verified 19/0, oracle
  cross-check 7/0, headers/CSP strict, config matches the live project.
- **Promoter dashboard:** GO once TC-F1 is closed (all claim/redeem/points machinery is
  applied live through 0017; the missing piece is only the 0018 DB gate for task-policy
  defense in depth).
- **Business/campaigner dashboard:** GO for create→fund→launch→track; CAUTION because
  TC-F2 (no refund/cancel affordance) means a misfunded campaign cannot be fixed in
  product. Owner may accept with a manual-SQL runbook.
- **Admin console:** GO — every route wired, coverage tested in the API suite.
- **Money paths (escrow/refund/payout):** GO on the applied 0016/0017 surface;
  refund remains a product gap (TC-F2).
- **Points/redemption:** GO — idempotency, append-only ledger, reversal path all TESTED.
- **Gamification vs platform policies:** GO in code (API 422 + allowlist + consoles),
  **NO-GO at the DB layer until 0018 is applied live (TC-F1)** — the "refused in
  Postgres" marketing claim is not yet true in production.
- **OVERALL GO-LIVE (tomorrow):** PERSISTENT NO-GO until TC-F1 (+ owner-accepted TC-F2).
  Owner-gated steps, by name: (1) run `npm run db:remote` to apply 0018 to the live
  Supabase project; (2) redeploy promota.click and re-run
  `node scripts/predeploy-check.js` + `node scripts/verifyLive.mjs https://promota.click`;
  (3) decide refund posture (ship without affordance + manual runbook, or build refund);
  (4) one small code fix is queued for owner approval: TC-F10 — make
  `scripts/predeploy-check.js` FAIL CLOSED when the DB is unreachable (parity skip must
  abort the gate, never print GO), so a transient network error cannot pass the deploy
  gate.

## Not done (limitations recorded, not hidden)

- Both purpose-built review subagents (promota-team-a, promota-team-c) could NOT run in
  either pass tonight: the same provider quota walls persisted (Gemini free-tier daily
  generate-content cap ~22h cooldown; Cloudflare Workers daily 10,000-neuron allocation
  exhausted). Both missions were absorbed into this main-session review again — findings
  and evidence rules unchanged; recorded here and in the evolution log.
- `db/live.proof.mjs` was not edited (TC-F3): the fix is a test-file change; it awaits
  owner approval together with TC-F1's `db:remote` step because both touch the live
  verification pipeline.
- No load/soak testing was performed (no staging traffic rig exists in-repo).
- Termii SMS OTP worker delivery: probes prove Termii credentials are configured
  (`healthz termii:true`); an outbound OTP send was NOT exercised (sends SMS to a real
  handset — needs owner consent and a test handset).
- Flutterwave payment link: credentials configured (`healthz flutterwave:true`); no real
  NGN transfer/charge was executed (would move real money — owner-gated).
- KYC verification flow: tier gates proven in SQL/PGlite; end-to-end with real NIN/BVN
  documents not exercised (requires real identity documents).
- OAuth/YouTube follower verification: not built (README lists it as future scope) —
  view-evidence instead relies on parsed factual counts paying brackets only for
  reviewer-confirmed or scraped counts (views-evidence suite 17/0).
