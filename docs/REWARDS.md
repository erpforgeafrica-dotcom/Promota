# Rewards & Points Economy — Promota

Everything a promoter can earn, exactly where each award is computed, and the owner-tunable settings behind it. This document describes **code and migrations that exist in this repository** — each award names its source file/migration.

## Where points are recorded

All earnings land in `public.point_entries` (migration `0008_points_levels.sql`), with an idempotency key per award so retries can never double-pay. Only server-side SQL functions and trusted service-role workers insert rows — clients cannot write points directly (table grants revoked from `anon`/`authenticated`).

## Point entry kinds

| Kind enum | Awarded for | Default value | Computed in |
|-----------|-------------|---------------|-------------|
| `task_points` | A claimed task whose proof is approved | per-campaign (`topics.value_points`), never less than 100 | `award_task_points_networked` — migration `0012` |
| `referral_reward` | Your referee completes their first real task | 300 points | `award_task_points_networked` / `qualify_referral` — migrations `0008`, `0012` |
| `views_bonus` | Views on posted task content cross a bracket | 50 / 100 / 200 / 400 | `award_views_bonus` — migration `0012` |
| `login_daily` | Daily check-in on the dashboard | 10 points + streak bonuses | `checkin` — migration `0013` |

## Task points

A referral-network bonus also fires: every approved task by a promoter who was referred pays a bonus to their referrer, capped at 300 points per task (`points.referred_task_bonus_bp`, default 25% of the task value, cap 300). An anti-MLM rule stays structural: **referrals award points, never cash**, and a referral only counts once the referee completes a real task.

## Views bonus (brackets)

Migration `0012` seeds `views.bonus_brackets`:

| Views (once, cumulative) | Bonus |
|--------------------------|-------|
| ≥ 500 | 50 pts |
| ≥ 2 000 | 100 pts |
| ≥ 10 000 | 200 pts |
| ≥ 50 000 | 400 pts |

One award per bracket per task (`views.min_points` is the bracket floor); view counts come from the platform probe (e.g. a Telegram post view snapshot), not from user claims.

## Daily check-in (migration `0013`, dashboard card in `apps/web`)

- **One check-in per Lagos day** (`login_days` keyed on `(profile_id, day)`; duplicates are refused).
- **10 points per day** (`login.points_per_day`).
- **Streak milestones:** every 7th consecutive day +50 points (`login.streak_7_bonus`); every 30th consecutive day +500 points (`login.streak_30_bonus`).
- **Perfect month:** when a promoter checks in on the 1st of a new month *and every day of the previous month was checked in*:
  - +1 000 points (`login.perfect_month_points`), and
  - one free **500 MB data bundle** queues via outbox topic `login.perfect_month` (`login.perfect_month_data_mb`). The fulfilment worker delivers it like a normal data redemption using the promoter's saved network/number, and it may take up to 24 hours — never immediate.
- Miss a day and the streak resets to 1. The dashboard shows the month as a dot grid: filled = checked in, hollow = missed, faint = still ahead.

## Rated repost payout scaling (admin-verified campaigns)

Repost campaigns are **admin-verified**: an admin rating (1–5) is now recorded with each approval (`tasks.rating`, migration `0013`; prompt in `apps/web/admin.js`).

- Rating ≥ 4 (`repost.min_rating_full`) → full task points.
- Rating below 4 → points scaled by 50% (`repost.low_rating_factor`), rounded up with a **floor of 1 point** — a rating can *never* pay more than the campaign's base value and a promoter can never be paid zero for approved work.
- Ratings apply on repost campaigns only (`api/admin.mjs`, `approveTask`).

## Spending: redemptions

| Kind | Minimum | Unlock |
|------|---------|--------|
| Data bundle (MTN/GLO/Airtel/9mobile, NGN-denominated bundles) | 500 points | no level gate |
| Cash payout to bank | 10 000 points | level 4+ and KYC tier 2 |

Referral-count gates live in the `levels` table (from `0008`, tuned in `0012`: level 4 = 3 000 points + 2 referrals, cash unlocked).

## Owner-tunable settings

All values above are `settings` rows (see `docs/settings.schema.md`) editable from the admin console without a code change or migration.
