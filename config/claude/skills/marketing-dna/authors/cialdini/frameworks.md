# Robert Cialdini — Frameworks

Robert Cialdini is an emeritus professor of psychology + marketing at Arizona State. His 1984 book *Influence: The Psychology of Persuasion* (revised 2021) is the most-cited work on persuasion in academic + applied marketing literature. His 2016 follow-up *Pre-Suasion* extended the framework to the moment BEFORE the message.

## 1. The Seven Principles of Influence

The first six come from *Influence*. The seventh (Unity) was added in *Pre-Suasion* (2016).

### 1. Reciprocity

> "People are obliged to give back to others the form of a behavior, gift, or service that they have received first." — Cialdini

**The mechanism.** Giving creates psychological obligation. The receiver feels they "owe." Especially powerful when the gift is **personalized**, **unexpected**, and **meaningful**.

**Marketing patterns.**
- Free content (Suby's Halo + Magic Lantern leverages this).
- Lead magnets (Hormozi's framing leverages this).
- Unexpected bonuses inside the product.

**Applied — CombatCall.** The 3-free-fights gate IS reciprocity. Lean in: "We give you three free fights every event. Before you ever pay a cent. Because we know once you see the numbers, the rest sells itself." That phrasing *names the reciprocity* explicitly — which makes it more powerful, not less.

### 2. Commitment & Consistency

> "People like to be consistent with the things they have previously said or done." — Cialdini

**The mechanism.** Once someone takes a small action, they want to act consistently with that identity downstream. Especially powerful when commitments are **active**, **public**, **voluntary**, and **written**.

**Marketing patterns.**
- Email opt-in is a micro-commitment.
- Onboarding quizzes that surface goals (the user articulates their goal → now they're committed to it).
- Asking the buyer to write down WHY they bought.

**Applied — CombatCall.**
- `EmailGate` modal: not just "enter email." Add a small question: "What's your biggest UFC betting frustration?" Multiple choice. They click, they've committed.
- Onboarding (already exists): ask the user to articulate their bankroll goal. Now subscribing is consistent with their stated goal.
- Public commitment: encourage users to share their picks on Discord/X with the CombatCall data alongside. Now they're publicly aligned with the brand.

### 3. Social Proof

> "Especially when they are uncertain, people will look to the actions and behaviors of others to determine their own." — Cialdini

**The mechanism.** Uncertainty + similar others doing X → I do X. Especially powerful when the social proof comes from people **similar to the prospect**.

**Marketing patterns.**
- Testimonials. Reviews. Star ratings. Counters ("1,247 active subscribers").
- Specificity matters more than volume. "Marcus, gym owner in Tampa, dropped 23 pounds" > "thousands have lost weight."

**Applied — CombatCall.**
- Landing stats band (already exists, currently live Supabase counts). Make these specific: "X verified picks tracked. X% +EV closed last 12 cards. Y subscribers betting tonight."
- Once user count grows: "1,247 bettors on the card tonight" as a live counter.
- Testimonials w/ specific receipts: "I made $X following the model last 3 cards — @bettor_handle" (only ship with permission + verification — gambling claims need to be defensible).

### 4. Authority

> "People follow credible, knowledgeable experts."

**The mechanism.** Credentials, expertise signals, third-party endorsements reduce perceived risk and accelerate trust.

**Marketing patterns.**
- Founder credentials.
- "As seen in" press logos.
- Citing data sources.
- Affiliations / endorsements.

**Applied — CombatCall.**
- "Our model is trained on every UFC fight since 2010" — this is mechanism (Schwartz) AND authority (Cialdini). Numbers are the credential.
- "Featured on [MMA podcast X]" once Cole does podcast tours.
- Cole's personal credentials: data background, length of fan history, betting history (if it's a winning one — show the screenshots).

### 5. Liking

> "People prefer to say yes to those that they like."

**The mechanism.** We say yes to people we know, like, similar to us, who compliment us, who cooperate with us, who are attractive.

**Marketing patterns.**
- Founder-led marketing (you like the human, you like the brand).
- Story-based content (Brunson's Attractive Character).
- Matching customer language (Suby's Dream Buyer persona).

**Applied — CombatCall.** Cole IS the brand. Show his face. Show his Twitter. Show his actual betting receipts. Lean into the fact that he's a bettor, not a Vegas insider. That similarity matters.

### 6. Scarcity

> "People want more of those things they can have less of."

**The mechanism.** Loss aversion. Things in short supply become more valuable. Especially powerful when framed as what they'll LOSE, not what they'll GAIN.

**Marketing patterns.**
- Limited quantity / limited time.
- Early-bird pricing.
- Exclusive access.

**Applied — CombatCall (carefully).** Subscription SaaS makes "scarcity" awkward. Don't fake it. Real scarcity moves:
- Event-bound: "UFC 300 card preview drops in 48 hours. Subscribers get it first."
- Early-pricing tier: lock founding-member rate for first 500 subs (real, finite).
- Annual-plan launch promo: "$120/yr through fight week. Goes to $150/yr after."

### 7. Unity

> "Unity creates in-group alignment. Shared identity, co-creation and inclusive language reduce resistance by making influence feel like alignment rather than persuasion."

**The mechanism.** Cialdini's newest principle. "We" is stronger than "I like you." Unity is shared identity, not just affinity.

**Marketing patterns.**
- Tribe language ("Funnel Hackers," "Glossiers," "CrossFitters").
- Founder writing as a peer, not an authority.
- Community spaces (Discord, Skool, Circle).

**Applied — CombatCall.** Build the tribe identity over time.
- Tagline candidates: "Data bettors." "Bet from the numbers." "The +EV crew."
- A Discord community for paid subscribers — instant Unity moat.
- Founder communicates as a member of the tribe ("I lost on the same prop. Here's what the model said and why I overrode it. Don't be like me.").

---

## 2. Pre-Suasion — The Privileged Moment

**What it is.** Cialdini's 2016 extension. The MOMENT before your ask determines its success. By focusing the prospect's attention on a specific concept BEFORE the ask, you can dramatically shift their response.

**Key concepts.**
- **Privileged moment** — the window after a pre-suasive opener when your ask is unusually powerful.
- **Channeled attention** — humans assign exaggerated importance to whatever they're focused on right now.
- **Optimal persuasion is achieved only through optimal pre-suasion.**

**Marketing patterns.**
- An ad that opens with a question ("What's the biggest mistake UFC bettors make?") pre-suades by directing attention to the problem before the product.
- Landing page hero that asks a focusing question primes the visitor before showing the offer.
- Email that opens with a story directs attention before the pitch lands.

**Applied — CombatCall.**
- Open the welcome email with: "Quick question. Think about the last UFC bet you lost. What were you actually basing it on?" Then deliver the product as the answer.
- Sales page pre-headline: "Before you read another word, answer this: of the last 5 UFC bets you placed, how many had real data behind them?" Then headline.

**Source.** *Pre-Suasion* (2016). NOT downloaded — paid book. Public summaries cited in `sources.md`. This framework is the weakest-covered in our library; if Cole wants Tristan top-tier here, the book is worth $20.

---

## 3. Practical Cialdini Heuristics (synthesized)

For any marketing asset, run this checklist:
- [ ] **Reciprocity:** did I give something of real value before asking?
- [ ] **Commitment:** did I get a small yes before the big yes?
- [ ] **Social proof:** is there evidence others like the prospect have done this?
- [ ] **Authority:** is my credibility clear? Mechanism, credentials, data sources?
- [ ] **Liking:** am I writing as a real human the prospect would like?
- [ ] **Scarcity:** is there a REAL reason to act now? (No fake countdown timers.)
- [ ] **Unity:** does the language make them feel they're already part of something?

If 5+ check off, ship. If under 5, rewrite.

---

## 4. The Ethics Note

Cialdini is unusual among marketing-adjacent figures in that he's relentless about ethics. He distinguishes:
- **Smugglers** — use these principles to push offers prospects shouldn't buy.
- **Bunglers** — use them poorly and lose trust.
- **Sleuths** — use them ethically by uncovering existing reasons to act.

The position to take with CombatCall: Sleuth. Don't manufacture urgency. Don't fake social proof. Don't promise winning records that aren't real. Gambling adds an extra duty of care — the 18+/1-800-GAMBLER disclaimer in the footer is the floor, not the ceiling.

**Source.** *Influence: The Psychology of Persuasion* (revised 2021), final chapter.

---

# Net-new additions 2026-06-09

Pre-Suasion got partial coverage in the first pass. This expansion adds the **case studies and experiments** that make Pre-Suasion tactical instead of theoretical. Sources: Cialdini's own Stanford GSB interview, ThePowerMoves' deep summary, verbalnotes Substack, and the Influence at Work site. Each section ends with how Tristan deploys the principle in CombatCall copy or funnel design.

## 5. Pre-Suasion — The Case Studies and Tactical Patterns

### 5a. The Identity Activation Open (helpful/adventurous frame)

**Experiment.** Researchers in a mall asked people to fill out a marketing survey. Cold ask: 29% compliance. **Pre-suasive ask** — "Excuse me, do you consider yourself a helpful person?" most said yes — THEN the survey ask: **77% compliance.** 2.7x lift from a single pre-question that activated a self-concept.

**The pattern.** Pre-question that activates the identity consistent with the desired behavior. "Do you consider yourself a helpful person?" → request that requires helpfulness. "Are you adventurous enough to try a new soft drink?" → ask. "Do you think about your bankroll seriously?" → CombatCall sub.

**Applied — CombatCall.**
- Landing page pre-headline (above the hero headline, small text): "If you bet on UFC, you take it seriously. Right?"
- Email subject for paywall-conversion sequence: "Quick question — are you a serious bettor?"
- Onboarding quiz Question 1: "How serious are you about your UFC bankroll?" Answers: "It's a hobby" / "I want to be profitable" / "I'm tracking ROI." Each one is a self-identification that the rest of onboarding then commits them to.

### 5b. Environmental priming (the furniture store example)

**Experiment.** An online furniture store sent visitors to one of two landing pages. Background image was either fluffy clouds or coins. The cloud cohort rated COMFORT as the most important feature in choosing furniture and bought more comfortable (more expensive) sofas. The coin cohort rated COST as most important and bought cheaper sofas. Same store. Same furniture. Same offer. Background pixels changed the buying decision.

**The pattern.** What is visually present at the moment of attention determines what the prospect treats as important. Background art is not decoration — it's a vote on the buying criterion.

**Applied — CombatCall.**
- Landing page hero background: NOT a generic UFC photo. A scoreboard with green +EV numbers. Now they're primed to rate "edge" as the most important feature.
- Pricing page background: a small chart of compound bankroll growth. Now they're primed to rate "long-term return" higher than "monthly cost."
- Paywall ad creative: a screenshot of a sportsbook ledger showing green. Pre-suades the "profit is possible" frame before they see the offer.

### 5c. The Anchoring Pre-Suasion (joke-anchor + line-length effect)

**Experiment 1 (Cialdini's consulting friend).** Before quoting fees, he'd joke "as you can tell, I'm not gonna be able to charge you a million dollars for this." Anchored prospects at $1M. Subsequent real quote ($30K, $80K, whatever) felt small. Nearly eliminated fee challenges.

**Experiment 2 (line length).** Drawing a long line vs short line on a notepad changed prospects' estimates of a river's length. The visual prior carried into the numerical judgment.

**The pattern.** Anchors don't have to be relevant. They have to be present at the moment of attention. The brain regression-to-the-anchor's a feature, not a bug.

**Applied — CombatCall.**
- Annual plan pricing page: show "What pro tout services charge: $500-2000/month" first, in muted gray. Then "$120/year" feels like a different category, not a different price.
- Sales asset: "If you're betting $100 per fight, this is a rounding error in your bankroll." Anchors them to their own betting size — making $25/mo feel sub-rational to NOT spend.

### 5d. The Open-Loop / Zeigarnik Effect

**Experiment.** Soft drink and toothpaste ads were stopped 4-5 seconds before their natural ending. Subjects recalled details from the unfinished ads better than from complete ads. Open loops persist in working memory; closed loops are flushed.

**Dating variant.** Women rated by attractive men on Facebook preferred the men whose ratings they couldn't see (open loop) over those who rated them highest (closed loop). Uncertainty = attention = preference.

**The pattern.** Leave a thread hanging. The brain returns to finish what it started.

**Applied — CombatCall.**
- Email subject lines: "What the model said about Pereira-Adesanya 3 (and why I almost ignored it)" — open loop, no resolution in the subject.
- Tweet threads: cliffhanger every 3-4 tweets. "(More in a sec.)"
- Free-3-fights gate: the OTHER fights of the night are still locked. That's the loop. The whole product is a Zeigarnik machine.

### 5e. The Petrified Forest National Park Inversion

**Experiment.** Park managers wanted to reduce wood theft. They tried two signs:
- Sign A: "Many past visitors have removed petrified wood, changing the natural state of the Petrified Forest." Showed three thieves in the image.
- Sign B: "Please don't remove the petrified wood from the Park." Showed one thief with a hand crossed out.

Sign A — meant to shame — **tripled theft.** Sign B halved it.

**The mechanism.** Sign A used "negative social proof" — it told visitors "lots of people do this," and that's the actual behavior people copy. Even when you're trying to scold a behavior, you're normalizing it.

**The pattern.** Never anchor against the behavior you don't want by saying it's common. Anchor INSTEAD against your desired behavior as the norm.

**Applied — CombatCall.**
- NEVER: "Most UFC bettors lose money." (You just told them losing is normal. They'll lose.)
- INSTEAD: "Our 1,247 active subscribers placed +EV bets on every fight in UFC 304." (You normalized winning + data-betting.)
- Tweet: "The smart UFC bettors are the boring ones — they have a system." (Anchors "smart bettor = systematic" as the in-group norm.)

### 5f. The Mall Compliment Experiment (context matters)

**Experiment.** Attractive young man approached women in a mall, complimented them, asked for their phone number. Average success: 13.5%. When he ran the same script in front of ONE SPECIFIC shop, success jumped to 24%. The shop? A florist. Romantic priming.

**Applied — CombatCall.** The page/feed your ad appears next to is part of the offer. Ads served alongside r/sportsbook or MMA Twitter content have a different surrounding "florist" than ads served on random YouTube preroll. Spend the targeting budget on context, not just demographics.

### 5g. The Hotel Towel Reuse Study (room-specific social proof)

**Experiment.** Three card variants in hotel rooms asking guests to reuse towels:
- A: "Please reuse to help the environment." (Worst.)
- B: "75% of hotel guests reuse their towels." (Better.)
- C: "75% of guests **who stayed in THIS room** reused their towels." (Best.)

**The pattern.** Social proof gets more powerful the closer the comparison group is to the prospect. "1,000 people did X" < "1,000 people LIKE YOU did X" < "1,000 people IN YOUR EXACT SITUATION did X."

**Applied — CombatCall.**
- Don't say: "1,247 bettors use CombatCall."
- Say: "1,247 bettors WHO LOST MORE THAN $1,000 ON UFC LAST YEAR use CombatCall." (Closer match.)
- Even better: post-event email — "Here's how the 412 subscribers who bet UFC 304 did this weekend." (Same-event peer group.)

### 5h. Advice vs Opinion — The Unity Lever

**Experiment / pattern.** Cialdini: when you ask someone for their OPINION, you get a critic — they step back and evaluate you from outside. When you ask for ADVICE, you get a partner — they step in and contribute. Same person, same question, different word, opposite stance.

**Direct Cialdini quote:** *"When you ask for opinion you get a critic. If instead you ask for advice, you get a partner — somebody who is in it with you."*

**Applied — CombatCall.**
- NEVER ask reviewers for "feedback" or "your opinion."
- ASK: "Can I get your advice on this landing copy?" Reviewer becomes co-conspirator.
- In product: every help/support touchpoint asks for "advice on how we can do this better" not "feedback." Users co-build the product mentally.

### 5i. The Sex/Threat Context Switch

**Experiment.** Subjects watching romantic movies preferred ads that emphasized UNIQUENESS (autonomy-seeking). Subjects watching scary movies preferred ads that emphasized POPULARITY (group-seeking). Same product. Context flipped which appeal worked.

**Applied — CombatCall.** UFC fight night is a THREAT-adjacent context (anticipation, anxiety about bet outcomes, fear of loss). Lean POPULARITY appeals in fight-week creative: "1,247 bettors are using this card tonight." Off-week (lower threat state): lean UNIQUENESS appeals: "The model nobody else is running."

### 5j. The Counterargument Power Move

**Pattern.** Counterarguments are MORE persuasive than arguments. Painting your opponent as an untrustworthy source — challenging their credibility — wins not just the current debate but FUTURE ones with them.

**Applied — CombatCall.** Don't argue for CombatCall. Counter-argue against tout services. "Here's why every '$1,500/month VIP picks' Discord has the same lifecycle: hot streak → loud → bad month → ghost → new name. Save your money." That's stronger than "we're better."

### 5k. The Metaphor Choice (wild beast vs virus)

**Experiment.** Subjects told "crime is a wild beast preying on the city" supported catch-and-cage solutions. Subjects told "crime is a virus infecting the city" supported root-cause solutions (education, jobs). ONE WORD difference moved policy preference more than party affiliation or gender did.

**Direct Cialdini quote:** *"If you want to change the world, change the metaphor."*

**Applied — CombatCall.** Choose your metaphor for "the betting market" deliberately.
- "The book is a vampire that bleeds you slowly" → makes them want a weapon (CombatCall).
- "The book is a casino, and you're a tourist" → makes them want a guide (CombatCall).
- "Betting is a game, and you're playing without the rule book" → makes them want the rule book (CombatCall).
Test all three. The right metaphor for your audience is empirical.

### 5l. The Post-Suasion Lock-In (commitment after the privileged moment)

**Pattern.** Pre-suasion gets the receptive moment. But the moment is brief. Without a COMMITMENT step right after, the effect fades. Cialdini's rule: **after pre-suasion, immediately ask for an active, voluntary, effortful behavioral commitment.** That locks in the attitude change.

The McCain campaign example: flag on screen → pre-suasion → online survey registration (commitment) → preference held for 8+ MONTHS.

**Applied — CombatCall.** Every pre-suasive open MUST be followed by a micro-commitment.
- Landing pre-suasive question → email opt-in (commitment).
- Email pre-suasive story → click to read full post (commitment).
- Sales-page pre-suasive opener → free 3-fights signup (commitment).

The pre-suasion without the commitment is a wasted privileged moment.

---

## 6. The System 1 / System 2 Match

Pre-Suasion's other operating principle: your prospect is in one of two cognitive modes at any moment. Your messaging needs to match.

- **System 1** — intuitive, fast, emotional. Triggered by music, story, image, urgency, fear.
- **System 2** — slow, deliberate, rational. Triggered by data, charts, mechanism, "how it works" copy.

**Match it.** If your ad creative is music + montage (System 1 trigger), the CTA copy should be emotional. ("Bet smarter Saturday.") If your ad is a data screenshot (System 2 trigger), CTA copy should be analytical. ("See the +EV scores.")

Schwartz's "interweaving" final-copy touch is the same idea: alternate emotion and logic so you hit both systems.

**Applied — CombatCall.** Landing page hero video → System 1. CTA below: "Bet from the data this Saturday." Pricing page → System 2 (specs, comparisons, math). CTA: "Lock in $120/yr." Match the cognitive mode.

---

## 7. The Stanford GSB Cialdini Quotes (worth memorizing)

These are Cialdini's own words from his 2017 Stanford Graduate School of Business interview — short, quotable, and ripe for Tristan to internalize.

> "What we present first changes the way people experience what we present to them next."

> "The highest achievers spent more time crafting what they did and said BEFORE making a request."

> "The factor most likely to determine a person's choice is often not the one offering the most accurate counsel; instead, it is the one elevated in attention at the moment of decision."

> "Nothing in life is as important as you think it is while you are thinking about it."

> "When you ask for opinion you get a critic. If instead you ask for advice you get a partner."

> "If you want to change the world, change the metaphor."

**Source.** Stanford GSB, *Change My Mind: Using Pre-suasion to Influence Others*, 2017 interview with Cialdini. See sources.md.
