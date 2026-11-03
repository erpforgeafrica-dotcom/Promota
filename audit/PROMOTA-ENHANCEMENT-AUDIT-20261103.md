# PROMOTA — BACKEND INVENTORY & ENHANCEMENT AUDIT

**Date:** 2026-11-03
**Repo:** `C:\Users\pc\owoworks` (brand Promota, remote `erpforgeafrica-dotcom/Promota`, branch `main`)
**HEAD at audit:** `017a37c682a5806ab5e93349e53a37ceb5b9e951`
**Working tree:** clean except untracked `.second-memory/`
**Purpose:** answer the owner's question — *"was there no backend to Promota?"* — with evidence, then define exactly what is already done, what is partial, and what the enhancement must add. This is an inventory, not a review of style.

**Rule:** every claim below names the file, migration, command or HTTP response that proves it. Anything not proven is marked `UNVERIFIED` with its proof venue.

---

## 0. The short answer

**Yes — Promota already has a real, tested backend.** It is not a landing page with a database. It has a points ledger with idempotency, levels, referrals, downline task bonuses, daily check-ins, views bonuses, redemptions, data delivery with provider failover, cash payouts, campaign escrow, task proofs, auto-approval, disputes, RBAC, RLS, audit logging and an outbox worker.

The reward economy the owner described is roughly **70% built**:

| Owner's requirement | Status |
|---|---|
| Points earned from tasks | **DONE** — `point_entries`, `award_task_points_networked` |
| Raffle draw | **SCHEMA ONLY** — `competitions` + tickets exist; no draw engine, no reveal, no prize fulfilment |
| Win money, items, TV, PS4, JBL speakers | **NOT BUILT** — prize pool JSON exists; no prize claim/delivery path |
| 100 active referrals = ₦50,000 | **NOT BUILT** — referral points and ambassador stipends exist; the ₦50k milestone does not |
| Downline tracking + fraction of task points | **DONE** — `referrals`, 25% task bonus capped at 300 points |
| Task opens on Telegram or WhatsApp with full detail | **PARTIAL** — Telegram *view parsing* exists; no bot, no WhatsApp bot, no chat-linked task state |
| Persistent task/points/rewards across 3 platforms | **NOT BUILT** — all state is in Postgres, but there is no chat identity link or bot command surface |
| Creator challenge (video/audio/sports/AI/journalism/ad visuals) | **NOT BUILT** |
| Top 3 posted on Promota channels, 60/40 revenue share | **NOT BUILT** |
| Like / follow / subscribe / watch / quiz / comment tasks | **BLOCKED BY POLICY** — migration `0018` prohibits exactly these as paid engagement |
| Share-to-status with 0-view floor, views scaling, reshare bonus | **PARTIAL** — base task points and view brackets exist; no floor setting, no reshare bonus, no downline-view data reward |
| Data ladder 500MB → 1GB → 5GB/5h → 10GB → 20GB → cash | **PARTIAL** — 500MB perfect-month reward and general data redemption exist; the named ladder does not |
| SEO for campaigners, politicians, ministries, government | **PARTIAL** — landing/blog/legal pages exist; no dedicated positioning or programmatic pages |
| Multi-platform persistence | **NOT BUILT** |
| Deployed on Hostinger `main` | **LIVE** — `promota.click` healthz 200 today; one migration behind (0018) |

---

## 1. Identity and live facts (observed 2026-11-03)

| Fact | Value | Evidence |
|---|---|---|
| Git HEAD | `017a37c` | `git rev-parse HEAD` |
| Remote | `erpforgeafrica-dotcom/Promota` | `git remote -v` |
| Working tree | clean except `.second-memory/` | `git status --short` |
| Site integrity | **187 PASS / 0 FAIL** | `npm run site` |
| Deploy gate | **NO-GO** — repo ships 18 migrations, live DB max 17 | `node scripts/predeploy-check.js` |
| Live health | **HTTP 200**, `ok:true`, config/auth true, all providers true, data provider `twenty5` ready | `GET https://promota.click/healthz` |
| Hostinger | `promota.click`, account `u515553672`, Node 22, entry `server.mjs`, Git source `Promota@main` | `DEPLOYED_STATE.md` |
| Live DB project | Supabase `ykyvmgdruterzrmltquz` | `DEPLOYED_STATE.md`, prior proofs |
| Full test suite | **418 PASS / 0 FAIL / 5 UNVERIFIED** (2026-10-31); fresh run started 2026-11-03 | prior compact + background log `.cache/test-20261103.log` |
| Live verify | `scripts/verifyLive.mjs` 19/0 (2026-10-24) | `DEPLOYED_STATE.md` |

**Migration parity is the one live blocker.** Migration `0018_task_policy_gate.sql` is in the repo but **not applied to the live database** (`predeploy-check` re-confirmed today). Until it is applied, the live API/DB may still accept prohibited task types. Applying it requires the live Postgres password; the last attempt (`npm run db:remote`, 2026-11-01) failed with `28P01` (stale credential). Owner action required.

---

## 2. What is DONE (implemented in code, with tests or live proof)

### 2.1 Points ledger, levels, redemption

- **Migration `0008_points_levels.sql`:**
  - `point_entries` — append-only, immutable (triggers `point_entries_no_update` / `no_delete`), one idempotency key per award, signed rewards, reversal shape enforced.
  - `levels` — six levels, points + referral gates, `cash_unlocked` flag.
  - `referrals` — one row per referee, `qualified_at` only after the referee's first approved task, self-referral refused.
  - `redemptions` — data/cash, state machine, provider reference required before `fulfilled`.
  - Functions: `points_balance`, `qualified_referral_count`, `level_for`, `next_level_requirements`, `cash_unlocked`, `award_task_points`, `qualify_referral`, `redeem_points`, `reverse_point_entry`.
  - Settings: `points.per_referral` (later 300), `redemption.data_min_points` (500), `redemption.cash_min_points` (10 000).
- **Migration `0012_close_the_loop.sql`:** softer ladder — level 4 = 3 000 points + 2 referrals, cash unlocked; level 5 = 7 000 + 5; level 6 = 14 000 + 10.
- **Tests:** `db/points.test.mjs` — 59 PASS / 0 FAIL (2026-10-31 run).
- **API:** `GET /api/v1/promoter/earnings`, `POST /api/redeem`; dashboard renders balance, level, entries, redemptions.

### 2.2 Referrals and downline

- `referrals` table (0008) + `qualify_referral()` — 300 points to the referrer on the referee's first approved task; **points only, never cash** (structural anti-MLM rule).
- `award_task_points_networked()` (0012, lines 276–321) — every approved task by a referred worker also pays the referrer 25% of the task reward (`points.referred_task_bonus_bp = 2500`), capped at 300 points (`points.referred_task_bonus_cap` pattern documented).
- `GET /api/v1/promoter/referrals` — own referrals only; dashboard shows total, qualified, points awarded, and the 25% downline bonus explanation.
- **No 100-active-referral milestone and no cash payout for referrals exist.**

### 2.3 Views bonus and evidence rules

- `award_views_bonus()` (0012, lines 328–383) — cumulative brackets: 500 → 50 pts, 2 000 → 100, 10 000 → 200, 50 000 → 400; one award per task, idempotent.
- `0015_views_evidence.sql` — a client-claimed view count cannot unlock the bonus; only `scraped` or `reviewer` evidence pays. `db/views-evidence.test.mjs` — 17 PASS / 0 FAIL.
- `api/social.mjs` `fetchTelegramViews()` — real view count parsed from `t.me/s/<channel>/<id>`.

### 2.4 Daily check-in and the 500 MB precedent

- **`0013_login_rewards.sql`:** one check-in per Lagos day, 10 points/day, +50 every 7-day streak, +500 every 30-day streak, perfect month +1 000 points **and a free 500 MB data bundle** queued through outbox topic `login.perfect_month`.
- The worker delivers that bundle through the normal data redemption path. This is the existing proof that a 500 MB data reward is operationally possible.

### 2.5 Task lifecycle, proofs, escrow, payouts

- `0001_core.sql` — double-entry ledger, campaigns, tasks, payouts, disputes, RBAC, RLS, audit log.
- `0012` — `task_proofs` (platform, post URL, views, screenshot, verdict), `claim_task()`, `fund_campaign_escrow()`, `social_links`, `campaign_owners` (business **and individual**), `mining_task_stages` view.
- `0014_redemption_integrity.sql` — redemption cannot overdraw; reversals are signed.
- `0016_money_flows.sql` — payout accounts, cash rate, payment links.
- `api/worker.mjs` — real fulfilment: data delivery via `providers/data.mjs` (twenty5 → vtung failover matrix), cash via Flutterwave, truthful `requested → processing → fulfilled/failed`, points reversed when every provider refuses.
- Tests: `db/ledger.test.mjs` 56/0, `db/redemption-integrity.test.mjs` 13/0, `providers/dataManager.test.mjs` + `payoutCrypto.test.mjs`.

### 2.6 Platform-policy gate (critical constraint)

- **`0018_task_policy_gate.sql`** — only three delivery classes may be sold:
  - `content` (`post`), `distribution` (`repost` / `share`), `review` (verified purchase only).
  - Everything else is `prohibited`: **like, comment, follow, subscribe, view, join_channel**, and paid shares of a specific post.
- Enforced by a Postgres trigger (`guard_task_policy`), by `claim_task()` (refuses prohibited tasks, requires policy acknowledgement), by `api/business.mjs` (`CAMPAIGN_ACTIONS`, `PROHIBITED_ACTIONS`), and in both consoles.
- `db/policy.test.mjs` — 35 PASS / 0 FAIL (local).
- **Live status: NOT APPLIED** — repo 18 migrations, live max 17 (`predeploy-check`, 2026-11-03).

**Why this matters for the new ideas:** paid likes, follows, subscribes, views and comments are banned by Meta, TikTok, YouTube, X and FTC 16 CFR Part 465. Re-adding them is not a feature request; it is a channel-deletion and legal risk. The enhancement must deliver the same business outcome through content creation/distribution, verified reviews, link visits and quiz-based contest entries — not through purchased engagement metrics.

### 2.7 Competitions, raffle schema, ambassadors

- **`0009_competitions_ambassadors.sql`:**
  - `competitions` (`kind in ('sprint','raffle')`), `competition_entries`, `ambassador_profiles` (junior/senior/executive; stipends ₦25 000 / ₦60 000 / ₦150 000; commissions 5/8/10%).
  - Raffle settings: 1 ticket per 100 points, max 50 tickets, draw date 28th.
  - `promoter_raffle_tickets(profile)` — own ticket count only.
- **`docs/LOTTERY.md` is explicit: "DRAFT / NOT SHIPPED."** No `draws` / `draw_seeds` tables, no draw worker, no reveal page, no prize fulfilment. The schema groundwork is real; the raffle itself is not.

### 2.8 Consoles and campaign surfaces

- `apps/web/index.html` (landing), `dashboard.html` (promoter: stats, tasks, proof, redeem, referrals, payout account, check-in), `business.html` (owner verification, campaign creation, payment link, payments), `admin.html`, `approval-queue.html`, `blog.html`, `about.html`, `contact.html`, legal pages.
- `api/routes.mjs` — 47 exact + 13 dynamic routes (last audit); no route mismatch found.

### 2.9 Deployment

- Hostinger `promota.click` live; `GET /healthz` 200 today with `config:true`, `auth:true`, every provider true.
- `scripts/deploy-hostinger.mjs` + `docs/DEPLOY-HOSTINGER.md`; Git deployment from `main`.
- `verifyLive.mjs` 19/0 on 2026-10-24; Railway remains a fallback target.

---

## 3. What is PARTIAL (schema or copy exists; the mechanic does not)

| # | Item | What exists | What is missing |
|---|---|---|---|
| P-1 | Raffle draw | `competitions` kind `raffle`, entries, tickets, draw-date setting | `draws`/`draw_seeds` tables, draw worker, commit-reveal, reveal page, prize claims, physical-item fulfilment, admin console |
| P-2 | Ambassador programme | `ambassador_profiles`, stipend/commission settings | Qualification worker, monthly activation, stipend payout schedule, UI |
| P-3 | Views mechanics | Task-level view brackets; Telegram parser; evidence rules | Share-to-status floor at 0 views, reshare bonus, downline-view data reward, status-specific brackets |
| P-4 | Telegram | Bot token probe, `t.me` view parsing, `social_links.telegram` | Bot webhook, `/start` account linking, task unfolding, proof submission in chat, notifications |
| P-5 | WhatsApp | `social_links.whatsapp`, env keys (`WHATSMITH_API_KEY`/`WA_API_KEY`) | Cloud API webhook, templates, interactive task flow, account linking, notifications |
| P-6 | Creator content | `social_accounts`/`social_links`, task `post`/`repost`/`share`, views evidence | Challenge submissions, voting/jury, top-3 publication, revenue-share ledger, rights/disclosure flow |
| P-7 | 100-referral payout | Referral points, ambassador stipends | Active-referral definition, milestone table, ₦50 000 payout path, KYC gate, legal copy |
| P-8 | Data ladder | 500 MB perfect-month reward; general data redemption; provider failover | Named 500 MB → 1 GB → 5 GB/5 h → 10 GB → 20 GB → cash ladder; 5-hour bundle support; tier settings |
| P-9 | SEO positioning | Landing, blog, legal pages, `noindex` gate | Campaigner/politician/ministry/government pages, programmatic city/industry pages, schema markup, content plan |
| P-10 | Live policy gate | 0018 in repo, local tests 35/0 | 0018 applied to live Supabase; Hostinger redeploy after parity |

---

## 4. What is NOT BUILT (the enhancement scope)

1. **Raffle execution engine** — commit-reveal draws, worker, reveal/verify page, prize catalogue, prize claims (cash, data, TV, PS4, JBL), delivery tracking, admin console, legal copy.
2. **100-active-referral ₦50 000 milestone** — compliant design (performance/ambassador bonus, not per-recruit cash), active-referral window, milestone award function, payout + KYC.
3. **Telegram + WhatsApp bot layer** — account linking, task detail unfolding, proof submission, points/rewards reads, notifications, idempotent chat events; one shared state in Postgres.
4. **Creator Challenge programme** — categories (comedy, singing, sports analysis, AI, live journalism, ad visuals), submission + moderation, community vote + jury score, top-3 publication on Promota channels, 60/40 revenue share, creator statements/payouts, rights and disclosure.
5. **Compliant task taxonomy extension** — link-visit/traffic tasks, quiz-based contest entries (proof of attention without paying for views), original content tasks, verified-purchase reviews; prohibited actions remain prohibited.
6. **Share-on-status mechanics** — minimum points at zero views, view-scaled points, reshare bonus, downline view/reshare data rewards (500 MB+).
7. **Data reward ladder** — named tiers and provider mapping, including a 5-hour bundle if the aggregator supports it.
8. **SEO and positioning** — pages and copy for businesses, creators, politicians, ministries, government, agencies; programmatic city/industry pages; schema; content calendar.
9. **Live parity and release** — apply 0018+ to live DB, redeploy Hostinger, verify every new surface end to end.

---

## 5. Findings that change the plan

### F-1 (BLOCKER) — the new task list collides with the policy gate

The owner asked for "click, like and follow, click subscribe, watch, answer a simple question, comment" tasks. Migration `0018` refuses every one of those as paid engagement, and the refusal is correct: Meta, TikTok, YouTube and X ban bought engagement; FTC 16 CFR Part 465 bans selling fake indicators. **Do not reinstate them.** The plan replaces them with:

| Requested | Compliant replacement | Why it works |
|---|---|---|
| Click a link | `visit` task with a unique attribution code + landing confirmation | Traffic is not a fake indicator; disclosure and real interest required |
| Like / follow / subscribe | Creator publishes **brand-supplied content** on their own channel (`post`/`repost`/`share`) with the platform's branded-content toggle | The creator is paid for the work, not for the metric |
| Watch a video | `quiz` contest entry: answer a question about the content; the entry is into a prize draw, not a payment for a view | Attention is proven; no fake view is purchased |
| Comment | Verified-purchase **review** (honest, not sentiment-conditioned) | A review is protected speech/product feedback, not a bought metric |
| "Are you funny?" / creative challenge | **Creator Challenge**: original content, judged on quality and verified votes, published on Promota channels, revenue share | Standard creator programme, not engagement farming |

This is the single most important decision in the plan. It must be stated on the site and in the creator terms.

### F-2 (BLOCKER) — live database is one migration behind

`predeploy-check` fails today: repo 18, live 17. `0018` is not enforced live. Applying it needs the live Postgres password (last attempt `28P01`). Until then, no new migration can be considered live, and the live API may accept prohibited tasks. Owner action.

### F-3 — the raffle is a paper design

`docs/LOTTERY.md` says it plainly. The enhancement is not "tweak the raffle"; it is "build the draw engine that the schema was prepared for." That is a bounded, well-specified build (the algorithm is written down).

### F-4 — the creator challenge is new, but it reuses existing primitives

`competitions`/`competition_entries`, `social_accounts`, `task_proofs`, views evidence, the ledger and the payout worker already exist. The challenge is additive: submissions, votes, jury scores, publication records, revenue-share entries. No rewrite of the economy.

### F-5 — 100 referrals for ₦50 000 is legally sensitive

The existing design deliberately keeps referrals points-only to stay outside MLM/pyramid rules. A cash payout tied to recruiting 100 people — even active ones — reads as a recruitment bounty. The compliant shape is an **Ambassador/performance milestone**: the 100 must be *active task-completers* in a defined window, the payout is a one-off performance bonus from platform revenue (not from recruit fees), and the copy never promises income for recruiting. Owner must sign this framing.

### F-6 — "5 GB / 5 hours" depends on the aggregator

`providers/dataManager.mjs` serves whatever the provider catalogue offers. A 5-hour time-boxed bundle must be confirmed with twenty5/vtung; if unavailable, ship 5 GB standard and mark the 5-hour variant as provider-dependent (never fake it).

---

## 6. Verdict

| Surface | Verdict | Basis |
|---|---|---|
| Points ledger, levels, redemption | **GO** | 59/0 tests; live healthz |
| Referrals + downline points bonus | **GO** | schema + functions + API + UI |
| Daily check-in + 500 MB reward | **GO** | 0013 + worker |
| Views bonus + evidence | **GO** | 17/0 tests |
| Campaign/task/escrow/payouts | **GO** | ledger 56/0, redemption 13/0, live healthz |
| Policy gate | **GO in code / NO-GO live** | 35/0 local; 0018 not applied live |
| Raffle | **NO-GO** | schema only; no draw engine |
| 100-referral ₦50k | **NO-GO** | not built |
| Telegram/WhatsApp task surface | **NO-GO** | no bot layer |
| Creator challenges | **NO-GO** | not built |
| SEO positioning pages | **PARTIAL** | landing/blog only; `noindex` on |
| Deployment | **GO with one blocker** | healthz 200; migration parity fails |

**Overall:** the backend is real and substantial. The enhancement is a set of additive modules on proven primitives — not a new build. The two hard blockers are the live migration password and the policy-compliant redesign of the requested task types.
