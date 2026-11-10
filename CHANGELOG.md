# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- BulkSMS Nigeria is now the SMS/OTP provider (`providers/bulksms.mjs`), selected through `providers/sms.mjs`. `POST /sms`, `GET /balance`, the sandbox base (`/api/sandbox/v2`, no real SMS, zero cost), `Authorization: Bearer`, digits-only recipients, an 11-character sender id, and `status:"error"` on a 200 all treated as the documented contract — success is the BSNG code, not the HTTP status.
- BulkSMS has no verify endpoint, so OTP verification is now server-side: `sendOtp` returns `pinId`, an HMAC-SHA256 challenge over the encoded payload (nonce + expiry), the recipient and the pin, keyed by `OTP_SECRET` (falling back to `SESSION_SECRET`). `verifyOtp` checks it locally — wrong pin, tampered payload, tampered signature, expired token, a token replayed against another number and a rotated secret are all refusals. No schema change, so sign-in works on the current database.
- `providers/sms.mjs` picks the provider in one place: `SMS_PROVIDER=bulksms|termii` → whichever has a credential → none (a loud refusal). Termii stays as the carrier-lookup adapter (BulkSMS documents no number-intelligence endpoint) and as an env-selectable SMS fallback.
- `providers/bulksms.test.mjs` (101 checks) and `providers/sms.test.mjs` (25 checks) are in `npm test`; `api/api.test.mjs` now drives a full request→verify round trip on BulkSMS by reading the code out of the SMS body the stub received.
- `scripts/audit-ui-wiring.mjs` runs as part of `npm test` (`npm run audit:ui`): it fails when a page calls a path the router does not serve, and when one of 14 launch-critical routes (KYC basic/identity, the whole mutual-promotion flow, admin promotion review and expiry) has no page caller.
- `scripts/checkDomContract.mjs` (`npm run audit:dom`): fails when a page script looks up an element id the page never ships. Ids the script creates itself (`el.id = 'x'`, injected markup) and ids a shared script only needs on some host pages are classified explicitly rather than silently ignored.
- Promote-you dashboard tab and admin Promotions pane (cards in review, deliveries in review, approve/reject with a note, expiry sweep) — the mutual-promotion API previously had no page calling it.

### Changed
- **Production data plane flipped (2026-11-09): promota.click now runs on Supabase `zaewhjzdoyaxsfjjxwqd`, migrations `0001`–`0020` all applied.** The previous project (`ykyvmgdruterzrmltquz`) sat at 17/20, so seven routes returned HTTP 500 and `/readyz` answered 503. After the flip (env push + restart, no code change): `/readyz` → HTTP 200 `{ready:true, migrations:{repo:20, applied:20}}`; `node scripts/audit-live.mjs https://promota.click` → 52 PASS / 1 FAIL (every formerly-500 route now returns the correct 401; the one FAIL is the Termii OTP blocker — country inactive, owner action); `node scripts/verifyLive.mjs https://promota.click` → 19 PASS / 0 FAIL with "deployed config matches this project". Sessions are unaffected: `api/session.mjs` verifies its own HMAC tokens keyed by `SESSION_SECRET`, not Supabase JWKS. Evidence: `PROOF/D1-zaew-dataplane-flip/`.
- Hostinger (`promota.click`) builds every push to `main` automatically — verified, not assumed: three completed builds for `ceeb6dc`, `cfc9cce` and `f500c32`, the newest carrying the full commit hash. `/healthz` therefore reports the deployed artifact's own provider row (`"sms":true,"smsProvider":"termii"`): the switch code is live, the provider is still Termii because no BulkSMS credential exists yet.
- The provider switch is now universal, not just the sign-in path: `api/worker.mjs` sent its four notification SMS through `providers/termii.mjs` directly, so switching to BulkSMS would have moved OTP while leaving the outbox billing Termii. All four call sites now go through `providers/sms.mjs`. `providers/sms.test.mjs` gained a static gate that fails when any module in `api/`, `providers/`, `scripts/` or the repo root imports a vendor SMS adapter directly (the facade, the two adapters, the per-vendor smoke/proof scripts and the `*.test.mjs` files are exempt by design). This gap was found by that same scan, not by review.
- `GET /healthz` reports `providers.sms` and `providers.smsProvider` next to `termii`, and `GET /api/admin/plugins` labels the balance row with the live provider (`smsProvider`) while keeping the historical `termiiBalance` response key the admin page already reads. The route table reads Termii's credential presence through `sms.vendors()` instead of importing the adapter, so the switch stays one env change.

### Fixed
- A Hostinger deploy would have silently dropped the new provider: `scripts/deploy-hostinger.mjs` pushed a fixed `CORE` env list that named only `TERMII_*`. It now pushes `BULKSMS_API_TOKEN`, `BULKSMS_API_KEY`, `BULKSMS_BASE_URL`, `BULKSMS_SENDER_ID`, `BULKSMS_SANDBOX`, `BULKSMS_OTP_GATEWAY`, `OTP_SECRET` and `SMS_PROVIDER` alongside the Termii keys.
- The OTP challenge signature did not cover the expiry: the MAC was taken over the nonce, recipient and pin, so an edited payload kept a valid signature and a client could have extended its own token (caught by `providers/bulksms.test.mjs`). The MAC now covers the encoded payload.
- `apps/web/landing.js` returned early whenever the auth modal was absent, silently disabling the mobile menu, the mobile theme toggle, the FAQ accordion and `FB.ready()` on `about.html` and `contact.html`. The modal wiring is now gated by a flag; the rest of the page always wires.

## [0.2.0] - 2026-10-07

### Added
- GitHub Actions CI/CD workflow (`.github/workflows/test.yml`) with test suite and live verification
- Edge rate limiting on `/config.js` and `/healthz` endpoints (30 req/min/IP) in `server.mjs`
- Legal pages: Terms of Service (`terms.html`), Privacy Policy (`privacy.html`), Refund Policy (`refund.html`)
- Footer legal links in `index.html` pointing to legal pages
- Oracle fix migration `0007_fix_submit_lead_oracle.sql` — duplicate phone returns identical success shape
- Expanded `db/leads.test.mjs` to 41 tests with indistinguishability checks
- `CHANGELOG.md` with semantic versioning

### Changed
- Updated `README.md` Pre-launch truths: lead capture IS implemented, RLS PROVEN, oracle FIXED
- Updated `docs/LEAD-CAPTURE.md` status: migrations 0001-0007 applied, oracle fix done, RLS verified
- Updated `STATUS.md` with current verified state: 7 migrations, 41 lead tests, RLS 14/0/0, legal pages, CI/CD, rate limiting
- Fixed documentation contradictions between README, LEAD-CAPTURE, and STATUS

### Fixed
- Membership oracle vulnerability in `submit_lead` RPC (0007 forward-only migration)
- Repository identity documentation (remote is OwoWorks, brand is Promota)
- RLS policies now verified over HTTPS on staging (14/0/0)

### Security
- Rate limiting on public endpoints to prevent DoS
- Strict CSP, security headers maintained
- `.env` verified gitignored, never committed

## [0.1.0] - 2026-10-03

### Added
- Initial Promota rebrand from OwoWorks
- Lead capture with `submit_lead` RPC and referral engine
- Double-entry ledger, escrow, campaigns, tasks, payouts, disputes, RBAC (7 migrations)
- WCAG 2.2 AA brand palette, zero-dependency typography, theme toggle
- Railway deployment with Docker (node:22-alpine)
- Supabase integration with RLS policies
- Test suites: phone (17), lead client (17), ledger (56), leads DB (37)
- Live proof: `db/live.proof.mjs` 14/0/0, `verifyLive.mjs` 19/0

### Security
- Row Level Security on all tables
- Publishable key only in client, service role never exposed
- Strict CSP: `script-src 'self'`, `connect-src 'self' https://*.supabase.co`
- Security headers: `nosniff`, `frame-deny`, `referrer-policy: no-referrer`

---

## Versioning Policy

- **MAJOR**: Breaking changes to public API, database schema, or user-facing contracts
- **MINOR**: New features, migrations, test coverage, backward-compatible improvements
- **PATCH**: Bug fixes, documentation, CI/CD, security patches

## Release Tags

Releases are tagged as `version/v<MAJOR>.<MINOR>.<PATCH>` (e.g., `version/v0.2.0`).

## Migration Convention

Database migrations are numbered sequentially: `0001_`, `0002_`, etc.
Forward-only: never edit applied migrations; create new ones for fixes.

## Audit Trail

Key audit deliverables (Sprint 22):
- `audit/gap-analysis-summary.md` — Executive gap analysis
- `audit/full-gap-matrix.csv` — 34 features analyzed
- `audit/release-gate-recommendation.md` — Team C conditional GO
- `audit/business-model-audit.md` — Team A business findings
- `audit/product-completeness-matrix.csv` — 74 persona/journey items
- `audit/product-claims-register.csv` — 51 claims tracked
- `audit/route-content-inventory.csv` — 35 routes/content elements
- `audit/evidence-integrity-review.md` — Team C evidence audit
- `audit/red-team-findings.md` — Team C adversarial findings
- `audit/team-d-verification.md` — Team D independent verification
- `audit/live-proof-g001-evidence.md` — Live RLS + oracle proof