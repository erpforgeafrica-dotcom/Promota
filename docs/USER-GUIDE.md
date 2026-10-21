# Promota — User Guide

Promota ("Naija promotes the world") is a two-sided promotion marketplace:
businesses fund campaigns, verified Nigerians promote them from their own
accounts with disclosure, and earn mobile data first and cash as they grow —
for checked results only. **No joining fee. No payment for recruiting. No
income promises.**

This guide describes what a real user can do **today** on the live pilot, and
what is not yet switched on, so nothing is oversold.

---

## 1. Create your account (works today)

1. Open the live site (see `ADMIN-GUIDE.md` for the current URL).
2. Press **Sign up** (or **Login** if you already have an account).
3. Enter your **Nigerian phone number** (e.g. `0803 000 0000` or
   `+234 803 000 0000`). Only real NCC prefixes are accepted.
4. Enter the one-time code the SMS sends you. The page then opens your
   dashboard.
5. The dashboard's **Referrals** tab shows when each person joined, whether
   they are qualified yet, and the points each one paid you.

### What the system does with your data

- Your phone number and the fields you typed are stored in the Promota database
  (Supabase, project `ykyvmgdruterzrmltquz`).
- The public site **cannot read the list back** — row-level security blocks it.
  Only the server-side function `submit_lead` can write to the waitlist table,
  and it never returns personal data. It returns only: `ok`, your
  `referral_code`, your `position`, and how many people joined with your code.
- The waitlist **form** is not on any page today — signing up uses the
  one-time-code flow above, which writes to the `profiles` table. The waitlist
  path itself (the `submit_lead` function and the `leads` table) still exists
  and is still row-level-security locked.
- Duplicate phone numbers get the **same** answer as a new one, so nobody can
  probe whether you are already registered.

### Referrals

- A referral **counts** toward your level but **pays no money** — this is
  deliberate (anti-MLM rule). Cash and data come only from completed,
  verified campaign tasks, never from recruiting.
- The 8-character **invite code** is assigned by the database when a waitlist
  signup happens (`submit_lead`). The promoter pages do not show one today.

---

## 2. Promoter account (wired: sign in from the landing page)

The landing page carries a **Login** and a **Signup** button. It asks for
your Nigerian number, sends a one-time code by SMS, and keeps the returned
session in the browser. Once the code checks out it opens your dashboard at
`/dashboard.html`.

From there the flow is:

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

> **Data bundles:** a multi-provider data aggregator is wired in
> (`providers/dataManager.mjs` — twenty5 first, then vtung, with the earlier
> generic adapter as the last resort). Delivery still depends on the provider
> credentials being set on the server. When no provider can serve a
> redemption, it is refused loudly and your points stay intact (reversible) —
> it is never silently marked fulfilled.
>
> **Cash payouts** need a verified payout account. Add your bank details on
> the dashboard's *Payout account* tab; the account number is encrypted
> before it is stored and the API never returns it, so the page shows only
> the last four digits. A payout cannot go out until that account is
> verified.

---

## 3. Business lane (a console exists, at `/business.html`)

The business console is the self-serve surface:

1. **Business verification** — send your display name, business name,
   registration number, website and a contact. An admin reads the record and
   marks it verified. Until then the server refuses a campaign; the console
   says which state the record is in.
2. **Create a campaign** — title, platform, objective, budget, price per
   outcome, and the tasks promoters must complete (caption, tracked link,
   action type).
3. **Fund escrow** — request a payment link for the campaign budget and send
   it to whoever is paying. A campaign goes live only after an admin confirms
   it and escrow is funded.

Cash movement still needs a payment gateway and merchant KYC, and a campaign
cannot be created before the owner record is verified. Do not promise a
brand a live campaign before that happens.

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
