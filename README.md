<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/web/assets/identity/banner-dark.png" />
  <img src="apps/web/assets/identity/banner-light.png" alt="Promota — Naija promotes the world" width="100%" />
</picture>

# Promota — Naija promotes the world

Money that works as hard as you do. A two-sided promotion marketplace: businesses fund
campaigns; verified Nigerians promote from their own accounts with disclosure and earn mobile
data first, cash as they grow — for checked results only.

- **Brand law:** `docs/BRAND.md` (palette pairs measured, voice rules, asset inventory).
- **Skill provenance:** `docs/BRAND-SKILLS.md` (what was adopted, from where, what was NOT installed).
- **Verified state:** `STATUS.md` (claims with evidence; blockers named, nothing assumed).

## Run

```powershell
npm test      # phone (17), lead client (24), API layer (80), image contents (7),
              # ledger (56), lead capture (41), points (56), data failover (26)
              # — 307 checks, 5 of them marked UNVERIFIED
npm run site  # page integrity: anchors, assets, SEO basics, theme switch, a11y tokens
npm run serve # preview at http://127.0.0.1:8080 (loopback only)
```

## Layout

```
apps/web/          vanilla JS frontend: landing + OTP sign-in, promoter
                   dashboard, business console, admin console, approval queue,
                   legal pages (lead capture still ships in app.js but no page
                   exposes the waitlist form today)
api/               production API: OTP sessions, tasks, redeem, referrals, worker
providers/         Termii (SMS/OTP), Flutterwave (bank transfers), data.mjs +
                   dataManager.mjs (twenty5 -> vtung failover), payoutCrypto.mjs
db/migrations/     Supabase schema 0001-0016: RBAC, ledger, escrow, tasks,
                   payouts, disputes, points/levels, competitions, RLS
scripts/           site checker, preview server, identity exporter, image guard
apps/web/assets/identity/   SVG masters + verified PNG exports + DESIGN_BRIEF.json
docs/              BRAND.md, BRAND-SKILLS.md, LEAD-CAPTURE.md, USER-GUIDE.md, ADMIN-GUIDE.md
```

## What is actually wired today (do not overstate)

- **Proven live at the database level:** visitor → `submit_lead` RPC → referral
  code, queue position, outbox event. The waitlist form itself is not on any
  page today. See `STATUS.md` and `PROOF/`.
- **Wired in the browser:** phone-OTP sign-in from the landing page
  (`apps/web/index.html` + `auth.js` + `landing.js`), the promoter dashboard
  (tasks, proof, redeem, referrals, payout account — `dashboard.html`), the
  business console (`business.html`: owner verification, campaign creation,
  payment link, payments), the admin console (`admin.html`) and the reviewer
  queue (`approval-queue.html`).
- **Not built:** the partner portal.
- **Blocked on external providers/owner decisions:** Termii API key (SMS),
  the data-provider credentials behind the twenty5/vtung failover
  (`providers/dataManager.mjs` is wired; without credentials a data
  redemption is refused loudly and stays reversible), Flutterwave merchant KYC,
  trademark/CAC/domain clearance.


## Pre-launch truths (do not edit these away without proof)

- Lead capture IS implemented: `submit_lead` RPC + referral engine + outbox events proven live (14/0/0).
- `noindex` stays until the SEO-D1 removal trigger is met (see amplo `docs/SEO.md`).
- RLS policies are deployed AND PROVEN — staging with real JWTs verified 14/0/0 (2026-10-05).
- "Promota" cleared a web prior-art check only. Trademark + CAC + domain: UNVERIFIED.
- Oracle fix (0007) applied: duplicate phone returns identical success shape — no membership leak.
