# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `scripts/audit-ui-wiring.mjs` runs as part of `npm test` (`npm run audit:ui`): it fails when a page calls a path the router does not serve, and when one of 14 launch-critical routes (KYC basic/identity, the whole mutual-promotion flow, admin promotion review and expiry) has no page caller.
- `scripts/checkDomContract.mjs` (`npm run audit:dom`): fails when a page script looks up an element id the page never ships. Ids the script creates itself (`el.id = 'x'`, injected markup) and ids a shared script only needs on some host pages are classified explicitly rather than silently ignored.
- Promote-you dashboard tab and admin Promotions pane (cards in review, deliveries in review, approve/reject with a note, expiry sweep) — the mutual-promotion API previously had no page calling it.

### Fixed
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