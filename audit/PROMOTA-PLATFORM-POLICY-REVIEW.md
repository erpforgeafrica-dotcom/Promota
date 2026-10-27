# Promota — platform-policy review of paid social delivery

**Date:** 2026-10-26
**Scope:** Does traffic delivered through Promota lead to account suspension or policy
breach on the social platforms it serves? Can delivery be redesigned so the risk is
removed without hurting creator earnings or the business?
**Verdict:** The risk is real, and it is in the **action being paid for**, not in the
link. The only complete fix is to stop selling prohibited engagement. That fix is now
enforced in the database (`0018_task_policy_gate.sql`), the API and the UI.

---

## 1. The short answer

A paid like, follow, view, comment, subscribe, share or channel join is prohibited
engagement on every platform Promota serves. Paying a creator to do it is the breach.
Hiding the payment behind a private dispatch, a redirect, a UTM or an "untraceable"
link does not remove the breach — it adds a second one (cloaking / circumvention).

Promota's own Terms already promised the right thing:

> "No fake likes, follows or views are bought or sold." — `apps/web/terms.html` at
> commit `e21e75f`

The code did not honour that promise. At the same commit, `api/business.mjs:30-33`
offered `post, like, comment, follow, subscribe, repost, share, view, join_channel,
review`, and `apps/web/business.js:53-64` rendered all of them in the campaign form.
That contradiction is now closed.

**What is allowed:** disclosed branded content, an original post/reel/short, a
brand-content post with the platform's branded-content toggle, a lead or signup through
the business's own link, and an honest review of a product the creator actually
received. Those are the only things the product sells now.

---

## 2. Platform-by-platform

| Platform | Prohibited paid action | What the policy actually says | Allowed alternative | Enforcement risk |
|---|---|---|---|---|
| **Meta (Facebook, Instagram)** | like, follow, comment, share, view, click-farm engagement | Spam policy prohibits "selling, buying, or exchanging for engagement, such as likes, shares, views, follows, clicks"; cloaking is separately prohibited | Clearly identified branded content; disclosed creator posts | Page/account restriction, content removal, ad-account shutdown |
| **TikTok** | like, comment, follow, share, view, channel join | Community Guidelines (eff. 2026-09-24) prohibit the "trade of services that artificially boost engagement or trick the recommendation system"; fake reviews and automation are separate violations | Branded content with the commercial-content disclosure toggle (policy eff. 2026-08-31) | Video removal, account restriction, creator-marketplace exclusion |
| **YouTube** | view, like, comment, subscribe | Fake Engagement policy prohibits artificial views/likes/comments; engagement is illegitimate when its sole purpose is financial gain. YouTube states that hiring someone to promote means **their** violations can take down **your** channel | Paid promotion with the paid-promotion disclosure; original creator video | Strike, monetisation loss, channel termination — including the brand's channel |
| **X (Twitter)** | follow, like, repost, view, coordinated engagement | Authenticity policy prohibits "coordinating to exchange engagement", "compensating others to conduct account metric inflation", and "using or promoting third-party services" for those transactions | Disclosed sponsored post; business-owned campaign link | Suspension, URL denylisting (the shared link stops working), account lock |
| **LinkedIn** | like, comment, follow, share, automated engagement | User Agreement Don'ts #13 prohibits bots/unauthorised automation to "create, comment on, like, share, or re-share posts, or otherwise drive inauthentic engagement" | Disclosed branded content from a real member | Restriction, content removal, page restriction |
| **WhatsApp** | channel joins, bulk views, bulk forwarding | Business Messaging policy prohibits unauthorised automation and bulk unsolicited messaging; channel growth sold as a service is inauthentic | Opt-in business messaging; disclosed status/content | Number ban, Business API access loss |
| **Telegram** | channel joins, views | Less prescriptive than the majors, but paid joins/views are still inauthentic engagement and a spam signal; the same conduct is prohibited on the platforms the traffic is later pointed to | Disclosed channel content; opt-in audience | Channel restriction, spam limits |

**Regulatory layer (Nigeria and the US):**

- **FTC 16 CFR Part 465** bans buying or selling fake reviews and fake social-media
  indicators, and bans compensation conditioned on sentiment.
- **FTC Endorsement Guides** require clear disclosure of material connections.
- **Nigeria FCCPA 2018 ss.125–126** prohibit misleading endorsements; **ARCON** requires
  sponsored content to be truthful, disclosed and pre-vetted, and may require the
  advertiser/creator to be registered. This is a legal-review item, not a settled
  conclusion in this document.

---

## 3. "Can we use a secure path so it cannot be connected to us?"

No — and the attempt makes things worse. Four reasons:

1. **The paid action is the violation.** A like is prohibited because it is bought, not
   because a link reveals the buyer. A private dispatch still pays for the like.
2. **Cloaking is itself prohibited.** Meta, TikTok and YouTube all prohibit
   circumventing enforcement or disguising the destination/behaviour. A hidden path is a
   second violation, not a fix.
3. **Detection is behavioural, not link-based.** Platforms correlate account cohorts,
   timing bursts, identical captions, device/IP graphs and engagement ratios. Promota's
   public board handed every promoter the **same** `tracked_link` (`dashboard.js:117-145`
   at `e21e75f`), which is exactly the burst/duplicate-content pattern enforcement looks
   for.
4. **The brand carries the downside.** YouTube explicitly warns that a promoter's
   violation can terminate the brand's channel; X can denylist the shared URL, which
   breaks the campaign for everyone. A creator losing an account is not a "creator
   problem" — it is a business-ending event for the customer who paid for the campaign.

**What is legitimately private** (and is now implemented):

- no Promota redirect or UTM in the creator's post;
- no shared tracked link — each task gets its own attribution code;
- no platform passwords, OAuth tokens, scraping or automation;
- no platform user IDs in Promota's database;
- 1:1 task packets instead of a public board blasting one link.

That is privacy separation, not evasion. It reduces collision risk without pretending
the paid action is something it is not.

---

## 4. What the product may sell

| Class | Action values | What the creator does | Disclosure |
|---|---|---|---|
| **Content** | `post` | Publishes an original post/reel/short about the brand | Campaign tag + platform branded-content toggle |
| **Distribution** | `repost`, `share` | Publishes brand-supplied content on their own channel | Same |
| **Review** | `review` | Reviews a product they actually received | Same; payment never depends on a positive rating |
| **Outcome** (business-owned) | campaign objective `click`, `signup`, `code`, `api_post` | The business's own link or code converts; the creator is paid for the verified outcome, not for a platform metric | Landing page discloses the offer |

**Not sold:** `like`, `comment`, `follow`, `subscribe`, `view`, `join_channel`, and any
"engagement package" that promises a number of those actions.

---

## 5. What changed in the code (this commit)

1. **Database gate — `db/migrations/0018_task_policy_gate.sql`**
   - `task_policy_class()` maps every action to `content`, `distribution`, `review` or
     `prohibited`.
   - `guard_task_policy()` refuses a new prohibited task, refuses a review without
     `review_verified_purchase`, refuses an empty disclosure tag, and assigns a unique
     `attribution_code`.
   - `claim_task()` refuses prohibited tasks, unacknowledged creators, unreleased tasks,
     and a second active task from the same campaign.
   - Existing rows are kept: draft prohibited tasks become unclaimable; tasks already
     assigned keep the state machine and can still be approved and paid.
2. **API — `api/business.mjs`, `api/routes.mjs`**
   - `CAMPAIGN_ACTIONS` is now `post, repost, share, review`.
   - Prohibited actions return `422` with the policy reason.
   - `GET /api/policy` exposes the version and rules; `POST /api/policy/ack` records the
     creator's acknowledgement.
   - Task lists filter prohibited work, expose the attribution code and policy class, and
     `claim` returns the code.
3. **UI — `apps/web/business.js`, `apps/web/business.html`, `apps/web/dashboard.js`,
   `apps/web/dashboard.html`**
   - The campaign form no longer offers prohibited actions; it asks for a disclosure tag
     and a verified-purchase attestation for reviews.
   - The dashboard shows the policy, requires the acknowledgement before claiming, and
     shows each creator their own attribution code.
4. **Terms — `apps/web/terms.html`**
   - Section 14 "Creator Delivery Policy" now matches the code.

**Evidence:** `node db/policy.test.mjs` — **35 PASS / 0 FAIL**; full suite green;
`node scripts/checkSite.mjs` — **187 PASS / 0 FAIL**; `predeploy-check` is NO-GO only
because migration `0018` has not yet been applied to the live Supabase project.

---

## 6. Residual risk and owner decisions

| Item | State | Owner decision |
|---|---|---|
| Live Supabase migration `0018` | **Not applied** — repo 18, live ledger 17 | Approve `npm run db:remote` |
| Hostinger redeploy | **Not run** | Approve `node scripts/deploy-hostinger.mjs deploy` after the migration |
| Legacy draft tasks with prohibited actions | Kept, unclaimable; in-flight work still pays | None — this is the safe default |
| ARCON registration / pre-vetting for sponsored content | **UNVERIFIED legal question** | Legal review before scaling brand campaigns |
| Review verification | Business attests `verifiedPurchase`; no platform purchase API | Consider receipt upload / order-ID check |
| Public task board | Now filters prohibited work and shows unique codes | Consider removing the public board entirely (private dispatch) |

**Bottom line:** traffic from Promota does not suspend an account by itself. Paying for
prohibited engagement does, and the platform can suspend the creator, the brand, or both.
The product now refuses to sell that engagement at the database, API and UI layers. What
remains is the live migration and the legal review — both named above with the exact
command or owner.
