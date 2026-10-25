# PROMOTA — FORENSIC AUDIT REPORT (pre-go-live)

**Repo:** `C:\Users\pc\owoworks` (brand: Promota / OwoWorks)
**Branch:** `main`
**HEAD:** `93d7dd3` (deploy: terminal states + verified Hostinger state)
**Remote:** `https://github.com/erpforgeafrica-dotcom/Promota.git`
**Deployed domain:** `https://promota.click` (Hostinger managed Node.js, Node 22, entry `server.mjs`)
**Parallel production target:** Railway `web-production-045b1.up.railway.app` (fallback)
**Audit date:** 2026-10-25
**Auditor:** Senior Forensic Software Auditor — promota-forensic-auditor agent
**Method:** Verified-Evidence-First paradigm. Every claim backed by a command actually run, cited by file:line. Labels: OBSERVED / TESTED / INFERRED / UNKNOWN.
**Auditor independence:** Findings and fix-verification are separate passes; two-pass agreement required before go-live.

---

## Phase results (A–F)

| Phase | Activity | Result | Evidence |
|-------|----------|--------|----------|
| A | Static source inspection of `api/`, `providers/`, `db/migrations/`, `server.mjs`, `apps/web/` | COMPLETE | All files read; claims labelled OBSERVED/TESTED/INFERRED/UNKNOWN |
| B | `npm test` (all suites), `npm run site`, `checkImage.mjs`, `predeploy-check.js` | PASS | [AUDIT-01]–[AUDIT-04] below |
| C | Adversarial reproduction (points-mint guard, webhook idempotency, OTP single-use, provider-failover honesty) | PASS | Test suites encode each exploit case |
| D | Live endpoint verification on `https://promota.click` | PASS 19 / FAIL 0 | [AUDIT-05], [AUDIT-06] |
| E | Documentation triage (README / STATUS / DEPLOYED_STATE vs code) | COMPLETE | Contradictions resolved in this session |
| F | Synthesis + release decision | See verdict below | This report |

---

## [AUDIT-01] `npm test` — full gate

**Result:** 379 checks, 0 FAIL, 5 UNVERIFIED (UNVERIFIED items are NOT passes; each names its proof venue).

| Suite | Pass | Fail | Unverified |
|-------|------|------|------------|
| `apps/web/phone.test.mjs` | 17 | 0 | 0 |
| `apps/web/lead.test.mjs` | 24 | 0 | 0 |
| `api/api.test.mjs` | 90 | 0 | 0 |
| `scripts/checkImage.mjs` | 7 | 0 | 0 |
| `db/ledger.test.mjs` | 56 | 0 | 2 |
| `db/leads.test.mjs` | 41 | 0 | 1 |
| `db/points.test.mjs` | 59 | 0 | 2 |
| `db/redemption-integrity.test.mjs` | 13 | 0 | 0 |
| `db/views-evidence.test.mjs` | 17 | 0 | 0 |
| `providers/dataManager.test.mjs` | 34 | 0 | 0 |
| `providers/payoutCrypto.test.mjs` | 21 | 0 | 0 |
| **Total** | **379** | **0** | **5** |

The 5 UNVERIFIED items all require PostgREST-over-HTTPS with real JWTs (PGlite's superuser bypasses RLS by design). Proof venue: `db/live.proof.mjs` against Supabase staging:
1. `assign_role` success path with a real grant
2. `settings.write` permission gating
3. `anon` INSERT-only policy over HTTP (no select/update/delete)
4. `anon` cannot read another promoter's points over HTTP
5. `client` cannot insert `point_entries` directly

---

## [AUDIT-02] `node scripts/predeploy-check.js`

**Result:** PASS 3, WARN 0, FAIL 0 — PREDEPLOY CHECK: GO
- required env names present (5/5): SUPABASE_URL, SUPABASE_ANON_KEY, FLUTTERWAVE_SECRET_KEY, TERMII_API_KEY, SESSION_SECRET
- CSP snapshot still contains `script-src 'self'`
- migration parity (repo 17, database max 17)

---

## [AUDIT-03] `node scripts/checkImage.mjs`

**Result:** PASS 7, FAIL 0 — IMAGE CONTENTS: ALL HOLD
The Dockerfile (`node:22-alpine`, no `npm install`) ships every path `server.mjs` imports: `api/`, `providers/`, `server.mjs`. Zero runtime dependencies.

---

## [AUDIT-04] `node scripts/checkSite.mjs`

**Result:** PASS 187, FAIL 0 — SITE CHECK: PASS
All 12 pages pass: lang, title, meta description, viewport, anchor resolution, no duplicate IDs, local assets, CTAs, no hardcoded phone numbers, no unsanctioned testimonials, img alt text, prefers-reduced-motion, theme-color meta, theme-toggle ARIA labels, no-flash theme boot, light-theme tokens, color-scheme declaration.

---

## [AUDIT-05] Live probe `https://promota.click/healthz`

**Result:** HTTP/1.1 200 OK
Headers observed:
- `content-type: application/json; charset=utf-8`
- `x-ratelimit-remaining: 60`
- `x-content-type-options: nosniff`
- `referrer-policy: no-referrer`
- `x-frame-options: DENY`
- `content-security-policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://*.supabase.co; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`
- `content-security-policy: upgrade-insecure-requests`
- `permissions-policy: geolocation=(), camera=(), microphone=()`
- `cache-control: no-store`

Body: `{"ok":true,"config":true,"auth":true,"providers":{...}}` — the Node app itself is serving (not a static placeholder), all dependency readiness flags present, no key or URL leaked.

---

## [AUDIT-06] `node scripts/verifyLive.mjs https://promota.click`

**Result:** PASS 19, FAIL 0 — DEPLOY VERIFY: ALL HOLD
End-to-end real flow verified on the deployed domain:
- Home page 200 HTML; CSP, nosniff, frame-deny present
- `/config.js` carries Supabase URL + publishable key only (no secret)
- Real visitor sign-up through deployed config → 8-char invite code, no phone in response
- Visitor cannot read the sign-up list (anon read blocked)
- Admin confirms the row really landed in the database
- Test row cleaned up

---

## [AUDIT-07] Migration `0001_core.sql` — money rules in SQL

**Result:** PASS (OBSERVED, cited)
Deferred balance constraint at COMMIT (`assert_entry_balanced()`), single-currency assertion (`assert_entry_single_currency()`), forbid-posting-mutation trigger, campaign-funded guard (`assert_campaign_funded()`), margin floor (`assert_campaign_margin_floor()`), task-state transition guard (`assert_task_transition()`), auto-approve sweeper (`auto_approve_stale_tasks()`), payout eligibility (`assert_payout_eligibility()`), atomic outbox claim (`claim_outbox_batch()` with SKIP LOCKED), dispute transition guard (`assert_dispute_transition()`). Idempotency via UNIQUE index on INSERT (duplicate ledger idempotency_key refused; duplicate payout idempotency_key refused). Escrow-before-live: unfunded campaign cannot go LIVE; partial escrow recorded but does not unlock launch; fully funded campaign goes LIVE; auto-pause at 90% of budget. Source: `db/migrations/0001_core.sql` — trigger functions and table constraints; proven by `db/ledger.test.mjs` (56 PASS / 0 FAIL / 2 UNVERIFIED).

---

## [AUDIT-08] Migration `0017_points_integrity.sql` — points-mint guard

**Result:** PASS (TESTED, cited)
`guard_task_points()` trigger refuses a promoter setting their own `tasks.points_awarded`. Measured exploit previously paid 999,999 points; now refused with a platform-owned reason; task points unchanged after attempt. Source: `db/migrations/0017_points_integrity.sql`; proven by `db/points.test.mjs`:
- "a promoter cannot set their own task points" — PASS
- "the refusal names the platform-owned reason" — PASS
- "the task points are unchanged after the attempt" — PASS

---

## [AUDIT-09] `api/worker.mjs` — three-state outcome + reconciliation

**Result:** PASS (TESTED, cited)
`fulfilDataRedemption()` (lines 66–115) enforces three states: `delivered` / not-delivered-and-retryable / not-delivered-and-permanent. PENDING and UNKNOWN are parked as `processing`, never re-purchased. `reconcilePending()` (lines 431–516) resolves parked data redemptions on the worker tick with durable backoff (updated_at), and retries cash redemptions waiting for a payout account. Outbox row never marked `delivered` for work that did not happen. Proven by `providers/dataManager.test.mjs` (34 PASS) and worker handler coverage in `api/api.test.mjs` (90 PASS).

**Finding (observed in code, not a test failure):** In `approveTask`→outbox insert (admin.mjs lines 551–552), a failed outbox insert is swallowed by `failingOutbox()` (logged once, `outboxWarned` flag) and approval still returns success. The task is marked approved but no award outbox event exists → points never awarded = false success on the money path. **Severity: HIGH.** Remediation: fail the approval (or enqueue a retry with the task) when the outbox insert fails, so approval and award are atomic.

---

## [AUDIT-10] `api/routes.mjs` — webhook reference constraint

**Result:** PASS (TESTED, cited)
Flutterwave webhook reference constrained to the two issued shapes before any PostgREST filter:
- `^(red-)?<UUID>$` → cash redemption payout
- `^cpay-<UUID>$` → business campaign payment
Unconstrained values (e.g. `x&id=gt.0`) are rejected with 400. Source: `api/routes.mjs` lines 451–456. The verified transfer amount/status is re-fetched from Flutterwave by id (never trusted from the webhook body). Proven by `api/api.test.mjs` webhook cases (bad signature refused, non-JSON refused, unknown events ignored) and `providers/payoutCrypto.test.mjs` / `dataManager.test.mjs`.

---

## [AUDIT-11] `providers/payoutCrypto.mjs` — fail-closed encryption

**Result:** PASS (TESTED, cited)
AES-256-GCM, versioned envelope `v1.<iv>.<tag>.<ciphertext>`, HKDF-SHA256 fallback derived from `SESSION_SECRET` (separate slot, not direct reuse). `configured()` returns false when no key material; `encrypt()`/`decrypt()` throw rather than fall back to plaintext. Source: `providers/payoutCrypto.mjs` lines 74–76 (configured), 99–101 (encrypt throws). `savePayoutAccount` refuses to store when not configured (503). `loadVerifiedPayoutAccount` reports key-rotation decryption failure as real failure, never silent. Proven by `providers/payoutCrypto.test.mjs` (21 PASS / 0 FAIL).

---

## [AUDIT-12] `api/session.mjs` — session security

**Result:** PASS (TESTED, cited, one noted limitation)
- HMAC-SHA256 via `node:crypto`, constant-time `timingSafeEqual` comparison (lines 62–70)
- 12-hour TTL (line 25, `SESSION_TTL_HOURS`)
- `jti` per-token nonce (line 53)
- Profile state re-read on every request (`requireSession`, routes.mjs lines 40–51) — suspension/ban takes effect immediately
- **Noted limitation (stated, not hidden):** Tokens cannot be revoked before expiry except by account-state change or rotating `SESSION_SECRET`. 12-hour window. Source: `api/session.mjs` lines 16–19. **Severity: MEDIUM.** Acceptable for pilot; add a sessions table if per-token revocation becomes necessary.

Minor crypto note: `newOtp()` uses `randomBytes(4).readUInt32BE(0) % 10000` — slight modulo bias on 4-digit PINs (2^32 not evenly divisible by 10000). **Severity: LOW.** Cosmetic; acceptable.

---

## [AUDIT-13] `.env` gitignore

**Result:** PASS (OBSERVED, cited)
`.gitignore` excludes `.env`, `.env.*` (except `.env.example`), `apps/web/config.js` (except `config.example.js`), `*.pem`, `*.key`. Real secret values are never printed or committed; only key names are documented. Source: `.gitignore` (33 lines).

---

## [AUDIT-14] No secrets committed

**Result:** PASS (OBSERVED)
No token or key value appears in any tracked file, commit, or this report. The Hostinger API token is referenced by path only (`C:\Users\pc\HOSTINGER API KEY.txt`, line 2) in `scripts/deploy-hostinger.mjs` and `docs/DEPLOY-HOSTINGER.md`. Key names only, values redacted everywhere.

---

## Findings register (severity-ranked)

| ID | Severity | Finding | Evidence (file:line + command + output) | Label | Remediation | Fix verified |
|----|----------|---------|-------------------------------------------|-------|-------------|--------------|
| F-01 | HIGH | Outbox insert failure in `approveTask` is swallowed; task marked approved but points never awarded (false success on money path). | `api/admin.mjs:551–552`; `failingOutbox()` logs once, continues | OBSERVED | Fail approval (or enqueue retry) when outbox insert fails; make approval+award atomic. | Not yet |
| F-02 | MEDIUM | Session tokens not revocable before expiry except by account-state change or `SESSION_SECRET` rotation (12-hour window). | `api/session.mjs:16–19` | Stated limitation | Add sessions table + revocation check if per-token revocation required. | Not yet |
| F-03 | LOW | `newOtp()` modulo bias on 4-digit PINs (`% 10000` on `readUInt32BE`). | `api/session.mjs:91–94` | OBSERVED | Use rejection sampling for uniform 4-digit PINs. | Not yet |
| F-04 | INFORMATIONAL | 5 UNVERIFIED test items require Supabase-staging JWT proof (RLS over HTTP). PGlite superuser bypasses RLS by design. | `db/ledger.test.mjs`, `db/leads.test.mjs`, `db/points.test.mjs` UNVERIFIED rows | UNKNOWN | Run `db/live.proof.mjs` against Supabase staging with anon/authenticated JWTs. | Not yet |
| F-05 | INFORMATIONAL | No metrics exporter, tracing, or alerting; failures visible only in logs / `outbox.last_error`. | `audit/SPRINT22-CURRENT-REVIEW.md` dimension 10 | OBSERVED | Add `/metrics` + alerting before high-volume launch. | Not yet |
| F-06 | INFORMATIONAL | No CI workflow was present at the start of this session (now `.github/workflows/test.yml` exists). | `.github/workflows/test.yml` | OBSERVED | CI runs `npm test` on push; keep green. | Done |

---

## UNVERIFIED register (proof venues named)

| Item | Proof venue | Owner |
|------|-------------|-------|
| `assign_role` success path with a real grant | `db/live.proof.mjs` on Supabase staging (authenticated JWT) | promota-db-engineer |
| `settings.write` permission gating | `db/live.proof.mjs` on Supabase staging (authenticated JWT) | promota-security-reviewer |
| anon INSERT-only policy over HTTP (no select/update/delete) | `db/live.proof.mjs` on Supabase staging (anon JWT) | promota-security-reviewer |
| anon cannot read another promoter's points over HTTP | `db/live.proof.mjs` on Supabase staging (authenticated JWT) | promota-security-reviewer |
| client cannot insert `point_entries` directly | `db/live.proof.mjs` on Supabase staging (anon/authenticated JWT) | promota-security-reviewer |

None of these block go-live for the lead-capture / data-redemption pilot; all are named, not hidden, per the paradigm.

---

## Release gate verdict

**CONDITIONAL GO — for the lead-capture + data-redemption pilot on `https://promota.click`.**

Go surfaces (verified):
- Promoter sign-in (Termii OTP), dashboard, tasks, check-in, referrals — 379 checks green
- Data-bundle rewards (twenty5 → vtung failover matrix) — live `data.ready=true`
- `/healthz` 200 with full CSP + rate-limit headers; live sign-up → invite code → admin DB row confirmed → cleanup
- Money rules in SQL: deferred balance, escrow-before-live, idempotency, provider-confirmation-only fulfillment
- Cash payout path implemented and honest (verified account + owner-set rate required — owner actions)

Not GO (named blockers):
- **F-01** (HIGH): outbox-insert failure → false success on task approval award. Must be remediated before cash-redemption or campaign-funding go-live.
- **F-04** (INFORMATIONAL): 5 RLS-over-HTTP items unproven locally; prove on Supabase staging.
- **F-05** (INFORMATIONAL): no metrics/alerting — acceptable for pilot, required before high-volume launch.
- Cash payouts: CONDITIONAL GO — needs verified payout account + `redemption.cash_rate_bp` (owner actions, not code gaps).
- Business campaign funding: CONDITIONAL GO — payment intent created; escrow credited only from verified provider callback; no hosted payment-link on this API host (money-in = transfer against reference).
- Multi-tenant / partner portal: NO-GO — not built.
- Public launch switch: `settings.platform.launched` is `false` — not flipped.

Full marketplace (campaign escrow, cash payouts at volume, partner portal) remains NO-GO until F-01 is fixed and verified, F-04 is proven on staging, and owner actions (cash rate, verified accounts, Flutterwave production keys) are completed.

---

## Auditor independence statement

Two independent passes were applied to this audit:
1. Primary forensic pass by this agent (static + dynamic + live evidence, this report).
2. Cross-check pass against the repo's own agents/skills (`promota-money-path-auditor`, `promota-security-reviewer`, `promota-release-gate`) — all concur on the CONDITIONAL GO verdict and on F-01 as the highest-priority remediation.

No auditor who found a defect verified its own fix. F-01 remains open pending remediation + re-test.

---

**End of forensic audit report.** Save this file to `audit/FORENSIC-AUDIT-REPORT.md` and update the session compact. Next immediate action: remediate F-01 (atomic approval+award), re-run `npm test`, then re-verify live.
