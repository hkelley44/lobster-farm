---
name: design-dna
description: >
  Design foundations, visual systems, and UI implementation standards. Auto-loads
  when building brand kits, creating design systems, developing component libraries,
  making visual/UX decisions, or implementing frontend with design intent. Covers
  both design principles and their expression in code.
---

# DESIGN-DNA.md — Our Design Foundation

_Built from real study. Evolved through real work. This is how we think._

---

## Philosophy

We design things that feel alive. Not loud, not busy — alive. There's a difference between a site that has animation and a site that *breathes*. We build the latter.

Every design decision serves identity. Every interaction has intent. Every pixel earns its place. If something exists just because "sites usually have this," it doesn't belong in our work.

We don't follow templates. We don't do generic. We study what makes exceptional work exceptional, then we build with that understanding — never by copying, always by feeling.

### Core Beliefs

- **Show, don't decorate.** Animation, color, layout — all of it serves the work. Nothing is ornamental.
- **Restraint is expression.** Knowing when *not* to use color, motion, or complexity is as important as knowing when to use it.
- **Each brand breathes differently.** Our foundation is shared. Our execution is always unique to the entity.
- **Craft is the standard.** We don't ship "good enough." We ship work that makes engineers excited to build it.
- **Seams should be invisible.** Sections flow. Transitions dissolve. The page is one continuous experience, not a stack of boxes.

---

## What We Build With

### Stack
- **TypeScript + Next.js** — our runtime and framework
- **Tailwind CSS** — primary styling (utility-first, design tokens via theme config)
- **Custom CSS** — when Tailwind can't express it (complex animations, scroll-driven effects, blend modes, advanced gradients)
- **Motion** (formerly Framer Motion) — micro-interactions, layout animations, gesture-based interactions, spring physics. Declarative, React-native, excellent for component-level animation.
- **GSAP** — complex timelines, orchestrated multi-element sequences, scroll-linked animation where precise control matters. When Motion can't cut it, GSAP steps in.
- **CSS Scroll-Driven Animations API** — native browser scroll-timeline and view-timeline for performance-critical scroll effects. Zero JS overhead. Progressive enhancement.
- **Remotion** — programmatic video generation for promotional media clips. React + TypeScript = our design language extends to motion graphics.
- **Canvas** — live HTML/CSS/JS rendering for animation prototyping and interactive previews. We can prototype micro-interactions, entry effects, and motion concepts directly in the canvas and iterate visually before committing to component code.
- **TradingView Lightweight Charts** — our default for interactive time-series and market data visualization. Lightweight, performant, purpose-built for financial data. **Always remove the watermark** (`watermark` prop set to empty/hidden). Style the chart to match the entity's palette — colors, grid lines, crosshairs, tooltips should all feel native to the brand, not default TradingView.

### When to Use What

| Need | Tool |
|---|---|
| Component mount/unmount, hover, tap, layout shifts | Motion |
| Multi-step orchestrated sequences, page-load choreography | GSAP timelines |
| Scroll-linked progress (parallax, reveal, sticky) | CSS Scroll-Driven Animations or GSAP ScrollTrigger |
| Micro-interactions (buttons, cards, toggles) | Motion |
| Complex SVG path animation | GSAP |
| Promotional video clips, brand media | Remotion |
| Animation prototyping, interactive previews | Canvas |
| Design tokens, spacing, color | Tailwind theme config (CSS custom properties) |
| Interactive time-series / market data charts | TradingView Lightweight Charts |
| Blend modes, complex gradients, mesh effects | Custom CSS |

---

## Color

### Principles

Color is our most powerful expressive tool. We use it with intention and restraint.

- **Let color breathe.** Generous negative space makes color pop harder than saturating every surface. Adurant exemplifies this — minimal canvas, maximum impact when color appears.
- **Color carries identity.** Each entity's palette is sacred. It's not just "their colors" — it's their emotional signature.
- **Dark/light mode is not an inversion.** When we build theme switching, the entire palette shifts — not just foreground/background. Different mode, different expression. Antimetal does this brilliantly: their light and dark modes feel like two distinct but related moods of the same brand.
- **Backgrounds are canvases, not containers.** Background color should evolve as the user scrolls — gradients that shift, subtle hue transitions, color that breathes with the content. No hard color breaks between sections.

### Palette Architecture

Every entity palette should include:
- **Primary** — the brand's core color. Used sparingly for maximum impact.
- **Surface tones** — background layers (2-3 levels of depth)
- **Content tones** — text, borders, subtle elements
- **Accent** — secondary expression. Can be bold or subtle depending on brand personality.
- **State colors** — interactive feedback (hover, active, focus) derived from the palette, never generic blue/green/red
- **Light + dark variants** — not inversions, but considered alternate expressions

### What We Avoid
- Pure black (#000) as a background — too harsh. Deep, rich darks with subtle warmth or coolness.
- Pure white (#fff) as a text background — too clinical. Slight warmth or coolness gives personality.
- Generic brand-less grays — our grays should always carry a hint of the brand's hue.

---

## Typography

### Principles

- **Typography creates hierarchy, not decoration.** Size, weight, spacing, and color do the work. We don't need many typefaces — usually one or two per entity.
- **System fonts are valid.** Don't reach for a custom font unless it genuinely contributes to identity.
- **Spacing is part of typography.** Letter-spacing, line-height, and margins are design decisions, not defaults.
- **Scale should feel musical.** A type scale with clear ratios (1.25, 1.333, etc.) creates natural visual rhythm.

### Hierarchy Pattern
1. **Display** — hero-level, large, commanding. Often lighter weight at scale.
2. **Heading** — section-level. Clear, confident.
3. **Body** — readable, comfortable. 16-18px base on web.
4. **Caption/Detail** — supplementary info. Smaller but never illegible.

### What We Avoid
- More than 2 typeface families per entity
- Decorative fonts that sacrifice readability
- Inconsistent sizing — establish a scale and stick to it
- Default browser styles for anything visible

---

## Animation & Motion

This is where our work comes alive. Animation is not decoration — it's identity.

### The Intention Test

Before adding any animation, it must pass one of these:
1. **Does it contribute to brand identity?** (Plasma's feature strip hover is uniquely *theirs*)
2. **Does it guide understanding?** (Antimetal's product animation shows how it works)
3. **Does it create emotional response?** (Monument Valley's origami-like movements create serenity)
4. **Does it provide interaction feedback?** (A button's hover state confirms it's interactive)

If the answer is no to all four, the animation doesn't belong.

### Entry Effects

- **Never generic translateY fade-in.** This is the hallmark of AI-generated, unconsidered design. We see it everywhere — we don't do it.
- Entry effects should feel native to the brand. Some possibilities:
  - Scale from a focal point (content emerging from a center of gravity)
  - Clip-path reveals (content unveiled like a curtain)
  - Blur-to-sharp (content materializing from atmosphere)
  - Stagger with character or rhythm (not uniform timing)
  - Mask-based reveals tied to scroll position
- The entry effect vocabulary should be consistent within an entity. Don't mix five different reveal styles on one page.

### Micro-interactions

These are the heartbeat of a living interface:
- **Hover states** that feel physical — slight lifts, color shifts, subtle scale
- **Cursor interactions** — elements that respond to mouse position (Antimetal's hero)
- **State transitions** — buttons, toggles, inputs that animate between states with spring physics
- **Feature reveals** — product features shown through animated demonstration, not static cards

### Scroll Behavior

- **Scroll-linked, not scroll-snapped (usually).** Content should react to scroll position — animation progress tied to where you are on the page. But the user stays in control. Mandatory snap-scrolling can feel rigid and takes agency away from the user.
- **Sticky + scroll-linked is powerful.** Pin a section, animate within it as the user scrolls, then release. Apple product pages master this. It works because it creates focused moments without permanent lockdown.
- **Seamless flow.** The page should feel like one continuous experience. Background colors can gradient between sections. Content can overlap. Elements from one "section" can bleed into the next.

### Scroll-Driven Narrative (Sticky Transitions)

Clear Street demonstrates the gold standard: text that stays pinned while the background/context evolves, telling a problem → solution story through scroll position. This is different from snapped chapters — it's continuous, smooth, and the user stays in control. Implementation:

- **Sticky text blocks** that transition (fade/slide) from one statement to the next as the user scrolls
- **Background color/imagery evolving** behind pinned content
- **Scroll progress as narrative progress** — the further you scroll, the further the story unfolds
- Works beautifully for complex products that need to explain "why us" before "what we do"

### Scrollytelling (Chapters/Stories)

The concept {{USER_NAME}} mentioned — scroll-driven narrative chapters — is genuinely powerful when done right. My take:

**When it works:**
- Content-heavy exposé sites where information needs pacing
- Product stories that unfold sequentially
- Data narratives (NYT "Snow Fall" style)
- When each chapter represents a genuinely distinct phase or idea

**When it doesn't:**
- Forced onto content that doesn't have narrative structure
- When snap-scrolling creates a "presentation deck" feel instead of a web experience
- When chapters are so short they feel like speed bumps
- When it prevents natural browsing/scanning behavior

**Our approach:** Use scroll-linked animation to create chapter *feeling* without hard snap constraints. Pin sections when focus matters, use scroll-driven progress indicators, but let the user scroll freely. The illusion of chapters without the cage.

### Load Choreography

First impressions matter. The page load is a performance:
- **Orchestrate the entrance.** Elements don't all appear at once — they arrive in a considered sequence.
- **Hero loads first, supporting content follows.** Establish the stage, then populate it.
- **Loading animations should preview the brand.** Antimetal's load animation introduces you to their visual language before you even read a word.
- **Keep it fast.** Choreography shouldn't delay perceived load time. Animate what's already painted.

### Physics & Easing

- **Spring physics over linear easing.** Springs feel natural. Linear feels robotic.
- **Easing should match brand personality.** Snappy springs for energetic brands. Gentle, slow springs for serene ones (Monument Valley's movements).
- **Momentum matters.** Elements should feel like they have mass. They accelerate and decelerate — they don't just move.

### Canvas Physics Constants

Reference values that feel good — tune per brand:

| Property | Range | Notes |
|---|---|---|
| Gravity | 2.0–3.5 | Higher = snappier falls |
| Bounce restitution | 0.7–0.85 | Energy retained per bounce |
| Spring stiffness (k) | 10–25 (position), 15–35 (rotation/skew) | Lower = softer |
| Damping | k/3 to k/5 ratio | Relative to stiffness |
| Drag | 0.3–2.0 | `velocity *= (1 - drag * dt)` |
| dt cap | 0.05 | `Math.min((t - lastT) / 1000, 0.05)` — prevents physics explosions on tab-away |

**AABB collision:** `overlapX = min(a.right, b.right) - max(a.left, b.left)`, push apart on shortest axis, exchange velocities × 0.7–0.9. O(n²) fine up to ~15 objects per cell.

### Compound Choreography (State Machine)

The best canvas animations aren't single loops — they're **narratives with phases.** Multiple distinct stages create a story: bounce → shrink → rotate → grow → settle.

```
st.mode = "bounce" | "shrink" | "rotate" | "grow" | "settle"
st.modeStart = t
elapsed = (t - modeStart) / 1000
if elapsed > duration: transition to next mode, re-init velocities
```

Position, rotation, and scale all moving but **NOT in sync** = organic feel. Pauses between movements prevent aimlessness — continuous motion without rest reads as noise.

### Isometric Projection

For isometric/MV-style canvas work without a 3D library:

```
isoX = (x - y) * 0.866
isoY = (x + y) * 0.5 - z
```

Face shading: top face lightest, left face mid, right face darkest. Consistent light direction (top-left) sells the depth illusion. All 2D canvas — no Three.js needed.

### Horizontal Rhythm (Marquees & Tickers)

Vertical scroll is the primary axis. Horizontal movement creates kinetic contrast:

- **Stats tickers** — key numbers scrolling horizontally, creating a stock-ticker energy (Clear Street)
- **Client/partner marquees** — logos or names in continuous horizontal scroll
- **Category strips** — audience types, asset classes, service names flowing horizontally

**Rules:**
- Marquees should be smooth and continuous, not jumpy
- Speed should feel ambient, not urgent (unless urgency is the brand)
- Don't overuse — one or two per page maximum. More than that and horizontal movement becomes noise.
- Consider `prefers-reduced-motion` — pause marquees for users who request it

### What We Avoid
- translateY + opacity fade-in as a default entry effect
- Animation for animation's sake
- Jarring, disconnected timing between elements
- Motion that fights the user's scroll direction
- Animations that replay every time an element enters viewport (once is usually enough)
- Uniform timing on staggered elements (vary the rhythm)
- **Overusing a single entry effect.** Even a good technique (clip-path reveal, blur-to-sharp) becomes monotonous when every element on the page uses it. Repetition kills the magic.
- **Know each effect's home.** Clip-path reveals are strong for **load choreography** (hero entrance, varied timing + directions = composed performance) and **section landmarks**. Blur-to-sharp is a **scroll-linked storytelling device** — content narratively materializing as part of a chapter, not a generic fade-in for static content. Most scroll content doesn't need an entry effect at all — good layout and spacing guide the eye. Content doesn't need to perform just because you scrolled to it.
- **Scroll indicators.** The bouncing pill/arrow/chevron saying "scroll down" is an AI-generated site signature. If the layout doesn't naturally pull the user forward, an indicator won't fix it — better layout will. Never add one.
- **Page-wide cursor effects.** Cursor glow, spotlight, trails etc. as a global page effect feels gimmicky. These interactions work when scoped to specific sections or interactive moments where they serve the experience. Global = decorative noise.
- **Generic hover effects.** TranslateY lift and scale-up on hover are AI defaults. Every generated site does them. Scale expansion is contextually okay when it feels alive/thematic, but should be the exception not the rule. Creative alternatives below.

### Hover & Interactive Effect Arsenal

_Built from iteration. Always growing._

**Hover effects with character:**
- **Clip-path background fill** — a color wipe that sweeps across the element on hover (inset, circle, diagonal)
- **Stroke/outline draw-in** — border draws itself around the element using stroke-dasharray animation
- **Color sweep** — gradient shifts across the element horizontally/diagonally
- **Geometric unfold** — element appears to hinge open slightly, revealing a new face (perspective + rotateX/Y)
- **Glow/warmth radiation** — scoped, subtle glow that emanates from the element (not page-wide)
- **Text scramble** — characters shuffle before resolving (tech brands)
- **Underline grow** — for text links, an underline that draws from left to right or from center outward

**Avoid as defaults:** translateY lift, scale-up expansion. These are the first things AI generates. Use only when they genuinely serve the metaphor.

### Animation & Effect Arsenal

_The full toolkit. Know what each does, when it fits, and what brand metaphor it serves._

#### Entry / Reveal Effects
| Effect | How | Best for |
|---|---|---|
| Clip-path wipe | `clip-path: inset()` transition L→R, R→L, center-out | Load choreography, section reveals |
| Blur-to-sharp | `filter: blur()` → clear | Scroll-linked storytelling, chapters |
| Geometric unfold | `perspective + rotateY/rotateX` from hidden angle | Architectural/MV brands, panel reveals |
| Fold/unfold (hinge) | Element rotates on an edge axis like a door/panel | **Monument Valley signature.** Panels hinge open along edges. |
| Build-up / stack | Elements arrive piece by piece, constructing something | Architectural, craft, construction metaphors |
| Text write-in | Characters appear sequentially as if being typed/written | Journal, editorial, personal brands |
| Text scramble | Characters cycle randomly before resolving | Tech, cyber, data brands |
| Path draw | SVG stroke-dasharray animates from 0 to full | Logo reveals, line art, diagrammatic brands |
| Scale from point | Element grows from a specific origin point | Focused reveals, UI state changes |
| Particle assembly | Elements converge from scattered positions into final form | Creative, playful, generative brands |

#### Ambient / Living Effects
| Effect | How | Best for |
|---|---|---|
| Scroll-linked bg shift | Background color interpolates based on scroll position | Any — creates thermal journey through page |
| Gradient shimmer | Background-position animation on subtle gradient | Water, reflection, luxury, dreamlike |
| Grain drift | Noise texture with translating position | Workshop, analog, textured brands |
| Floating particles | Small elements drifting with sine-wave motion | Atmospheric, dreamlike, spatial |
| Parallax layers | Elements at different scroll speeds creating depth | Immersive, world-building, gaming |

#### Interactive Effects
| Effect | How | Best for |
|---|---|---|
| Mouse-driven scene rotation | `useMotionValue` + transforms on container | World-building, 3D, gaming |
| 3D tilt card | Cursor position → rotateX/Y with springs | Portfolio, product showcase |
| Spring physics | Configurable stiffness/damping/mass | Any interactive — tune to brand personality |
| Fold/unfold on click | Panel hinges open to reveal content beneath | **MV.** Menus, accordions, reveals |
| Magnetic elements | Elements subtly pull toward cursor | Playful, interactive, gaming |
| Drag & place | Draggable elements that snap to positions | Playground, creative tools |

_Theme-specific effects (e.g., Monument Valley fold/unfold, isometric construction) live in THEME-DNA.md._
- **Decorative elements without purpose.** Random geometric shapes floating in whitespace because they "fit the aesthetic" don't add anything. Every visual element should serve a function — navigation, orientation, interactivity, or storytelling. Decoration for decoration's sake is clutter.
- **Reskinning the same layout.** The biggest trap: rebuilding the same site structure (sidebar + pages, or topnav + sections) with a new color palette and calling it a rebrand. If the brief calls for a fundamentally different experience, the STRUCTURE must change too. A Monument Valley theme on a document layout is still a document.

### Background Continuity

_Added from Studio v1 iteration learnings._

- **No hard background breaks between sections.** A page that jumps from one background color to a completely different one feels like stacked blocks, not a flowing experience.
- **Scroll-linked background temperature** is powerful — the background subtly warms or cools as the user progresses. One continuous thermal gradient. This is The Breathe at its most effective.
- **Section dividers should dissolve, not cut.** Gradient lines (transparent → color → transparent) instead of hard 1px borders. Or no divider at all — let spacing do the work.
- **The hero should bleed into content.** Set hero height slightly taller than viewport (105vh+) so the next section peeks up naturally, creating a pull to scroll without any explicit indicator.

---

## Layout & Structure

### Principles

- **The page is a continuous surface, not a stack of sections.** No hard dividers. No clearly demarcated "blocks" with different background colors that don't relate to each other.
- **Content flows.** Use gradients, overlapping elements, and scroll-driven color transitions to create seamless flow between areas.
- **Asymmetry is interesting.** Not every element needs to be centered. Off-grid placement, varied column widths, and intentional whitespace asymmetry create visual tension that keeps the eye moving.
- **Negative space is a design element.** It's not empty — it's breathing room that gives content weight.

### Anti-patterns (The Generic Site Structure)

This is what we never build:
1. ~~Hero section~~
2. ~~"About" section with icon cards~~
3. ~~Feature grid with emoji/icon + heading + description cards~~
4. ~~Testimonials carousel~~
5. ~~"Contact us" section~~
6. ~~Footer with every link ever~~

Every one of these is a default. Templates use them because they're safe. We don't build safe — we build considered. Sometimes a hero is right. Sometimes features need showcasing. But the *how* is what separates our work:

- **Instead of feature cards:** Embed animated product demonstrations. Show the feature working. Use scroll-linked reveals that unfold the capability, not a grid of identical rectangles.
- **Instead of testimonial carousels:** If social proof matters for an entity, integrate it into the narrative — a single powerful quote woven into the page flow, not a carousel of ten that no one reads.
- **Instead of hard sections:** Create visual themes that evolve as the user progresses. The top of the page might feel cool and expansive; the bottom might feel warm and intimate. One journey.
- **Instead of "About":** Let the content *be* the about. The way you present information says more about a brand than a paragraph labeled "About Us."

### Hover & Toggle Anti-Patterns

- **No `hover:bg` on theme toggles.** Background-on-hover for icon toggles is an AI default — it looks clunky and breaks visual smoothness. Theme toggles should animate between states (rotate, scale, opacity cross-fade) with no background highlight.
- **No `hover:bg` on icon-only buttons** unless they're in a toolbar context with other icon buttons. Standalone icon actions should use color shift (`hover:text-sb-ink`) not background fill.
- **Button hover = simple state shift.** Primary buttons (filled) use `hover:opacity-85`. Outline buttons shift border color (`border-sb-rule → border-sb-ink`). Ghost buttons shift text color. All transitions at `duration-150`. No fills, no animated strokes, no gimmicks.
- **All clickable components must have `cursor: pointer`.** Buttons, links, selects, checkboxes, radio inputs, labels with `for`, summary elements — everything interactive shows a pointer. No exceptions. If it responds to a click, the cursor must communicate that.

### The Convention Trap

_Added from Studio v1 learnings. Critical._

It's possible to build a strong brand kit and then put it in a template-shaped container. The brand *uses* the palette, type, and motion vocabulary — but the site *structure* is still generic: top nav, centered hero, scrolling sections with headers, card grids. The brand dresses the template. It doesn't transform it.

**The principle: when the brief allows creativity, the site structure itself should be expressive.**

- **Navigation isn't always a top bar.** A sidebar with notebook tabs, a floating radial menu, a collapsed mark that expands — the nav can express the brand's personality. Convention is right for dashboards, SaaS, and corporate products. For creative/internal/portfolio work, the nav is a design opportunity.
- **Cards should feel integrated, not floating.** Card components are useful, but they shouldn't feel like isolated boxes sitting on a surface. They should feel like *part of* the surface — differentiated through subtle material shifts, not hard borders and elevation.
- **Headers are often overworked.** Section label + section title + subsection title = three levels of "look at this" before the content. Especially on internal tools: the team knows what this is. Let content speak. Small labels are nice touches; stacked headers are overkill.
- **Don't repeat content across pages.** If the brand kit lives in the showcase, the home page doesn't need to display it too. Each page earns its content.
- **Redundant navigation links.** If the logo routes home, don't also have a "Home" or brand-name tab. Every nav item should go somewhere distinct.
- **Page titles restating navigation.** If the sidebar/nav clearly shows which page you're on (active state, indicator), don't repeat the page name as a title in the content area. The content should just begin. Page titles earn their place when navigation is nested, collapsed, or search-based — when the user might not see where they are. Context-dependent, not default.

### World-Based Navigation

_Added from Studio v4b. The breakthrough._

When a site is an experience (not a document), navigation should BE the environment:

- **Portal navigation** — Full-width columns or zones that ARE the destinations, not links to them. Hovering previews the world's theme in real-time. Clicking enters the world. The nav items are the world itself.
- **Mark-triggered overlay** — A single logo mark in the corner that, when clicked, opens a portal selector (blurred backdrop, grid of destination tiles with biome symbols). Feels like a game pause menu. Available from anywhere in the site.
- **Floating exit pill** — Inside a world, a single "← Exit World" pill replaces the entire navbar. Minimal, unobtrusive, always accessible but never competing with content.
- **Persistent utility links** — Things like "Lab" or "Settings" that exist across all worlds can live as small fixed text links (top-right corner). They're not part of the world — they're meta.

**When to use world-based nav:** Creative sites, brand showcases, portfolios, anything where the experience IS the product.
**When NOT to use it:** Dashboards, SaaS tools, content-heavy reference sites. Convention serves utility.

### Logo Interaction Strategy

_Added from Studio v4b._

The site logo/mark has different behaviors depending on context:

- **Home page** → Logo is a **toy/easter egg**. Clicking triggers a compound choreography animation (unfold → rotate → reassemble, or deconstruct → float → snap back). Multi-phase, satisfying, replayable. The logo is alive.
- **All other pages** → Logo is a **navigation trigger**. Opens portal menu or links home. Functional, not decorative.

This creates a subtle discovery moment — users on the home page click the logo expecting navigation and get a delightful surprise instead. It rewards exploration.

**Logo animations use compound choreography** — multi-phase sequences unique to each brand. The specific animation should feel inseparable from the mark's identity. Guard against spam (prevent re-triggering mid-sequence).

### Theme Transition Requirements

_Technical learnings from Studio v4b._

- **Debounce theme switches** (~300ms cooldown). Rapid hover-triggered theme changes queue conflicting CSS transitions that glitch. Guard against this in the provider.
- **CSS custom property transitions are magic.** Border radius, colors, shadows — all morphing smoothly between biomes via `transition: all 0.8s ease` creates the organic shape-shift effect that feels alive. This is technically simple but visually stunning.
- **Each biome needs a unique page entry effect.** Not just different colors — different animation types:
  - Tech/void → clip-path wipe (data materializing from center)
  - Craft/atelier → rotateX fold from top (origami hinge)
  - Nature/grove → scaleY from bottom (growing from earth)
  - The entry effect IS the brand's character.

### Entry Effects Should Match the Metaphor

_Critical learning from Studio v2._

A good animation technique applied generically is still generic. **The entry effect should be inseparable from the brand's identity.** It should tell you something about the brand before you read a word.

- A **design journal/workbook** → content writes itself in, gets stamped, sketched
- A **tech product** → text scrambles/decodes, elements glitch into place
- A **luxury brand** → elements materialize slowly, deliberately, like something being unveiled
- A **data platform** → content assembles from fragments, like data being parsed

The clip-path reveal is a strong tool. But reaching for it as a default entry effect on every project makes it wallpaper. Ask: **what would this brand's content do if it were arriving in character?** The answer is the entry effect.

### Component Libraries

When building brands, create supporting component libraries:
- **Practical scope** — only the components the entity actually needs, not an exhaustive design system
- **Shown in showcase** — the component library is part of the brand kit presentation
- **Injected into repos** — {{BUILDER_NAME}} references these when building production code
- **Living documentation** — components are demonstrated live, not described in static docs

### Two-Phase Design → Code Workflow

**Phase 1: Exploration (static HTML/CSS)**
- Fast, throwaway, pure visual — iterate on direction, palette, layout, component shapes
- No build tools, no boilerplate, no React overhead
- Serve via simple HTTP server for Tailscale preview
- This is where taste happens — explore freely, kill darlings, try variations
- Get approval from {{USER_NAME}} before moving on

**Phase 2: Implementation (React/Tailwind components)**
- Once design is approved, build the actual component kit as typed React/Tailwind
- Create a `components/ui/` directory with proper TypeScript, proper props, proper tokens
- Drop directly into the entity's repo — {{BUILDER_NAME}} imports and composes, no translation needed
- Include: component files, Tailwind config tokens, any shared utilities
- {{BUILDER_NAME}} focuses on data/API/routing/state — not recreating design from a visual reference

**Why both phases:**
- Phase 1 is fast and exploratory — fighting React/build tooling while exploring visual ideas kills creativity
- Phase 2 eliminates the interpretation gap — the design IS the code, no spec translation
- Skipping Phase 2 works if the engineer is strong, but it's always slower and risks drift

### Responsive Design

- **Mobile is not a shrunken desktop.** Touch interactions differ fundamentally from cursor interactions. Simplify animations, adjust hover states for tap, ensure touch targets are generous.
- **Reduce animation complexity on mobile.** Fewer simultaneous animations. Simpler effects. Battery and performance matter.
- **Respect `prefers-reduced-motion`.** Always. Provide a beautiful, functional experience without any animation.

---

## Icons & Visual Elements

### Icons

Icons serve specific functions:
- **Navigation shortcuts** (search, menu, close)
- **Brand/platform logos** (where recognition > words)
- **Functional indicators** (arrows, checkmarks, status)

**They are not:**
- Decorative filler alongside headings
- Replacements for good copywriting
- Used in feature cards to make generic content feel "designed"

**Rule: If removing the icon doesn't reduce understanding, remove the icon.**

### Dropdowns & Select Inputs

**Never ship OS-default dropdowns.** Native `<select>` elements are visually uncontrollable and break visual cohesion immediately. Every dropdown — navigation menus, form selects, filter controls — must be custom-styled to match the entity's design language. Use Radix, Headless UI, or similar accessible primitives as the foundation, then style them fully. The dropdown content (options, panels, nested menus) is part of the design, not an afterthought.

### Popups, Menus & Overlays

**Every popup must be viewport-collision-aware.** Context menus, dropdowns, tooltips, popovers — anything that appears at a dynamic position must detect when it would overflow the viewport and shift/flip accordingly. Never render a menu at raw click coordinates without checking bounds.

- Measure the element after render, shift inward if it exceeds viewport edges (8px padding minimum)
- For complex cases, use **Floating UI** (`flip()` + `shift()` middleware) which handles this automatically
- If the popup is inside a container with `overflow: hidden`, **portal it to the body** so the container doesn't clip it
- This applies everywhere: chart context menus, nav dropdowns, date pickers, autocomplete lists

### Cards

Cards should feel **embedded in the surface**, not floating above it. The default card pattern (border + background + shadow + rounded corners) is overengineered and creates visual clutter.

**The rule: border OR background, never both.**

- **Border card** — transparent/no background, subtle border to define the boundary. Feels like a region of the page, not a separate object. Works well on surfaces where the card content is the focus.
- **Background card** — slight surface shift (e.g., `surface-secondary` on a `surface-primary` page), no border. Differentiates through material, not outline. Feels like a different layer of the same surface.
- **Never border + background + shadow.** That's three levels of "I'm a separate thing" — it screams UI kit default.
- Elevation (box-shadow) should be used sparingly and only when a card genuinely floats above content (modals, popovers, tooltips). Not for content cards sitting in a layout.

### Emojis

**No.** Not in headings. Not in body copy. Not in navigation. Not anywhere visible to users in our designs. Emojis are informal, uncontrollable (they render differently across platforms), and destroy visual cohesion. We design our own visual language — we don't borrow Apple's.

### Decorative Elements

When a design needs visual texture beyond content:
- **Subtle grain/noise overlays** for tactile depth
- **Geometric patterns** derived from brand identity
- **Ambient gradients** that shift with interaction
- **SVG-based abstract shapes** unique to each entity
- **Light/shadow play** for dimensional depth
- **Generative/3D abstract art** — brand-native visualizations (mesh forms, crystalline structures, abstract data-scapes). Clear Street uses these beautifully to bridge "real company" with "future-forward tech." These should feel native to the brand, not generic stock 3D renders.

---

## Logo Design

### Our Approach

Logos are icon-only marks. No wordmarks needed — the mark should stand alone and work at every size, including favicons (16x16, 32x32).

### SVG-First

Logos should be SVGs. Period. They scale perfectly, they're tiny in file size, and they can be animated.

**On LLM-generated SVGs:** The field has limitations but is improving rapidly. Our approach:
- **Lean geometric.** Clean shapes, mathematical relationships, defined paths. This is where programmatic generation excels.
- **Embrace constraints.** The best logos are often the simplest. A strong geometric mark at 32x32 is better than a complex illustration that turns to mush.
- **Iterate aggressively.** Generate variations, refine, hand-tune the SVG code if needed. SVGs are just XML — we can edit them directly.
- **Study the reference logos:** Adurant's marks, Antimetal's logo, Palantir's hexagonal mark — all geometric, all distinctive, all work at small sizes.

### Logo Principles
- Must be legible at 16x16 (favicon)
- Must work on both light and dark backgrounds
- Should feel inevitable — like it couldn't be any other way
- Geometric > illustrative for our workflow
- Color optional — should work in monochrome first
- Each entity's logo is part of a broader brand kit (palette, typography, mark)

---

## Promotional Media

Adurant's portfolio brand clips show what's possible: short, punchy, animated promotional content that extends the brand beyond the website.

### Our Approach: Remotion

Remotion lets us build promotional video with the same tools we build our sites:
- React components for composition
- TypeScript for type safety
- Our existing design tokens and brand assets
- Programmatic rendering — we can generate variants, personalized content, series

### What Promotional Media Looks Like For Us
- **Brand intro clips** — 5-15 second animated pieces that capture an entity's visual identity
- **Feature demonstrations** — animated product walkthroughs
- **Social content** — formatted for platform-specific dimensions
- **Interactive elements rendered to video** — our web animations, captured as distributable media

---

## Theme Architecture

### Theme Strategy

Every project starts with a deliberate decision about theming. Three tiers:

**1. No toggle** — The site has one identity. The mood IS the brand. Adding light/dark would dilute it. Default for marketing sites, brand-forward products, anything with strong visual conviction.

**2. Simple toggle** — Swap palette, shadows, borders. Typography, layout, animations stay the same. Good for dashboards, tools, content-heavy sites where users spend hours. Quick to implement, covers accessibility needs. **This is our default when a toggle is needed.**

**3. Full personality shift** — Different typography, animations, icons, component styling, even layout. Two distinct design expressions under one roof. Reserved for when dual identity is a feature, not just a preference. High overhead — only when explicitly requested.

When specifying a new project, state the theme strategy upfront: `none`, `simple`, or `full`.

### Dark/Light Mode Done Right

Drawing from Antimetal's approach:

```
Light mode ≠ white background + dark text
Dark mode ≠ dark background + light text

Light mode = the brand's daytime expression
Dark mode = the brand's nighttime expression
```

Both modes should feel intentional and complete. Implementation:

- **CSS custom properties for all color tokens** — switch the entire token set, not individual values
- **Tailwind's `dark:` variant** for utility classes, but backed by semantic token names (not raw colors)
- **Consider beyond color:** imagery, shadow intensity, border opacity, gradient directions can all shift between modes
- **Respect system preference** by default, allow manual override

### Token Structure (Tailwind + CSS Custom Properties)

```
--color-surface-primary      /* main background */
--color-surface-secondary    /* elevated surfaces */
--color-surface-tertiary     /* deeply nested surfaces */
--color-content-primary      /* main text */
--color-content-secondary    /* supporting text */
--color-content-tertiary     /* subtle text */
--color-accent-primary       /* brand accent */
--color-accent-secondary     /* secondary accent */
--color-border-default       /* subtle borders */
--color-border-emphasis      /* emphasized borders */
--color-interactive-default  /* button/link default */
--color-interactive-hover    /* button/link hover */
--color-interactive-active   /* button/link active */
```

Every color in the system references these tokens. Mode switching changes the tokens — everything downstream updates automatically.

---

## Performance & Accessibility

### Performance

Beauty means nothing if it takes 5 seconds to load.

- **Core Web Vitals are non-negotiable.** LCP < 2.5s, FID < 100ms, CLS < 0.1
- **Lazy load everything below the fold.** Images, heavy animations, video.
- **GPU-accelerate animations.** Use `transform` and `opacity` — never animate layout properties (`width`, `height`, `top`, `left`).
- **Measure animation FPS.** If it drops below 60fps on mid-range hardware, simplify.
- **Image optimization:** WebP/AVIF, responsive `srcset`, blur-up placeholders that match the brand aesthetic.
- **Font loading:** `font-display: swap`, preload critical fonts, subset where possible.

### Scrollbar Strategy

Context-dependent, not universal:

- **Immersive/world sites** → Hide scrollbar (`scrollbar-width: none; &::-webkit-scrollbar { display: none }`). The site is an experience — visible scrollbars break immersion. The user explores naturally.
- **Tools/dashboards** → Custom thin scrollbar (6px, themed to match palette). Users need orientation when scanning long content.
- **Default for our work** → Hide. We build worlds, not documents. If the site is engaging enough, users know to scroll.

### Accessibility

- **`prefers-reduced-motion` is sacred.** Every animation must have a reduced-motion alternative. This isn't optional.
- **Contrast ratios meet WCAG AA minimum.** Our color choices must be beautiful AND readable.
- **Semantic HTML always.** Animation and visual flair don't replace proper heading hierarchy, landmark regions, and ARIA where needed.
- **Keyboard navigation works.** Every interactive element is reachable and operable without a mouse.
- **Focus indicators are designed, not hidden.** Custom focus rings that match the brand — visible, clear, on-brand.

---

## Case Study Reference

These are our north stars. Not to copy — to understand.

### Adurant Labs & Portfolio (Galaxy, Plasma)
**What we learn:** Minimal canvas + expressive moments. The page is almost entirely whitespace — content earns its place through scarcity. Portfolio pieces are shown as embedded media (video clips, not screenshots), making each brand feel alive within Adurant's own site. Colors pop because they're rare. Promotional media extends brand beyond the page. Feature-specific hover/entry effects feel unique to each brand. The entire visual weight comes from typography and spacing — barely any UI chrome.

### Antimetal
**What we learn:** Load choreography as brand introduction. The hero uses a deep blue gradient with an interactive particle/node visualization — it creates depth and atmosphere before you read a word. The page flows through a continuous color journey: deep blue → light blue → white → warm blue → bottom. No hard section breaks. Product demonstration is embedded directly as animated UI, not described in cards. The "Find → Fix → Prevent" flow replaces what would typically be a feature card grid. Theme switching transforms the entire mood. Cursor-reactive elements.

### Palantir
**What we learn:** Managing massive content breadth with elegance. Video backdrop shows a real facility — contextual, not decorative. Tabbed content navigation manages product depth without overwhelming (Security, Data Science, AIP, Infrastructure — all accessible from one interface). Typography does extreme heavy lifting at massive scale — the mission statement fills the viewport. Capabilities are listed as clean text statements, not icon cards. The site feels "sturdy" because of confident typography, generous spacing, and restrained color. Corporate-modern without being sterile.

### Monument Valley (ustwo)
**What we learn:** A masterclass in expressing complexity through simplicity.

**Shape language:** Everything is built on a strict 30° isometric grid. Structures composed of cubes, rectangular prisms, columns, arches, stairs — all flat-shaded with three-tone directional lighting (light face, medium face, dark face). No textures. No gradients on geometry. Pure color on faces. Characters abstracted to the simplest possible form (a tiny cone-hat figure). Penrose triangles, impossible staircases, Möbius-like paths as core motifs. Interactive elements are circles, rotors, wheels — rotation as the primary verb.

**Color:** Each level has its own monochromatic or analogous palette — teal levels, coral levels, amber levels, deep purple levels. The palettes sit in a specific zone: mid-saturation, avoiding both heavily saturated darks and washed-out lights. Background gradients are atmospheric washes behind sharp geometric foreground, creating depth through contrast of edge quality. Each chapter's palette shift *is* the emotional progression — color tells the story.

**Motion:** Structure rotations are smooth with predictable easing — feels like turning a physical object with mass. Character movement is steady-paced with no acceleration (deliberately calm). Element slides use gentle ease-in-out. Level transitions dissolve between color palettes. Water renders as gently undulating triangulated meshes. Sound design is synaesthetic — zither-like tones triggered by movement, making motion feel musical.

**Evolution across games:** MV1-2 drew from South Asian, Arabic, and European architecture (angular, tower-based). MV3 introduced South East Asian influences — curves in geometry, plant shapes, more organic forms. The origami level transforms the entire screen into a flat artboard with Risograph textures, moving between 2D and 3D. This proves the visual language can evolve dramatically while maintaining its soul.

**For our web work, MV teaches us:**
- Flat-shading with directional lighting creates depth without gradients or drop shadows
- Monochromatic/analogous palettes per "scene" create mood without complexity
- Simple shapes composed into complex structures = elegance through composition, not detail
- Calm, deliberate motion with consistent easing = serenity
- Atmospheric backgrounds behind sharp foreground geometry = depth perception
- Every element reduced to its simplest expressive form — nothing unnecessary

### Clear Street (by Burocratik)
**What we learn:** How to make a fintech site feel alive instead of corporate-dead.

**Scroll-driven narrative:** The homepage tells a story as you scroll — "The financial industry still operates on outdated infrastructure built in the 1970s" → "Over the years, technology has been layered on top..." → "Leading to inefficiencies..." → "This is where Clear Street comes in." Sticky text transitions that unfold the problem/solution arc. The user doesn't read sections — they experience a narrative. No hard snapping, just smooth scroll-linked storytelling. This is our scrollytelling ideal.

**Color confidence:** Their saturated blue isn't just for buttons — it owns entire sections. Full-width blue backgrounds that transition smoothly into white areas via gradient dissolution. The blue is used with enough restraint elsewhere that when it goes full-bleed, it hits hard. Proof that a single brand color used boldly can carry an entire site.

**Stats at scale:** Numbers like "$1.0bn" fill significant viewport space. A horizontal stats marquee/ticker creates kinetic energy within a vertical scroll. This replaces generic "numbers in boxes" with typographic landmarks that convey authority through sheer visual weight.

**Product embedded, not described:** Clear Street Studio is shown as animated/interactive UI in-context — you see the product working, not a feature list explaining it. The dark-mode Studio sections use generative 3D data visualizations (abstract mesh/crystalline forms) that extend the brand into unique visual territory. This is the Antimetal approach taken further — the product IS the demonstration.

**Navigation done right:** Clean top nav with well-organized dropdowns, frosted glass effect that adapts on scroll. CTAs (Login, Studio) are visually separated from navigation links. Disappears when not needed. Serves function without competing with content.

**Horizontal marquees:** Client types, stats, clearing partner lists — horizontal scrolling elements within a vertical page create rhythm and kinetic contrast. Not overused, but placed at strategic moments to break vertical monotony.

**Photography with purpose:** Real team photos, real offices, real whiteboards — not stock. Mixed with generative abstract art. The combination of authentic photography + branded generative visuals creates a feeling of "real company, future-forward technology."

**What this adds to our toolkit:**
- Scroll-linked narrative (sticky transitions for problem → solution arcs)
- Stats as typographic landmarks at massive scale
- Horizontal marquees for kinetic contrast within vertical scroll
- Generative/3D abstract art as brand-native visual extension
- Full-bleed brand color sections with gradient transition edges
- Product-as-demonstration (animated UI in context)

### Burocratik (Studio Reference)
**What we learn from the studio itself:** A 9-person team in Portugal with 287 awards. Best Studio at CSS Design Awards 2022, Top 15 on Awwwards. Their principles are instructive:

- **"NO POPPINS"** — they literally reject generic defaults. This is the same instinct behind our anti-pattern list. Opinionated rejection of the expected.
- **"Design is not tequila. It can't make everyone happy."** — Having taste means not every audience will love it. That's fine.
- **Typography as architecture** — They use type at massive, structural scale. Numbers, statements, principles — all displayed as visual landmarks, not just content. Type isn't read, it's experienced.
- **Branding → Digital is one stream** — Their process treats brand identity and digital implementation as continuous, not separate phases. The brand IS the digital experience. This aligns perfectly with our approach.

### OpenClaw (Anti-reference)
**What we learn from avoiding:** The classic AI-generated site structure in action — Hero → "What People Say" (testimonial carousel) → Quick Start → "What It Does" (6 identical feature cards with icons) → "Works With Everything" (badge/pill grid) → "Featured In" → newsletter → footer. Every section has distinct, disconnected background styling. Feature cards are the exact icon + heading + description pattern. Integration badges are noisy. Sections are visually isolated blocks, not a flowing experience. The overall feeling is *template* — functional but without soul. This is our benchmark for what we never build.

---

## Design Process

### How We Approach a New Entity

**Step 0: Intake conversation.** Before any design work, we talk. See `BRAND-INTAKE.md` for the full guide — but the core idea is simple: never design blind. Ask about emotional direction, content shape, audience, references, constraints. This is a conversation, not a form. Listen for implicit answers, clarify ambiguity, and summarize understanding before starting.

Then:
1. **Feel first.** What emotion should this brand evoke? Energetic? Serene? Trustworthy? Playful? This drives everything.
2. **Palette and type.** Establish the visual foundation before touching layout.
3. **Motion vocabulary.** Define 2-3 signature animations/interactions for this entity. These become its kinetic identity.
4. **Layout concept.** How does content flow? What's the narrative structure? Is this a story or a tool?
5. **Prototype real.** Build in code, not mockups. See how it actually moves and responds.
6. **Refine obsessively.** The difference between good and great is in the details most people never consciously notice but always feel.

### Handoff to Engineering ({{BUILDER_NAME}})

We don't "hand off" — we collaborate:
- Prototypes are built in the same stack (Next.js + Tailwind)
- Design tokens are code, not screenshots
- Animation specs include easing curves, durations, and spring configs
- Components are designed as systems, not one-offs
- If {{BUILDER_NAME}} has a better way to implement something, we listen

### Git Workflow

Git workflow (branching rules, PR process, merge policy) is defined per-project in each repo's `CLAUDE.md`. Read it before starting work.

---

## Living Document

---

## Build Checklist — Every Site, Every Time

Things that are easy to forget but non-negotiable:

- **Favicon.** Always. Generate from the entity's mark/logo. SVG preferred (`app/icon.svg` in Next.js). Must work at 16×16. A site without a favicon looks unfinished.
- **`<title>` and meta description.** Even internal sites.
- **`prefers-reduced-motion` respect.** Always.
- **Viewport meta tag.** (Next.js handles this, but verify.)
- **No gradient text.** Solid colors only for all text.
- **Abstract geometric logos.** No letters, no initials. Must be legible at 16×16.
- **Theme strategy declared.** `none`, `simple`, or `full` — decided at project kickoff, not afterthought.

_This list grows as we catch things we keep forgetting._

---

This DNA evolves. Every project teaches us something. When we discover a pattern that works, we codify it here. When we find an anti-pattern, we document it.

**Last significant update:** 2026-03-09 — Added Clear Street + Burocratik case studies. New patterns: scroll-driven narrative (sticky transitions), stats at typographic scale, horizontal marquees for kinetic contrast, generative art as brand extension, full-bleed color confidence.

---

_Design is not what it looks like. Design is how it works. But when both are extraordinary — that's what we do._
