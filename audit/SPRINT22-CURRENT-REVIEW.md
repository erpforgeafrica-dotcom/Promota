# Promota — Current Review (HEAD 18f0bfb)

**Date:** 2026-10-13 · **Repo:** `C:\Users\pc\owoworks` · **Branch:** `main`
**HEAD:** `18f0bfb095d5493c700257fcb3342c4530da4827`
**Remote:** `erpforgeafrica-dotcom/OwoWorks`

This supersedes the prior audit written at `5c1f2dd` (which predates the API
layer, providers, worker, CI, rate limiting, legal pages, and migrations
0008/0009). Method: read-only source inspection + fresh test/smoke runs + a
Docker-image boot simulation. Labels: OBSERVED / TESTED / INFERRED / UNKNOWN.

## What changed since the prior audit (closed items)

| Prior finding | Status now |
|---|---|
| No CI | `CLOSED` — `.github/workflows/test.yml` exists |
| No rate limiting | `CLOSED` — sliding-window limiter in `server.mjs` |
| Legal pages missing | `CLOSED` — `terms.html`, `privacy.html`, `refund.html` |
| Membership oracle (0004) | `ADDRESSED` — forward migration `0007` |
| `console.log` only | `PARTIAL` — still log-based, no metrics/tracing |

## Findings (this review)

| ID | Sev | Finding | Evidence | Label |
|---|---|---|---|---|
| P-001 | CRITICAL | Docker image omitted `api/` + `providers/`; `server.mjs` imports them, so the container exits at boot with `ERR_MODULE_NOT_FOUND` and the `/healthz` healthcheck fails. **Current HEAD could not deploy.** | `Dockerfile` (before fix) vs `server.mjs:23-24`; reproduced in a temp image-sim | TESTED |
| P-002 | HIGH | OTP login impossible: `requestOtp` discarded Termii's `pin_id`, but `verifyOtp` requires it. | `api/routes.mjs` requestOtp/verifyOtp | OBSERVED→FIXED |
| P-003 | HIGH | Production is **stale**: live `/healthz` returns `{ok,config}` (old server), not the current `{ok,config,auth,providers}`. Live SHA not established. | live `Invoke-WebRequest` this session | OBSERVED |
| P-004 | HIGH | Entire `/api` layer is headless — `apps/web/app.js` calls only Supabase RPCs (`submit_lead`, `lead_position`, `preview_referral`). No login/dashboard/task UI. | `apps/web/app.js` | OBSERVED |
| P-005 | MEDIUM | `npm test` skipped `api/api.test.mjs`, `api/server.smoke.mjs`, `providers/providers.smoke.mjs` — the API/security tests never ran in CI. | `package.json` (before fix) | OBSERVED→FIXED (offline API suite added) |
| P-006 | MEDIUM | README claimed "no backend yet", contradicting live lead capture + API. | `README.md` (before fix) | OBSERVED→FIXED |
| P-007 | MEDIUM | Repo/deployment identity drift: remote is `OwoWorks`; `STATUS.md`/`PROOF/` say `Promota`; PROOF bundles predate HEAD. | git remote vs `STATUS.md:88-89` | OBSERVED |
| P-008 | LOW | No data aggregator: data redemptions park as `failed` (points reversible). Honest, but a launch blocker for the "earn data" promise. | `providers/data.mjs` | OBSERVED |

## Fixes applied this session

1. `Dockerfile` — `COPY api ./api` and `COPY providers ./providers`.
2. `api/routes.mjs` — `requestOtp` now returns `pinId` (never the PIN).
3. `package.json` — `npm test` now runs the offline API suite + the new image guard.
4. `scripts/checkImage.mjs` — new regression test: fails if the image omits a
   top-level path reachable from `server.mjs`.
5. `api/api.test.mjs` — behavioral regression test for P-002 (stubbed provider).
6. `README.md` — corrected scope; added "what is wired today".
7. `docs/USER-GUIDE.md`, `docs/ADMIN-GUIDE.md` — user + operator guides.

## Fresh evidence

| Command | Result |
|---|---|
| `npm test` | EXIT 0 — phone 17/0, lead 24/0, API 48/0, image 7/0, ledger 56/0/2UNV, leads 41/0/1UNV, points 56/0/2UNV |
| `node api/server.smoke.mjs` | PASS 22 / FAIL 0 — server boots, serves, API + headers + rate limit hold |
| image-sim boot (pre-fix) | `ERR_MODULE_NOT_FOUND ...\api\routes.mjs` (EXIT 1) — reproduced P-001 |

## Release posture

- **Lead-capture pilot:** GO on the tested local artifact. Live deploy must be
  rebuilt from HEAD after the Dockerfile fix (P-001) and re-verified (P-003).
- **Full marketplace:** NO-GO — no admin/campaign/partner UI, no data provider,
  no payout beneficiary flow, regulatory items open (inherited from prior gate).

## Not done (limitations recorded, not hidden)

- The purpose-built audit subagents (`promota-team-a/-b/-c`) could not run this
  session (provider quota exhausted); this review was executed directly instead.
- Railway deploy was not performed: the account-freeze rule requires the owner to
  name the account in-session and `railway whoami` to confirm it.
- `providers.smoke.mjs` / `server.smoke.mjs` need live provider env and are kept
  out of the default `npm test` to keep CI offline-deterministic.
