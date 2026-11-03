# RUNBOOK — Promota enhancement execution

**Purpose:** the command-level companion to `docs/ENHANCEMENT-PLAN-20261103.md`.
The plan says *what*; this says *what to type* and *what must be true before moving on*.

**Repo:** `C:\Users\pc\owoworks` · branch `main` · remote `erpforgeafrica-dotcom/Promota`
**Live:** `https://promota.click` (Hostinger, Node 22, entry `server.mjs`, Git source `Promota@main`)

---

## 0. House rules that gate every step

1. Points/money are minted only in Postgres functions. No JS arithmetic that creates value.
2. Never edit an applied migration — add the next number.
3. Every new behaviour ships with a test in the same commit.
4. No success claim without the command and its output pasted in the report.
5. A provider `pending` is not a success. A prize/payout is done only on provider confirmation.
6. Forward-only migrations. No `git reset`, no force push.

---

## 1. Pre-flight (run before every phase)

```powershell
cd C:\Users\pc\owoworks
git status --short
git log --oneline -3
npm test 2>&1 | Select-Object -Last 5
npm run site 2>&1 | Select-Object -Last 3
node scripts/predeploy-check.js 2>&1 | Select-Object -Last 6
```

**Gate:** tree clean (`.second-memory/` may be untracked), tests 0 FAIL, site 0 FAIL, predeploy **GO**.

If predeploy says `repo ships N migration(s) but the database max is N-1`, the live password is stale —
stop and get the credential. Do not add a migration on top of a broken parity gate.

---

## 2. Phase 0 — parity and redeploy

```powershell
# owner supplies/resets the live Postgres password first
npm run db:remote
node scripts/predeploy-check.js
git push origin main                     # Hostinger pulls main
node scripts/deploy-hostinger.mjs        # manual trigger if the pull did not fire
node scripts/verifyLive.mjs https://promota.click
Invoke-WebRequest https://promota.click/healthz -UseBasicParsing | Select-Object StatusCode
```

**Gate:** predeploy GO, verifyLive 19/0, healthz 200 with `ok:true`, parity N = N.

---

## 3. Per-phase build loop

```
write migration 00NN_*.sql
write/extend the test first (red)
apply locally:  npm run db:test
implement SQL functions + API + worker topic
apply locally:  npm run db:test
wire the page and the route
npm test
npm run site
```

**Gate:** new suite green, old suites unchanged, site check green. Commit as
`feat(<area>): <behaviour>` with the test file in the same commit.

---

## 4. Phase 1 — raffle (`0019_raffle_draws.sql`)

Order of work: `draws` → `prize_claims` → `open_draw` → `commit_draw` → `draw_winners`
→ `reveal_draw` → `claim_prize` → `fulfil_prize` → worker topics → routes → pages.

Proof that must exist before calling it done:

```powershell
node db/raffle.test.mjs
# fixed seeds reproduce the same winners twice
# winners contain no duplicate entry
# 101st ticket refused
# double claim refused
# cash prize -> exactly one payout row
# data prize -> exactly one redemption + outbox row
# item prize cannot be fulfilled without a delivery reference
```

Live check: open a staging raffle, draw it, recompute the result in the browser verify page,
claim once, confirm the second claim is refused.

---

## 5. Phase 2 — milestone and downline (`0020_referral_milestones.sql`)

```powershell
node db/referrals.test.mjs   # extend the existing suite, do not fork it
```

Must prove: 99 active → no award; 100 active → exactly one award; inactive referee excluded;
no payout without KYC tier 2; downline data paid once per bracket; reshare bonus paid once.

---

## 6. Phase 3 — chat bots (`0021_chat_links.sql`)

```powershell
node api/bot.test.mjs
# bad Telegram secret token -> 401
# bad WhatsApp X-Hub-Signature-256 -> 401
# expired link code -> refused
# replayed update_id -> no second award
# chat balance == app balance for the same profile
# cross-profile read -> refused
```

Live check needs `TELEGRAM_BOT_TOKEN` and WhatsApp Cloud credentials plus one approved template.
Register the webhook only after the signature test passes locally.

---

## 7. Phase 4 — challenges (`0022_challenges.sql`)

```powershell
node db/challenges.test.mjs
# one vote per profile per entry
# rank deterministic under ties
# 60/40 split exact to the kobo
# revenue replay is idempotent
# rejected entry cannot be ranked
# payout blocked without KYC
```

Live check: submit → moderate → vote → rank → publish → record ₦10,000 → creator gets ₦6,000 once.

---

## 8. Phase 5–6 — taxonomy and data ladder (`0023`, `0024`)

```powershell
node db/policy.test.mjs
node db/data-ladder.test.mjs
```

Taxonomy gate: a `like` task is refused in the DB trigger, the API and both consoles.
Ladder gate: an unavailable 5-hour bundle returns `provider_unavailable` — never a silent
substitution of a different bundle.

---

## 9. Phase 7 — SEO

Build pages, then:

```powershell
npm run site
node scripts/checkSite.mjs
```

Gate: titles, descriptions, canonical, OG, JSON-LD valid; no `noindex` on a page that is meant
to rank; internal links resolve; sitemap includes every new URL.

---

## 10. Phase 8 — release

```powershell
npm test
npm run site
node scripts/predeploy-check.js
npm run db:remote
git push origin main
node scripts/verifyLive.mjs https://promota.click
```

Then update, in the same commit: `STATUS.md`, `DEPLOYED_STATE.md`, `README.md`,
`docs/REWARDS.md`, `docs/LOTTERY.md`, `docs/CREATOR-CHALLENGES.md`, `docs/CHAT-BOTS.md`,
the audit and the session compact.

**Final report format:** resolved / owner-blocked / deferred, each with the evidence line.

---

## 11. Rollback posture

- Migrations are forward-only; a bad module is disabled by its feature flag, not by a down-migration.
- A wrong points award is corrected with `reverse_point_entry`, never by `UPDATE`.
- A wrong payout is corrected with a reversing ledger entry plus a new payout, never by editing the old one.
- If Hostinger serves a bad build: redeploy the previous green commit from `main` history, then fix forward.
