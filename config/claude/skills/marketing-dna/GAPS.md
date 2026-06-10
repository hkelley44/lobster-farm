# GAPS — what's missing in this library, why, and what to do about it

**Updated 2026-06-09 after second-pass expansion.** Original first-pass GAPS preserved at the bottom; updated assessment is at the top.

---

# 2026-06-09 — Hallucination sweep (CRITICAL, READ FIRST)

The first-pass research agent fabricated specific dollar amounts ("$3,400 loss" → "$9K recovery") for the founder story, plus a constellation of supporting fake specifics (a "Khamzat" fighter reference, "Florida legalized" as a timeline anchor, "two pick services — one ghosted, one was a 19-year-old running a Discord", specific W/L percentages like "53% of those", "+37 units last 10 cards", "58% W/L, N=120"). The second-pass agent did not catch them. Cole flagged the "$9K" as fabricated; verification revealed the cascade.

**Verified-true founder story** (per Cole, 2026-06-09): bought picks from tipsters for years, they didn't work (most was gut feeling dressed up as analysis), started building his own model 3-4 months ago, bankroll has been up since. **No dollar specifics. No specific fighter references. No specific service-name stories.** The pivot insight: didn't want to rely on people's feelings about fighters.

**Brand spine**: *"Data over feels."*
**Enemy**: tipsters selling emotions as analysis.

**Files swept and corrected** (every fabricated specific either replaced with the verified version or annotated with a discipline note):
- `combatcall-application.md` — *now moved to `~/.lobsterfarm/entities/combatcall/files/marketing/application.md` per the 2026-06-09 entity-overlay refactor*
- `authors/brunson/frameworks.md`
- `authors/sabri-suby/frameworks.md`
- `authors/schwartz/frameworks.md`
- `frameworks/copy-fundamentals.md`
- `frameworks/emotional-triggers.md`
- `templates/ad-copy/cold-traffic-x.md`
- `templates/landing-pages/sales-page.md`
- `templates/social/x-thread.md`
- `templates/social/reddit-post.md`
- `templates/social/tiktok-script.md`
- `templates/email/welcome-sequence.md`

**Discipline rule for Tristan, going forward**: any specific number, fighter name, date, percentage, or service-name claim in CombatCall copy must come from a verified source (Cole, the live ledger when it exists, public Stripe/Supabase data, a public news article). If a specific would strengthen the copy and no verified source exists, ask Cole. Vague-but-true beats specific-but-fake every time.

---

# Updated state — what the second pass closed and what remains

## Gaps the second pass CLOSED

### 1. Schwartz — Mass desire mechanics ✓ CLOSED
The first pass had Mass Desire as a concept. The second pass added the **three measurable dimensions** (Urgency × Staying Power × Scope) and the **two-bucket force model** (Permanent forces vs Forces of change). Both are in `authors/schwartz/frameworks.md` sections 6-7. These are the operational meat of Mass Desire.

### 2. Schwartz — 38 Headline Techniques ✓ CLOSED
The first pass acknowledged the 38 list and named ~12. The second pass added the **full 38(+2) list with EXAMPLES** synthesized from two independent third-party sources (Steven Abraham on Medium, Roy Furr at Breakthrough Marketing Secrets). Each technique now has a Schwartz-era example AND a CombatCall verbalization. In `authors/schwartz/frameworks.md` section 11. Cross-checked across sources for fidelity.

### 3. Schwartz — The 7 Techniques of Breakthrough Copy ✓ MOSTLY CLOSED
This was the HUGE gap nobody flagged in the first pass — the 7 body-copy techniques (Intensification, Identification, Gradualization, Redefinition, Mechanization, Concentration, Camouflage) are arguably the most-used Schwartz chapter in working practice. Now in `authors/schwartz/frameworks.md` section 9 with definitions, examples, and CombatCall applications. (Remaining gap: exact in-book examples for each technique would benefit from the primary text; public summaries vary on which examples Schwartz uses for which technique.)

### 4. Schwartz — Body copy structure ✓ CLOSED
The 3-step channeling process (select desire → acknowledge in headline → connect product elements) + the 5 final-copy touches (Verification/Reinforcement/Interweaving/Sensitivity/Momentum). In `authors/schwartz/frameworks.md` sections 8 + 10.

### 5. Schwartz — Working method ✓ CLOSED
The 33:33 sprint method with rules + rationale + Schwartz's own quote. In `authors/schwartz/frameworks.md` section 12.

### 6. Cialdini — Pre-Suasion case studies ✓ LARGELY CLOSED
The first pass had Pre-Suasion as a concept. The second pass added **12 specific case studies and experiments** (helpful-person mall survey, fluffy-clouds furniture store, anchoring, Zeigarnik soft-drink ads, Petrified Forest sign, hotel-towels-by-room, mall-compliment-at-florist, advice-vs-opinion, sex/threat context, counterarguments, metaphor choice, McCain flag post-suasion). Plus **System 1/System 2 matching** and **7 verified Cialdini quotes** from the Stanford GSB interview. In `authors/cialdini/frameworks.md` sections 5a-5l + 6 + 7. Cross-author synthesis in `frameworks/pre-suasion-tactics.md`.

### 7. Hormozi — Post-book frameworks ✓ CLOSED
The first pass got the canonical book frameworks. The second pass added **15 new frameworks** from Hormozi's 2023+ content — 10-Stage Scaling Roadmap (Black Friday 2024), 30-Day Rule (refined CFA), Three P's of Business Ideas, Fulcrum Model (Supply×Demand×Leverage), 3D Training, Stop/Start/Keep, Barrels vs Ammunition (Rabois citation), Smallest Skill Deficiency Hiring, 20/60/20 Audience Rule, Vague-to-Specific decision framework, Brand Mosaic theory, Cowardice Redefinition, Specificity-Attracts polarity rule, Consultant Learning Method, and the 7 quotable Hormozi/Layla lines. In `authors/hormozi/frameworks.md` sections 9-23.

### 8. Brunson — Post-trilogy thinking ✓ CLOSED
Added the **Voice Evolution framework** (Dreamer → Reporter → Framework Creator → Servant → Expert), **Teaching vs Selling a framework**, **the 2025 Six Growth Pillars**, **One Funnel to Rule Them All**, **Magnetic Story Selling** (Kennedy collab), and the **framework-naming heuristic**. In `authors/brunson/frameworks.md` sections 11-16.

### 9. Sabri Suby — Recent content ✓ MOSTLY CLOSED
Added the **17-Point Sales-Page Checklist** (Sabri's operational practice), the **Lead Quality > Quantity thesis**, the **Ad-Hook Testing Protocol**, the **Disney Funnel teaching anchor**, and the **Platform-Specific Creative Rule**. In `authors/sabri-suby/frameworks.md` sections 9-13.

### 10. Adjacent thinkers ✓ CLOSED (new file)
A `frameworks/adjacent-thinkers.md` file covers Dan Kennedy (No B.S. rules, Results Triangle), Gary Halbert (Starving Crowd, 40/40/20, Dollar Bill Letter, hand-copying), Claude Hopkins (Scientific Advertising — public domain, with classic campaigns), and David Ogilvy (Big Idea, headline-leverage, brand-aware DR). Each at ~300-400 words with frameworks + canonical quotes + when-to-use.

### 11. Pre-Suasion cross-author synthesis ✓ CLOSED (new file)
A `frameworks/pre-suasion-tactics.md` file consolidates the 8 Pre-Suasion patterns + 4 anti-patterns + a 10-point pre-flight checklist. Bridges Cialdini's mechanism + Schwartz's gradualization + Hopkins' specificity + Halbert's pattern interrupt into a single problem-shaped index.

---

## Gaps the second pass DID NOT close

### Schwartz — primary text page numbers
The chapter attributions in `authors/schwartz/frameworks.md` for sections 6-12 are APPROXIMATE. Different public summaries cite slightly different chapter ranges for the same technique. Without the primary text, the exact page-level provenance can't be verified. Practical impact: low (the FRAMEWORKS are correct; the citations are summary-level).

### Schwartz — In-book Schwartz EXAMPLES
The 38 headline techniques have public examples (mostly from Schwartz's mid-20th-century era). But the BODY COPY examples for the 7 breakthrough copy techniques are sparser in public summaries. Tristan working from the public material has the SHAPE of each technique but not the specific Schwartz-illustrated case for each. If Cole eventually buys the book ($125), this is the gap closing fully.

### Internet Archive Schwartz borrow
Internet Archive lists *Breakthrough Advertising* at two URLs (catalogued, "Access-restricted-item: true"). WebFetch could not render the borrow interface — it returned metadata only ("No suitable files to display"). Either:
- Manual logged-in Internet Archive borrow likely works (recommended next step if Cole wants the primary text).
- OR the book is print-disabled access only (Internet Archive sometimes restricts to verified-disability users).

Recommendation: try the IA borrow manually. If it works, that's the cheapest legal path to the primary text. If it doesn't, the $125 Brian Kurtz reprint still stands.

### Pre-Suasion primary text
*Pre-Suasion* IS available to borrow at archive.org/details/presuasionrevolu0000cial. WebFetch returned the same access-restricted metadata. Manual IA borrow likely works for a logged-in user. Not done in this pass (the public synthesis was rich enough — 12 case studies surfaced).

### Sabri Suby — Diary of a CEO appearance
The user's prompt referenced a Sabri Suby Diary of a CEO episode (2023ish). 2026-06-09 search of the DOAC catalog did NOT surface such an episode by name. May have been confused with one of his other appearances (Tai Lopez, Foundr, GaryVee). Sabri appearances WERE confirmed on Tai Lopez (October 2024), Foundr Ep 235, and Cole Gordon, etc. If a real DOAC episode exists, it should be at podcasts.happyscribe.com — not fetched.

### Podcast transcripts — most still not pre-fetched
- Hormozi Diary of a CEO: ✓ fetched (the canonical Bartlett interview)
- Hormozi My First Million Episode 764: episode page summarized, full transcript not fetched
- Sabri Tai Lopez: page summarized, full transcript not fetched
- Russell Brunson Show 2025 episodes: blog recaps fetched, full audio transcripts not fetched
- Brunson on Mixergy / Foundr / GaryVee: not fetched
- Robbins's recent podcast appearances: not fetched

The PATTERN is now clear: episode pages + blog recaps + happyscribe transcripts work via WebFetch when they exist. Tristan can fetch specific episodes on-demand by URL when he needs depth.

### Hormozi $100M Scaling Roadmap — stage-level instructional depth
The 10 stage NAMES are public (Improvise → Capitalize). The instructional CONTENT per stage is gated behind acquisition.com's free email signup flow. Not signed up in this pass (no real inbox to dirty). If Cole wants the full stage-by-stage Hormozi playbook, signing up free at acquisition.com/training is the next step.

### Brunson "Atlas Mastermind"
Atlas is Brunson's top-tier inner-circle program (members at $100K/day ad-spend benchmark). Specific Atlas curriculum is paid/private. Out of scope.

### The 5th and 6th of Brunson's "Six Growth Pillars for 2025"
The public blog recap names FOUR (Break-Even Funnels, Metrics, Ad Creativity, Curiosity). The full audio episode would name all six. Not fetched in this pass.

### Robbins — no second-pass expansion
Robbins was identified in the first pass as a "supporting voice" — psychology/state/decision-making background. Second pass DID NOT expand him because (a) he's not direct-marketing-centric, (b) his recent content is mostly seminar-driven and paid, (c) the existing coverage is adequate for the supporting role. If Tristan ends up doing identity-transformation copy at scale, expanding Robbins becomes worth it.

### What this skill still doesn't cover (intentional scope cuts — UNCHANGED)
- Brand identity / visual design (belongs in design-dna)
- SEO-specific tactical guides
- PR / media relations
- B2B-specific frameworks (Predictable Revenue, etc.)
- Affiliate / partnership marketing
- CRO tactics (button colors, form psychology)

---

## Updated summary recommendation to King Arthur (2026-06-09)

The second pass closed enough of the previous gaps that the BUY-A-BOOK recommendation has materially weakened.

### Strongly recommended (was strongly recommended; still stands but weaker)
1. ~~**Eugene Schwartz — *Breakthrough Advertising*** (~$125).~~ → **DOWNGRADED to "optional but high-value."** The second pass closed the 38 headline patterns, the 7 techniques of breakthrough copy, the three forces of mass desire, gradualization, and the body-copy mechanics. The remaining marginal value of the primary text is in-book EXAMPLES per technique. Still the highest-quality marketing book ever written; still worth buying if budget allows; but Tristan can now ship Schwartz-quality work without it.

2. ~~**Robert Cialdini — *Pre-Suasion*** (~$20).~~ → **DOWNGRADED to "optional."** The second pass surfaced 12 case studies + Cialdini's own quotes + System 1/2 matching. The remaining marginal value is the additional 40+ case studies in the book. Still cheap if Cole wants to be exhaustive; Tristan has the working set.

### Cheaper path: Internet Archive borrow
Both *Breakthrough Advertising* and *Pre-Suasion* appear borrowable on Internet Archive. Manual logged-in IA borrow is the cheapest path. ~$0 if it works.

### Total revised recommendation
- **Try Internet Archive borrow first** for both books. $0 cost, hours of work.
- **If IA borrow fails**: $145 for both (down from $145 priority; now optional).
- **Skip Suby's book** (frameworks well-covered).
- **Skip Hormozi books** (free PDFs cover it + Diary of a CEO + Scaling Roadmap).
- **Skip Brunson books** (covered + free + shipping if needed + Magnetic Story Selling on Audible if interested in Kennedy×Brunson collab).
- **Skip Robbins books** (not the bottleneck).

### Total cost of MAXIMAL Tristan-brain: $0-$145 (down from $145-$175 in first-pass recommendation).

---

# Original first-pass GAPS.md content (preserved for historical reference)

## What I couldn't get cleanly

### 1. Schwartz — *Breakthrough Advertising* primary text
**What's missing.** The 38 headline techniques in their original detailed form, plus subtler insights in chapters 5-10 that don't surface in summaries.
**Why.** Out-of-print book. Reprints sell for $125-200. Public summaries cover the big frameworks (Awareness Stages, Sophistication, Mass Desire) but the tactical depth — particularly the 38 headline patterns — exists only in the original.
**Recommendation to King Arthur.** **WORTH BUYING.** $125 at https://breakthroughadvertisingbook.com — the most "underleveraged in our library" book. If Tristan is going to write top-tier headlines, the original 38 techniques are the source of truth. Other authors quote/extend these constantly.

### 2. Cialdini — *Pre-Suasion* tactical applications
**What's missing.** The dozens of pre-suasion case studies and tactical patterns in the book that go beyond the high-level "attention as leverage" principle.
**Why.** Paid book, in print, ~$15-20. Public summaries cover the thesis but the application examples are the value.
**Recommendation.** **WORTH BUYING.** $20. If Tristan is going to write Cialdini-grade pre-suasive openers for emails, ads, landing pages — the case-study density of Pre-Suasion is unmatched elsewhere. Best-value-per-dollar book on this list.

### 3. Sabri Suby — *Sell Like Crazy* tactical chapters
**What's missing.** Specific scripts, ad teardowns, and email templates Suby provides in the book that don't surface in third-party summaries.
**Why.** Paid book, in print, ~$20-30. Public material covers the 8-phase structure but the in-chapter templates are paywalled.
**Recommendation.** **OPTIONAL.** Frameworks already well-covered from public sources. Buy if Tristan ends up writing a lot of long-form sales pages — the templates in chapter 7 are reportedly good. Skip otherwise.

### 4. Hormozi — *$100M Offers* + *$100M Leads* primary text
**What's missing.** Some specific in-chapter examples and exact wording.
**Why.** Books are paid (~$10-20 each), though Hormozi has put much of the content in free PDFs (we have 6 of those downloaded). Audiobooks are also free for $100M Leads.
**Recommendation.** **LOW PRIORITY** — coverage is already excellent via the 6 free PDFs + Hormozi's YouTube. Buy if Tristan wants quotable lines.

### 5. Brunson — Secrets Trilogy primary text
**What's missing.** Some chapter-level tactical depth, particularly Expert Secrets Section 3 (the One-to-Many Selling / Perfect Webinar mechanics) and Traffic Secrets Section 3 (the buying-traffic specifics).
**Why.** Books are paid (or "free + shipping" via Brunson's tripwire — ~$10 shipping).
**Recommendation.** **OPTIONAL.** Public summaries cover the major frameworks well. Buy via "free + shipping" if Tristan ends up doing webinar-style sales assets. Skip if not.

### 6. Robbins — primary books
**What's missing.** Tactical depth in *Awaken the Giant Within* on identity-shifting and decision-making.
**Why.** Paid books.
**Recommendation.** **SKIP.** Robbins is a supporting voice in this library — for psychology / state / decision-making background. Public summaries plus his blog cover enough. Buy only if Tristan ends up writing identity-transformation-heavy copy for a coaching-style entity.

## What I couldn't access / verify

### Podcast transcripts
- Hormozi on Diary of a CEO, My First Million, Joe Polish, Andy Frisella — not transcribed locally.
- Suby on Foundr, Ed Mylett, Russell Brunson's Marketing Secrets — not transcribed locally.
- Brunson's own Marketing Secrets podcast — not transcribed locally.
- Robbins's podcast — not transcribed locally.

**Why.** Transcription is expensive + slow + per-episode targeting requires specific quote-hunting. I didn't fabricate quotes; I cited summaries with attribution.

**Mitigation.** Sources.md per author lists podcast feeds. When Tristan needs a specific quote, he goes to the source — does NOT fabricate. Use YouTube auto-transcripts as a quick search method.

### YouTube auto-transcripts
**What's missing.** I didn't pull individual YouTube transcripts into local files.

**Why.** Each Hormozi/Suby/Brunson YouTube channel has hundreds of videos. Local transcripts would explode the library size and most wouldn't be referenced.

**Mitigation.** Sources.md per author lists channels. Tristan can fetch transcripts on-demand via YouTube's API or transcript scrapers.

### King Kong / Sabri Suby blog posts
**What's missing.** Specific Sabri Suby blog posts at kingkong.co/blog — I have URL but didn't deep-fetch every post.

**Why.** Time-budget. The blog is large + crawl-cost was prohibitive in this session.

**Mitigation.** sources.md has URL. When Tristan needs Suby-specific blog content, he WebFetches the specific post.

### Cialdini academic papers
**What's missing.** Local copies of Cialdini's published academic papers.

**Why.** Google Scholar links + paywalls vary. Free copies exist for most but require search-per-paper.

**Mitigation.** sources.md lists key papers. Tristan can fetch on-demand.

## What surprised me

1. **Hormozi's free-PDF strategy is generous.** I expected to scrape one or two free downloads from acquisition.com. There were six legitimately free PDFs totaling ~85MB of high-density content. The Money Models book launch (2025) generated multiple free companion PDFs — the $100M Journal alone is 278 pages.

2. **Sabri Suby's content footprint is thinner than expected.** I expected a deep blog + multi-hundred-video YouTube channel given King Kong's brand. The actual public material is solid but less voluminous than Hormozi or Brunson. The frameworks are well-summarized in third-party blogs; the original book *Sell Like Crazy* is the canonical source.

3. **Schwartz material is THIN.** *Breakthrough Advertising* is rare + expensive. Public summaries cover the famous frameworks (Awareness, Sophistication, Mass Desire) but the 38 headline techniques have only fragmentary public coverage. This is the largest practical gap in the library and the single best book purchase recommendation.

4. **Cialdini's site is sparse on Unity.** The 7th principle, added in 2016's Pre-Suasion, has less public documentation than the original 6. Some details I had to infer from secondary sources.

5. **The cross-author convergence is striking.** The Value Equation, Godfather Offer, and Brunson's HSO Offer component are essentially the same idea in three vocabularies. Schwartz's Mass Desire is what Hormozi calls Dream Outcome. Cialdini's principles undergird every other framework. The synthesis was easier than I expected — these authors are saying mostly the same thing.

## What's NOT in this library (intentional scope cuts)

- **Brand identity / visual design.** Belongs in design-dna, not marketing-dna.
- **SEO-specific tactical guides.** Tangential to direct-response/copywriting. Tristan can pull from blog posts when needed.
- **PR / media relations.** Not yet needed at CombatCall's stage.
- **B2B-specific frameworks** (Predictable Revenue, Aaron Ross, etc.). CombatCall is consumer; B2B would warrant its own DNA later.
- **Affiliate / partnership marketing.** Premature for CombatCall.
- **Conversion-rate optimization tactics** (specific button colors, form-field psychology). Belongs in design-dna + tactical playbooks; Tristan can consult when needed.

## Summary recommendation to King Arthur (FIRST PASS — superseded by Updated section above)

**Buy these books, in this order:**

1. **Eugene Schwartz — *Breakthrough Advertising*** (~$125). Biggest gap-closer. Schwartz's 38 headline techniques would 5-10x the headline quality of any asset Tristan ships.
2. **Robert Cialdini — *Pre-Suasion*** (~$20). Highest-value-per-dollar. Specific application patterns missing from the framework summary.
3. **(Optional) Sabri Suby — *Sell Like Crazy*** (~$20-30). Buy if long-form sales pages become a recurring deliverable.

Skip Hormozi (covered), Brunson (covered), Robbins (sufficient).

Total: ~$145 for the top-priority gap closure. ~$175 with the Suby add-on. Modest investment for Tristan-level marketing depth on every entity.

---

# What the second pass surprised me with (2026-06-09)

1. **The 7 Techniques of Breakthrough Copy is the under-cited Schwartz chapter.** The first pass focused on awareness/sophistication/mass desire — the famous frameworks. But Schwartz's CHAPTER 7-9 territory (the 7 body-copy techniques: Intensification, Identification, Gradualization, Redefinition, Mechanization, Concentration, Camouflage) is what working copywriters use day-to-day. This is a much bigger gap than the 38 headlines.

2. **Pre-Suasion has 50+ case studies in public summaries, not the "few" the first pass implied.** ThePowerMoves alone catalogs 53 distinct experiments. The first-pass "we need the book to get the case studies" was over-pessimistic — the book is paywalled, but secondhand case studies are abundant.

3. **Brunson's post-trilogy thinking is moving fast.** The "Voice Evolution" framework, the "One Funnel to Rule Them All" thesis, and the Magnetic Story Selling collab with Dan Kennedy are all from 2024-2025 and represent a meaningful pivot in Brunson's teaching — away from "build many funnels" toward "obsess over one." Tristan should track The Russell Brunson Show as ongoing input.

4. **Hormozi launched a major free training (Scaling Roadmap) Black Friday 2024.** Ten stages, free, gated only by email. This is bigger than the existing free PDFs and represents Hormozi's most-current operating framework. Worth signing up for if Cole wants the full instructional depth per stage.

5. **The "Sabri Suby on Diary of a CEO" episode mentioned in the user's prompt does not exist as of 2026-06-09 in the public DOAC catalog under his name.** May have been confused with one of his Tai Lopez / Foundr / Ed Mylett appearances. Not fabricated — flagged as still-unverified.

6. **Internet Archive controlled digital lending DOES have both target books cataloged.** WebFetch couldn't render the borrow interface (returned metadata only), but a logged-in human likely can borrow. This is the unblocked next step if Cole wants the primary texts for $0.

7. **Schwartz's 33:33 working method.** Not even on the radar in the first pass. Could materially change Tristan's output cadence and IS a Schwartz "framework" in his own life — worth knowing.

8. **Dan Kennedy and Brunson are now formally collaborating.** *Magnetic Story Selling* (2024-25) is a real Kennedy×Brunson joint book. The fact that the godfather of direct-response and the modern funnel king both converged on STORYTELLING as the moat is the signal to weight story higher in Tristan's hierarchy.

9. **The convergence theme deepens.** Hormozi's 30-Day Rule = Brunson's Break-Even Funnels = Kennedy's "every communication must have an offer." Three vocabularies, same insight. The cross-author convergence noted in the first pass extends to recent content — these operators continue to land on the same handful of operational truths.
