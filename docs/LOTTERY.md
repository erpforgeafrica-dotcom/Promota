# Promota Lottery — Transparent & Provably Fair (PLAN)

**Status: DRAFT / NOT SHIPPED.** This document is an execution design only. Schema groundwork exists (migration `0009_competitions_ambassadors.sql` ships a `competitions` table with `kind in ('sprint','raffle')`, per-promoter entries, ticket-count settings and a draw-date setting), but **no draw worker, reveal publication, or verification page exists in the codebase yet.** Nothing below is live until it is built and this file flips to SHIPPED with a verification trail.

## Design goal

End the "boxes were rigged" doubt before it starts. Every monthly raffle draw must be:
1. **Committed in advance** — the organizer cannot pick a seed that favors any entry.
2. **Anchored to public randomness** — neither operator nor player can grind the client seed.
3. **Replayable by anyone** — every input published; winners recomputable on a pocket calculator.

## The draw algorithm (standard commit-reveal pattern)

For each raffle `R` with a sealed promoter list `E = [e₁ … eₙ]`:

1. **Commit.** When entries open, the server generates a random `serverSeed`, publishes `serverHash = SHA-256(serverSeed)` on the draw page **while tickets are still accumulating**. Swapping the seed later is now impossible.
2. **Anchor.** When entries close, the `clientSeed` is a public, unguessable event — e.g. `raffle_<id>_<next NIST Randomness Beacon pulse>` or a future public block hash. Neither side controls it; nobody could have predicted it at commit time.
3. **Draw.** `drawSeed = HMAC-SHA256(key = serverSeed, msg = clientSeed)`. Map `drawSeed` to an integer in `1..n` (discard-bias or expand feed) → winning entry index. Multi-prize draws repeat with a per-prize counter in the message (`…:<prize_index>`) and draw **without replacement** (Fisher–Yates over the full entrant array, seeded by the same HMAC stream).
4. **Reveal.** Publish `serverSeed`, `serverHash`, `clientSeed`, the entrant list hash, each winning index and the SHA-256 of the result page — all in one public record. Anyone can now recompute every step locally.

## What already exists (promoter-facing)

- `competitions` table with `kind='raffle'`, active window, prize pool JSON and per-promoter entries (0009).
- Ticket accrual settings: `competitions.raffle_tickets_per_100_points` (1 ticket per 100 points earned from qualified tasks in the month), `competitions.raffle_max_tickets_per_promoter` (50), `competitions.raffle_draw_date` (28th of the month).
- `promoter_raffle_tickets(profile)` — a promoter can read **their own** ticket count; other people's entries are RLS-hidden.

## What must still be built

| # | Piece | Notes |
|---|-------|-------|
| 1 | `draws` + `draw_seeds` tables (commit stored, status `open → committed → drawn → revealed`) | server hash must be published *before* the draw date; store `committed_by` (operator id) for audit |
| 2 | Draw worker (outbox topic `raffle.draw_due`) | fetches the anchored client seed, computes winners, writes `drawn` row |
| 3 | Reveal publisher | after reveal everyone sees `serverSeed`; a page `/versions/lottery/verify` recomputes hashes in-browser |
| 4 | Prize fulfilment | winners routed into the existing payouts/redemptions queue (data bundles or campaign prizes), one record per prize with a claimed flag |
| 5 | Anti-fraud hardening | one-identity rule already enforced upstream (one row per Nigerian phone/identity); self-referral tickets excluded; KYC tier 2 required to *claim* a prize worth > ₦X |
| 6 | Legal copy | entry is always **earned by completing paid tasks, never purchasable with cash**; add the no-purchase language to terms/lottery page |

## Operating rules (owner settings, added when built)

- Draw date stays the 28th; reveal happens the same day.
- A raffle that fills early still draws on the draw date — never sooner.
- If the anchoring event is unavailable at draw time, the draw **waits** (status stays `committed`) and an admin note is published on the page. Draws never fall back to any platform-generated number.
- The full seed history (`draw_seeds`) is append-only, select-restricted to the audit view and the public reveal endpoint.

## Why this is honest

- The operator **cannot** choose the winning seed: `serverHash` is published before anyone could tweak `serverSeed` to hit a chosen index.
- The promoter **cannot** grind: the `clientSeed` is a public pulse nobody can predict in advance.
- Everyone can **verify**: two SHA-256 computations and one HMAC — demonstrated on the verify page with the real published values, not a screenshot.
