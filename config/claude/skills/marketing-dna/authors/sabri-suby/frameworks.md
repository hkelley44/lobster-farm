# Sabri Suby — Frameworks

Sabri Suby is the founder of King Kong, an Australian direct-response agency that scaled to $10M+ in ~4 years on paid-traffic strategies. His book *Sell Like Crazy* (2019) codifies the 8-phase system. He's the operator's operator for paid-ad-driven funnels at scale.

## 1. The 8-Phase Sell-Like-Crazy System

The book's spine. Sequence matters.

1. **Understand & Identify Your Dream Buyer** — get pathologically specific. Demographics + psychographics + the actual language they use in their head when they think about the problem.
2. **Create the Perfect Bait for Your Dream Buyer** — the lead magnet. Solves a narrow pain completely, fast, free.
3. **Capture Leads & Get Contact Details** — opt-in page. Single column, single goal, no nav.
4. **The Godfather Strategy** — craft the irresistible offer (see #2 below).
5. **Traffic** — paid (Google + Meta primarily). Hit cold traffic at the top of the funnel.
6. **The Magic Lantern Technique** — content sequence (mostly email + remarketing) that walks them from cold → trusting (see #4 below).
7. **Sales Conversion** — the long-form sales page or sales call.
8. **Automate & Multiply** — turn the funnel into an autonomous machine, then scale spend.

**Applied — CombatCall.** Map directly:
1. Dream Buyer = 25-45 male, MMA fan, places real money on UFC cards, frustrated with hype-based picks, $25 is a rounding error in his betting account.
2. Bait = the 3-free-fights gate (already built). Also: "Last 5 Cards Reviewed" email.
3. Capture = `EmailGate` modal (already built).
4. Godfather offer = annual plan w/ stacked bonuses (see Offer Construction framework).
5. Traffic = X content + Reddit organic first (warm/content), THEN Meta paid once funnel proves.
6. Magic Lantern = pre-fight night email sequence (covered in `templates/email/welcome-sequence.md`).
7. Sales conversion = paywall page + Stripe checkout.
8. Automate = the entire stack is automated. Scale ad spend once LTV:CAC > 3:1.

---

## 2. The Godfather Offer

**What it is.** An offer so good your market literally cannot refuse it (Don Corleone reference). Components:
- Massive value stack
- Risk reversal (guarantee)
- Bonuses that solve specific objections
- Urgency / scarcity (real)
- Reframed pricing — "$X today, instead of $Y if you buy them separately"

This is essentially Hormozi's Grand Slam Offer expressed differently. Suby's version is more sales-page-coded; Hormozi's is more operator-coded.

**Applied — CombatCall.** See `frameworks/offer-construction.md` for the cross-author synthesis.

**Source.** *Sell Like Crazy*, Phase 4.

---

## 3. The Halo Strategy

**What it is.** A content + retargeting strategy that builds a "halo" of value around your brand BEFORE asking for the sale. You publish high-value content (blog posts, videos, free tools) on owned channels, then retarget visitors with paid ads across platforms. Visitors who consume content are dramatically more likely to convert when they hit a paid ad.

Functionally: convert paid-cold-traffic into earned-warm-traffic via free content, then retarget the warm-traffic w/ direct-response ads.

**Applied — CombatCall.**
- Free content engine: Cole's X account posts pick threads + fighter breakdowns. Cole's YouTube posts card preview videos.
- Pixel everything. Anyone who watches a video, reads a thread, hits the landing page → enters retargeting audience.
- Retargeting creative: testimonial-style ad ("Three free fights this card. If they don't hit, walk.") shown only to the warm halo.
- This is the long-term move that compounds. Start before paid ads ever turn on.

**Source.** *Sell Like Crazy*, Phase 5-6. King Kong's `kingkong.co` blog and YouTube channel are full of Halo content live.

---

## 4. The Magic Lantern Technique

**What it is.** A metaphor: prospect is in the dark, you hold the lantern, you light the path. Practically — an indoctrination sequence (usually email + retargeting) that takes a cold lead through Schwartz's awareness ladder (unaware → most aware) by delivering high-value free content in sequence.

**Mechanic.** After opt-in:
- Email 1: deliver the lead magnet. Set expectation for what's coming.
- Emails 2-4: educate. Tell stories. Reveal the mechanism. Each email = one false belief reversed (Brunson's Epiphany Bridge concept used in service of Suby's Lantern).
- Email 5-7: pitch the Godfather offer. Stack value. Reverse risk.

**Applied — CombatCall.** See `templates/email/welcome-sequence.md`.

**Source.** *Sell Like Crazy*, Phase 6.

---

## 5. The Dream Buyer Persona (Halo Method for personas)

**What it is.** A research-heavy persona doc. Suby's twist: don't just list demographics. List the *language* the prospect uses internally and externally about their problem. Lurk in Reddit/forums/comment sections. Steal their words verbatim and put them in your headlines.

**Applied — CombatCall.**
- Lurk: r/MMA, r/MMAbetting, r/sportsbook, MMA Twitter, Discord MMA betting servers.
- Steal language patterns. Examples to mine: "I'm tired of getting cooked by underdogs," "Tank Davis vs Ryan Garcia all over again," "I need a -EV alarm," "Pelican picks," "bankroll preservation."
- Build a swipe file at `~/.lobsterfarm/entities/combatcall/files/marketing/dream-buyer-language.md` (Tristan creates this on first session).

**Source.** *Sell Like Crazy*, Phase 1.

---

## 6. The Long-Form Sales Page Architecture

Suby is religious about long-form direct-response sales pages. Structure he advocates:

1. **Pre-headline** — small text, sets the avatar ("Attention: UFC bettors who lost money on UFC 300...")
2. **Headline** — biggest promise + dream outcome + mechanism, in one sentence.
3. **Sub-headline** — twist or proof.
4. **Lead** — agitate the pain. Open the wound.
5. **Story** — your origin story or a customer's. Epiphany Bridge.
6. **Mechanism reveal** — WHY this works when nothing else has. (Schwartz Stage 4 territory.)
7. **The offer** — stacked value, broken out line by line.
8. **Bonuses** — each one solves an objection.
9. **Guarantee** — risk reversal.
10. **Scarcity / urgency** — real, not fake.
11. **FAQ** — pre-empt remaining objections.
12. **Final CTA** — restate offer, restate guarantee, ask for the action.

**Applied — CombatCall.** See `templates/landing-pages/sales-page.md` for a filled-in version.

**Source.** *Sell Like Crazy*, Phase 7. Pattern visible across King Kong client sales pages.

---

## 7. YouTube Ad Script Formula — Hook / Educate / CTA

**What it is.** Suby's 3-part framework for YouTube/video ads.

- **Hook (first 5-10 sec):** pattern interrupt + qualifier. Polarizing. Should make the wrong audience click away (saves you money on retargeting).
- **Educate (60-90% of the runtime):** deliver real value. Demo the mechanism. Build trust by showing you actually know your shit.
- **CTA (last 15-20 sec):** ONE ask. Soft, but clear. ("If you want the full breakdown of every UFC fight before Saturday, link in description.")

**Applied — CombatCall.**
- Hook: "If you've ever lost money on a heavy favorite because you 'felt' it, this 90 seconds will save your bankroll."
- Educate: walk through a real fight you called correctly. Show the data. Show the pick. Show the result.
- CTA: "Three free picks every card at combatcall.com. No card required."

**Source.** Suby's YouTube (`@SabriSubyOfficial`), various ad teardowns and his AdSpend community.

---

## 8. The Larger Market Formula

**What it is.** The buying-tier breakdown of any market. Suby borrowed from Schwartz + Chet Holmes. Of any 100 potential buyers:
- 3% are buying NOW (top of pyramid)
- 17% are gathering info / open to it
- 20% are problem-aware but not solution-aware
- 60% are NOT in the market

Most marketers chase the 3%. Suby's argument: the 17% + 20% is where the leverage is. Lead-magnet funnels capture them; the 3% buy anyway.

**Applied — CombatCall.** The 3-free-fights gate captures the 17% (info-gatherers) brilliantly. The X content strategy reaches the 20% (problem-aware: "I keep losing on UFC bets"). Don't waste paid-ad spend chasing only the 3%.

**Source.** *Sell Like Crazy*, Phase 1. Chet Holmes' *The Ultimate Sales Machine* (the original).

---

# Net-new additions 2026-06-09

The first pass got the canonical 8-phase system. These additions surface Sabri's **17-point funnel/sales-page checklist** (the operating practice), **the Lead Quality vs Lead Quantity thesis** (recent emphasis), **the ad-hook testing protocol** (specific operating practice), and **the Disney funnel breakdown** he uses as a teaching anchor.

## 9. The 17-Point Sales-Page / VSL Checklist

Sabri's actual line-by-line checklist for any direct-response sales page or video sales letter. Source: synthesis from his King Kong teardowns and Naja Faysal's notes from a $100K/day funnel breakdown (see sources.md).

1. **Call out your audience** — narrow avatar identification ("Attention: UFC bettors who...")
2. **Demand their attention** — pattern interrupt
3. **Back up the promise** — early proof/credential signal
4. **Create irresistible intrigue** — open loop
5. **Shine a light on the problem** — agitate
6. **Provide a solution to the problem** — bridge to the offer
7. **Show your credentials** — authority signal
8. **Detail the benefits** — lived outcomes, not features
9. **Social proof** — testimonials, case studies, numbers
10. **Make a godfather offer** — the can't-refuse stack
11. **Add bonuses** — each one reverses a specific objection
12. **Stack the value** — itemized $-value-per-element vs the price
13. **Reveal your price** — late, AFTER value is stacked
14. **Inject scarcity** — real, time-bound, or quantity-bound
15. **Give a power guarantee** — risk reversal
16. **Call to action** — single, unmistakable, repeated
17. **End with a P.S.** — restate the offer + the guarantee + the deadline

**The caveat (per modern critics).** This checklist is high-velocity direct response and can feel pushy / "attention-hungry" for premium / brand-led / B2B audiences. For CombatCall — consumer, transactional, time-bound (fight night) — this checklist FITS the medium. For a future LobsterFarm entity in luxury or B2B, dial back items 14 (scarcity) and 17 (P.S.) and lean more on item 9 (social proof) and item 8 (benefits).

**Applied — CombatCall.** Use this as the literal review checklist on `templates/landing-pages/sales-page.md` before any push to production. 17/17 = ship. <14/17 = rewrite.

**Source.** Naja Faysal funnel-checklist breakdown of Sabri's $100K/day funnel; consistent with the long-form structure Sabri teaches in Phase 7 of *Sell Like Crazy*.

---

## 10. The Lead Quality > Lead Quantity Thesis (post-2023 emphasis)

Sabri's most-repeated recent claim: **you don't have a sales problem. You have a lead problem.** And the lead problem is QUALITY, not VOLUME.

**The breakdown.**
- More leads of the wrong type → wasted sales bandwidth, low conversion, churn.
- Fewer leads of the right type → high conversion, sustainable LTV, scalable.
- The system you build should ATTRACT *and* QUALIFY in the same motion.

**Suby's quote (paraphrased from multiple talks):** *"The person who gives the most value upfront wins."*

**Mechanisms for built-in qualification:**
- Lead magnets with self-selecting content (only people serious about the problem will read 20+ pages).
- Quizzes / score-based gating (the quiz itself asks the qualifying questions).
- Friction on the opt-in (small but real — proves intent).
- Educational drip (auto-prunes the not-serious).

**Applied — CombatCall.** The 3-free-fights gate is GOOD because it self-qualifies (you have to want to bet UFC enough to read 3 picks). Make this stronger:
- Add ONE qualifying question to the EmailGate: "What's your typical bet size?" (Multiple choice: <$10 / $10-50 / $50-200 / $200+.) Now the email list has size-of-bet metadata for downstream targeting.
- Add a second question: "Are you trying to (a) win more money, (b) stop losing money, (c) just have fun?" The answer determines which downstream email sequence they enter.

**Source.** Sabri's Tai Lopez podcast appearance + multiple King Kong YouTube videos. See sources.md.

---

## 11. The Ad-Hook Testing Protocol

Sabri's specific operational practice for any paid creative.

**The protocol.**
1. Write 8-15 hooks for the same core ad. (Hook = first 3-7 seconds of video, or first sentence of static.)
2. Shoot/produce each hook separately with the SAME body content.
3. Run each as its own ad set, equal budget.
4. After 48-72 hours, kill the bottom 80%.
5. Take the WINNING hook. Now produce 5-10 VARIATIONS of just that hook.
6. Re-test. Find the winning-winner.
7. Run that one until performance drops by ~30%, then re-test from step 1.

**Why hooks specifically.** Hooks have outsized leverage — they decide whether the rest of the ad gets watched at all. A 2x better hook = a 2x cheaper customer.

**Applied — CombatCall.** First paid campaign should NOT be "12 different ads." It should be "1 ad body, 12 different hooks." Variations:
- "If you bet UFC, you're leaking money."
- "I bought picks from tipsters. They were guessing. So I built this."
- "Here's what nobody tells you about closing-line value."
- "The smartest UFC bettors don't trust their gut."
- "Stop guessing on UFC cards."
- (...etc.)

**Source.** Sabri's YouTube ad teardowns + Tai Lopez interview. See sources.md.

---

## 12. The Disney Funnel — Sabri's Teaching Reference

Sabri's go-to public example for how a perfect long-cycle funnel looks in the wild — Disney's.

**The structure (as Sabri teaches it):**
1. **Bait** — Disney movies and Disney+. Cheap or free entry into the brand world.
2. **Tripwire** — Disney merchandise (Mickey ears, plush toys). Tiny first transactional commitment. Identity claim — "we're a Disney family."
3. **Mid-tier offer** — Disney Cruise / Disney Hotel stays. ~$5K spend.
4. **High-ticket** — Disney World vacation packages. ~$10K+ per family.
5. **Premium** — Disney Club 33 / VIP tours. Limited-access tier.
6. **Continuity** — Disney+ subscription, magazines, recurring memberships.

**The principle.** Every tier ASCENDS the customer up the value ladder without forcing the jump. Each tier delivers REAL value AND warms the customer for the next. Each tier RE-ENGAGES the kid-in-them (or the parent's nostalgia).

**Applied — CombatCall (future-state Value Ladder, mapping to Disney's pattern):**
- Bait: free 3 fights/event.
- Tripwire: $1 first-month trial. (Not yet built. Worth testing.)
- Mid-tier: $25/mo or $120/yr subscription. (Live.)
- High-ticket: $300-500 "Bankroll Mastery" course + Discord community. (Future.)
- Premium: $1,500-5K/yr "Edge Syndicate" — invite-only group bet syndicate with full transparency. (Future.)
- Continuity: the subscription itself.

The Disney pattern says CombatCall is missing a tripwire and a premium tier. Both are future Tristan/Bedivere work.

**Source.** Sabri's Facebook video "Disney's master sales funnel" — facebook.com/sabrisubyofficialpage/videos/disneys-master-sales-funnel. See sources.md.

---

## 13. The Platform-Specific Creative Rule

Sabri's recent clarification on creative-by-platform.

- **Facebook / Instagram** — image, short video (3-15 sec), carousel. Lean on POLARIZING / curiosity-driven hooks. Lower attention budget.
- **YouTube** — long-form video (3-15 min). Lean on EDUCATIONAL / mechanism-revealing creative. Higher attention budget. Best place to demo the product.
- **TikTok / Reels** — fast, raw, founder-led. Pattern-interrupt hooks. Authentic > polished.
- **Google Search** — intent-led. Demand capture, not demand generation. Use to harvest people already searching for the solution.

**Applied — CombatCall.** Paid spend allocation, when it turns on:
- 40% YouTube (Cole-led card preview videos — the long-form demo)
- 30% Meta (short-form retargeting on Halo-warmed audiences)
- 20% Reddit (organic + promoted on r/sportsbook, r/MMA, r/MMAbetting)
- 10% Google Search (capture "UFC betting tool" + long-tail searches)

**Source.** Sabri's Tai Lopez interview + King Kong YouTube.
