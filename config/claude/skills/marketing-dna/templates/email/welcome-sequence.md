# Welcome Sequence — Freemium Funnel (Magic Lantern)

Triggered when a user completes `EmailGate` (free tier signup, no subscription). Goal: walk them from Schwartz Stage 2 to Stage 5 over ~7 days, ending in a paywall hit primed to convert.

If the user subscribes mid-sequence, pivot to a SUBSCRIBED sequence (last template at bottom).

## Send schedule

- T+0: Welcome email (immediate, transactional-feeling)
- T+1 day: Story email (Cole's origin)
- T+2 days: Mechanism email (how the model works)
- T+4 days: Social proof email (last card recap)
- T+5 days: Objection-killer (Cialdini + Hormozi)
- T+6 days: Soft pitch w/ stack
- T+8 days: Hard pitch w/ scarcity (founding rate)

7 emails total. Tailored to CombatCall's freemium funnel + 7-day cadence between UFC cards.

## Voice + format rules

- Plain-text feel. Minimal formatting. Single column. NO image-heavy templates — those feel like newsletters, not from Cole.
- Cole writes. First-person. "I." Not "we."
- Subject lines: lowercase, conversational, often a question.
- One CTA per email. Same destination across the sequence (the paywall page).

---

## Email 1 — Welcome (T+0)

**Subject:** you're in. here's how this works.

```
Hey —

You just signed up for CombatCall. Here's the deal:

→ Every UFC card, you get the three lowest-bout-order fights free. Forever.
  That's prelims, usually.
→ The other fights (main card) are locked unless you subscribe.
→ I'm Cole. I built this because I was tired of losing money to UFC betting.
  More on that tomorrow.

If you want to see how the model picks fights, the three free fights are
available now in the app. No card required.

[ See Free Picks → app.combatcall.com ]

Tomorrow I'll tell you the embarrassing story of why this exists. It involves
me buying picks from "experts" for too long and finally getting tired of it.

Cole
combatcall.com
```

---

## Email 2 — Origin story (T+1 day)

**Subject:** Why I stopped buying UFC picks from "experts"

```
True story —

I've been a serious MMA fan for years. Watched every card. Read every preview.
Knew the rankings.

I thought I had an edge betting UFC. I didn't. For a long time I lost more
than I made.

So I tried the obvious thing — I bought picks from "experts." Tipsters with
big followings, $50 Discord rooms, "lock of the day" Twitter guys. Most of
it turned out to be gut feeling dressed up as analysis. *"He's looking sharp."*
*"She's ready to surprise people."* That's not analysis. That's vibes.

What was killing me:

  - Heavy favorites I "knew" couldn't lose — that still juiced my account when
    they won, because I was paying so much vig.
  - Hype underdogs the Twitter guys swore had the better striking. They didn't.
  - Tipsters who went silent the weeks they lost and shouted the weeks they won.

Three or four months ago I got tired of it and started building my own model.
Power-accuracy. Grappling control. Camp moves, weight cuts, ring rust. The same
factors the books are looking at when they set the lines. Trained on every UFC
fight since 2010.

My bankroll's been up since I started using it.

> *Email-discipline note:* the previous draft of this email used fabricated
> specifics — a $3,400 loss amount, "Khamzat" as a specific fighter reference,
> "Florida legalized" as a specific timeline anchor, "53% of those" as a loss
> rate, "March 2025 it was a real model" and "By June... four straight
> underdogs at +180" as specific model-validation milestones. None of those
> are confirmed by Cole. Removed. Do NOT reintroduce.

A buddy asked how I was doing it. I showed him the spreadsheet. He told me to
turn it into an app.

That's CombatCall.

UFC 30X drops this weekend. The three free fights are live. If you want to see
what the model thinks, link below.

[ See Free Picks → ]

Cole

P.S. tomorrow I'll show you the actual mechanism. The three components of the
score. Boring? Sure. But you don't want a black box.
```

---

## Email 3 — Mechanism (T+2 days)

**Subject:** here's the actual model (no black box)

```
Most pick services tell you "trust me." I don't trust them. I'm not asking
you to trust me either.

Here's how the CombatCall model actually works:

THREE INDEPENDENT SCORES, COMBINED.

  1. STRIKING SCORE — Power-accuracy ratio (sig strikes landed × power impact)
     decayed by recency. Adjusted for opponent caliber via Elo-style ranking.
     This is NOT just "strikes per minute" — power-weighting matters and most
     models skip it.

  2. GRAPPLING SCORE — Control time × submission attempt rate, normalized to
     weight class. Catches the underrated grapplers most pick services miss.

  3. SITUATIONAL SCORE — Camp changes, weight cuts, ring rust, cage size,
     prelim vs main, short-notice. The intangibles, quantified.

Each fight gets three scores. They get weighted by which type of fight it is
(stand-up battle vs grappling-heavy vs intangible-driven). Then we cross-
reference current odds for +EV.

That's the pick.

Trained on every UFC fight since 2010. ~5,200 fights of data.

You can see the actual output for the three free fights this week:

[ See Free Picks → ]

If you ever want to see HOW a pick was made — every subscriber view shows
the score breakdown. No black box.

Cole

P.S. Saturday morning the picks for UFC 30X drop. The first three are free
for you. The rest are for subscribers.
```

---

## Email 4 — Social proof (T+4 days)

**Subject:** UFC 30X wrap — here's how it did

(Note: this email is dynamic — write a new version each card. Below is a template.)

```
UFC 30X is in the books. Here's the model's card:

  PICK                    RESULT       PROFIT (1u stake)
  Main event underdog     HIT  +185    +$185
  Co-main favorite        HIT  -140    +$71
  Prelim winner           HIT  +120    +$120
  Prelim underdog         MISS         -$100
  Prop: KO yes/no         HIT  +220    +$220
  Prelim parlay           MISS         -$100

  Card P/L:               +3.96 units

Year to date: +37 units. (Full ledger at combatcall.com/picks.)

For context: the average bettor on a UFC card is -2 to -4 units. The "lock of
the day" Twitter accounts I follow are -7 on the year.

The first three picks were free for you this card. The rest were paywall.

The full card price is $25/month or $120/year — that's ~$10/month annual.

If you want the full card for UFC 30Y next week:

[ Get the Full Card → ]

Cole

P.S. one of these three numbers tells you the most: ledger up, public, single
math you can verify. No screenshot manipulation. No deleted tweets.
```

---

## Email 5 — Objection killer (T+5 days)

**Subject:** the 4 reasons people don't subscribe (and what I say)

```
Most people who sign up for the free version never subscribe. I get it.
Here's what I usually hear:

OBJECTION 1: "Pick services are all scams."
ANSWER: True for most. Look at the ledger. Public. Auditable. Every pick we
ever made, since launch, with the math. No screenshots, no edits, no Discord
that disappears.

OBJECTION 2: "I don't bet enough for it to matter."
ANSWER: At $25/mo or $120/year, you need ONE good underdog pick to pay for it.
The model called four straight underdogs in March-April 2025. One hits, you're
covered for the year.

OBJECTION 3: "Sportsbooks will limit my action."
ANSWER: Not at modest stake sizes. The bankroll guide tells you how to bet
correctly to stay under the radar. Most subscribers bet $20-200 a fight and
never get limited.

OBJECTION 4: "What if I cancel?"
ANSWER: One click in the Stripe portal. 30-day prorated refund on annual.
Three free picks stay yours forever — even after cancel.

If any of those was your reason, now you know.

[ Subscribe → ]

If you're STILL on the fence: use the free fights for one more card. Decide
after that.

Cole
```

---

## Email 6 — Soft pitch w/ stack (T+6 days)

**Subject:** what you actually get when you subscribe

```
Here's everything that comes with a CombatCall subscription:

  ✓ Every fight on every UFC card scored on +EV ............ $600/yr value
  ✓ Full fighter dossier per matchup ...................... $240/yr value
  ✓ Power-accuracy edge score + transparent model output .. $300/yr value
  ✓ Pre-card pick alerts (push + email, 4hr before bell) .. $97/yr value
  ✓ Bankroll Mastery PDF guide ............................ $97/yr value
  ✓ Public W/L ledger access .............................. $200/yr value
  ✓ Historical pick archive (since launch) ................ $200/yr value
  ─────────────────────────────────────────────────────────────────────
  Total value: ............................................ $1,734/yr
  Today: .................................................. $120/yr
                                                            (or $25/mo)

  Cancel anytime. 30-day prorated refund on annual.

UFC 30Y drops in 3 days. Subscribe before Saturday morning to get the full card.

[ Subscribe → ]

Cole

P.S. founding-member rate ($120/yr) is locked for the first 500 subs. After,
it goes to $150/yr. You're early. Lock it in.
```

---

## Email 7 — Hard pitch w/ scarcity (T+8 days)

**Subject:** last email about this

```
This is the last email I'll send about subscribing. Two things:

1. Founding-member rate ($120/yr) — locked for first 500 subs. After: $150/yr.
   We're approaching the cap. If $120/yr matters, do it now.

2. Free picks aren't going anywhere. Three picks every UFC card, free, forever.
   Even if you never subscribe.

I'm not going to email you again about subscribing for at least a month. If
you want it, the link is below. If not, see you at the prelims.

[ Subscribe → ]

Cole

P.S. if there's something specific blocking you that I haven't addressed —
hit reply. I read every email.
```

---

## SUBSCRIBED pivot email (replaces emails 4-7 if user subscribes mid-sequence)

**Subject:** you're in. here's what's next.

```
You subscribed. Welcome to the data bettors.

Here's how to get the most out of CombatCall:

1. Set up your push notifications in the app. Picks drop 4 hours before the
   first prelim every card.

2. The bankroll guide is in the Resources tab. Read it before you size up.

3. The model's reasoning is on every fight page — click any pick to see the
   breakdown.

4. Got a question, a complaint, an idea? Hit reply. Goes to my actual inbox.

Saturday morning the full UFC 30X card unlocks. Read the dossiers, place
bets that match your bankroll, and let me know how it goes.

Cole
```

---

## Notes for implementation

- Sequence engine: Klaviyo, Customer.io, or Postmark + a cron. King Arthur to pick.
- Trigger: `EmailGate` submission writes to `marketing_emails` table → webhook to email tool → sequence starts.
- If user converts to paid: pause cold sequence, fire SUBSCRIBED pivot, start paid sequence (NOT covered here — separate file when needed).
- Track: open rate, click rate, conversion rate per email. The pivot point is usually email 4 (the social-proof card recap). Tune it relentlessly.
- Marketing consent: only send to `marketing_emails.marketing_consent = true` (already implemented per memory).
