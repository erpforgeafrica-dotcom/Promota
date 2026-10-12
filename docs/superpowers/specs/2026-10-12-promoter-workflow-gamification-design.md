# Promota Promoter Task Workflow & Gamification Design Spec

**Document Version:** 1.0  
**Date:** 2026-10-12  
**Status:** DRAFT (APPROVED CONCEPT)  
**Target Repo:** `C:\Users\pc\owoworks`  

---

## 1. Executive Summary

Promota is a two-sided promotion platform connecting sponsors (brands, content creators, platform owners) with promoters (verified individuals with spare time and social accounts). Promoters complete verified social actions (follow, subscribe, watch, engage, refer) to earn points redeemable for mobile data and cash.

This spec details the **Promoter Task Workflow, Hybrid Verification, Gamification, Points Economy, and Ambassador Ladder**, designed for legal compliance in Nigeria (anti-pyramid, anti-lottery regulation compliance), high operational efficiency, and anti-fraud resilience.

---

## 2. Platform Roles & Core Principles

### 2.1 Roles
1. **Sponsors (including Platform Owners):** Fund campaigns, submit content links (YouTube, Instagram, X/Twitter, LinkedIn, TikTok), set action requirements and point values within platform bounds.
2. **Promoters:** Verified individuals using their own logged-in social accounts to perform task actions.
3. **Ambassadors:** Top-performing promoters who qualify based on active completions, qualified downline referrals, and active referee completion rates. Paid a monthly stipend/salary plus bonus commissions.
4. **Admins / Moderation Workers:** Audit manual proof submissions, handle disputes, manage system settings.

### 2.2 Core Principles & Compliance Laws
- **No Join Fees / Zero Pay-to-Play:** Joining Promota is 100% free. No paid upgrades or mandatory purchases.
- **Anti-MLM / Anti-Pyramid Law:** Referrals yield **points only**, never direct cash payouts. Referrals only qualify after the referee completes at least 1 real approved task.
- **Checked Results Only:** Points are awarded ONLY after verified completion. Unverified clicks or fake proofs carry penalties and account suspensions.
- **Anti-Lottery Compliance:** Raffles and competitions are performance-gated or point-entered (where points were earned via real task work). No cash can be spent to buy competition entries.

---

## 3. Social Media Task Taxonomy & Hybrid Verification Engine

### 3.1 Social Platform & Task Matrix

| Platform | Action Types | Default Points Range | Primary Verification | Fallback Verification |
|---|---|---|---|---|
| **YouTube** | Subscribe, Like, Watch (≥3 min), Comment | 20–100 pts | OAuth Read Scope / Webhook | Screenshot + Video timestamp proof |
| **Instagram** | Follow, Like, Story Share, Comment | 15–80 pts | Basic Display API / OAuth | Screenshot of profile/post |
| **X (Twitter)** | Follow, Retweet, Like, Reply | 10–50 pts | X API v2 (Read follow/tweet status) | Screenshot proof |
| **LinkedIn** | Follow Page, Like Post, Comment, Share | 25–100 pts | OAuth / API Inspection | Screenshot proof |
| **TikTok** | Follow, Like, Comment, Video Watch | 15–70 pts | API where available | Screenshot / Profile handle link |

### 3.2 Hybrid Verification Flow

```
[ Promoters sees task feed ]
            │
            ▼
[ Selects task → Gets tracking link (?ref_promoter=xyz) ]
            │
            ▼
[ Is Social Account Connected via OAuth? ]
       │                         │
      YES                        NO
       │                         │
       ▼                         ▼
[ Perform Action ]        [ Perform Action ]
       │                         │
       ▼                         ▼
[ System polls API ]     [ Upload Proof (Screenshot) ]
       │                         │
       ▼                         ▼
[ Verified by API? ]     [ AI Vision Sanity Check + Spot Audit ]
  │            │                 │                 │
 YES           NO               PASS              FAIL
  │            │                 │                 │
  ▼            ▼                 ▼                 ▼
[ Award ] [ Fallback ]      [ Award ]        [ Reject + Warn ]
```

1. **OAuth Connection:** Promoters connect their social accounts (Google/YouTube, X, Instagram, LinkedIn).
2. **Automated Verification (Primary):** For connected platforms, background workers query the social API to confirm the follow, like, or video watch state.
3. **Proof Upload (Fallback):** For un-integrated platforms or API gaps, promoters upload a clear screenshot.
4. **AI-Assisted Proof Sanity:** An automated image check validates username presence, engagement indicators, and timestamps before enqueueing for payout.
5. **Human Spot Audits:** 5–10% of manual proof submissions undergo manual review by moderators. Flagged fake proofs lead to point clawback and strike issuance (3 strikes = permanent ban).

---

## 4. Points, Levels & Ambassador Program

### 4.1 Points Ledger Rules
- Points are append-only, immutable records in `point_entries`.
- Balances are derived dynamically (`sum(points)`).
- Points can be earned from:
  - `task_reward`: Completing verified tasks.
  - `referral_reward`: Referee completes 1st qualified task (awards 5x default task points to referrer).
  - `daily_streak`: Daily login bonus (e.g., 5 pts/day, scaling to 25 pts for a 7-day streak).
  - `competition_prize`: Leaderboard/raffle wins.
  - `adjustment`: Admin correction.
- Points can be spent on:
  - `redemption`: Mobile Data bundle or Cash payout.

### 4.2 Levels Ladder (from `0008_points_levels.sql`)

| Level | Title | Lifetime Points Required | Qualified Referrals Required | Cash Payout Unlocked? | Benefits |
|---|---|---|---|---|---|
| 1 | Starter | 0 pts | 0 | No (Data only) | Entry-level task feed |
| 2 | Worker | 500 pts | 0 | No (Data only) | +5% points multiplier |
| 3 | Regular | 1,500 pts | 0 | No (Data only) | Unlocks Raffles & Contests |
| 4 | Established | 4,000 pts | 3 | Yes | Cash redemptions unlocked |
| 5 | Senior | 9,000 pts | 8 | Yes | +15% points multiplier, priority verification |
| 6 | Ambassador Candidate | 18,000 pts | 15 | Yes | Eligible for Monthly Ambassador Cohort |

### 4.3 Ambassador Monthly Stipend Program
- **Qualification Criteria:**
  1. Hold Level 6 (Ambassador Candidate).
  2. Minimum 30 completed tasks in the calendar month.
  3. Minimum 5 new *active qualified referees* (referees who complete ≥5 tasks in the month).
- **Ambassador Tier Structure:**
  - **Junior Ambassador:** ₦25,000 monthly stipend + 5% bonus on active referee task earnings.
  - **Senior Ambassador:** ₦60,000 monthly stipend + 8% bonus on active referee task earnings.
  - **Executive Ambassador:** ₦150,000 monthly stipend + 10% bonus on active referee task earnings.
- **Payment Schedule:** Monthly payouts disbursed on fixed dates (e.g., 28th of every month) directly to verified bank account via Flutterwave.

---

## 5. Gamification: Competitions & Weekly/Monthly Raffles

### 5.1 Weekly Task Sprints (Leaderboards)
- **Mechanic:** Promoters compete for top completed task counts during a 7-day sprint (Monday 00:00 to Sunday 23:59).
- **Prizes:**
  - 1st Place: 5,000 Points + ₦10,000 cash bonus.
  - 2nd–5th Place: 2,500 Points + ₦5,000 cash bonus.
  - 6th–20th Place: 1,000 Points.

### 5.2 Weekly & Monthly Points Raffles
- **Eligibility:** Reached Level 3 (Regular) or higher.
- **Entry System:** 1 Raffle Ticket per 100 points earned from completed tasks in the period.
- **Cap:** Maximum 50 tickets per promoter per draw to prevent whale dominance.
- **Draw Transparency:** Provably fair random selection logged in `outbox` / ledger.
- **Prizes:** Mobile data bundles (1GB–10GB), Airtime vouchers (₦1,000–₦5,000), and monthly grand cash prizes.

---

## 6. Anti-Fraud & Risk Management Controls

1. **One Account Per Person / Device:**
   - Single Nigerian phone number per account (`UNIQUE(phone)`).
   - Phone normalization (`0803...` -> `+234803...`).
   - Device fingerprinting & IP velocity checks on task claims.
2. **Task Completion Cooldowns:** Minimum elapsed time between task pick-up and completion submission to prevent instant script submissions.
3. **Clawback & Reversals:** If a promoter unfollows, unsubscribes, or deletes engagement within 14 days of task approval, points are reversed using `reverse_point_entry()` and a strike is logged.
4. **Referral Fraud Firewall:** Unqualified sign-ups yield 0 points. Referrals only qualify when referee completes a real, approved task.

---

## 7. Website Copy & Messaging Updates (`apps/web/index.html`)

To align the public landing page with these laws and mechanics:
1. **Hero Section:** "Your spare time is your income. Promote real brands, earn data & cash on your schedule."
2. **How It Works (3 Steps):**
   - Step 1: Connect your social accounts (YouTube, X, Instagram, LinkedIn).
   - Step 2: Complete quick daily tasks — watch, subscribe, follow, engage.
   - Step 3: Get paid in instant mobile data first; unlock cash payouts & ambassador salaries as you grow.
3. **Trust & Compliance Banner:**
   - 100% Free to join — no fees ever.
   - No payment for recruiting — points earned from real verified work only.
   - Transparent 24-hour task review guarantee.
4. **Ambassador Spotlight Section:** "Build a team of active promoters, reach Level 6, and secure a predictable monthly salary as an official Promota Ambassador."

---

## 8. Database & API Changes Required

1. **Database Schema:** `0008_points_levels.sql` (already committed in dirty tree) covers `levels`, `point_entries`, `referrals`, `redemptions`.
2. **Additional Schema (`0009_competitions_ambassadors.sql` - Proposed):**
   - `competitions` (id, title, start_at, end_at, rules, prizes)
   - `competition_entries` (id, competition_id, profile_id, score, rank)
   - `ambassador_profiles` (profile_id, tier, monthly_stipend_minor, active_referees_count, status)
   - `social_accounts` (id, profile_id, platform, handle, oauth_token, verified_at)
3. **API Endpoints (`api/server.mjs` / `api/routes.mjs`):**
   - `/api/tasks` (GET feed, POST claim, POST submit proof)
   - `/api/points` (GET balance, GET history)
   - `/api/redemption` (POST data/cash request)
   - `/api/competitions` (GET active, GET leaderboard)
   - `/api/social/connect` (OAuth callback routes)

---

## 9. Implementation Plan & Next Steps

1. **Commit & Push Spec:** Save this document to `docs/superpowers/specs/2026-10-12-promoter-workflow-gamification-design.md`.
2. **Migration 0009 Creation:** Draft `0009_competitions_ambassadors.sql` for competitions, raffles, and social accounts.
3. **UI/Landing Page Copy Updates:** Update `apps/web/index.html` to reflect these exact workflows and rules.
4. **Backend Route Implementation:** Wire task submission, points calculation, and redemption endpoints.
5. **Test & Deploy:** Run full test suite (`npm test`), verify site (`npm run site`), commit, push to GitHub, and redeploy to Railway.
