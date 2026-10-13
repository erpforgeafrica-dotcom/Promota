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
npm test      # phone+lead client (41), API layer (48), image contents (7),
              # ledger (56), lead capture (41), points (56) — ~250 checks
npm run site  # page integrity: anchors, assets, SEO basics, theme switch, a11y tokens
npm run serve # preview at http://127.0.0.1:8080 (loopback only)
```

## Layout

```
apps/web/          landing page + lead form (lead capture IS live: submit_lead RPC)
api/               production API: OTP sessions, tasks, redeem, referrals, worker
providers/         Termii (SMS/OTP), Flutterwave (bank transfers), data (parked)
db/migrations/     Supabase schema 0001-0009: RBAC, ledger, escrow, tasks,
                   payouts, disputes, points/levels, competitions, RLS
scripts/           site checker, preview server, identity exporter, image guard
apps/web/assets/identity/   SVG masters + verified PNG exports + DESIGN_BRIEF.json
docs/              BRAND.md, BRAND-SKILLS.md, LEAD-CAPTURE.md, USER-GUIDE.md, ADMIN-GUIDE.md
```

## What is actually wired today (do not overstate)

- **Wired end to end (proven live):** visitor → lead form → `submit_lead` RPC →
  referral code, queue position, outbox event. See `STATUS.md` and `PROOF/`.
- **API implemented but not yet surfaced in the UI:** phone-OTP login, promoter
  task list/submit, referrals, points→data/cash redemption, Flutterwave webhook,
  outbox worker. The landing page does not yet link to these.
- **Not built:** admin dashboard, advertiser/campaign manager UI, partner portal.
- **Blocked on external providers/owner decisions:** Termii API key (SMS), a
  data-bundle aggregator (nothing configured — data redemptions park as failed),
  Flutterwave merchant KYC, trademark/CAC/domain clearance.


## Pre-launch truths (do not edit these away without proof)

- Lead capture IS implemented: `submit_lead` RPC + referral engine + outbox events proven live (14/0/0).
- `noindex` stays until the SEO-D1 removal trigger is met (see amplo `docs/SEO.md`).
- RLS policies are deployed AND PROVEN — staging with real JWTs verified 14/0/0 (2026-10-05).
- "Promota" cleared a web prior-art check only. Trademark + CAC + domain: UNVERIFIED.
- Oracle fix (0007) applied: duplicate phone returns identical success shape — no membership leak.
