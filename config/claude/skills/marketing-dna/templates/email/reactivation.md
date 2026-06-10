# Reactivation / Win-Back Sequence

Triggered when a paid subscriber cancels (Stripe `customer.subscription.deleted` webhook). Three emails over 14 days.

Goal: bring back 5-15% of cancellers. Win-back tends to convert at higher LTV than fresh acquisitions because they already know the product.

## Email 1 — T+1 day

**Subject:** sorry to see you go

```
You cancelled CombatCall yesterday. Two things:

1. The three free picks every card are yours forever. You don't lose those.
   I never want you to feel locked out of the free tier just because you
   tried the paid one.

2. If you'd tell me what didn't work, I'd appreciate it. Was the model off?
   Was it the price? Just didn't bet enough? Hit reply, I read everything.

If you want to come back later, the door's open. We're here.

Cole
```

## Email 2 — T+5 days

**Subject:** what changed since you left

```
Five days since you cancelled. Quick update on what's changed since:

  • New: independent grappling model is now its own score. Picks ground-game
    upsets the old striking-weighted model missed.
  • New: bankroll-sizing calculator in the Resources tab.
  • New: public W/L ledger at combatcall.com/picks. Every pick we made
    since launch, with the math.

UFC 30Y just hit. Model went +4.2 units on the card.

If you want back in, the founding rate is still locked ($120/yr).

[ Resume Subscription → ]

If not — see you in the free tier.

Cole
```

## Email 3 — T+14 days

**Subject:** $50 off if you come back

```
Two weeks since you cancelled. Last reach-out.

If you want back in, here's $50 off the annual plan: code WELCOME-BACK at
checkout. Brings it to $70 for the year.

If $70 for 12 months of full UFC card data + picks doesn't math out for
you, nothing will. And that's fine — the free tier is yours either way.

[ Resume Subscription → ]

Cole
```

## Implementation notes

- Stripe webhook on `customer.subscription.deleted` triggers sequence.
- The $50 off in email 3 — create a Stripe Coupon w/ a unique code that expires 30 days after issue.
- If user re-subscribes via Stripe portal before T+14, cancel remaining emails.
- Track conversion: % of cancellers who resubscribe within 30 days. Industry benchmark for SaaS: 5-15%.

## Soft win-back: subscriber-only newsletter

A lighter touch: keep cancellers on a monthly "what the model is doing" newsletter. NOT a sales pitch — just the highlights. Card recaps, big wins, big misses, model updates. Keeps the relationship warm. Low effort, high LTV win-back potential.

Send monthly. Same Cole voice. No CTA at the bottom — just brand mindshare.
