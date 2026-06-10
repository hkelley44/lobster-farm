# Funnel Architecture — Cross-Author Synthesis

## The core concepts

- **Brunson's Value Ladder** — staircase of offers, low → high.
- **Brunson's Funnel Stacking** — multiple funnels chained, each ascending the customer up the ladder.
- **Suby's 8-Phase System** — operational sequence of a single conversion funnel.
- **Hormozi's CFA (Client-Financed Acquisition)** — front-end revenue covers acquisition cost.
- **Schwartz's awareness stages** — what stage your funnel entrance traffic is at determines its design.

## A funnel is

A specific sequence of pages + assets designed to move a prospect from awareness state A to awareness state B and either capture or close.

Not a website. A site is broad and exploratory. A funnel is narrow and conversion-shaped.

## The CombatCall funnel (current, as of 2026-06-09)

```
COLD TRAFFIC (paid + organic)
   │
   ├──► combatcall.com (landing)
   │      • Hero w/ video, founder quote, stats band, features, pricing, FAQ
   │      • Stage 2-3 calibrated. Generalist.
   │      • CTA → app.combatcall.com
   │
   ▼
app.combatcall.com (app)
   │
   ├──► EmailGate modal (anonymous user)
   │      • Captures email + marketing consent → marketing_emails table
   │      • Marketing-only — no auth.users row
   │
   ▼
FREE TIER (email captured, no auth)
   │
   ├──► User browses, sees 3 free fights/event
   │
   ├──► User clicks a locked (non-free) fight → PaywallModal
   │      • shows $25/mo and $120/yr
   │      • CTA → /api/createCheckoutSessionPublic
   │
   ▼
STRIPE CHECKOUT
   │
   ├──► Successful payment → checkout.session.completed webhook
   │      • Creates auth.users row w/ throwaway password
   │      • Creates public.users row (or upserts existing)
   │      • Sets subscription_active = true
   │      • Copies marketing_consent from marketing_emails
   │
   ▼
/paymentsuccess
   │
   ├──► Prompts user to set password (claim flow via /api/setPasswordFromCheckout)
   │
   ▼
SUBSCRIBED USER
   │
   ├──► Full app access. Stripe Customer Portal for billing.
```

## Where the funnel is strong

- Email capture before paywall = recoverable lead even if they bounce.
- Free 3 fights = Suby's "perfect bait" + Hormozi's lead magnet, all in one.
- Stripe Customer Portal handles cancel/upgrade with no custom UI debt.
- Annual plan offered with no friction — CFA-friendly.

## Where the funnel is weak (Tristan's first-pass audit)

### 1. No nurture sequence between email capture and paywall hit

After EmailGate captures the email but BEFORE the user hits the paywall modal, there's no email touch. The Magic Lantern is missing.

**Fix.** Drip 5-7 email sequence after EmailGate opt-in. See `templates/email/welcome-sequence.md`. Sequence runs even if the user converts to paid mid-flow (the sequence pivots in that case — see template).

### 2. Paywall modal probably underselling

The current PaywallModal (per memory: `src/components/usePaywall.js`) likely shows price + button. Hormozi/Suby standard: full Stack visualization, bonuses, guarantee, risk reversal — even in a modal.

**Fix.** Redesign PaywallModal to show stacked value (see `frameworks/offer-construction.md`), guarantee language, social proof counter ("X bettors subscribed"). A 600px-tall modal is fine; conversion improves with the right content density.

### 3. No abandoned-cart recovery

If a user opens checkout and bounces, there's currently no follow-up. Stripe Checkout has session abandonment data + email. Hook it.

**Fix.** Webhook on `checkout.session.expired` (Stripe sends this after 24 hours). Trigger an abandoned-checkout email sequence. See `templates/email/abandoned-cart.md`.

### 4. No reactivation flow

When a user cancels, currently no win-back sequence. SaaS reactivation rates of 5-15% are normal with a good sequence.

**Fix.** Webhook on `customer.subscription.deleted`. Send a 3-email win-back. See `templates/email/reactivation.md`.

### 5. No Value Ladder above $120/yr

Annual is the top of the current ladder. Big LTV ceiling. Future moves:
- **Bankroll Mastery course** ($297-497, one-time). Discord access included.
- **Private syndicate / VIP fight-week calls** ($1,500-3,000/yr). Capped seats.
- **1:1 bankroll consulting** (Cole's time — limited). $500/session.

Don't ship these immediately. Validate the core funnel converts. Then build ladder rungs.

## A funnel architecture rule of thumb

**Hormozi's CFA test.** Take your average new-customer revenue in the first 30 days. Divide by your customer acquisition cost. If > 1, you can scale ad spend indefinitely without raising capital. CombatCall's annual plan ($120 collected day 1) makes this trivially achievable if CAC < $120, which it should be for a sub-$30 LTV-per-month product.

**Push the annual plan hard at checkout.** It's the CFA unlock.
