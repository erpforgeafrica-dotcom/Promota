# Promota — User Guide

Promota ("Naija promotes the world") is a two-sided promotion marketplace:
businesses fund campaigns, verified Nigerians promote them from their own
accounts with disclosure, and earn mobile data first and cash as they grow —
for checked results only. **No joining fee. No payment for recruiting. No
income promises.**

This guide describes what a real user can do **today** on the live pilot, and
what is not yet switched on, so nothing is oversold.

---

## 1. Join the pilot list (works today)

1. Open the live site (see `ADMIN-GUIDE.md` for the current URL).
2. Choose the lane that fits you: **Promoter**, **Business**, or **Partner**.
3. Enter your **name** and a **Nigerian phone number** (e.g. `0803 000 0000`
   or `+234 803 000 0000`). Only real NCC prefixes are accepted.
4. Tick consent and submit. The page confirms: *"You are on the list."*
5. You are assigned an **8-character invite code**. Share it — every person who
   joins with your code moves you up the queue.

### What the system does with your data

- Your phone number and the fields you typed are stored in the Promota database
  (Supabase, project `ykyvmgdruterzrmltquz`).
- The public site **cannot read the list back** — row-level security blocks it.
  Only the server-side function `submit_lead` can write, and it never returns
  personal data. It returns only: `ok`, your `referral_code`, your `position`,
  and how many people joined with your code.
- Duplicate phone numbers get the **same** answer as a new one, so nobody can
  probe whether you are already registered.

### Referrals

- A referral **counts** toward your queue position but **pays no money** — this
  is deliberate (anti-MLM rule). Cash and data come only from completed,
  verified campaign tasks, never from recruiting.

---

## 2. Promoter account (API ready, not yet linked in the UI)

The backend supports passwordless login and paid tasks, but the landing page
does not yet expose buttons for them. When wired, the flow is:

1. **Sign in** — enter your phone, receive a 4-digit SMS code, enter it.
   You get a signed 12-hour session.
2. **Find work** — see available tasks (caption, tracked link, disclosure tag,
   and the **points value shown up front**).
3. **Submit proof** — paste the link to the post that carries the required
   disclosure tag. Submitting does **not** pay you; it moves the task to
   *submitted*.
4. **Get paid** — a task auto-approves 24 hours after submission if the brand
   stays silent. Points are then awarded to your balance.
5. **Redeem points** — convert points to **mobile data** (MTN/GLO/AIRTEL/
   9MOBILE) or, once your level and KYC allow, **cash** to a Nigerian bank
   account.

> **Current limitation:** data-bundle delivery has no aggregator configured, so a
> data redemption is refused loudly and your points stay intact (reversible) —
> it is never silently marked fulfilled. That is intentional until a provider is
> chosen.

---

## 3. Business lane (interested party only today)

The Business form registers your interest. Campaign creation, escrow funding,
and budget tracking exist as a tested database layer but have **no UI yet**, and
cash movement needs a payment gateway. Do not attempt to fund a campaign yet.

---

## 4. Your rights and limits

- **Withdraw/delete:** contact the operator (see `ADMIN-GUIDE.md`). Data is
  retained per the published Privacy Policy.
- **No guarantees:** nothing on this pilot promises income. Rewards exist only
  for completed, verified work and only from funded campaigns.
- **Legal:** Terms, Privacy, and Refund pages are live (`/terms.html`,
  `/privacy.html`, `/refund.html`).

---

## 5. Reporting a problem

Include: the lane you used, the exact phone number you typed, the time, the
message shown, and (ideally) a screenshot. Send it to the operator contact in
`ADMIN-GUIDE.md`.
