# Promota — Growth Log

Reusable **patterns**, not a diary. Each entry is a root cause that cost real
time; the symptom it produced is only an example. Newest first.

---

## 1. A test file referenced by `package.json` but never committed breaks the build, not the test

**Symptom.** `npm test` passed locally for weeks. A Railway build sourced from
GitHub failed. Nine files — including the entire multi-provider reward
manager — existed only in the working tree, and `package.json` already
referenced `providers/dataManager.test.mjs`, so the CI chain asked for a file
that git did not have.

**Pattern.** *The local working tree and the remote can disagree for months
without any local signal, because `npm test` runs against the working tree.*
A reference from a **tracked** file to an **untracked** file is the tell: the
tracked file is the contract, the untracked one is the missing half.

**Signal to recognise.** `package.json`/`Dockerfile`/CI names a path, but
`git ls-files` does not list it. `git ls-files --others --exclude-standard`
next to `git ls-files` makes the gap obvious in one line.

**Rule adopted.** Before any deploy, diff *what git has* against *what the
build needs* — not against what the local run proved.

---

## 2. "Delivered" must mean the provider confirmed it, not that the HTTP call returned 2xx

**Symptom.** The legacy data adapter reported `{kind:'delivered'}` for **any**
2xx and fell back to our *own* internal reference as the provider reference.
The database rule "a fulfilled redemption must name a provider reference"
was therefore satisfied by a value that was not a provider reference — an
unconfirmed order looked confirmed to the ledger.

**Pattern.** *A success flag that is set on the absence of an error is not a
success flag.* HTTP status says the request was accepted, not that the bundle
was sent. The provider reference is the only evidence; if there is none, there
is no delivery.

**Rule adopted.** Every provider adapter returns one of three shapes —
`delivered` (with a provider reference), `pending`, `failed` — and a 2xx
without an explicit delivery signal is **pending**, never delivered.

---

## 3. A refund is the other half of "never report success that did not happen"

**Symptom.** The worker marked a permanently failed redemption `failed`,
consumed the outbox row, and left the promoter's points debited — the
platform had charged for a bundle that never arrived.

**Pattern.** *Truthfulness is symmetric.* Fixing the false success without
fixing the silent loss leaves the same complaint in the other direction: the
promoter paid and got nothing.

**Rule adopted.** A permanent failure now reverses the debit through
`reverse_point_entry` (idempotent by key) before the event is closed.

---

## 4. `revoke execute on function f() from anon, authenticated` leaves the function public

**Symptom.** Thirteen money functions (`redeem_points`, `award_task_points`,
`fund_campaign_escrow`, `checkin`, …) were still executable by **PUBLIC**,
because PostgreSQL grants EXECUTE to PUBLIC on every new function and a
revoke that does not name `public` does not remove it.

**Pattern.** *Revoking from named roles is not revoking.* The default grant is
to the pseudo-role `PUBLIC`; `from anon, authenticated` removes only the two
named grants. And revoking without re-granting to the caller breaks the API,
so the two halves must travel together.

**Rule adopted.** `revoke execute on function <sig> from public, anon, authenticated;`
**and** `grant execute on function <sig> to service_role;` — in the same
migration, always.

---

## 5. An RLS policy guards *which rows*, never *which columns*

**Symptom.** `grant update on public.tasks to authenticated` plus the
`tasks_submit` policy (`assigned_to = auth.uid()`) let the **assigned
promoter** update their own task row — including `points_awarded`. Measured:
as `authenticated`, `update tasks set points_awarded = 999999` was accepted,
and the worker then paid 999,999 points, convertible straight into paid data
bundles.

**Pattern.** *Column-level authority cannot be expressed in RLS.* RLS answers
"whose row?". The column question needs a trigger, because triggers fire for
every role including owners and superusers.

**Rule adopted.** `guard_task_points()` — a BEFORE UPDATE trigger that refuses
a change to the platform-priced columns unless the write came from the
service role. Detected by `current_setting('role')` / `current_user`.

---

## 6. A green database suite can certify a feature the application never writes

**Symptom.** `award_views_bonus()` paid only on `views_source in
('scraped','reviewer')` — and **no producer ever set `views_source`**. The
suite was 17/17 green because it inserted the column by hand. In production
the bonus was structurally incapable of paying, and the "closed exploit" was
open: the submit path stored the *typed* count and set `parsed = true`, so a
typed 50,000 views paid the full 750-point bracket.

**Pattern.** *A test that constructs the state the application cannot
construct is not testing the application.* A suite that hand-inserts the very
column the code never writes proves the SQL, not the feature.

**Rule adopted.** Every provenance stamp is now written by the API
(`scraped` / `client_claimed` / `reviewer`), the scraped value wins over the
typed one, and the backfill upgrades **nothing** to a verified source —
historical rows cannot be distinguished, so they pay nothing.

---

## 7. `encrypt at rest` in a comment is not encryption

**Symptom.** A migration declared "the account number is never stored in the
clear: the app layer encrypts it (AES-256-GCM)". There was no cipher anywhere
in the repository, and the UI told the promoter "your account number is
encrypted on our side".

**Pattern.** *Documentation is a promise about the code.* When the code does
not exist, the promise is a lie with a test-mode header — and the first
writer of that column has to choose between violating the comment and
violating the promise.

**Rule adopted.** Implement the claim or delete it. Here it was implemented
(`providers/payoutCrypto.mjs`): real AES-256-GCM, versioned envelope, auth
tag, HKDF key derivation, **fails closed** when no key is available — because
a module that cannot encrypt must refuse, not degrade to plaintext.

---

## 8. Migrations must land before the code that needs them

**Symptom.** The live `/readyz` returned 503 with
`"database is at migration 17, repo ships 13"` in the window between applying
the migrations and deploying the new build.

**Pattern.** *The readiness probe is a contract between two halves.* Applying
migrations first and deploying second is a deliberate, self-announcing
unready window; deploying first would have crashed the new code on a missing
column with a 500 instead of a readiness reason.

**Rule adopted.** Migrations first, then the build, then verify. A 503 that
names the exact mismatch is the gate working, not the gate failing.

---

## 9. The Railway CLI session is shared global state — always re-read it immediately before acting

**Symptom.** `railway whoami` confirmed the Promota account at the start of
the session. Half an hour later the same command returned a *different*
account: a concurrent session working on another project had re-linked the
shared `~/.railway/config.json` (it had even added its own project entry).
The Promota project became unreachable and the CLI ended up unauthorised.

**Pattern.** *A login is a global mutable resource on a machine with several
agents.* The standing order already demands a live identity check before any
state-changing command; this is the reason that rule exists, seen in the
wild.

**Rule adopted.** Re-run `railway whoami` **immediately** before every
state-changing Railway command, and treat the account named by the owner in
the current conversation as the only authority. If the identity has changed,
stop and restore the session rather than acting on the new account.

---

## 10. A test that only passes because the superuser bypasses RLS is not a test

**Symptom.** PGlite's superuser bypasses RLS, so a policy cannot be proven
locally — the repo's own suites say so in their headers and name the venue
(`db/live.proof.mjs` against Supabase staging with real JWTs).

**Pattern.** *Proving the GRANT is not proving the POLICY.* The suites prove
"anon cannot INSERT because the table grant is revoked"; the policy that
would let a row through is proven over HTTPS with a signed JWT.

**Rule adopted.** Keep the two claims separate and label the gap `UNVERIFIED`
with its proof venue. Five items in this repo are UNVERIFIED for exactly this
reason, and they are counted as failures of proof, not as passes.
