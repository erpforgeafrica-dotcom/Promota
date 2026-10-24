# DEPLOY-HOSTINGER.md — Promota on Hostinger (promota.click)

Canonical procedure for deploying this repository to Hostinger managed
hosting at `promota.click`. The whole Node app (server.mjs + api/ +
apps/web/ + providers/ + db/migrations) runs there; nothing is static-only.

## Access (hardcoded reference, per owner directive)

- Token file on the owner machine — **the single source of the API key**:
  `C:\Users\pc\HOSTINGER API KEY.txt`
  - Line 1 label: `EngrhostingerPromotatoken`
  - Line 2: the secret (never printed, never committed; this path is the
    only thing in the repo that references it).
- Override the path with the `HOSTINGER_KEY_FILE` env var if needed.

Never copy the key into another file, a terminal command line, or a commit.

## Platform facts (verified 2026-10-24)

| Fact | Value |
|---|---|
| Hostinger website | `promota.click` |
| Hosting username | `u515553672` |
| Root directory | `/home/u515553672/domains/promota.click/public_html` |
| Auth scheme | `Authorization: Bearer <token>` (OpenAPI: `apiToken`, http bearer) |
| API base | `https://developers.hostinger.com/api/` (OpenAPI: developers.hostinger.com/openapi/openapi.json) |
| Git GitHub App installation | `erpforgeafrica-dotcom` org/user, active |
| Node runtime | Node 22 via the managed Node.js build pipeline |

## Deploy

```powershell
# from the repo root
npm test                      # house gate
node scripts/predeploy-check.js
node scripts/deploy-hostinger.mjs deploy
```

`deploy` does, in order:
1. `PUT  /api/hosting/v1/accounts/u515553672/websites/promota.click/nodejs/builds/settings/env`
   — applies the env allow-list from the repo `.env` (see `scripts/deploy-hostinger.mjs`
   for the list; adds `TRUST_PROXY_HOPS=1` if absent).
2. `PUT  …/nodejs/builds/settings` — node 22, `app_type other`,
   root `.` → output `.`, empty build script, entry `server.mjs`, npm.
3. `POST …/nodejs/builds` — git source build from `erpforgeafrica-dotcom/Promota`
   `main` (pins the live `main` commit SHA via the GitHub API).
4. Polls `…/nodejs/builds/{uuid}` until a terminal state and prints the log
   tail when the build fails.

## Other commands

```powershell
node scripts/deploy-hostinger.mjs status     # website + git installation + settings + builds + env keys
node scripts/deploy-hostinger.mjs env        # re-apply .env to the Hostinger build env
node scripts/deploy-hostinger.mjs restart    # restart the Node server
node scripts/deploy-hostinger.mjs logs <uuid> # fetch a build log
```

## Post-deploy verification (house gate)

```powershell
node scripts/verifyLive.mjs https://promota.click
curl.exe -i https://promota.click/healthz
```

and walk the landing page + lead submit in a real browser.

## Rollback

Railway remains the previous production target
(`web-production-045b1.up.railway.app`). If a Hostinger build goes bad, point
the domain back or fix forward with a new commit and rerun `deploy` — never
edit the deployed site files directly.
