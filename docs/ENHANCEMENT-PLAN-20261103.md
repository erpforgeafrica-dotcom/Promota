# PROMOTA — ENHANCEMENT PLAN

**Date:** 2026-11-03
**Status:** PROPOSED — owner approval required before code changes
**Companion audit:** `audit/PROMOTA-ENHANCEMENT-AUDIT-20261103.md`
**Repo:** `C:\Users\pc\owoworks` · branch `main` · remote `erpforgeafrica-dotcom/Promota`
**Baseline:** HEAD `017a37c`, site 187/0, deploy gate NO-GO (repo 18 / live 17), live healthz 200.

---

## 1. What this plan delivers

A surgical enhancement of the existing Promota backend — **not a rebuild** — that turns the current points economy into the full reward engine the owner described:

1. A real **raffle draw** with commit-reveal fairness, prizes (cash, data, TV, PS4, JBL), claims and fulfilment.
2. A compliant **100-active-referral ₦50,000 performance milestone**, plus downline view/reshare data rewards.
3. **Telegram and WhatsApp bots** where tasks unfold, proofs are submitted, and points/rewards stay identical to the app.
4. A **Creator Challenge programme** (comedy, singing, sports analysis, AI, live journalism, ad visuals) with voting, top-3 publication on Promota channels, and a 60/40 creator/platform revenue share.
5. A **compliant task taxonomy** — link visits, quiz contest entries, original content, verified reviews — replacing the prohibited paid like/follow/subscribe/watch/comment actions.
6. The **data ladder** 500 MB → 1 GB → 5 GB/5 h → 10 GB → 20 GB → cash.
7. **SEO and positioning** for businesses, creators, politicians, ministries, government and agencies.
8. **Live parity and release** — apply migrations, redeploy Hostinger, verify every surface.

Everything is additive: new numbered migrations, new routes, new worker topics, new pages. Existing tables, functions and tests are not rewritten.

> **Migration numbering update (2026-11-03).** The **Promote You mutual-promotion
> engine** landed first and took `0019`–`0020`
> (`0019_promotion_point_kinds.sql`, `0020_mutual_promotion.sql`; see
> `docs/PROMOTION-MUTUAL.md`). Every phase below therefore shifts by two:
> raffle `0021`, referral milestones `0022`, chat links `0023`, challenges
> `0024`, task taxonomy `0025`, data ladder `0026`. The file names in each
> heading already reflect the shift.

---

## 2. Non-negotiable rules (from `AGENTS.md`)

- Points are minted only by Postgres functions; never in JavaScript.
- Every money/points action is idempotent and auditable; corrections are reversals, never edits.
- Business rules live in SQL; the API stays thin.
- Never edit an applied migration — add the next number.
- No invented data; no silent failures; no success claim without a command and its output.
- New behaviour ships with a test; `npm test` stays green.
- RLS is the security boundary; the service-role key is for writes the browser must not perform.
- No destructive git commands.

---

## 3. Locked assumptions (owner to confirm before Phase 1)

| # | Assumption | Default | Owner action |
|---|---|---|---|
| A-1 | Revenue split on monetized challenge content | **Creator 60% / Promota 40%** ("for just 40% of your win" = platform keeps 40%) | Confirm |
| A-2 | 100 active referrals | One-off **₦50,000 performance milestone**; "active" = qualified referee with ≥1 approved task in the last **90 days**; KYC tier 2; paid as Ambassador performance bonus, not per-recruit cash | Confirm + legal sign-off |
| A-3 | Data ladder | 500 MB (entry), 1 GB, 5 GB (5-hour if provider supports), 10 GB, 20 GB, cash; points prices in settings | Confirm prices |
| A-4 | Prohibited actions | Paid like/comment/follow/subscribe/view/join_channel **stay prohibited**; replacements: visit, quiz contest, content, verified review | Confirm |
| A-5 | Challenge categories | Comedy, singing/audio, sports analysis, AI, live journalism, ad visuals | Confirm |
| A-6 | Raffle entry | Earned by task work only; **no cash purchase of tickets** | Confirm |
| A-7 | Challenge entry | Free; original content; 18+; rights + disclosure accepted | Confirm |

If the owner disagrees with any default, it changes a setting or a rule, not the architecture.

---

## 4. Architecture delta (what is added to what exists)

```
Existing                          Added by this plan
────────                          ───────────────────
point_entries / levels            (unchanged) + milestone & challenge point kinds via new entries
referrals / downline bonus        referral_milestones, milestone_awards, downline_activity view
competitions / entries            draws, draw_seeds, prize_claims, rank/reveal functions
data redemption + worker          data_ladder tiers, downline.data_reward, share floor/brackets
task_proofs / views evidence      visit tasks, quiz entries, reshare bonus, status brackets
social_links                      chat_links, chat_link_codes, chat_events, notifications
(no challenge)                    challenges, challenge_entries, votes, publications, revenue entries
(no bots)                         Telegram webhook, WhatsApp Cloud webhook, command router
(landing/blog)                    positioning pages, programmatic city/industry pages, schema
```

New outbox topics: `raffle.draw_due`, `raffle.drawn`, `prize.claimable`, `referral.milestone`, `downline.data_reward`, `challenge.published`, `challenge.revenue`, `chat.notify`.

---

## 5. Phase 0 — Baseline and unblock (0.5 day)

**Why first:** no new migration is real until the live database is at parity.

Tasks:
1. Owner supplies or resets the live Postgres password; run `npm run db:remote` → applies `0018`–`0020` (and then `0021+` as they land).
2. `node scripts/predeploy-check.js` → **GO** (18/18).
3. Redeploy Hostinger from `main` via `scripts/deploy-hostinger.mjs`; `node scripts/verifyLive.mjs https://promota.click` → 19/0.
4. `npm test` + `npm run site` green at baseline.

Acceptance: parity GO; live verify 19/0; tests green.
Blocker: live DB credential (owner).

---

## 6. Phase 1 — Raffle engine (`0021_raffle_draws.sql`) — 3 days

### 6.1 Schema
- `draws` — `competition_id`, `status` (`open → committed → drawn → revealed`), `server_seed_hash`, `server_seed` (sealed until reveal), `client_seed`, `entrant_count`, `entrant_hash`, `committed_by`, `committed_at`, `drawn_at`, `revealed_at`, `result_hash`.
- `draw_seeds` — append-only history of seed material (select-restricted).
- `prize_claims` — `draw_id`, `entry_id`, `prize_index`, `prize_kind` (`cash|data|item`), `prize_name` (TV/PS4/JBL/etc.), `value_minor`, `status` (`claimable → claimed → fulfilling → fulfilled|rejected`), delivery fields, KYC gate, idempotency key.
- `settings` — `raffle.prize_catalogue` (JSON: cash, data, TV, PS4, JBL speaker, etc.), `raffle.claim_window_days`, `raffle.kyc_threshold_minor`.

### 6.2 Functions
- `open_draw(competition)` — snapshot eligible entries, compute `entrant_hash`, generate `server_seed`, store hash; publish hash.
- `commit_draw(draw, client_seed)` — anchor the public seed (NIST beacon pulse or public block hash); refuse if unavailable.
- `draw_winners(draw)` — `HMAC-SHA256(server_seed, client_seed || ':' || prize_index)`, Fisher–Yates without replacement; write ranks; emit `raffle.drawn`.
- `reveal_draw(draw)` — publish seeds, entrant list hash, winners, result hash.
- `claim_prize(entry)` — one claim per prize; KYC gate above threshold; emits `prize.claimable`.
- `fulfil_prize(claim, payload)` — cash → payout row; data → redemption + worker; item → delivery record + tracking.

### 6.3 Worker and API
- Worker topic `raffle.draw_due` → fetch anchor → draw → notify.
- `GET /api/lottery`, `GET /api/lottery/:id`, `GET /api/lottery/:id/verify`, `POST /api/lottery/:id/claim`.
- Admin: create raffle, commit, draw, reveal, claims queue, fulfil.

### 6.4 Pages
- `/lottery` — current draw, prize showcase, ticket count, draw date, "how the draw is proven fair".
- `/lottery/:id` — entrant hash, seeds, winners, in-browser recompute widget.
- Dashboard raffle card + claim flow.
- Admin console raffle panel.

### 6.5 Tests and acceptance
- `db/raffle.test.mjs`: fixed seeds → deterministic winners; no replacement; ticket cap; prohibited entries excluded; double claim refused; cash prize creates one payout; data prize queues one redemption; item prize cannot be marked fulfilled without a delivery reference.
- Acceptance: a seeded draw reproduces the published winners on the verify page; no double pay.

---

## 7. Phase 2 — Referral milestone, downline data, share mechanics (`0022_referral_milestones.sql`) — 2 days

### 7.1 Schema and functions
- `referral_milestones` — `threshold` (100), `reward_kind` (`cash`), `reward_minor` (5 000 000 kobo), `active_window_days` (90), `kyc_tier_required` (2), `is_active`.
- `referral_milestone_awards` — `profile_id`, `milestone_id`, `awarded_at`, `payout_id`, unique `(profile_id, milestone_id)`.
- `active_referral_count(profile)` — qualified referrals with ≥1 approved task in the window.
- `award_referral_milestones(profile)` — idempotent; emits `referral.milestone`; creates a payout only when KYC passes; otherwise parks with a reason.
- `downline_activity` view — referee id, referrer id, task proofs, views, reshares.
- `award_downline_data(profile)` — 500 MB at first bracket, then tiered (`downline.views_data_brackets`); emits `downline.data_reward`; worker delivers.
- Settings: `share.min_points` (floor at 0 views), `share.views_brackets`, `share.reshare_bonus_points`.

### 7.2 API and UI
- `GET /api/v1/promoter/milestones` — progress `X/100`, active count, reward state.
- `GET /api/v1/promoter/downline` — per-referee activity and data rewards.
- Dashboard: milestone progress bar, downline table, data reward history.

### 7.3 Tests and acceptance
- `db/referrals.test.mjs` extended: inactive referee excluded; 99 does not trigger; 100 triggers once; no payout without KYC; downline data once per bracket; reshare bonus once.
- Acceptance: exactly one ₦50,000 payout record at 100 active; zero at 99.

### 7.4 Legal copy
- "Performance bonus for active promoters" — never "recruit 100 people for cash".
- 100 must be active task-completers; no join fee; no payment for recruiting.

---

## 8. Phase 3 — Telegram + WhatsApp (`0023_chat_links.sql`) — 4 days

### 8.1 Schema
- `chat_links` — `profile_id`, `platform` (`telegram|whatsapp`), `chat_id`, `phone_e164`, `verified_at`, `state`; unique `(platform, chat_id)`.
- `chat_link_codes` — `profile_id`, `code_hash`, `expires_at` (5 min), `used_at`.
- `chat_events` — `platform`, `update_id`/`message_id`, `profile_id`, `command`, `payload`, unique idempotency key, `processed_at`.
- `notifications` — `profile_id`, `channel`, `template`, `payload`, `state` (`queued|sent|failed`), `provider_ref`.

### 8.2 Telegram
- `POST /api/webhooks/telegram` with secret-token header check.
- Commands: `/start CODE`, `/tasks`, `/task ID`, `/points`, `/rewards`, `/redeem`, `/help`.
- Inline buttons: claim, submit proof, confirm.
- Proof: photo/document + URL; same `task_proofs` row as the app.
- Callback queries handled idempotently.

### 8.3 WhatsApp Cloud API
- `GET /api/webhooks/whatsapp` verification (`hub.verify_token`).
- `POST` with `X-Hub-Signature-256` HMAC validation.
- Interactive list/buttons; template messages for notifications; 24-hour session rules.
- Same command set and link flow.

### 8.4 Account linking
- App generates a 6-digit code (hashed, 5-minute TTL); user sends `/start CODE`; bot links chat to profile.
- All reads/writes go through the same API/Postgres — one balance, one task state.

### 8.5 Tests and acceptance
- `api/bot.test.mjs`: bad signature rejected; expired code rejected; duplicate update idempotent; chat balance equals app balance; cross-profile access impossible; notification queued once.
- Acceptance: link Telegram → see same task/points as app → submit proof → approval notification; replay does not double-award. WhatsApp same on a test number.

---

## 9. Phase 4 — Creator Challenges (`0024_challenges.sql`) — 5 days

### 9.1 Schema
- `challenges` — `slug`, `title`, `category` (`comedy|singing|sports|ai|journalism|ad_visuals`), `brief`, `rules`, `start_at`, `end_at`, `status` (`draft|open|judging|published|closed`), `prize_pool` jsonb, `creator_share_bp` (6000), `platform_share_bp` (4000), `rights_version`.
- `challenge_entries` — `challenge_id`, `profile_id`, `title`, `content_url`, `platform`, `thumbnail_url`, `rights_accepted_at`, `disclosure_tag`, `moderation_state`, `jury_score`, `vote_count`, `rank`.
- `challenge_votes` — one per profile per entry; verified profiles only; rate-limited.
- `challenge_publications` — `entry_id`, `channel`, `published_url`, `published_at`, `views_snapshots`, `monetized_revenue_minor`, `source_ref`.
- `challenge_revenue_entries` — `publication_id`, `creator_share_minor`, `platform_share_minor`, `payout_id`, idempotency.

### 9.2 Flow
1. Creator submits original content (link + title + category + rights/disclosure).
2. Admin moderation: originality, rights, no prohibited content, disclosure present.
3. Public gallery + verified votes.
4. Jury score (1–5) combined with votes (weights in settings: jury 60 / votes 40).
5. Top 3 ranked; published on Promota YouTube and social handles with creator credit + `#ad`.
6. View snapshots recorded (platform API where available; manual with evidence otherwise).
7. Monetized revenue recorded; 60/40 split; creator payout via Flutterwave with statement.
8. "Blow you up" package: channel feature, shorts cut, community post, pinned post, cross-platform — no paid engagement.

### 9.3 API and pages
- `GET /api/challenges`, `GET /api/challenges/:slug`, `POST /api/challenges/:slug/entries`, `POST /api/challenges/entries/:id/vote`, admin moderate/rank/publish/revenue.
- Pages: `/challenges`, `/challenges/:slug`, entry page, leaderboard, creator dashboard panel, admin moderation console.

### 9.4 Tests and acceptance
- `db/challenges.test.mjs`: one vote per profile; rank deterministic; 60/40 math exact to the kobo; revenue idempotent; rejected entry cannot win; payout requires KYC.
- Acceptance: test challenge submit → moderate → 3 votes → rank → publish → ₦10,000 revenue → creator receives ₦6,000 exactly once.

### 9.5 Legal
- Content licence, originality warranty, disclosure, 18+, platform ToS, no purchase necessary, prize-tax responsibility.

---

## 10. Phase 5 — Compliant task taxonomy (`0025_task_taxonomy.sql`) — 2 days

### 10.1 What changes
- Bump `current_task_policy_version()` to `2026-11-03`.
- Extend `task_policy_class()`:
  - `visit` → `traffic`
  - `quiz` → `contest`
  - `create` → `content`
  - `post`/`repost`/`share`/`review` unchanged.
- `PROHIBITED_ACTIONS` unchanged: like, comment, follow, subscribe, view, join_channel.
- New columns: `visit_url`, `visit_attribution_code`, `quiz_question`, `quiz_answer_hash`, `quiz_entry_points`.
- Guards: visit needs URL + disclosure; quiz needs question + hashed answer; create must reference a challenge.
- API: `POST /api/tasks/:id/visit` (server-side landing confirmation + dwell), `POST /api/tasks/:id/quiz` (one entry, answer never returned).
- UI: task cards label the compliant class and show the policy note.

### 10.2 Acceptance
- Policy tests green; a like task refused in DB, API and console; quiz awards once; visit records attribution and cannot be replayed.
- Site copy: "Promota does not sell likes, follows, views, comments, subscribes or channel joins."

---

## 11. Phase 6 — Data ladder and share economy (`0026_data_ladder.sql`) — 1.5 days

- `data_ladder`: 500 MB, 1 GB, 5 GB (5-hour where the provider offers it), 10 GB, 20 GB, cash; points cost, provider plan code per network, active flag.
- `share.min_points` floor at 0 views; `share.views_brackets`; `share.reshare_bonus_points`.
- Redemption maps points → tier → provider plan; if the 5-hour plan is unavailable, return an explicit `provider_unavailable` — never silently substitute.
- Dashboard ladder visual: what the user can redeem now and what the next tier costs.
- Tests: tier math, plan mapping, honest unavailable state.
- Owner decision: exact points prices.

---

## 12. Phase 7 — SEO and positioning — 2–3 days (parallel with Phases 1–6)

### 12.1 Positioning
"Promota is campaign infrastructure for anyone with something to promote — businesses, creators, politicians, ministries, government agencies."

### 12.2 Pages
- `/for-businesses`, `/for-creators`, `/for-politicians`, `/for-ministries`, `/for-government`, `/for-agencies`, `/pricing`, `/how-it-works`.
- Programmatic: cities (Lagos, Abuja, Kano, Port Harcourt, Ibadan, Benin, Enugu, Kaduna) × use cases (influencer marketing, political outreach, government sensitisation, product launch, event promotion); industry pages (fashion, food, fintech, real estate, entertainment, NGO).

### 12.3 Schema and content
- Schema: Organization, Service, FAQPage, BreadcrumbList, Event (challenges), Offer (campaign packages).
- 12–20 articles: campaign playbooks, compliance, measurement, creator economy, political digital outreach, ministry sensitisation, data rewards.
- Sitemap, robots, meta/OG, internal links.
- `noindex` removed only when the SEO-D1 trigger is met (owner decision).

### 12.4 Skills to load
`ai-seo`, `seo-audit`, `programmatic-seo`, `content-strategy`, `copywriting`, `schema`, `social`, `ad-creative`, `marketing-psychology`, `offers`, `pricing`, `launch`.

---

## 13. Phase 8 — Verification and release — 1.5 days

1. `npm test` — all suites including new (`raffle`, `referrals`, `bot`, `challenges`, `data ladder`).
2. `npm run site` — 187+ checks, 0 failures.
3. `node scripts/predeploy-check.js` — GO (repo = live).
4. `npm run db:remote` — apply `0021`–`0026` in order.
5. Hostinger redeploy from `main`; `verifyLive` 19/0.
6. Live smoke: raffle draw in staging, bot link + task proof, challenge submit + revenue split, downline reward.
7. Update `STATUS.md`, `DEPLOYED_STATE.md`, `README.md`, `docs/REWARDS.md`, `docs/LOTTERY.md` (flip to SHIPPED with the verification trail), audit, session compact, memory note.
8. Feature flags per module for rollback; forward-only migrations; no destructive commands.
9. Final report: resolved / owner-blocked / deferred, with evidence.

---

## 14. Files and routes that will change

| Area | Files |
|---|---|
| Migrations | `db/migrations/0021_raffle_draws.sql` … `0026_data_ladder.sql` |
| API | `api/routes.mjs` (new routes), `api/raffle.mjs`, `api/challenges.mjs`, `api/bots/telegram.mjs`, `api/bots/whatsapp.mjs`, `api/promoter.mjs` (milestones/downline), `api/business.mjs` (taxonomy) |
| Worker | `api/worker.mjs` (new topics: draw, prize, milestone, downline data, challenge revenue) |
| Providers | `providers/dataManager.mjs` (ladder mapping), `providers/flutterwave.mjs` (creator/milestone payouts) |
| Web | `apps/web/lottery.html`, `challenges.html`, `challenge.html`, `for-*.html`, `pricing.html`, `dashboard.js`, `admin.html`, `admin.js` |
| Tests | `db/raffle.test.mjs`, `db/referrals.test.mjs` (extend), `db/challenges.test.mjs`, `api/bot.test.mjs`, `db/data-ladder.test.mjs` |
| Docs | `STATUS.md`, `DEPLOYED_STATE.md`, `README.md`, `docs/REWARDS.md`, `docs/LOTTERY.md`, `docs/CREATOR-CHALLENGES.md`, `docs/CHAT-BOTS.md` |

### Route additions (summary)
- Lottery: `GET /api/lottery`, `GET /api/lottery/:id`, `GET /api/lottery/:id/verify`, `POST /api/lottery/:id/claim`.
- Milestones/downline: `GET /api/v1/promoter/milestones`, `GET /api/v1/promoter/downline`.
- Bots: `POST /api/webhooks/telegram`, `GET|POST /api/webhooks/whatsapp`, `POST /api/v1/chat/link-code`, `DELETE /api/v1/chat/link`.
- Challenges: `GET /api/challenges`, `GET /api/challenges/:slug`, `POST /api/challenges/:slug/entries`, `POST /api/challenges/entries/:id/vote`.
- Taxonomy: `POST /api/tasks/:id/visit`, `POST /api/tasks/:id/quiz`.
- Admin: draw commit/draw/reveal/fulfil; challenge moderate/rank/publish/revenue.

---

## 15. Owner decisions required (blocking)

1. Confirm **60/40** split and the exact meaning of "40% of your win".
2. Confirm the **₦50,000 / 100 active referrals** shape, the 90-day active window, and the legal copy.
3. Confirm the **challenge prize pool** and the monetization source (AdSense only, sponsors, or both).
4. Confirm **data ladder** points/prices and whether the 5-hour bundle is available from the aggregator.
5. Confirm that paid **like/follow/subscribe/watch/comment** are **not** reinstated; approve the compliant replacements.
6. Provide or reset the **live Postgres password** so `0018`–`0026` can be applied.
7. Decide when `noindex` comes off for SEO.

---

## 16. Sequence and effort

| Phase | Deliverable | Effort |
|---|---|---|
| 0 | Live parity + baseline | 0.5 day |
| 1 | Raffle engine | 3 days |
| 2 | Referral milestone + downline data + share | 2 days |
| 3 | Telegram + WhatsApp bots | 4 days |
| 4 | Creator Challenges | 5 days |
| 5 | Compliant taxonomy | 2 days |
| 6 | Data ladder | 1.5 days |
| 7 | SEO + positioning | 3 days (parallel) |
| 8 | Verification + release | 1.5 days |

**Total:** ~22 working days sequential; ~18 with SEO running in parallel.

---

## 17. Definition of done

- Every migration applied live; `predeploy-check` GO.
- Every new route has a test; `npm test` green.
- Every new page verified on the live domain, not just HTTP 200.
- No false success: a prize, payout or reward is "done" only on provider confirmation.
- `STATUS.md`, `DEPLOYED_STATE.md`, `README.md` and the audit tell the truth about what is live.
- Owner signs off on the assumptions in §3.
