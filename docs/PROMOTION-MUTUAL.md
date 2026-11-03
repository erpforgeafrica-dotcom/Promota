# Promote You — mutual promotion between members

Promota's core marketplace is brand → promoter. **Promote You** is the other
direction, and the simplest promise of the product's own name: a member puts
*themselves* up for promotion, and another member promotes them back.

> You promote me. I promote you. Both posts are real, both are disclosed, both
> sides are paid.

This is **not paid engagement**. Nothing in this module buys a like, follow,
view, comment, subscribe or channel join. A delivery is original distribution
work on the member's own channel with a branded-content disclosure — the same
`distribution` class that `0018_task_policy_gate.sql` allows.

## The flow

1. A member publishes a **promo card** about themselves or their business
   (`draft` → `review` → `active`). A reviewer must approve it before anyone
   can offer it.
2. The member opens the card board, picks another member's active card, and
   **proposes a pair** (their card ↔ the partner's card).
3. The invited member **accepts**. The pair becomes `active` with a delivery
   deadline.
4. Each side **delivers one post** promoting the *other* member's card: an
   https post URL, a named platform and a disclosure (`#ad`, `#sponsored` or
   "paid partnership").
5. A reviewer **approves or rejects** each delivery independently.
6. An approved delivery pays `promotion.delivery_points`. When **both** sides
   are approved, each member also receives `promotion.mutual_bonus_points`,
   and the pair moves to `completed`.
7. A pair that is not delivered inside `promotion.delivery_window_hours` is
   expired by the housekeeping sweep. An expired pair pays nothing.

## Rules, and where each one is enforced

Business rules live in Postgres (`db/migrations/0020_mutual_promotion.sql`), not
in the API, so they hold for every caller — including the platform's own
operators.

| # | Rule | Enforced by |
|---|---|---|
| R1 | Only the owner can create a card, and a new card starts in `draft`/`review` — never `active` | `guard_promo_card_insert` trigger |
| R2 | A pair is two different members with two different cards | `propose_promo_pair` + table constraints |
| R3 | Only the invited member can accept; only participants can act on a pair | `accept_promo_pair`, `promo_participant` |
| R4 | Each side promotes the **partner** card, never their own | `guard_promo_delivery_insert` trigger |
| R5 | One delivery per side per pair; https URL, platform and disclosure required | trigger + unique index + `submit_promo_delivery` |
| R6 | Points are minted only in Postgres, idempotently, once per delivery and once per member for the mutual bonus | `review_promo_delivery` + `point_entries.idempotency_key` |
| R7 | A rejection mints nothing and never edits a prior entry; the only correction is a reversal entry | `review_promo_delivery` + points ledger law (0008) |
| R8 | Every review writes an append-only `audit_log` row and an outbox event | `review_promo_card`, `review_promo_delivery` |
| R9 | Caps are settings, not code | `promo_setting_int` + `settings` |

Additional guards:

- A member needs an **active, phone-verified** account to own a card, and the
  partner account must be active and verified.
- A member may hold at most `promotion.max_cards_per_member` cards in
  `review`/`active`.
- Both the proposer and the invited member are checked against
  `promotion.max_active_pairs` — one member cannot be used as a hub.
- Invitations are rate-limited per member per rolling 7 days.
- A second open pair between the same two members is refused.
- A card in `review`/`active` cannot be duplicated by link (`unique(owner_id, link_url)`).

## Points economics

| Kind | When | Default | Setting |
|---|---|---|---|
| `promotion_reward` | Once per approved delivery | 100 points | `promotion.delivery_points` |
| `promotion_bonus` | Once per member when both sides are approved | 250 points | `promotion.mutual_bonus_points` |

So a completed pair is worth **350 points to each member** (100 delivery + 250
mutual bonus) at default settings, and 100 points if only one side delivers.
The API never computes these numbers and never writes a point entry; it calls
`review_promo_delivery`, which owns both.

A rejection pays **0**. The delivery can be resubmitted only while the pair is
active and the side has no approved delivery; a rejected side may try again
inside the window.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `promotion.delivery_points` | 100 | Points per approved delivery (must be > 0) |
| `promotion.mutual_bonus_points` | 250 | Bonus per member when both sides are approved |
| `promotion.max_active_pairs` | 3 | Open pairs per member (proposer and invitee both checked) |
| `promotion.max_proposals_per_week` | 10 | Invitations per member per rolling 7 days |
| `promotion.delivery_window_hours` | 72 | Time from acceptance to deliver |
| `promotion.max_cards_per_member` | 5 | Cards in `review`/`active` per member |

All are typed `settings` rows, editable from the admin console — no migration
needed to tune the economics.

## API

Every route requires a Termii-verified session. The handler passes the verified
session id into SQL; a client-supplied actor id is never read.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/promotion/cards` | Active cards from other members (`category`, `city`, `limit`) |
| `POST` | `/api/v1/promotion/cards` | Publish your own card (lands in `review`) |
| `GET` | `/api/v1/promotion/cards/mine` | Your cards and their moderation state |
| `GET` | `/api/v1/promotion/pairs` | Your pairs, both cards and both deliveries |
| `POST` | `/api/v1/promotion/pairs` | Propose a pair `{ selfCardId, partnerCardId }` |
| `POST` | `/api/v1/promotion/pairs/:id/accept` | Accept an invitation (invitee only) |
| `POST` | `/api/v1/promotion/pairs/:id/deliver` | Submit your side `{ platform, postUrl, disclosure, evidence? }` |

Admin (role `admin`, `owner` or `support`, or the `task.review` permission):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/admin/promotion/cards?state=review` | Card moderation queue |
| `POST` | `/api/v1/admin/promotion/cards/:id/review` | `{ approve, note }` |
| `GET` | `/api/v1/admin/promotion/deliveries?state=submitted` | Delivery moderation queue |
| `POST` | `/api/v1/admin/promotion/deliveries/:id/review` | `{ approve, reason }`; a rejection needs a reason |
| `POST` | `/api/v1/admin/promotion/expire` | Expire overdue pairs (housekeeping sweep) |

Example:

```http
POST /api/v1/promotion/pairs
{ "selfCardId": "<my card>", "partnerCardId": "<their card>" }

201 { "id": "<pair>", "state": "proposed" }
```

## Data model

| Table | Holds |
|---|---|
| `promo_cards` | A member's own promotion offer: kind, title, summary, https link/media, category, city, state, moderation note |
| `promo_pairs` | Two members and their two cards, state, proposer, acceptance, deadline, completion |
| `promo_deliveries` | One row per side: platform, post URL, disclosure, evidence JSON, state, points, reviewer, rejection reason |

Enums: `promo_card_kind`, `promo_card_state`, `promo_pair_state`,
`promo_delivery_state`, `promo_disclosure`.

## Evidence and honest state

- Local proof: `node db/mutual-promotion.test.mjs` — PGlite applies all
  migrations and runs the rule matrix (self-promotion, wrong accepter, own-card
  delivery, caps, deadline, double delivery, double approval, idempotent
  points, RLS/grants).
- The two cases that need a real JWT venue are reported as `UNVERIFIED`, not
  as passes. Run `npm run db:live` on the staged project to close them.
- **Live deployment is blocked** until migrations `0019` and `0020` are applied
  to the live database (`npm run db:remote` needs the live Postgres password —
  owner action). Until then the feature exists in `main` and is not live.

## Compliance note

Promote You sells **distribution**, never engagement. The prohibited-action
list from `0018_task_policy_gate.sql` is unchanged: no like, comment, follow,
subscribe, view or channel-join can be bought here. A delivery is a disclosed
post on the member's own channel, reviewed by a human before any point is
minted.
