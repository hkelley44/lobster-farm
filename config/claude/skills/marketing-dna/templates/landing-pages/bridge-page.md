# Bridge Page Template

A bridge page sits between a paid ad and the main landing page. It "pre-frames" the visitor — primes them for the offer before they hit the heavy sales asset. Brunson + Cialdini pre-suasion territory.

## When to use a bridge page

- Cold paid traffic where direct-to-landing has low conversion.
- When the ad creative makes a specific claim you need to deliver on before pitching.
- When the offer needs context that doesn't fit in an ad's character limit.

## Structure

```
[Quick hook — connects to the ad creative]
[Brief context — 1-2 paragraphs]
[Value delivery — give them what was promised in the ad]
[Soft transition to the offer]
[Single CTA → main landing page]
```

## CombatCall worked example — bridge from a "1 stat" ad

(Ad promised: "The 1 stat that predicts 73% of UFC fights.")

```
You clicked because I claimed there's ONE stat that predicts 73% of UFC fights.

Here it is.

POWER-ACCURACY RATIO weighted by recency.

Most analytics show "significant strikes per minute" or "striking accuracy."
Both are wrong on their own.

Significant strikes per minute counts jabs the same as overhand rights. Striking
accuracy ignores damage. Neither correlates strongly with actual fight outcomes.

POWER-ACCURACY RATIO = significant strikes landed × power impact (KO threat
proxy), then weighted by recency (last 3 fights count more) and opponent
caliber.

When we backtested this against every UFC fight since 2010, it correctly
predicted the WINNER 73.2% of the time on its own — before adding grappling,
situational, or any other signal.

That's the stat.

Now: knowing the stat doesn't mean you'd bet it correctly. You also need the
power-accuracy data per fighter, per matchup, weighted properly. Doing this by
hand takes hours per fight.

We did it for every fight on the next UFC card.

[ See the Picks → ]

Cole
combatcall.com
```

## Why this works

- **Delivers the ad's promise immediately.** No bait-and-switch. Cialdini's reciprocity at work.
- **Demonstrates mechanism (Schwartz Stage 3-4).** Shows the work.
- **Authority signal.** Specific numbers, specific methodology.
- **Soft pivot to the offer.** Doesn't sell hard — bridges to the main landing.

## When NOT to use bridge pages

- When ad creative IS the bridge (a 60-second video ad that delivers value can hand off direct-to-landing).
- For retargeted warm traffic — they don't need re-priming.
- When the main landing is itself short + punchy. Bridge + short landing = doubled work for no lift.

## Implementation notes

- Bridge page lives at a unique URL: `/learn/power-accuracy` or similar.
- Pixel + tag for the bridge → main landing CTR.
- Bridge pages typically convert lower than direct-to-landing on COLD traffic, but produce HIGHER-quality sign-ups (longer LTV, better activation).
- Test: 50% of ad traffic to bridge → main, 50% direct → main. Measure not just conversion but 30-day LTV. The bridge often wins on LTV.
