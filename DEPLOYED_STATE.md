# DEPLOYED_STATE.md — Canonical deployment identity & state triage

**Date:** 2026-10-07
**Purpose:** Single source of truth for repository identity, deployed SHA, and verified state.
Per Team C recommendation: "Add a DEPLOYED_STATE.md triage record."

---

## Repository Identity

| Aspect | Value | Status |
|---|---|---|
| **Local repo name** | `owoworks` | Directory name |
| **Git remote (origin)** | `https://github.com/erpforgeafrica-dotcom/Promota.git` | **Canonical remote** (verified `git remote -v` 2026-10-24; the earlier `OwoWorks.git` note is stale) |
| **Brand name** | `Promota` | Product brand |
| **GitHub repo (deployed)** | `erpforgeafrica-dotcom/Promota` | Pushed as `Promota` |
| **Branch** | `main` | Default |

---

## Deployed State (Hostinger — promota.click)

Added 2026-10-24. Full app (server.mjs + api/ + apps/web/ + providers/) on
Hostinger managed Node.js. Procedure: `docs/DEPLOY-HOSTINGER.md`, the
repository script `scripts/deploy-hostinger.mjs` reads the API token file
from the owner machine (`C:\Users\pc\HOSTINGER API KEY.txt` — path only).

| Aspect | Value | Verified |
|---|---|---|
| **Domain** | `promota.click` | Live API `GET /api/hosting/v1/websites` 2026-10-24 |
| **Hosting account** | `u515553672` | Same call |
| **Runtime** | Node 22, entry `server.mjs`, git source `erpforgeafrica-dotcom/Promota@main` | Build settings via API |
| **Env** | Core + provider allow-list from repo `.env` via `PUT …/env` | Script `putEnv()` |
| **Health** | `https://promota.click/healthz` | verify after each build |
| **Git GitHub App** | installation `01a16c1d-7a43-70fc-a943-10885016dd9e` active | `GET /git/installations` 2026-10-24 |

Railway (below) stays as the parallel/fallback production target.

---

## Deployed State (Railway)

| Aspect | Value | Verified |
|---|---|---|
| **Railway Account** | `Engr.emmamickado@gmail.com` / `m1ckad0's Projects` | 2026-10-03 |
| **Railway Project** | `owoworks` (`60ac6fc7-c53d-4150-b419-5ca790e35a96`) | Yes |
| **Railway Service** | `web` / `production` | Yes |
| **Live Domain** | `https://web-production-045b1.up.railway.app` | Yes |
| **Deployed SHA** | `f9ecdd2` (per STATUS.md 2026-10-03) | Historical |
| **Current HEAD** | `5c1f2dd68d2b067cae44feba76ca78e0e8e27dfe` | 2026-10-05 |
| **Docker Image** | `node:22-alpine` (no npm install) | Yes |
| **Config Injection** | `window.PROMOTA` from `SUPABASE_URL` + `SUPABASE_ANON_KEY` | Yes |

---

## Supabase Project

| Aspect | Value | Verified |
|---|---|---|
| **Project ID** | `ykyvmgdruterzrmltquz` | Yes |
| **Migrations Applied** | `0001`–`0007` (7 total) | Yes |
| **RLS Verified** | 14/0/0 on staging (2026-10-05) | Yes |
| **Oracle Fix** | `0007` applied, duplicate phone indistinguishable | Yes |
| **Lead Capture** | `submit_lead` RPC proven live | Yes |

---

## Test Suite Status (Local PGlite)

| Suite | Tests | Pass | Fail | Unverified | Last Run |
|---|---|---|---|---|---|
| `phone.test.mjs` | 17 | 17 | 0 | 0 | 2026-10-07 |
| `lead.test.mjs` | 24 | 24 | 0 | 0 | 2026-10-07 |
| `ledger.test.mjs` | 56 | 56 | 0 | 2 | 2026-10-07 |
| `leads.test.mjs` | 41 | 41 | 0 | 1 | 2026-10-07 |
| `live.proof.mjs` | 14 | 14 | 0 | 0 | 2026-10-05 (staging) |
| `verifyLive.mjs` | 19 | 19 | 0 | 0 | 2026-10-03 (railway) |
| `checkSite.mjs` | ~40 | All | 0 | 0 | 2026-10-07 |

**Total:** ~191 automated checks, 0 failures.

---

## Feature Completeness (Team A Matrix)

| Domain | Status | Blockers |
|---|---|---|
| **Lead Capture + Referral** | ✅ COMPLETE & PROVEN LIVE | None |
| **Brand / Design System** | ✅ COMPLETE | None |
| **Static Site Integrity** | ✅ COMPLETE | None |
| **Database Schema** | ✅ COMPLETE & PROVEN (7 migrations) | None |
| **Migration System** | ✅ COMPLETE & PROVEN | None |
| **Railway Deployment** | ✅ LIVE | None |
| **RLS Policies** | ✅ PROVEN LIVE (14/0/0) | None |
| **CI/CD** | ✅ GitHub Actions created | None |
| **Rate Limiting** | ✅ Edge rate limiting added | None |
| **Legal Pages** | ✅ Terms, Privacy, Refund published | None |
| **Admin Dashboard** | ❌ 0% BUILT | No external deps — can build |
| **Promoter Dashboard** | ❌ 0% BUILT | No external deps — can build |
| **Business Campaign Manager** | ❌ 0% BUILT | Needs payment gateway |
| **Partner Portal** | ❌ 0% BUILT | No external deps — can build |
| **Payouts / Ledger Execution** | ⚠️ DB ONLY | Needs Termii, payment gateway, KYC |
| **Task State Machine** | ⚠️ DB ONLY | No external deps — can build API/UI |
| **Disputes** | ⚠️ DB ONLY | No external deps — can build API/UI |
| **SMS/Termii Verification** | ❌ MISSING WORKER | **Termii API key** |
| **KYC/IDV** | ❌ NOT STARTED | **KYC provider** |
| **Payment Gateway** | ❌ NOT STARTED | **Flutterwave/Paystack/Monnify** |
| **Platform OAuth** | ❌ NOT STARTED | **OAuth providers** |
| **Observability** | ⚠️ MINIMAL (console.log only) | No external deps — can add |
| **Webhooks** | ❌ MISSING | No external deps — can build |

---

## Critical Blockers (Owner Action Required)

| # | Blocker | Status | Notes |
|---|---|---|---|
| 1 | Trademark + CAC + domain for "Promota" | UNVERIFIED | Web prior-art done; legal clearance needed |
| 2 | Registered entity + PII-storage decision | UNVERIFIED | Jurisdiction, data residency |
| 3 | Termii API key (SMS OTP worker) | MISSING | Blocks `verified_at` flow |
| 4 | Payment gateway (cash payouts) | NOT STARTED | Flutterwave/Paystack/Monnify |
| 5 | KYC/IDV provider | NOT STARTED | Smile Identity/VerifyMe/Youverify |
| 6 | Data aggregator (MTN/Glo/Airtel) | NOT STARTED | Termii/Migo/Arkesel |
| 7 | Legal counsel (NDPA + SEC) | NOT STARTED | Compliance review |

---

## Release Gates (Team C — Updated Post-Team D)

| Gate | Status | Evidence |
|---|---|---|
| **G-001: RLS Verification** | ✅ CLOSED | 14/0/0 on staging (2026-10-05) |
| **G-002: Product Scope Agreement** | ⚠️ PARTIAL | Docs aligned; scope = lead-capture pilot |
| **G-003: Integration Tests** | ✅ CLOSED (replaced) | `db/leads.test.mjs` 41 tests on PGlite |
| **G-003′: Client Fetch Path** | ⚠️ OPEN | No DOM/fetch-level test for `submit_lead` |
| **G-004: CI Configuration** | ✅ CLOSED | `.github/workflows/test.yml` created |
| **GH-1: Oracle Fix** | ✅ CLOSED | `0007` applied + live verified on staging |

---

## Next Recommended Actions (Priority Order)

### Immediate (This Week) — No External Deps
1. Add DOM/fetch-level integration test for `submit_lead` (closes G-003′)
2. Add structured logging + `/metrics` endpoint (observability)
3. Document canonical repository identity in README

### Short Term (2-4 Weeks) — No External Deps
4. Build Admin Dashboard API + minimal UI (DB ready)
5. Build Promoter Dashboard (task assignment, payout history, dispute view)
6. Build Partner Portal (partner role + permissions exist)
7. Add observability stack (Grafana Cloud free tier)

### Medium Term (1-2 Months) — Requires External Deps
8. Termii API key + SMS worker → `verified_at` flow
9. Payment gateway integration (Flutterwave/Paystack) for cash payouts
10. KYC/IDV provider integration (Smile Identity/VerifyMe)
11. Data aggregator integration (Termii/Migo) for MTN/Glo/Airtel bundles
12. Platform OAuth (YouTube/Facebook) for follower verification

### Long Term / Regulatory
13. Trademark registration (Nigeria + international)
14. CAC registration (legal entity)
15. Domain acquisition (promota.ng / promota.com)
16. NDPA compliance audit
17. SEC compliance review (anti-MLM already designed in)

---

## Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| **Release Owner** | [OWNER] | TBD | PENDING |
| **Team A (Product/Business)** | Delivered | 2026-10-05 | ✅ Complete |
| **Team C (Red Team)** | Delivered | 2026-10-05 | ✅ Complete |
| **Team D (Verifier)** | Delivered | 2026-10-05 | ✅ Complete |

**Current Verdict:** CONDITIONAL GO for lead-capture-only pilot.
Full marketplace remains NO-GO pending external dependencies and admin/promoter/business UIs.