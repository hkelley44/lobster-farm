# Paywall Page / Modal Template

The page (or modal) shown when a free-tier user tries to access a locked fight. The "moment of truth" for the CombatCall freemium funnel.

## Current state (per CombatCall MEMORY.md)

`PaywallModal` lives in `src/components/`. Triggered by `useFightLocked` when a non-subscriber clicks a locked fight. Probably shows price + button only.

This template proposes a redesign — much more content density.

## Design rules

- Modal (not full page) — keep the context of the fight they were trying to view.
- Visible the moment they click.
- Single column. Max 600px tall on desktop, scrollable on mobile.
- Two clear CTAs: Subscribe Annual (primary) + Subscribe Monthly (secondary).
- Close button is small + offset. Not aggressive, but not too easy.

## Structure

```
[Headline — what they're getting blocked from]
[Stack visualization — what subscribing unlocks]
[Guarantee + risk reversal]
[Social proof — one stat]
[Two CTAs: annual (primary, ~30% savings highlighted) + monthly]
[Tiny print: cancel anytime, Stripe-secured, etc.]
```

## CombatCall worked example

```
┌─────────────────────────────────────────────────────────┐
│                                                    [×]  │
│                                                         │
│   This fight is part of the full card.                  │
│   You're seeing 3 free fights every event.              │
│   Subscribe to unlock everything.                       │
│                                                         │
│   ───────────────────────────────────────────────────   │
│                                                         │
│   WHAT YOU GET:                                         │
│                                                         │
│   ✓ Every fight scored on +EV ............ $600/yr      │
│   ✓ Full fighter dossier per matchup ..... $240/yr      │
│   ✓ Power-accuracy edge score + reasoning. $300/yr      │
│   ✓ Pre-card pick alerts ................. $97/yr       │
│   ✓ Bankroll Mastery PDF guide ........... $97/yr       │
│   ✓ Public W/L ledger access ............. $200/yr      │
│   ────────────────────────────────────────────────      │
│   Total value: $1,734/yr                                │
│                                                         │
│   ───────────────────────────────────────────────────   │
│                                                         │
│   Cancel anytime. 30-day refund on annual.              │
│   The model went +3.96 units last card.                 │
│                                                         │
│   ───────────────────────────────────────────────────   │
│                                                         │
│   ┌─────────────────────────────────────────────────┐   │
│   │     SUBSCRIBE — $120/YEAR  ($10/mo)            │   │
│   │     Save 60% vs monthly. Founding rate.        │   │
│   └─────────────────────────────────────────────────┘   │
│                                                         │
│   ┌─────────────────────────────────────────────────┐   │
│   │     Or $25/month                                │   │
│   └─────────────────────────────────────────────────┘   │
│                                                         │
│   Stripe-secured. Cancel anytime.                       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Why this beats a price-only paywall

- **Stack visualization** lifts perceived value 2-3x (Hormozi).
- **Social proof line** ("model went +3.96 units last card") reduces uncertainty (Cialdini).
- **Guarantee in the modal** kills the "what if I don't like it" objection at the decision moment.
- **Annual-primary CTA** drives CFA (Client-Financed Acquisition — Hormozi).
- **"Save 60% vs monthly" framing** anchors against the higher number, not the lower (Cialdini contrast).
- **Founding rate** = real scarcity (Cialdini).

## Variant A/B tests worth running

1. Headline copy — current vs "You're missing X picks tonight."
2. Stack length — full 7 items vs top 3 items only (some products convert better at shorter modal length).
3. Primary CTA wording — "Subscribe" vs "Unlock the Card" vs "Get the Picks."
4. Social proof line — "model went +X.X units last card" vs "1,247 bettors subscribed" vs nothing.
5. Modal vs full-page paywall.

## What NOT to do

- Don't add a "Maybe later" button — let the close (×) be the soft exit. "Maybe later" trains the user to keep saying maybe later.
- Don't fake the founding-rate counter. If the spots are sold, raise the price.
- Don't dark-pattern the close. The × is visible.

## Implementation notes

- Component: `src/components/PaywallModal.jsx` (existing).
- Both CTAs hit `/api/createCheckoutSessionPublic` (per memory — handles both auth + freemium states).
- Track open rate (how many fights are clicked while locked), close rate, conversion rate.
- For freemium users who close the paywall 3+ times in a session → consider a soft email nudge.
