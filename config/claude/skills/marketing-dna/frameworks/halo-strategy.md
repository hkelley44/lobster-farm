# Halo Strategy — Sabri Suby's Framework

## What it is

A two-stage flywheel for converting cold paid traffic into warm earned traffic.

1. **Halo content engine** — you publish high-value free content on owned channels (blog, YouTube, X). Cold paid traffic gets pixeled when they hit your content.
2. **Retargeting** — those pixeled visitors get hit with direct-response ads. By then they trust you. Conversion rates 3-10x cold.

The "halo" is the perception of authority/value that wraps your brand by the time the prospect sees your sales asset.

See `authors/sabri-suby/frameworks.md` §3.

## Why it works (synthesis)

- **Cialdini's Reciprocity:** free content creates obligation.
- **Cialdini's Authority:** the content itself demonstrates expertise.
- **Cialdini's Liking:** repeated benign exposure → liking (mere-exposure effect).
- **Schwartz's Sophistication:** in Stage 4-5 markets, prospects don't trust claims — they trust demonstrated expertise. Content is the demonstration.
- **Brunson's Attractive Character:** the founder's voice in the content builds personal brand.
- **Hormozi's Lead Magnet logic:** Halo content IS a high-frequency, low-cost lead magnet at scale.

## Components

1. **A content hub you own** — your domain, not a Substack or YouTube alone. Cross-post but home base is yours.
2. **A consistent publishing rhythm** — weekly or better. Quality > quantity, but with a floor.
3. **A pixel/analytics layer** — Meta pixel, X pixel, TikTok pixel, Google Analytics, Vercel analytics, ALL of them. Tag every visitor.
4. **Custom audiences for retargeting** — visitors who hit the content but didn't sign up.
5. **A retargeting creative pool** — testimonial-style, mechanism-reveal, offer-led ads. Cycle them.
6. **A measurement loop** — CPL/CPA for cold vs warm retargeted. Halo works when warm CPA << cold CPA.

## Applied — CombatCall

### Content engine (start here, weeks 1-4)

- **X / Twitter (primary):** Cole posts pick threads every UFC card. Pre-fight breakdown, in-fight tracking, post-fight recap. Show the model's output. Show wins AND losses (credibility).
- **YouTube (secondary, higher leverage long-term):** 5-15 min fight card preview videos. The model's picks + reasoning. Upload Wednesday/Thursday before each card.
- **Reddit (high-leverage, low-effort):** comment intelligently on r/MMAbetting threads. Don't shill. Drop value. Link to combatcall.com in profile only.
- **Blog at combatcall.com/blog (medium-term):** SEO-targeting "best UFC betting tool 2026" and similar long-tail searches. Long-form, real depth.

### Pixel & audience layer (week 1)

- Meta pixel installed on combatcall.com + app.combatcall.com.
- X pixel installed.
- Define custom audiences:
  - All visitors past 30/60/180 days.
  - Watched 50%+ of YouTube video.
  - Read pick thread (track via UTM).
  - Signed up but didn't convert to paid.

### Retargeting (weeks 4-8, after content has run a month)

- 3 creative variations per warm audience.
- Mechanism creative: "Here's exactly how we picked Jiri vs Pereira. Three free fights this card."
- Testimonial creative (once you have testimonials): "Marcus, casual bettor: '+$847 in 3 cards.'"
- Offer creative: "Annual plan locks in $120 through fight week. Goes up after."

### The math to make Halo work

- Cold CPA goal: < 3-month subscriber LTV (= $25 × 3 = $75 minimum CAC ceiling).
- Warm retargeted CPA goal: 30-50% of cold (= $20-$35).
- If warm < cold by 2x, the Halo is paying its rent. Scale.
- If warm ≥ cold, the content isn't building authority. Fix content or audience targeting.

## Common mistakes

- **Halo content that's actually thinly-veiled sales pitches.** Prospects detect this instantly. The content must genuinely give value. Suby is dogmatic about this.
- **Going straight to paid before content exists.** Cold-only CPA is brutal. Build the halo first.
- **Retargeting too soon / too aggressively.** Wait until the visitor has had 2-3 exposures organically before showing them direct-response ads. Use the pixel's frequency caps.
- **Cross-channel mismatch.** YouTube content + Meta retargeting works (the prospect doesn't notice the platform shift). YouTube content + YouTube retargeting feels stalker-y.

## When NOT to use Halo

- Pre-product. If your product isn't shipping yet, content can build the audience but you have nothing to retarget for.
- Hyper-niche B2B with sub-100 prospects. Cold direct outreach beats Halo at this scale.
