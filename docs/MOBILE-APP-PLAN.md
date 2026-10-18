# Promota Mobile App Plan (Android & iOS)

**Status: PLAN — NOT SHIPPED.** Today Promota is a responsive web app (vanilla HTML/JS served by `apps/web`, one API). This doc is the recommended path to a real mobile presence without burning the runway on the wrong stack, and it is explicit about what exists today versus what would be new work.

## The Nigerian reality (why PWA-first)

- **Android dominates the promoter demographic.** Nigerian phones are overwhelmingly budget Android (Tecno, Infinix, itel) on metered data. An app that must be downloaded before its value is visible loses most of the funnel at the download screen.
- **PWAs install without review friction and cost nothing in extra code** — one web codebase already serves every screen this product needs (OTP login, task boards, earnings, admin). Konga, the largest Nigerian e-commerce case, cut first-load data by ~92% going PWA-first.
- **Store review roulette is the wrong tax today**: every release would queue for Play/App Store approval and can be rejected on policy quirks (many of which touch rewards/referral products especially hard). A promoter-facing rewards app wants instant hotfix capability.
- **iOS share (~10–15%) skews to high-LTV urban users.** A PWA serves iPhone Safari today; a native iOS build matters only once push-completeness of signup is proven to need it.

## What exists already (no new work needed)

- Fully responsive layout, light/dark themes, branded identity set (`apps/web/assets/identity/*`), skip-links and semantic nav — all passable on a phone browser today at the Railway URL.
- Phone-OTP session flow; dashboard; admin console.
- **Gaps to close for "installable" status** (phase 1 work): `manifest.webmanifest` (name, icons at 192/512, theme colors matching `theme-boot.js`), a minimal service worker for offline shell/loading screen, and an "Add to Home screen" onboarding nudge.

## Recommended path

### Phase 1 — Installable PWA (weeks, not months; do first)
1. Web manifest + service worker (offline app shell, cache-first for identity/CSS, network-first for API).
2. iOS Safari → "Add to Home Screen" is a first-class install path; add the iOS `apple-touch-icon` (already present) and `standalone` meta.
3. Push via Web Push once rewards SMS needs a fallback (iOS ≥16.4 supports Web Push from an installed app).

### Phase 2 — Android presence without a rewrite (TWA)
When store discoverability is genuinely needed: a **Trusted Web Activity** — a thin Play-Store wrapper around the live PWA. One lightweight Play review at publish time, then deployments stay decoupled from store releases. Cost is a Bubblewrap config + asset links file, not a codebase.

### Phase 3 — React Native (only on a real trigger)
Move to a shared-codebase native app (Expo is the default manager for this stack: OTA updates, one TS codebase, camera/liveness for KYC) **only if** at least one of these becomes true:
- Automated proof-of-post requires camera/liveness/accelerometer that PWA APIs won't provide;
- Push-dependent streak mechanics need guaranteed delivery Web Push can't give on target devices (Transsion battery optimizers throttle this for native too);
- Play/App store-exclusive distribution deals arrive.

React Native would reuse the whole web API unchanged — the app talks to the same `/api/*` contract while the PWA continues to exist (it is also the admin console home).

## Priority order for promoter value today

1. **PWA manifest + offline shell** — makes "the app" installable in a browser with zero server change.
2. **Android TWA** — Play Store listing only when listing itself is the ask (marketing/search).
3. **Expo RN** — only on the triggers above; not planned work until then.

Nothing above is built yet — Phase 1 items are the ones this repo can pick up in a single change set (manifest + service worker + nudge), which is the recommended immediate deliverable.
