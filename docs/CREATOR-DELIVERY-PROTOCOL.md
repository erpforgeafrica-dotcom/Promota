# Creator Delivery Protocol

**Status:** implemented in migration `0018_task_policy_gate.sql`, `api/business.mjs`,
`api/routes.mjs`, `apps/web/business.js` and `apps/web/dashboard.js`.
**Date:** 2026-10-26.

This document is the operating model for how Promota hands work to a creator. It exists
so the product can keep paying creators without selling engagement that platforms
prohibit.

---

## 1. What we sell

| Policy class | Action | Deliverable | Payment trigger |
|---|---|---|---|
| `content` | `post` | An original, disclosed post/reel/short | Public post URL + business confirmation |
| `distribution` | `repost`, `share` | Brand-supplied content published on the creator's own channel | Public post URL + business confirmation |
| `review` | `review` | An honest review of a product the creator received | Public review URL + verified purchase |
| `lead` / `click` (campaign objective) | `click`, `signup`, `code`, `api_post` | The business's own link or code converts | Provider/business-confirmed conversion |

**Never sold:** likes, comments, follows, subscribes, views, channel joins, or any
package that promises a count of those actions.

---

## 2. Private dispatch algorithm

The goal is not to hide a prohibited action. The goal is to stop a burst of identical
behaviour that looks like a botnet even when the work is legitimate.

### 2.1 Eligibility

A creator may claim a task only when all of these are true:

1. `profiles.state = 'active'` and the session is valid.
2. `profiles.policy_ack_version = tasks.policy_version` — the creator has read and
   accepted the current delivery policy.
3. The task is `draft`, belongs to a `live` campaign, and is not `prohibited`.
4. `release_at <= now()` — the task has been released.
5. The creator does **not** already hold a task from the same campaign in
   `assigned, submitted, checking, held, approved, paid`.

Rules 2–5 are enforced in `claim_task()`; a client cannot skip them.

### 2.2 Capacity and cooldowns

- **One active task per campaign per creator.** Prevents the same account from posting
  the same campaign repeatedly in a short window. A creator can take another task from
  the same campaign only after the previous one is paid.
- **Staggered release.** `tasks.release_at` lets an admin or the campaign scheduler
  release work in waves (for example 10 tasks every 30 minutes) instead of all at once.
  The dashboard hides unreleased tasks and `claim_task()` refuses them.
- **Per-campaign cap.** The number of live tasks is bounded by the campaign budget and
  the task count (1–10 per campaign today). Add a per-platform daily cap in the admin
  console before scaling.

### 2.3 One-to-one packet

Each task carries:

- its own `attribution_code` (`PM` + 12 hex characters, unique);
- the business's own link (never a Promota redirect);
- the caption and creative;
- the disclosure tag;
- the platform and the branded-content instruction.

The creator posts from their own account. Promota never holds the password, never
automates the action, and never scrapes the platform. Proof is the public URL the
creator submits; the business or a reviewer confirms the outcome.

### 2.4 Why this is not cloaking

The creator's post openly says it is paid (`#ad` / `#sponsored` and the platform toggle).
The attribution code is a normal campaign code, not a disguised redirect. There is no
attempt to make a paid like look organic — because a paid like is not sold at all.

---

## 3. Disclosure flow

1. The business chooses a disclosure tag when creating the task (`#ad` default;
   `#sponsored`, `#paidpartner` also valid).
2. The task card shows the tag and the instruction to use the platform's branded-content
   toggle (Instagram/Facebook "Paid partnership", TikTok "Commercial content", YouTube
   paid-promotion checkbox).
3. The creator acknowledges the policy once per version before their first claim.
4. The reviewer checks the live post for the tag and toggle before approval. A missing
   disclosure is a rejection reason, not a warning.
5. Payment is never conditioned on the review being positive. A negative but honest
   review is payable; a positive review that was bought is not.

---

## 4. Data minimisation

Promota stores only what it needs to pay and to prove the work:

- public post/review URL;
- platform name;
- optional view count (creator-reported or parsed from a public page);
- the business's campaign link and the creator's attribution code;
- no platform password, OAuth token, cookie, device fingerprint or private profile data;
- no platform user ID;
- no shared Promota redirect in the creator's post.

The service-role key stays server-side. The browser holds only the publishable key and
is stopped by RLS.

---

## 5. Migration and grandfathering

`0018_task_policy_gate.sql` is additive and forward-only:

- new prohibited tasks cannot be inserted or claimed;
- existing draft prohibited tasks are classified `prohibited` and become unclaimable;
- existing assigned/submitted/approved tasks keep their state and can still be paid;
- every task gets an attribution code, including legacy rows;
- the creator acknowledgement is a new profile column, not a blocking change for
  existing accounts (they acknowledge on their next claim).

Rollback is forward-only: ship a new migration that reverses the gate. Never edit
`0018` after it is applied.

**Apply order:**

```powershell
npm test                      # local proof
npm run db:remote             # apply 0018 to Supabase
node scripts/predeploy-check.js
node scripts/deploy-hostinger.mjs deploy
node scripts/verifyLive.mjs https://promota.click
```

---

## 6. Business metrics that replace engagement counts

Selling likes was easy to measure and easy to sell. The compliant model needs metrics
that are just as concrete:

| Old metric | New metric |
|---|---|
| Cost per like/follow/view | Cost per verified post |
| Engagement rate | Completion rate (claimed → approved) |
| Follower growth | Qualified leads / code redemptions |
| Reach | Dispute rate and disclosure-compliance rate |
| Creator payout per action | Creator retention and repeat-campaign rate |

These keep the business sellable without promising a platform metric the platform
forbids us to buy.

---

## 7. Open items

- Apply `0018` to the live Supabase project (owner approval).
- Redeploy Hostinger after the migration.
- Legal review of ARCON registration/pre-vetting for sponsored content in Nigeria.
- Optional: remove the public task board entirely and move to invite-only dispatch.
- Optional: receipt/order-ID check for review tasks instead of a business attestation.
