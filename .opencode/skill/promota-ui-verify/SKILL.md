---
name: promota-ui-verify
description: "Verify the deployed Promota UI end to end: the page loads with the runtime config injected, a session can be established, and one real feature path completes. Use when a change touches apps/web or when a deploy must be proven to work, instead of asserting HTTP 200."
metadata:
  project: promota
---

Proving the deployed Promota app actually works. HTTP 200 on the homepage
proves the server is up. It does not prove the config was injected, that the
database is reachable, that a promoter can sign in, or that a redemption
button leads anywhere.

## The three levels of proof

| Level | What it proves | How |
|---|---|---|
| 1 | The server is up and configured | `GET /healthz` returns `{ ok: true, config, auth, providers }` |
| 2 | The server is ready to serve | `GET /readyz` returns `{ ready: true, checks: { supabase: {ok}, flags: {ok}, migrations: {ok} } }` |
| 3 | A real user path works | the live feature check below |

A release is not proven until level 3 passes for the surface being released.

## Level 1 and 2

```powershell
Invoke-WebRequest -Uri "<base>/healthz" -UseBasicParsing | Select-Object -ExpandProperty Content
Invoke-WebRequest -Uri "<base>/readyz"  -UseBasicParsing | Select-Object -ExpandProperty Content
```

`/healthz` has a frozen shape — `{ ok, config, auth, providers }` — because
`railway.json` uses it as the healthcheck path and `api/server.smoke.mjs`
asserts it. If the shape differs, the deployed artifact is not the code you
think it is. The body must contain booleans and counts, never a variable
value.

`/readyz` is the stricter one: `checks.migrations.ok` is true only when the
maximum applied migration version equals the number of migration files the
repo ships. `reason: "database is at migration N, repo ships M"` means the
deploy is ahead of the database — fix that before calling it ready.

## Level 3 — the live feature check

### The tool

Use the `playwright` MCP server (configured in `.opencode/opencode.json`) to
drive a real browser against the deployed URL. It gives an accessibility
snapshot of the page rather than a screenshot, which is what you want for
checking roles, labels and focus order.

The repo's own script covers the lead-capture surface end to end and is the
canonical proof:

```powershell
node scripts/verifyLive.mjs https://web-production-045b1.up.railway.app
```

It loads the deployed site, reads the runtime `/config.js` the container
actually serves (not the local `.env`), compares it with the Supabase
project, submits a real visitor sign-up, confirms the row and its outbox
event exist, and cleans both up.

### The manual path, when the script does not cover your change

Drive the browser and record what you observed at each step. Do not
describe intent; record what the page did.

1. **The page loads.** Open the URL. Confirm the title, the main heading and
   the nav are present, and that the console has no error that breaks a
   feature. A blank page with a 200 is a failure.
2. **The runtime config is present.** In the page context, `window.PROMOTA`
   must exist and carry `SUPABASE_URL` and `SUPABASE_ANON_KEY`. It must
   carry the **publishable** key and nothing else — if a secret key is
   visible in the page source or the network tab, that is a CRITICAL
   finding, stop and report it.
3. **The theme and layout hold.** The theme switch works, the page is
   readable at a narrow width, and the focus ring is visible. `npm run site`
   checks the static side of this; the browser checks the live side.
4. **A session can be established.** Sign in through the OTP flow
   (`POST /api/auth/otp/request` then `POST /api/auth/otp/verify`). Confirm
   the token is issued, the profile loads, and that the profile's `state` is
   honoured — a suspended account must be refused immediately.
5. **One real feature path completes.** Pick the path the change touched:
   - **Task board**: the list loads, a task can be claimed, and a
     submission with a proof URL is accepted. The response must show the
     proof verdict, and the points must NOT have been awarded yet — points
     follow approval, never submission.
   - **Redemption**: the balance shown matches what the server reports (not
     a client-side number), a data redemption is accepted, and the response
     says `state: 'requested'` — not `fulfilled`. Fulfilment is the
     worker's job and requires a provider confirmation.
   - **Admin queue**: a submitted task appears, and approving it moves the
     state once, with the points moving through the SQL function.

### What to record

For each step: the URL, the action, the observable result, and a screenshot
or a captured response body. Anything you did not perform, you did not
verify.

### The failure modes worth naming explicitly

- A page that loads but whose buttons do nothing (missing external script, a
  CSP violation blocking a script). The browser console shows the CSP
  error; the server logs show nothing.
- A page that shows a balance the API never sent (client-side arithmetic).
- A redemption that shows "success" while the response said `state:
  'requested'`.
- A page that only works when the API is reachable from the laptop and not
  from the deployed origin — the `connect-src 'self' https://*.supabase.co`
  rule in `server.mjs` is the thing to check.

## Accessibility spot checks on the live page

Not a substitute for the repo's `npm run site` gate, but a live page can
still break things a static check misses:

- tab through the page: every interactive element is reachable, in a
  sensible order, with a visible focus ring;
- open a dialog: focus moves into it, is trapped, `Escape` closes it, focus
  returns to the trigger;
- open a tab set: arrow keys move between tabs, `aria-selected` follows,
  and each panel is associated with its tab;
- the page reports its language, and images have alt text;
- contrast holds on the live theme, not just the default one.

## What you report

```
LIVE UI VERIFICATION — <surface> — <date> — <base url>

| # | Step | Action | Observed result | Evidence |
|---|---|---|---|---|
| 1 | Page loads | GET / | 200, title "…", main heading present | screenshot |
| 2 | Runtime config | read window.PROMOTA | SUPABASE_URL + publishable key present, no secret | console output |
| 3 | Session | OTP request + verify | token issued, profile loaded, state honoured | response body |
| 4 | <feature path> | <action> | <observed> | <screenshot / body> |

VERDICT: PASS / FAIL / PARTIAL
NOT VERIFIED: <what you did not exercise and why>
```

"NOT VERIFIED" is not a formality. If you did not sign in, you did not
verify the session. If you did not redeem, you did not verify redemption.

## Related

- `.opencode/skill/promota-release/SKILL.md` — step 7, the live check in the
  release sequence
- `.opencode/agent/promota-frontend-engineer.md` — the CSP and accessibility
  constraints this verifies
- `.opencode/agent/promota-devops-engineer.md` — `/healthz` and `/readyz`
