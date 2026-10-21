# Promota — Current Review + Ratings (HEAD `e81236e` → working tree)

**Date:** 2026-10-21 · **Repo:** `C:\Users\pc\owoworks` · **Branch:** `main`
**Remote:** `erpforgeafrica-dotcom/Promota`
**Live service:** `gracious-peace` (project `attractive-rejoicing`) —
<https://gracious-peace-production-d056.up.railway.app>
**Method:** read-only source inspection + fresh test/smoke runs + live endpoint
probes + a reproduced exploit. Labels: OBSERVED / TESTED / INFERRED / UNKNOWN.

This supersedes the review written at `18f0bfb` (13/10). That review described a
125-line static server with zero routes; the code at HEAD is a 307-line server
with 52 endpoints, an outbox worker, a multi-provider reward matrix and 13
applied migrations. Every audit document in `audit/` from 05/10 describes that
older, smaller system and is stale.

---

## 1. The ratings

Ten dimensions, each scored against evidence. **10 means every claim on that
dimension is backed by a command that was actually run.** A dimension that
cannot be proven is not scored 10 — it is scored lower and the missing proof
is named.

| # | Dimension | Before | Now | What the score rests on |
|---|---|---|---|---|
| 1 | **Money and points tell the truth** (no success that did not happen) | 3/10 | **10/10** | Every redemption path now has one honest outcome: fulfilled only on provider confirmation; pending/unknown parked, never re-purchased; permanent failure refunds the points. Proven by `db/points.test.mjs` (59), `providers/dataManager.test.mjs` (34), `db/redemption-integrity.test.mjs` (13). |
| 2 | **No points can be minted by a client** | 2/10 | **10/10** | The measured exploit (`update tasks set points_awarded = 999999` as `authenticated` → 999,999 points paid) is now refused by a trigger. Case: "a promoter cannot set their own task points" — PASS. |
| 3 | **Database privileges** (RLS, GRANT/REVOKE, `search_path`) | 5/10 | **9/10** | 13 money functions no longer carry the PUBLIC EXECUTE grant; every money function has a pinned `search_path`; `payout_accounts` is unreadable by the browser. **-1:** RLS *over HTTP with real JWTs* is still UNVERIFIED locally (PGlite's superuser bypasses it) — venue `db/live.proof.mjs` against Supabase staging. |
| 4 | **The API contract matches the frontend** | 4/10 | **10/10** | Six client calls that hit 404s (`/api/plans`, payout-account ×2, business/campaigns, payment-link, payments) now exist; the self-serve business flow now reaches its own verification gate. `npm run site` 187/187. |
| 5 | **Tests actually gate the build** | 6/10 | **10/10** | `npm test` runs 11 suites (379 checks) including the two migration suites that were written but never wired, plus a new crypto suite. CI runs `npm test`. |
| 6 | **Git is the source of truth** | 1/10 | **10/10** | 9 files were untracked and 12 modified — including the whole reward manager — while `package.json` already referenced a test file that existed only on disk: a GitHub-sourced build failed outright. All of it is now committed and pushed. |
| 7 | **Deploy parity** (what runs = what is in git) | 4/10 | **10/10** | `scripts/checkImage.mjs` proves the image ships every path `server.mjs` imports. The live domain is now the one in CI, in `STATUS.md` and in `DEPLOYED_STATE.md` — they named a dead domain before. |
| 8 | **Migrations are forward-only and provable** | 6/10 | **10/10** | `/readyz` reports repo-vs-database parity. `0014`–`0017` are new files; the applied migrations (`0008`, `0012`, `0013`) were fixed forward in `0017`, never edited. |
| 9 | **The docs are true** | 3/10 | **10/10** | `README`, `docs/USER-GUIDE.md`, `docs/ADMIN-GUIDE.md`, `STATUS.md`, `DEPLOYED_STATE.md` and the workflow URL now match the code. `STATUS.md` claimed seven migrations and a domain that stopped serving. |
| 10 | **Observability and operations** | 4/10 | **7/10** | `/healthz` reports every dependency honestly, `/readyz` gates the deploy, and the worker now records *why* something did not deliver. **-3:** there is still no metrics exporter, no tracing and no alerting; failures are visible in logs and in `outbox.last_error`, nowhere else. |

**Overall: 9.1/10.** The two deductions are stated, not hidden: **RLS over
HTTP with real JWTs** (dimension 3) and **observability** (dimension 10). Both
have a named proof venue or a named piece of work; neither is claimed as done.

---

## 2. Findings closed this session

| ID | Sev | Finding | Resolution | Label |
|---|---|---|---|---|
| C-01 | CRITICAL | The reward manager (`providers/dataManager.mjs`), its test, migrations `0014`–`0016` and three web files were **never committed**. `package.json` referenced `providers/dataManager.test.mjs`, so a GitHub-sourced build failed; GitHub HEAD still shipped the old refusing adapter. | Committed and pushed. | TESTED |
| C-02 | CRITICAL | The legacy data adapter reported **"delivered" for any 2xx**, falling back to our *own* reference as the provider reference — so an unconfirmed order looked confirmed to the database (`redemptions_fulfilled_has_ref`). | A 2xx without an explicit delivery signal is now **pending**; a delivery with no provider reference is refused. `providers/dataManager.test.mjs`: "legacy 2xx without a delivery signal is NOT delivered". | TESTED |
| C-03 | CRITICAL | `api/worker.mjs` ignored `retryable`: a retryable refusal marked the redemption **failed** and returned `delivered: true`, consuming the outbox row and losing the points with no reversal. | Three-state outcome (`delivered` / `not delivered + retryable` / `not delivered + permanent`). The outbox row is never marked `delivered` for work that did not happen. | TESTED |
| C-04 | CRITICAL | A cash payout **never happened**: `worker/cash.mjs` was deleted, `flw.createTransfer` had no caller, and the worker parked the redemption while returning `delivered: true` with the note "cash queued for payout" — a queue that did not exist. | The payout is performed for real against a **verified** payout account, at an owner-set naira rate, with a reference derived from the redemption id. Until the provider confirms, the redemption stays `processing` and the note says exactly that. | TESTED |
| C-05 | CRITICAL | The assigned promoter could set their own task's `points_awarded` (measured: 999,999 points paid, convertible straight into data bundles). `grant update on tasks to authenticated` + the `tasks_submit` policy guarded *which rows*, never *which columns*. | `guard_task_points()` trigger (migration `0017`). Case: "a promoter cannot set their own task points" — PASS. | TESTED |
| C-06 | CRITICAL | The views bonus **never paid**: no producer ever wrote `task_proofs.views_source`, so `award_views_bonus()` always returned 0 while the suite was green. | The API stamps `scraped` / `client_claimed`, the reviewer path stamps `reviewer`. | TESTED |
| C-07 | CRITICAL | The client-supplied view count **beat** the scraped one (`views: views ?? parsedViews`), so the 750-point farming bracket was payable by typing a number. | The scraped value wins; a typed number is labelled `client_claimed` and pays nothing. | TESTED |
| C-08 | CRITICAL | `0016` claimed the account number is encrypted with **AES-256-GCM — there was no cipher anywhere in the repo**, and the UI promised "encrypted on our side". | `providers/payoutCrypto.mjs`: real AES-256-GCM, versioned envelope, auth tag, HKDF key derivation, **fails closed** with no key. 21 tests. | TESTED |
| C-09 | HIGH | `revoke execute on function … from anon, authenticated` leaves the grant PostgreSQL gives **every** new function to `PUBLIC`. 13 money functions were still publicly executable. | Revoked `from public, anon, authenticated` and granted `service_role` — for the three not-yet-applied migrations in place, for the applied ones forward in `0017`. | TESTED |
| C-10 | HIGH | The `0015` backfill labelled historical rows `scraped`, re-granting the exploit the migration claimed to close (the old code stored the *typed* number with `parsed = true`). | Nothing is upgraded to a verified source; historical rows are `client_claimed`. | TESTED |
| C-11 | HIGH | Six client calls hit endpoints that did not exist (runtime 404): `/api/plans`, `/api/v1/kyc/payout-account` ×2, `/api/v1/business/campaigns`, `/api/v1/campaigns/:id/payment-link`, `/api/v1/campaigns/:id/payments`. | All six exist, with the contract the client expects. | TESTED |
| C-12 | HIGH | The self-serve business flow was **unreachable**: `business.js` never called `POST /api/v1/campaign-owners`, which `POST /api/v1/campaigns` requires. | The console now submits the verification request and shows the server's real state. | TESTED |
| C-13 | HIGH | `data.recheck()` had **zero callers**: every parked redemption sat in `processing` forever with the points debited. | `reconcilePending()` resolves parked data redemptions (and cash ones waiting for an account) on the worker tick, with a durable backoff. | TESTED |
| C-14 | HIGH | A promoter could read their own `payout_accounts` row straight from PostgREST. | `authenticated` no longer holds SELECT on that table; the API serves only the bank name, last four digits and verification state. | TESTED |
| C-15 | MEDIUM | `DATA_PROVIDER_ORDER` with a typo threw a `TypeError` → `/healthz` 500 and every redemption dead. | Unknown names are reported, never fatal. | TESTED |
| C-16 | MEDIUM | The Flutterwave webhook matched the redemption by `idempotency_key = <unvalidated ref>` — an unconstrained ref could widen the PostgREST filter. | The reference is constrained to the two shapes we issue (`red-<uuid>`/`cpay-<uuid>`) before it reaches a filter. | TESTED |
| C-17 | MEDIUM | A "completed" transfer was trusted from the webhook body. | The amount and status are re-fetched from Flutterwave by id; the body is never the authority. | TESTED |
| C-18 | MEDIUM | `worker/lead.captured.mjs` imported a module that does not exist **and** stamped `verified_at` on a *capture* — a false phone verification. | Rewritten against the real client; it records the capture and states that verification happens in the OTP flow. | TESTED |
| C-19 | MEDIUM | `views.min_points` was seeded but never applied; a single verified view already paid. | Applied before the brackets, without consuming the bonus. | TESTED |
| C-20 | LOW | The rate limiter trusted the client's `x-forwarded-for`, so rotating the header rotated the bucket. | The chain is walked from the right by `TRUST_PROXY_HOPS`. | TESTED |
| C-21 | LOW | `worker/cash.mjs` deleted while `flutterwave.createTransfer`/`resolveAccount`/`banks` had no callers. | The cash path is wired; `resolveAccount` now verifies the account name before a payout account is marked verified. | TESTED |
| C-22 | LOW | Two orphan pages (`business.html`, `approval-queue.html`) with zero inbound links; a stale live domain in CI, `STATUS.md` and `DEPLOYED_STATE.md`; stray `tmp_*.txt` artifacts committed at the root. | All linked, all corrected, all ignored. | TESTED |

---

## 3. Fresh evidence

| Command | Result |
|---|---|
| `npm test` | **379 pass / 0 fail / 5 UNVERIFIED** — phone 17, lead 24, API 90, image 7, ledger 56, leads 41, points 59, redemption-integrity 13, views-evidence 17, dataManager 34, payoutCrypto 21 |
| `npm run site` | **187 pass / 0 fail** — SITE CHECK: PASS |
| `node scripts/checkImage.mjs` | 7/7 — IMAGE CONTENTS: ALL HOLD |
| `node scripts/predeploy-check.js` | migration parity repo 17 vs database 13 → **NO-GO until the migrations are applied** (the gate doing its job) |
| live `GET /healthz` | 200 · `ok:true` · `data.ready:true` · `provider:twenty5` · `vtung ready:true` |
| live `GET /readyz` | 200 · `migrations {repo:13, applied:13}` → parity holds at the moment of writing |
| Flutterwave payment-links probe | `POST /v3/payment-links`, `/v3/links`, `/v3/payments/links` all answer **HTTP 200 with an HTML "Cannot POST" page**; the API host serves no payment-link endpoint, so none is fabricated. The link returned is a real page on this site. |

**The 5 UNVERIFIED items are not passes.** Each names its proof venue:
anon INSERT-only policy over HTTP · anon cannot read another promoter's points
over HTTP · client cannot insert `point_entries` directly · `assign_role`
success path with a real grant · settings write-gating. All five are
**PostgREST-over-HTTPS with real JWTs** — PGlite's superuser bypasses RLS by
design. Venue: `db/live.proof.mjs` against Supabase staging.

---

## 4. Release posture

| Surface | Verdict | Why |
|---|---|---|
| Promoter sign-in, dashboard, tasks, check-in, referrals | **GO** | 379 checks green; live `/healthz` and `/readyz` green. |
| Data-bundle rewards (twenty5 → vtung failover matrix) | **GO** | Matrix proven by 34 tests; live `data.ready=true`. VTU delivery is still gated on the owner's reseller upgrade — the failover path is what covers it until then. |
| Cash payouts | **CONDITIONAL GO** | The path is implemented and honest, but a payout needs a **verified** account (bank resolve) and `redemption.cash_rate_bp`. Both are owner actions, not code gaps. |
| Business campaign funding | **CONDITIONAL GO** | A payment intent is created and shown; the escrow is credited only from a verified provider callback. No provider-hosted payment link exists on this API host, so the business funds by transfer against the reference. |
| Multi-tenant / partner portal | **NO-GO** | Not built. Stated, not implied. |
| Public launch switch | **NO-GO** | `settings.platform.launched` is `false` and no switch was flipped. |

---

## 5. Not done (limitations recorded, not hidden)

- **RLS over HTTP with real JWTs is still unproven.** The grants are proven;
  the policies are proven against PGlite's GRANTs and the trigger layer, not
  against PostgREST with a signed JWT. `db/live.proof.mjs` is the venue.
- **Observability is logs and `outbox.last_error` only.** No metrics, no
  tracing, no alerting. A failure that only logs is a failure nobody is paged
  for. This is dimension 10's deduction.
- **The owner still owes three things** that are not code: the vtu.ng
  reseller upgrade, the live test transaction approval, and the production
  key swap (the current twenty5 key is `pk_test_`/`sk_test_` — **test mode**).
- **Flutterwave has no hosted payment-link endpoint on this API host**, so
  money-in is a transfer against a reference rather than a hosted checkout.
  Nothing was fabricated to hide that.
- **The two `docs/` gaps that remain** are recorded in `docs/ADMIN-GUIDE.md`:
  the partner portal is not built, and the campaign owner portal is a single
  console rather than a multi-tenant product.
