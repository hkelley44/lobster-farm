# Abandoned Checkout Sequence

Triggered when a user opens Stripe Checkout but doesn't complete. Three emails over 5 days.

Stripe sends `checkout.session.expired` after 24 hours. Use that as the trigger. (If `checkout.session.completed` fires within 24h, cancel the sequence.)

## Email 1 — Same day (T+3 hours)

**Subject:** something happen?

```
Saw you started checkout but didn't finish. Could be:

  - Phone died
  - Got distracted
  - Hesitated on the price

If it's the first two, here's the link to pick up where you left off:

[ Resume Checkout → ]

If it's the third — hit reply, tell me what you were thinking. I read
every email.

Cole
```

## Email 2 — T+2 days

**Subject:** the only objection I can't answer

```
Two days ago you started subscribing. Didn't finish.

I've thought about why people bail at checkout. Honestly there's only one
objection I can't answer: "I'm not sure I'll use it enough to matter."

Here's the math I'd run if I were you:

  - $120/yr ÷ 12 UFC cards = $10/card
  - Average UFC card has 3 picks the model loves
  - You'd need ONE underdog to hit (+150 or better, $20 stake) to break
    even on the year

If you watch UFC and bet AT ALL — even casually — the math works.

If you don't — you shouldn't subscribe.

[ Resume Checkout → ]

Cole

P.S. the founding rate ($120/yr) doesn't last forever. Going to $150 at
500 subs.
```

## Email 3 — T+5 days

**Subject:** last one about this

```
Five days ago you started checkout. Last email I'll send about it.

The free three fights every card are yours forever. You don't have to
subscribe to get those. You're already in.

If you want the full card next time:

[ Resume Checkout → ]

If not — no problem. See you at the prelims.

Cole
```

## Implementation notes

- Stripe webhook on `checkout.session.expired` → triggers sequence.
- Stripe webhook on `checkout.session.completed` BEFORE T+5 days → cancels remaining emails.
- Pull email from the Stripe session's `customer_email` field.
- Suppress if user is already on the welcome sequence (avoid double-sending).
