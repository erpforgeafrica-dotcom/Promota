---
name: promota-money-flow
description: "How to touch the Promota points, redemption and payout path without breaking idempotency or introducing a false success. Maps every table, function, provider call and state transition on the points -> data -> cash flow, and lists the traps that have already caused real defects."
metadata:
  project: promota
---

The map of Promota's money path, and the rules for changing it. Load this
before touching `point_entries`, `redemptions`, `payout_accounts`,
`campaign_payments`, `ledger_entries`, the outbox, or any provider adapter.

## The flow, end to end

```
 POINTS IN
   task submitted (api/routes.mjs submitTask)  -> task_proofs
   -> approved by admin, or auto-approved by auto_approve_stale_tasks()
   -> award_task_points_networked(p_task)      [0012]
   -> award_views_bonus(p_task)                [0015]
   -> point_entries (append-only)  -> points_balance(p_profile)   [0008]

 POINTS OUT (the debit)
   POST /api/redeem
   -> redeem_points(p_profile, p_kind, p_points, p_idem,
                   p_network, p_plan_code)                       [0014]
      - pg_advisory_xact_lock serialises redemptions per promoter
      - cash_unlocked(p_profile) gate for kind='cash'
      - minimum redemption read from settings
      - plan_code required for kind='data'
      - idempotent replay on an existing idempotency_key
      - insert redemptions + point_entries (points negative)
      - insert outbox ('redemption.requested')

 VALUE OUT - DATA
   outbox 'redemption.requested' -> api/worker.mjs
   -> providers/data.mjs -> providers/dataManager.mjs deliver()
   -> redemptions.state='fulfilled' with the PROVIDER's reference

 VALUE OUT - CASH
   same debit, then the worker parks redemptions.state='processing'
   provider='flutterwave'
   -> POST /api/webhooks/flutterwave
        -> flw.verifyWebhookSignature(rawBody, verif-hash)
        -> reference constrained to a UUID shape BEFORE it selects a row
        -> flw.verifyTransfer(id) re-verifies against Flutterwave
        -> only then: state='fulfilled', value_minor = Math.round(naira)*100

 MONEY IN
   business funds a campaign
   -> campaign_payments (provider_ref UNIQUE, amount_minor, settled_minor)
   -> webhook -> escrow credited with an idempotency key derived from
      provider_ref (a replay cannot credit twice)
   -> ledger_entries / postings / accounts (balanced at commit)
   -> assert_campaign_funded() lets the campaign go live
```

## The five invariants, applied

1. **Fulfilled means the provider confirmed.** Not a 2xx, not a webhook, not
   a queued job. `redemptions.provider_ref` must be the provider's own
   reference.
2. **Points are minted only by Postgres functions.** `points_balance`,
   `award_task_points_networked`, `award_views_bonus`, `qualify_referral`,
   `redeem_points`, `reverse_point_entry`. Never in JavaScript.
3. **Idempotent and auditable.** A `UNIQUE` key on every money write, an
   append-only `point_entries`, an `audit_log` row for admin and money
   actions. A correction is a reversal entry, never an edit.
4. **RLS is the boundary.** The service-role key is for writes the browser
   must not perform, not for convenient reads.
5. **Evidence before claims.** A fulfilment claim cites the provider response
   or the command that proved it.

## The traps that have already caused real defects

Each of these is a shipped bug in this repo. They are here so the next
change does not reintroduce them.

**Amount-scoped idempotency key.** The old key was
`redeem:<profile>:<kind>:<points>:<network>`. A promoter's legitimate second
redemption of the same value looked like a replay: the API returned the old
redemption id with no debit and no fulfilment — a silently unpaid promoter.
The key is now `redeem:<profile>:<nonce>`, with the nonce supplied per
request.

**Plan code dropped between request and worker.** The outbox payload never
carried the chosen plan, so every data redemption failed in the worker with
"planCode is required" *after* the points were already debited. The plan code
is now persisted on `redemptions.plan_code` and forwarded.

**Redeem race.** `redeem_points()` read the balance and inserted with no row
lock, so two concurrent redemptions both passed the balance check and the
balance went negative. Fixed with a per-profile advisory transaction lock
taken before the balance read, plus a deferred constraint trigger as a
backstop.

**A bare 2xx treated as delivery.** The legacy data adapter reported
"delivered" for any 2xx and then used *our own* reference as the provider
reference, which made an unconfirmed order look confirmed to the database.
That is why `providers/dataManager.mjs` requires an explicit delivered status
*and* a provider reference, and why there is a
`redemptions_fulfilled_has_ref` constraint.

**A webhook treated as proof.** The Flutterwave webhook is replayable and
the body is caller-supplied. The authoritative amount and status come from
`flw.verifyTransfer(id)`, by id, not from the body. The amount is converted
as `Math.round(amountNaira) * 100` — integer naira to kobo, never a float
times 100.

**A topic with no handler silently dropped.** The worker used to mark an
unknown topic `dead`, which dropped the event. It now leaves the row queued
and logs once, so a redeploy that adds the handler still drains it.

**A negative balance guard that was too broad.** The first version of the
balance guard fired on every `point_entries` insert and forbade corrections —
but a reversal can legitimately drive the balance negative, because that
negative number *is* the promoter's debt. The guard is now scoped to
`new.kind = 'redemption'`. Widening it again breaks reversals; narrowing it
lets a hand-run redemption overdraw.

## The failover matrix — do not change the semantics

`providers/dataManager.mjs`:

| Provider says | Rule |
|---|---|
| explicit delivered status | delivered, never retried, never failed over |
| pending / in flight | park as pending, resolve with `recheck()`, never re-purchase |
| explicit rejection (402/422, empty wallet, unsupported plan) | try the next provider with the SAME internal reference |
| 2xx with no explicit success signal | park as pending |
| transport died mid-flight | outcome UNKNOWN: retry the SAME provider, do not switch |

One internal reference (the redemption id) is reused across every attempt, so
a provider-side duplicate cannot be created.

## The outbox contract

`api/worker.mjs` claims rows atomically with `claim_outbox_batch`
(SKIP LOCKED), so a second replica is safe.

**Nothing is marked delivered that was not actually delivered.** A row
reaches `delivered` only when its handler ran to completion without throwing.
Three distinct states that must not be conflated:

- the **outbox row** is delivered (the handler ran);
- the **redemption** is `fulfilled` (the provider confirmed);
- the **promoter was paid** (a bundle landed or a transfer settled).

The second and third are not implied by the first. A handler that parks a
redemption as `failed` or `processing` and returns normally has delivered the
*event*; it has not delivered the *bundle*. And a handler that swallows a
provider error and returns normally has marked a row delivered while nothing
happened — that is the defect this rule exists to prevent.

## Two gaps that are still open

Re-verify before you cite these; they are facts about a point in time, and
closing them is a legitimate task.

- `providers/flutterwave.mjs` defines `createTransfer()`, and nothing in
  `api/` or `providers/` calls it. The cash path debits points and parks the
  redemption as `processing`.
- The `payout_accounts` table (`0016_money_flows.sql`, encrypted
  `account_number_enc` / `account_name_enc`, `verified_at` required for a
  payout) is not read or written by any JavaScript. Likewise
  `campaign_payments`: the live money-in path is still
  `fund_campaign_escrow()`, called from `api/admin.mjs`.

Until those are wired, a cash redemption is a debit with no transfer behind
it. That is honest to state and dishonest to hide.

## Changing the money path — the checklist

Before writing code:

- [ ] Which invariant does this touch? (1 fulfilment, 2 minting, 3
      idempotency/audit, 4 RLS, 5 evidence)
- [ ] Does the rule belong in SQL? If it can be a constraint, a trigger or a
      function, it goes in `db/migrations/` — see the `promota-migration`
      skill.
- [ ] What is the idempotency key, and is it request-scoped rather than
      amount-scoped?
- [ ] What makes the state `fulfilled`, and can that thing happen without a
      provider confirmation?
- [ ] Does a failure leave the promoter's points reversible?

While writing:

- [ ] No JavaScript arithmetic on points or balances.
- [ ] Every provider call carries the same internal reference.
- [ ] `pending` and `unknown` are not success.
- [ ] Every state change writes a reason: `failure_reason`, `last_error`,
      `provider_ref`.
- [ ] No secret value in a log, a response body or a test fixture.

Before claiming it works:

```powershell
node db/points.test.mjs
node db/redemption-integrity.test.mjs
node db/ledger.test.mjs
node providers/dataManager.test.mjs
node api/api.test.mjs
npm test
```

Then have `promota-money-path-auditor` review the diff. It is read-only and
it is the role that exists to catch exactly what you might have missed.

## Related

- `.opencode/agent/promota-money-path-auditor.md` — the role that reviews this
- `.opencode/agent/promota-backend-engineer.md` — the API side
- `.opencode/agent/promota-db-engineer.md` — the SQL side
- `.opencode/skill/promota-release/SKILL.md` — the release procedure that
  carries these guarantees
