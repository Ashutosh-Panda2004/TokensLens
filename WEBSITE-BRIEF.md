# TokenLens — Website Build Brief & Content Bible

**Document purpose:** This is the complete specification for building the TokenLens launch website. It is written for an AI web-development model that has **zero prior context** about this product. Everything you need — the product story, the exact copy, the design system, the motion choreography, the data, and the rules — is in this file. Do not look anything up. Do not invent anything.

**Document version:** 1.0
**Prepared for:** Google AI Studio (front-end build)
**Stack assumption:** React + Tailwind + GSAP (ScrollTrigger) + optional Three.js / React Three Fiber. Substitute freely, but honour the *behaviour* described.

---

# PART 0 · HOW TO USE THIS DOCUMENT — READ THIS FIRST

## 0.1 The single most important rule

**This product's entire identity is that it does not lie with numbers.**

TokenLens exists because every other tool in its category presents estimates as if they were facts. Its core principle — enforced in its source code, in its type system, and in its command-line output — is:

> **Never publish an estimate as a measurement.**

Therefore the website must obey the same rule. This has three hard consequences:

1. **Do not invent a single number.** Every figure you may display is listed in **PART 9 · DATA APPENDIX**. If a number is not in Part 9, it does not go on the site. If you need a number for a layout and cannot find one, use the copy provided or leave the space — do not fabricate a plausible-looking statistic.

2. **Every number on the site must visibly carry its provenance.** This is the site's signature design device (see **PART 5.1**). A number that was read from a real file gets a green `measured` chip. A number that was projected or modelled gets an amber `modelled` chip. An aggregate total that mixes both gets an amber `blended` chip showing the exact split. **No unlabelled number appears anywhere on the page.**

3. **Never soften a "modelled" label.** Do not write "proven savings of $2.1M". Write "modelled savings of $2.1M" with the amber chip. Counter-intuitively, this *increases* persuasion with the target audience — see Part 2.

If you follow only one instruction from this document, follow this one. A beautiful site that fudges a number destroys the product's premise.

## 0.2 What you are building

A long-form, scroll-driven, single-page marketing and pitch website. It will be presented **live, on a screen, by a person, to a room of senior executives**. It is therefore not a lead-generation page — it is a **presentation instrument**. Design for someone scrolling through it while talking over it.

Practical consequences of that:

- **Sections must be self-contained.** The presenter may jump. Each section must make sense cold.
- **Every section needs one dominant idea and one dominant visual.** No section should require reading three paragraphs to understand.
- **Text must be readable from three metres away** on a projected screen. Body text minimum 18px, key figures very large.
- **Provide a persistent section navigator** so the presenter can jump directly to a section.
- **Nothing may depend on hover** to be understood — the presenter may be using a clicker, not a mouse. Hover is enhancement only.

## 0.3 Document map

| Part | Contains |
|---|---|
| **PART 1** | Full product context. Read this before anything else. |
| **PART 2** | Audience, objectives, what success looks like |
| **PART 3** | Creative direction — the theme and why |
| **PART 4** | Design system: colour, type, spacing, motion tokens |
| **PART 5** | Signature component specifications |
| **PART 6** | Section-by-section build: exact copy + layout + motion |
| **PART 7** | The scenario section, specified in depth |
| **PART 8** | The interactive calculator |
| **PART 9** | **DATA APPENDIX — the only numbers you may use** |
| **PART 10** | Voice, tone, and forbidden phrases |
| **PART 11** | Technical implementation notes |
| **PART 12** | Asset list |
| **PART 13** | Acceptance checklist |

---

# PART 1 · PRODUCT CONTEXT

*You have no prior knowledge of this product. This part gives you all of it. Read it fully before writing any copy.*

## 1.1 The world this product lives in

GitHub Copilot is an AI coding assistant used inside the VS Code editor by millions of professional software engineers. Until recently, organisations paid a flat monthly fee per developer and usage was effectively unlimited.

**That changed.** GitHub moved Copilot to **metered billing**. Organisations now buy "AI Credits". Each plan includes a monthly allowance of credits, pooled across the whole organisation. When the pool runs out, **Copilot stops working** — there is no fallback, no degraded mode, no cheaper model. It simply cuts off until the next month or until you buy more.

Two facts make this urgent:

- **1 AI credit = $0.01.**
- The generous promotional credit allowances that launched with metered billing **drop by roughly 37%** on **1 September 2026**. Copilot Business goes from 3,000 to **1,900** credits per user per month. Copilot Enterprise goes from 7,000 to **3,900**.

So on 1 September, every organisation using Copilot at scale gets substantially less included capacity for the same subscription fee, and starts paying overage on the difference.

## 1.2 The problem, stated plainly

**GitHub's billing dashboard tells you *that* you spent the money. It does not tell you *what you spent it on*.**

An executive can see: "Your organisation consumed 4.9 million credits last month." They cannot see which requests, which developers, which tools, which behaviours, or which of it was avoidable. There is no itemised bill. There is no line-item detail. There is a total.

This is unusual. No other significant line in a technology budget works this way. Cloud compute is itemised to the instance-second. Software licences are itemised per seat. AI-assisted engineering — now one of the fastest-growing line items in an engineering budget — arrives as a single opaque number.

## 1.3 The insight nobody else had

Here is the thing that makes this product possible.

**VS Code already writes an extremely detailed record of every single Copilot request to the developer's own hard drive.** It is a local file. It sits in the VS Code workspace storage folder. It has always been there. Nobody reads it.

That file contains, for every request:

- The exact number of tokens sent to the model
- **A breakdown of those tokens into five named categories** — VS Code itself computes this and writes it down
- Which model was used
- Every tool the AI called, and what each tool returned
- Every file the AI read
- Every edit it proposed
- How long each step took
- And for some requests, **the exact credit cost GitHub charged**

Nobody had looked. The product's founding act was reading that file.

## 1.4 What was found

A real developer's Copilot history was analysed: **115 days · 102 session files · 790 model requests · 10,532 tool-call rounds.** These are measurements, not estimates. Every one is reproducible from the files on disk.

The five findings that matter most to a non-technical executive:

### Finding A — Almost none of what you pay for is your question

Every time a developer asks Copilot something, the request that gets sent and billed is enormous — a median of **83,166 tokens**. The developer's actual question is a rounding error inside it. The rest is context: conversation history, file contents, tool descriptions, and previous tool results.

### Finding B — About one fifth of every request is a fixed toll unrelated to the question

Software teams install "tools" and "MCP servers" that extend what Copilot can do — a database connector, a ticketing integration, a documentation searcher. Each installed tool must be **described to the AI in full, in every single request**, so the AI knows the tool exists.

That description is billed. Every time. Whether or not the tool is used.

Measured: the median request spent **17,016 tokens** — about **21% of the entire prompt** — purely on describing installed tools. One observed request spent **74%** of its budget describing tools before a single word of the developer's question was processed.

**The cost scales with what you have *installed*, not what you *use*.** A team that installs six integrations and uses two pays for six, on every request, forever. This has a name in the product: **the Tool-Definition Tax**. Nobody prices it. Nobody has ever seen it.

### Finding C — You pay for the same words about ten times over

An AI model has no memory. To continue a conversation, the entire conversation must be re-sent with every new message. In an agent loop — where the AI reads a file, thinks, runs a command, thinks again — the accumulated context is re-transmitted at every step.

Measured amplification: **9.8×**. Every token of genuinely new content is paid for approximately ten times.

### Finding D — Leaving a chat window open is expensive, and it's free to fix

Because history is re-sent every turn, a long-running chat gets more expensive with every message. Measured: a conversation on its 33rd message costs **61% more per message** than a fresh one.

The fix is *"start a new chat when you start a new task."* It costs nothing, requires no tooling, and nobody does it — **because nobody can see the meter running.**

### Finding E — The spend is wildly concentrated

**16% of chat sessions accounted for 50% of all money spent.** The most expensive single session cost **$32.70**; the median session cost **$3.61**.

This is good news: you do not need to change how everybody works. Fixing the worst tenth captures most of the value.

## 1.5 Why no existing tool can do this

There is a large, well-funded category of "LLM observability" tools. None of them can see this, for a structural reason:

Those tools work by sitting **in the network path** — you route your AI traffic through them, and they inspect it. That works when your application calls an AI provider directly.

**It does not work for Copilot.** The traffic goes from the developer's editor to GitHub over a channel the customer does not control and cannot intercept. There is no proxy point. You cannot put a tool in the middle.

So the *only* place this data exists in a readable form is the local file on the developer's machine — and reading it requires reverse-engineering an undocumented, unstable, event-sourced file format that changes with VS Code releases.

**That difficulty is the product's moat.** It is why the category is empty.

## 1.6 What TokenLens is

**TokenLens is a local tool that reads the Copilot usage records already on your engineers' machines and turns an unexplained invoice into an itemised bill — then into a specific, deployable saving.**

It does four things, in order:

1. **Measure** — read the local records and produce an exact, traceable credit ledger. Every figure can be traced back to a specific file and byte position on disk.
2. **Attribute** — assign wasted spend to **fourteen named, individually detectable causes**, so waste is never a vague total but always a specific, fixable thing.
3. **Simulate** — replay real recorded sessions under a proposed policy and report what it *would have* saved, before anything is deployed.
4. **Enforce** — emit the exact configuration files an IT team deploys through existing device-management tooling. **Most of the saving requires no developer to change any behaviour at all.**

And then, critically:

5. **Prove** — run the change as a randomised trial against a holdout group on the customer's own fleet, and report the *actual* realised saving with confidence intervals, including where the model was wrong.

## 1.7 The six principles (these are real, and they are a selling point)

These are enforced in the product's source code, not aspirations on a slide.

| # | Principle | What it means for a customer |
|---|---|---|
| **P1** | **No source code ever leaves the machine.** | Only aggregate counts and irreversible hashes. Offline by default. Nothing to review with your data-protection officer. |
| **P2** | **Every number is traceable.** | Any figure in any report can be traced to the exact file and byte position it came from. One command prints the receipt. |
| **P3** | **Never publish an estimate as a measurement.** | Every figure is labelled `measured` or `modelled`. The distinction is enforced by the type system — the code physically cannot print an estimate without its label. |
| **P4** | **Read-only on user data.** | Opens files for reading only. Never writes to, moves, or alters a developer's data. |
| **P5** | **Degrade loudly, never silently.** | If the tool doesn't understand something, it says so and counts it. It never quietly reports zero. |
| **P6** | **Zero infrastructure to adopt.** | No proxy, no server, no agent, no data pipeline. One command on one laptop produces the first report. |

## 1.8 Current status (as at 31 July 2026)

Three of ten build phases are complete and working:

- **Phase D0 — Foundation.** Complete.
- **Phase D1 — Ingest and Credit Ledger.** Complete. The tool reads real Copilot journals and produces an exact, traceable ledger.
- **Phase D2 — Dashboard and Reporting.** Complete. A local dashboard and offline exportable report.

**The tool is running today on real data.** The live figures in Part 9.2 are what it currently reports on the developer machine it was built on. Phases D3–D9 (waste attribution, simulation, policy compilation, runtime enforcement, editor integration, randomised proof, organisation rollup) are specified and sequenced.

The website must be honest about this. **Do not imply that phases D3–D9 are shipped.** Part 6 includes a dedicated roadmap section that handles this properly — and handles it as a strength, not an apology.

---

# PART 2 · AUDIENCE & OBJECTIVES

## 2.1 Who is in the room

**Primary audience: Vice President level and above. Non-technical or semi-technical.** They may run Engineering, Technology, Operations, or Finance. They approve budgets. They do not write code.

They care about:
- Money, expressed in currency and in annual terms
- Risk — to data, to productivity, to their own credibility if they champion this
- Effort — how much of their organisation's time this consumes
- Certainty — how do they know it's true

They do **not** care about:
- Architecture, file formats, programming languages, test coverage
- How clever the engineering is
- Feature lists divorced from outcomes

**Secondary audience:** a technical lead in the room who will be asked *"is this real?"* after the meeting. The site must contain enough substance to survive their scrutiny — but that substance must be **layered underneath**, in expandable detail panels, never in the primary reading path.

## 2.2 What the site must achieve

In priority order:

1. **Make an invisible cost visible.** The executive should leave able to say the sentence *"about a fifth of what we pay is describing tools we may not even use"* to someone else. If they can repeat one fact, the site worked.
2. **Establish that this is measured, not guessed.** Differentiation is honesty. Lead with it.
3. **Show the money at organisational scale**, and show that it lands on the line finance actually feels.
4. **Kill the effort objection.** The headline intervention is a configuration change pushed through tooling the organisation already owns. No developer retraining. No workflow change.
5. **Kill the risk objection.** Nothing leaves the machine. Read-only. Offline by default.
6. **Ask for a specific, small next step** — a two-week measurement pilot, not a purchase.

## 2.3 The one-sentence pitch

> **Copilot bills you by the token, cuts you off when the budget runs out, and cut included capacity by 37% in September. We read the usage records already sitting on your engineers' machines, show you exactly what every credit bought, and hand your IT team a configuration change that removes a third of the spend without any developer changing how they work.**

## 2.4 The emotional arc to design for

| Section range | Intended feeling |
|---|---|
| Hero → Cliff | *"Wait — is that on our books?"* — unease |
| Anatomy → Tool tax | *"I have never seen this. Nobody has ever shown me this."* — revelation |
| Blind spot | *"So this is why nobody has fixed it."* — permission to have missed it |
| Product → How it works | *"Oh. That's simpler than I feared."* — relief |
| Scenario | *"I can see us doing this."* — projection onto self |
| Calculator | *"Let me try our number."* — ownership |
| Trust / Honesty | *"They told me what they don't know."* — credibility |
| Ask | *"That's a small ask."* — easy yes |

Never let the site feel like it is *selling*. It should feel like it is *revealing*. The product is positioned as a measuring instrument, and instruments do not persuade — they show.

---

# PART 3 · CREATIVE DIRECTION

## 3.1 The concept: **The Instrument**

The site should feel like **a precision measuring instrument that has been pointed at something nobody has ever measured.**

Not a SaaS marketing page. Not a dashboard mock-up. An *instrument* — dark, calibrated, luminous, exact. Part oscilloscope, part financial ledger. The visual tension between **scientific measurement** and **financial accounting** is the whole aesthetic.

Three ideas drive every design decision:

### Idea 1 — Darkness that resolves into light

The site opens nearly dark. As the visitor scrolls, structure emerges from the dark: a solid grey block becomes five labelled coloured bands; a flat number becomes a decomposed breakdown; an unexplained total becomes an itemised bill.

**The scroll *is* the act of measurement.** Nothing should ever "fade in" generically. Things should *resolve*, *decompose*, *illuminate*, or *get labelled* — as though an instrument is being focused.

### Idea 2 — Every number wears its receipt

The signature device. Every single figure on the entire website carries a small chip beside it:

- **Green `measured`** — read from a real file.
- **Amber `modelled`** — projected or estimated. Hovering or tapping reveals the assumption behind it.
- **Amber `blended · N% measured`** — used only for *aggregate totals* that sum measured and modelled parts together. A single value is always one or the other; a total across hundreds of requests is routinely a mix, and claiming otherwise in either direction would be a lie. The real product makes exactly this distinction, so the site must too. See Part 5.1 and Section 12.

There is **no fourth state**, and **no unlabelled number anywhere on the page.**

This is not decoration. It is the product's core principle, applied to the marketing material itself. **The website practices what the product preaches.** It is unusual, it is instantly noticeable, and it is the strongest possible proof of the honesty claim — because we are volunteering the weakness of our own numbers.

The chip legend must appear early (in the hero) and be persistently accessible.

### Idea 3 — The ledger rule

A thin horizontal hairline, like a ruled line in an accounting ledger, is the site's recurring structural motif. It separates sections, underlines figures, and forms the baseline that data grows from. When a value animates in, it should feel like it is being *entered into a ledger* — settling onto a line, not floating in space.

## 3.2 What to avoid

- **No stock photography of people at laptops.** Ever.
- **No generic gradient blobs / aurora backgrounds.** Overused.
- **No cartoon illustrations, no 3D blobs, no isometric characters.**
- **No fake dashboard screenshots with invented numbers.** Where a dashboard is shown, use the real figures in Part 9.2.
- **No "AI" clichés** — no glowing brains, no neural network node diagrams, no circuit-board motifs, no robot hands.
- **No confetti, no celebration animations.** This is a serious financial instrument.
- **Do not use purple-to-pink SaaS gradients.** The palette in Part 4 is deliberate.

## 3.3 Reference feeling (for calibration, not imitation)

The intersection of: a Bloomberg terminal, a scientific instrument panel, a Swiss financial report, and a spectrometer readout. Restrained, dense, confident, luminous on black. High information density treated as beautiful rather than hidden.

---

# PART 4 · DESIGN SYSTEM

## 4.1 Colour tokens

```
/* Surfaces — near-black with a cold instrument tint */
--surface-void:        #04070B   /* page background */
--surface-base:        #080C13   /* section background */
--surface-raised:      #0D131C   /* cards */
--surface-overlay:     #131B27   /* modals, popovers */
--hairline:            #1C2635   /* the ledger rule */
--hairline-bright:     #2B3849   /* emphasised rule, active states */

/* Text */
--text-primary:        #E9EFF6
--text-secondary:      #97A6B8
--text-tertiary:       #5F6E80
--text-inverse:        #04070B

/* PROVENANCE — the two most important colours on the site */
--measured:            #34E5A0   /* green. Read from a real file. */
--measured-dim:        #34E5A01A
--measured-text:       #7CF3C4
--modelled:            #FFB43D   /* amber. Projected or estimated. */
--modelled-dim:        #FFB43D1A
--modelled-text:       #FFD08A

/* Semantic */
--waste:               #FF5470   /* avoidable spend, alerts, the cliff */
--waste-dim:           #FF54701A
--saved:               #34E5A0   /* same as measured, deliberately */
--neutral-spend:       #4D7FFF   /* unavoidable / baseline spend */

/* The five cost centres — used in the treemap and everywhere they appear.
   These five colours are FIXED. The same category is always the same colour
   on every screen of the site. This consistency is what lets the presenter
   say "the amber block" and be understood. */
--cc-messages:         #4D7FFF   /* Conversation history */
--cc-tool-results:     #8B5CF6   /* What tools returned */
--cc-tool-defs:        #FFB43D   /* Tool descriptions — THE HERO COLOUR */
--cc-files:            #22B8CF   /* Attached files */
--cc-system:           #64748B   /* System instructions */

/* Accent — used sparingly, for focus and CTA only */
--accent:              #34E5A0
--accent-glow:         0 0 40px rgba(52, 229, 160, 0.25)
```

**Correction to the above:** none. All tokens above are final.

**Colour discipline:**
- Amber `--cc-tool-defs` is the site's most important accent. It is the Tool-Definition Tax. **Do not use amber for anything else decorative** — it must always mean either "tool definitions" or "modelled". Its scarcity is what makes it land.
- Red `--waste` appears only for: the September cliff, avoidable spend, and warnings. Never decorative.
- Green `--measured` doubles as the saving colour, deliberately — the emotional link between *measured* and *saved* is the product's thesis.

## 4.2 Typography

```
Display / headlines:   'Instrument Sans', 'Space Grotesk', system sans
                       — weight 500–600, tight tracking (-0.02em to -0.04em)
Body:                  'Inter', system sans — weight 400, 1.65 line-height
Numerals & data:       'JetBrains Mono', 'IBM Plex Mono', ui-monospace
                       — ALWAYS tabular-nums. Every figure on this site is
                         monospaced. This is non-negotiable: it is what makes
                         the site read as an instrument rather than a brochure.
Micro-labels:          'JetBrains Mono', uppercase, 0.16em tracking, 11–12px
```

**Type scale** (fluid; values are the desktop end of a `clamp()`):

| Token | Size | Use |
|---|---|---|
| `display-xl` | 104px | Hero line only |
| `display-l` | 72px | Section-opening statements |
| `display-m` | 52px | Section headlines |
| `heading` | 34px | Sub-headings |
| `subhead` | 24px | Lead paragraphs |
| `body-l` | 19px | Primary body — **never smaller than this for body copy** |
| `body` | 17px | Secondary body |
| `caption` | 14px | Footnotes, chip explanations |
| `micro` | 11px | Uppercase labels |
| `figure-xl` | 128px | The single dominant number in a section |
| `figure-l` | 72px | Supporting figures |
| `figure-m` | 40px | Table and card figures |

Big numbers use `font-variant-numeric: tabular-nums` and `letter-spacing: -0.03em`.

## 4.3 Spacing & layout

- **Grid:** 12 columns, 1440px max content width, 88px gutters at desktop.
- **Section vertical rhythm:** 200px top and bottom padding on desktop; 96px on mobile. This site should breathe — it is presented, not skimmed.
- **Spacing scale:** 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96 · 128 · 200
- **Radii:** 4px (chips), 8px (cards), 12px (large panels). Nothing more rounded — this is an instrument.
- **Borders:** 1px `--hairline`. Cards are defined by hairlines and background elevation, not shadows.
- **Shadows:** almost none. Use luminosity (glow) instead of drop shadows. A dark instrument doesn't cast shadows; it emits light.

## 4.4 Motion language

**Principles:**
- Easing: `cubic-bezier(0.16, 1, 0.3, 1)` (expo-out) for entrances. `cubic-bezier(0.87, 0, 0.13, 1)` for scrubbed timelines.
- Duration: 600–900ms for reveals. Long enough to read as deliberate measurement.
- **Numbers always count up** from zero when they enter, over ~1200ms, with tabular figures so nothing shifts.
- **Bars and blocks always grow from a baseline** (the ledger rule), never fade in.
- **Labels always arrive after the thing they label** — 200ms delay. The instrument measures, *then* annotates. This ordering is the whole motion thesis.
- Stagger: 60–80ms between siblings.

**Forbidden motion:** bounce, elastic, spin, parallax-for-its-own-sake, anything that reads as playful.

**Scroll behaviour:** Use pinned, scrub-driven sections for the four "revelation" moments only (see Part 6: sections 3, 4, 5, and the scenario). Everywhere else, use simple triggered entrances. **Do not pin more than five sections in total** — over-pinning makes a presented site frustrating to navigate.

## 4.5 Accessibility (mandatory)

- Honour `prefers-reduced-motion`: replace all scrubbed sequences with their final state, immediately.
- Every provenance chip must have an accessible label: `aria-label="measured value"` / `aria-label="modelled value — hover for assumptions"`.
- Chips must not rely on colour alone — they carry the words `measured` / `modelled`.
- Minimum contrast 4.5:1 for body text against its surface. Check `--text-secondary` on `--surface-base`.
- All interactive elements keyboard-reachable, with a visible `--accent` focus ring.
- The section navigator must be operable by keyboard.

---

# PART 5 · SIGNATURE COMPONENTS

These five components carry the site. Build them first; everything else composes them.

## 5.1 `<Provenance>` — the receipt chip

**The most important component on the site.**

```
<Figure value="21%" provenance="measured" source="Measured across 6,142,177 tokens
  of real Copilot requests." />

<Figure value="$2.1M" provenance="modelled" basis="Linear projection from measured
  cost shares across 5,000 seats." assumptions={[
    "Assumes your fleet's usage resembles the measured profile",
    "Assumes no change in model pricing",
    "Not validated against a deployed policy — that is a later phase"
  ]} />
```

**Visual:**
- A small pill immediately after the number: 11px mono, uppercase, 0.16em tracking, 2px/8px padding, 4px radius.
- `measured` → `--measured` text on `--measured-dim` background. Label: `measured`.
- `modelled` → `--modelled` text on `--modelled-dim` background. Label: `modelled`.
- `blended` → `--modelled` text on `--modelled-dim` background. Label: `~N% measured` (e.g. `~24% measured`). Used **only** for aggregate totals that sum measured and modelled parts. Its popover states the exact split in both directions: *"24% of this total was read from published credit figures; 76% is estimated from rates measured on those."*
- On hover/focus/tap: a dark popover (`--surface-overlay`, 1px `--hairline`) showing the source (for measured) or the basis + bulleted assumptions (for modelled and blended).
- **Modelled and blended chips get a subtle 3s pulse** on the border — a gentle, continuous reminder that this figure is not purely a measurement. Measured chips are static.

**Rule:** No `<Figure>` may render without a `provenance` prop. Make it a required prop and throw in development if omitted. This mirrors the actual product, where the code refuses to print an unlabelled estimate.

## 5.2 `<CostCentreBar>` — the decomposition bar

The visual spine of the site. A single horizontal bar representing one Copilot request, divisible into the five cost centres.

**Three states, animated between:**
1. **Sealed** — one solid `--text-tertiary` block. One label: `1 REQUEST · 83,166 TOKENS · $0.45`.
2. **Splitting** — a bright scan line sweeps left→right across it; behind the line the bar resolves into five coloured segments.
3. **Labelled** — each segment gains a leader line and label with its percentage.

**Requirements:**
- Segments sized by percentage; each keeps its fixed colour from Part 4.1 everywhere on the site.
- Segments individually highlightable (used in later sections to isolate one cost centre).
- Below 720px, rotate to vertical stacked bars with labels beside them.
- Total width always represents 100% of one request. Never truncate — the completeness is the point.

## 5.3 `<Treemap>` — the headline visual

A proportional-area rectangle grid showing the five cost centres by share. This is the image the presenter will linger on. The amber Tool-Definitions block is the story.

- Areas proportional to token share (Part 9.2).
- Each cell: category name, percentage, credit figure with provenance chip.
- The amber cell gets a soft `--modelled`-toned outer glow and enters last, 400ms after the others, with a slight scale-up. It should feel *found*.
- Cells are selectable; selecting one dims the others to 25% and surfaces a detail panel.
- Must be legible at projector distance: minimum 20px labels inside cells; move labels outside for small cells.

## 5.4 `<LedgerLine>` — the animated figure entry

For any large figure. The number counts up from zero while a hairline draws beneath it left→right; the label and provenance chip arrive after both complete.

```
  $3,613,314        [modelled]
  ─────────────────────────────
  ANNUAL OVERAGE · 5,000 SEATS
```

Sequence: hairline draws (500ms) → number counts up (1200ms) → label + chip fade in (300ms). Total ~2s. Use for every hero figure.

## 5.5 `<Reveal>` — the scan-line wrapper

A generic wrapper implementing the site's core motion idea: content is revealed by a horizontal scan line rather than a fade.

- A 2px `--accent` line sweeps across the element; content becomes visible behind it with a soft mask edge.
- 700ms, expo-out. Triggered at 65% viewport.
- Respects `prefers-reduced-motion` (renders final state immediately).

Use for section headlines and key statements. Do not use for body paragraphs — it becomes tiresome.

---

# PART 6 · SECTION-BY-SECTION BUILD

**Total: 17 sections.** Copy below is final — use it as written. Where you see `[DATA: x]` the value comes from Part 9; the reference tells you which provenance chip to attach.

Persistent UI throughout:
- **Section navigator** — a fixed right-edge vertical rail of 17 dots with labels on hover; current section highlighted. Clicking jumps. Hidden below 1024px.
- **Provenance legend** — a small fixed bottom-left pill: `● measured  ● modelled` which expands on click to explain the distinction. Present from section 1 onward.

---

## SECTION 1 · HERO

**Layout:** Full viewport. Content left-weighted at 7 columns; the right 5 columns hold the ambient visual.

**Copy:**

> **Eyebrow (mono, uppercase, `--text-tertiary`):**
> RUNS LOCALLY · NO CODE LEAVES THE MACHINE · EVERY FIGURE TRACEABLE
>
> **H1 (display-xl, two lines, line 2 in `--measured`):**
> Your Copilot invoice has no line items.
> **So we wrote them.**
>
> **Sub (subhead, `--text-secondary`, max 620px):**
> GitHub now bills your organisation by the token — and stops working when the budget runs out. It tells you what you spent. It has never told you what you bought.
>
> TokenLens reads the usage records Copilot already writes to your engineers' machines and turns an unexplained total into an itemised bill.
>
> **Primary CTA:** `See what a single request actually costs ↓`
> **Secondary CTA (ghost):** `Skip to the numbers`

**Visual (right / background):**

A single `<CostCentreBar>` in its **sealed** state, rendered large and vertical along the right edge, very dim (20% opacity) — a solid grey column. A faint scan line drifts down it every 6 seconds, briefly hinting at the coloured segments beneath before they fade back to grey. **The whole product in one ambient loop: there is structure in there, and you cannot see it.**

Behind everything: an extremely subtle animated field of thin vertical hairlines at 3% opacity, drifting very slowly — like a ledger page, or an oscilloscope grid.

**Below the fold indicator:** a thin vertical line that draws downward continuously, with the mono label `SCROLL TO MEASURE`.

**Motion:** H1 lines reveal via `<Reveal>` scan-line, 150ms apart. Eyebrow first. Sub 400ms later. CTAs last. Total ~1.8s.

---

## SECTION 2 · THE CLIFF

**Purpose:** Establish urgency with a hard, external, verifiable fact. This is not our claim — it is GitHub's published change.

**Layout:** Full-width. A single dominant chart, centred.

**Copy:**

> **Kicker (mono, `--waste`):** 1 SEPTEMBER 2026
>
> **H2 (display-l):** The included allowance just fell by 37%.
>
> **Body (body-l, max 720px):**
> Copilot's launch allowances were promotional. On 1 September they dropped — the same subscription fee, substantially less included capacity. Everything beyond the allowance is billed as overage. When the pooled budget is exhausted, Copilot stops.
>
> There is no cheaper fallback model. There is no degraded mode. It stops.

**Visual:** Two vertical bars per plan, before → after, with the delta highlighted in `--waste`.

| | Before 1 Sep | After 1 Sep |
|---|---|---|
| **Copilot Business** | 3,000 credits/user/month | **1,900** |
| **Copilot Enterprise** | 7,000 credits/user/month | **3,900** |

Both figures: `measured` chip (these are published facts, sourced from GitHub's own documentation — treat as measured).

Below, in smaller type:
> 1 AI credit = $0.01 · Credits are pooled across the organisation, do not carry over, and are forfeited monthly.

**Motion:** The "before" bars are present on entry. On scroll trigger, they **fall** to the "after" height over 900ms, and the vacated space fills with a hatched `--waste` region labelled `NOW BILLED AS OVERAGE`. The fall should feel like a floor dropping — this is the only slightly dramatic moment on the site, and it earns it.

---

## SECTION 3 · THE ANATOMY OF ONE REQUEST *(pinned, scrubbed)*

**Purpose:** The first revelation. This is where the executive learns what they are actually buying.

**Pinned section, ~350vh of scroll.** Four beats, scrubbed to scroll progress.

### Beat 1 — the question
Centre of screen, large: a plain text bubble reading
> *"Can you add validation to the checkout form?"*

Mono caption beneath: `12 WORDS · 14 TOKENS`

### Beat 2 — the reality
The bubble shrinks to a tiny dot and slides to the far left of a very wide bar that draws across the entire viewport. Caption:

> **What was actually sent and billed:**
> `83,166 TOKENS` `[measured]`
>
> The developer's question is the dot on the left. Everything else is context the model needs re-sent, from scratch, every single time.

The dot must be almost invisibly small. **That contrast is the entire beat.** Do not exaggerate it — 14 tokens of 83,166 is genuinely 0.017% of the bar, so render it as a hairline sliver and label it with a leader line.

### Beat 3 — decomposition
The `<CostCentreBar>` scan line sweeps across; the bar resolves into five colours. Labels arrive after, staggered.

> **H2 (display-m, entering with the scan):** Every request is five bills in one.
>
> VS Code writes this breakdown to disk on every request. Nobody has ever read it.

### Beat 4 — the price tag
Each segment gains its credit cost. A total settles at the right end:

> `44.5 CREDITS` `$0.45` `[measured]`
> MEDIAN COST OF ONE COPILOT REQUEST

Then one line of copy, held on screen:

> A one-line question and a ninety-minute refactor cost close to the same. **The cost is dominated by a fixed floor, not by the work.** `[measured]`

**Reduced motion:** show Beat 4's final state only, with all four captions stacked.

---

## SECTION 4 · THE FIVE COST CENTRES *(pinned)*

**Purpose:** Name the parts. Give the presenter vocabulary.

**Layout:** `<Treemap>` occupying the right 7 columns; a stepped explanation list on the left 5. As the visitor scrolls, each list item activates in turn and the corresponding treemap cell highlights while others dim.

**Copy — H2:** Where the money actually goes.

**The five, in order of size** — use the live measured figures from Part 9.2:

| Order | Name | Share | The one-line explanation to display |
|---|---|---|---|
| 1 | **Conversation history** | 49% | Everything already said in this chat, re-sent in full with every new message. The model has no memory — so you buy it again each turn. |
| 2 | **Tool results** | 23% | What the AI's tools handed back — file contents, command output, search results. Once returned, it rides along in every later step. |
| 3 | **Tool descriptions** | 16% | Instructions describing every installed tool, sent in full on every request. **Billed whether or not the tool is ever used.** |
| 4 | **Attached files** | 7% | Files deliberately attached to the question. |
| 5 | **System instructions** | 5% | The fixed rules that tell Copilot how to behave. |

Each row shows its share and credit total with a `measured` chip.

**Closing statement below the treemap** (`display-m`, high emphasis):

> Rows 3 and 5 are **fixed overhead** — identical on every request, unrelated to the question asked. Together: **21% of every credit.** `[measured]`

**Motion:** Cells enter with a staggered scale-from-baseline. The amber cell enters last with a 400ms pause before it, plus a soft glow. That pause is deliberate — it is the beat before the reveal.

---

## SECTION 5 · THE TOOL-DEFINITION TAX *(pinned — the centrepiece)*

**Purpose:** The single novel finding. If the executive remembers one thing, it is this. Give it the most design budget of any section.

**Copy:**

> **Kicker (mono, `--cc-tool-defs`):** THE FINDING NOBODY HAS PRICED
>
> **H2 (display-l):** You are paying to describe tools you may never use.
>
> **Lead (subhead, max 760px):**
> Modern AI assistants can use tools — a database connector, a ticketing integration, a documentation searcher. For the AI to use a tool, that tool must be **described to it in full.**
>
> Not once. **On every single request.**
>
> Install six integrations, use two, and you pay for six — on every request, from every developer, for as long as they remain installed.

**Three figures in a row, each a `<LedgerLine>`:**

| Figure | Label | Chip |
|---|---|---|
| **17,016** | tokens spent describing tools, on the median request | measured |
| **21%** | of a typical prompt, before the question is even read | measured |
| **74%** | the highest share observed on a single real request | measured |

**The signature visual — "The Toll Gate":**

A horizontal lane represents one request travelling left → right toward the model. Before it can reach the model it passes through a gate. The gate is amber and occupies a proportional share of the lane's width. A counter above ticks up as the request passes through it.

Then the killer interaction: **an installed-tools slider**, `0 → 12 tools`.

As the visitor drags it, the amber gate physically widens and the remaining lane narrows. Beneath, live figures update:

```
INSTALLED TOOLS            6
TOKENS PER REQUEST     ~9,600   [modelled]
SHARE OF PROMPT           12%   [modelled]
COST PER DEVELOPER
PER MONTH               $9.60   [modelled]
ACROSS 5,000 SEATS    $48,000   [modelled]  /month
```

**Basis for the modelled figures** (must appear in the chip popover, and in a footnote):
> Modelled at ~1,600 tokens per tool description and 100 requests per developer per month, using the measured blended rate. Derived from the measured finding that a 15-tool integration adds roughly 3,000 tokens per request.

**Closing line, held large:**

> This cost scales with what you have **installed** — not with what you **use**. It is invisible, it is large, and it is the most trivially reducible cost in the entire bill. `[measured]`

**Motion:** The gate widening must be physical and immediate — the slider drives it directly with no easing lag. The visitor should feel they are widening a toll booth. This is the most tactile interaction on the site; make it excellent.

---

## SECTION 6 · THE MULTIPLIER

**Purpose:** Explain re-transmission simply. Short section — one idea, one visual.

**Copy:**

> **H2 (display-m):** You pay for the same words about ten times.
>
> **Body (body-l, max 700px):**
> The model has no memory between steps. When the AI reads a file, then runs a command, then decides what to do next, everything it has gathered so far is re-sent at every step so it can "remember".
>
> Across real sessions, every token of genuinely new content was billed roughly ten times over.

**Figure:** `9.8×` `[measured]` — label: `RE-TRANSMISSION MULTIPLIER · MEASURED ACROSS 790 REQUESTS`

**Visual:** A single word-block on the left. An arc loops it back into a stack on the right, ten times, each pass leaving a fainter copy and incrementing a cost counter. Loops continuously and slowly. Restrained — one small looping diagram, not a full-screen spectacle.

**Footnote:** *Some of this is unavoidable — it is how the technology works. A meaningful share is not, and that is what we go after.* (Honesty beat. Keep it.)

---

## SECTION 7 · THE FREE 61%

**Purpose:** The most relatable finding. The executive will personally recognise the behaviour.

**Copy:**

> **H2 (display-m):** The most expensive habit in your engineering org is leaving a chat window open.
>
> **Body:**
> Because the whole conversation is re-sent every turn, a chat gets more expensive with every message. By the thirty-third message, each new message costs **61% more** than it would in a fresh chat.
>
> The fix is *"start a new chat when you start a new task."*
>
> It costs nothing. It requires no tooling. Almost nobody does it — **because nobody can see the meter running.**

**Visual:** A line chart, cost-per-message against message number, climbing from 31.2 to 56.9 credits. Two markers: `A FRESH CHAT · 31.2 credits` and `THE 33rd MESSAGE · 56.9 credits`. Both `measured`. The rising area fills `--waste` at low opacity.

**Callout box:**
> This is what an absent cost signal looks like. Nobody is being careless — the information simply does not exist at the moment the decision is made. `[measured]`

---

## SECTION 8 · CONCENTRATION — THE GOOD NEWS

**Purpose:** Relieve the fear that this requires changing everyone's behaviour.

**Copy:**

> **Kicker:** THE ENCOURAGING PART
> **H2 (display-m):** You do not have to change how everyone works.

**Two figures side by side:**

| **16%** `[measured]` | **50%** `[measured]` |
|---|---|
| of chat sessions | of all money spent |

> **Body:**
> Spend is extremely concentrated. The most expensive single session cost **$32.70**; the typical session cost **$3.61**. `[measured]`
>
> This means the intervention is surgical, not cultural. Fix the worst tenth and you capture most of the value — without a training programme, a policy memo, or a single all-hands.

**Visual:** 57 small squares (one per real measured session), sized by spend, sorted descending. The largest nine glow `--waste` and are lassoed with a hairline bracket labelled `50% OF ALL SPEND`. **Use the real distribution from Part 9.2** — 57 sessions, top session 8,644.6 credits.

---

## SECTION 9 · THE BLIND SPOT

**Purpose:** Answer the executive's inevitable question — *"why hasn't anyone solved this?"* Answering it well converts scepticism into confidence in the moat.

**Copy:**

> **H2 (display-m):** Why has nobody shown you this before?
>
> **Body (body-l):**
> There is a whole industry of AI monitoring tools. None of them can see Copilot — for a structural reason, not a lack of effort.
>
> Those tools work by sitting **in the network path**: you route your AI traffic through them and they inspect it as it passes. That works when your own application calls an AI provider.
>
> Copilot does not work that way. The traffic goes from the editor to GitHub over a channel you do not control and cannot intercept. **There is no point in the middle to stand.**
>
> The only place this information exists in readable form is a file on the developer's own machine — in an undocumented format that changes with every VS Code release. Reading it reliably is genuinely difficult.
>
> **That difficulty is exactly why the category is empty. It is also our moat.**

**Visual:** Two diagrams side by side, sparse and schematic.

- **Left — "How monitoring tools work":** `YOUR APP → [ MONITORING TOOL ] → AI PROVIDER`, with the tool node glowing. Caption: `A place to stand.`
- **Right — "How Copilot works":** `EDITOR ⟶⟶⟶ GITHUB`, a single unbroken line, with a dashed ghost box in the middle marked `✕ NOWHERE TO STAND` in `--waste`. Below the editor, a small file icon glowing `--measured`, labelled `THE RECORD IS ALREADY HERE`, with an arrow to a TokenLens node.

**Closing line:** *We did not find a better place to stand. We found that the receipt was already on the floor.*

---

## SECTION 10 · WHAT TOKENLENS IS

**Purpose:** The pivot from problem to product. Must feel like relief.

**Copy:**

> **Kicker:** THE PRODUCT
> **H2 (display-l):** An itemised bill for AI-assisted engineering.
>
> **Lead (subhead, max 780px):**
> TokenLens reads the usage records already on your engineers' machines, shows you exactly what every credit bought, names what was wasted and why, and hands your IT team a configuration change that removes a large part of it — without asking a single developer to work differently.

**Five step-cards in a horizontal sequence**, connected by a hairline that draws through them as the section enters:

| # | Title | Copy |
|---|---|---|
| **01** | **Measure** | Read the records Copilot already writes. Produce an exact credit ledger. Every figure traceable to the byte it came from. |
| **02** | **Attribute** | Assign wasted spend to fourteen named, individually detectable causes. Waste stops being a total and becomes a list of specific, fixable things. |
| **03** | **Simulate** | Replay real recorded sessions under a proposed change and report what it *would have* saved — before anything is deployed. |
| **04** | **Enforce** | Emit the exact configuration your IT team pushes through the device-management tooling you already own. No developer action. |
| **05** | **Prove** | Run it as a randomised trial against a holdout group on your own fleet. Report the *actual* saving, including where we were wrong. |

Steps 01 and 02 carry a small `AVAILABLE TODAY` tag; 03–05 carry `ON THE ROADMAP` — see Section 15. **Be honest here.** It costs nothing and buys credibility.

---

## SECTION 11 · HOW IT WORKS — IN FOUR PLAIN STEPS

**Purpose:** Kill the "this sounds like a big project" fear. Must feel almost anticlimactic.

**Copy:**

> **H2 (display-m):** What adopting this actually involves.
>
> **Sub:** There is no server to run, no proxy to configure, no agent to install, and no data pipeline to build.

**Four steps, vertically stacked, each with a large numeral:**

**1 · One command, one laptop.**
An engineer runs a single command on their own machine. It reads the local Copilot records and prints the ledger. Nothing is uploaded. Nothing is installed permanently. This takes minutes, not a project.

**2 · Look at the report.**
A local dashboard opens in the browser — running on that machine, reachable only from that machine. It shows the itemised bill: where the credits went, which sessions, which tools, which behaviours.

**3 · Widen to a sample.**
Repeat across a representative group of engineers — twenty is plenty. Only aggregate counts are combined. Source code never moves.

**4 · Deploy the configuration.**
TokenLens produces the exact settings file. Your IT team pushes it through the same tooling used for every other setting. **Developers notice nothing except that things stop running out.**

**Visual:** A vertical hairline spine connecting the four steps, drawing downward as the visitor scrolls. Each step's numeral fills with `--measured` as its threshold is passed. Restrained and procedural.

**Reassurance strip at the bottom** — four items with hairline dividers, each with a small icon:

| | |
|---|---|
| **Nothing leaves the machine** | Only aggregate counts and one-way hashes. Offline by default. |
| **Read-only, always** | Files are opened for reading. Nothing is ever written, moved, or altered. |
| **No infrastructure** | No proxy, no server, no agent, no pipeline. |
| **Every number traceable** | One command prints the file and byte position behind any figure. |

---

## SECTION 12 · THE ITEMISED BILL — LIVE

**Purpose:** Proof of life. Show the actual working product on real data.

**Copy:**

> **Kicker:** RUNNING TODAY, ON REAL DATA
> **H2 (display-m):** This is not a mock-up.
>
> **Body:**
> Everything below was produced by the tool as it exists today, reading one real developer's Copilot history — **`[DATA: 713]` requests across `[DATA: 57]` chat sessions over `[DATA: 61]` active days.** Every figure carries its own receipt.

**Visual:** A faithful rendering of the real dashboard using the live figures in Part 9.2. Show:

- Headline total: `66,008.2 credits` · `$660.08` · chip: `blended — 24% measured` *(see the three-state note below)*
- The cost-centre treemap
- The model table with per-model credits and rates, each rate chipped `measured` or `modelled`
- A burn-down chart across the 61 active days

**IMPORTANT — the blended chip.** This is the section where the third provenance state (defined in Part 3.1 and Part 5.1) does its real work. The headline total here is genuinely a mix, and the product refuses to claim otherwise.

**Reproduce this faithfully.** It is a subtle honesty point that will impress a sceptical technical reviewer: the product will not present a mixed total as a measurement.

**Callout:**
> Only **24%** of these requests had a credit figure published by GitHub. The rest are estimated from rates measured on the ones that did — and every one of those is labelled as an estimate, never as a fact. `[measured]`

That callout is the most persuasive paragraph on the entire website for a technical sceptic. Do not cut it.

---

## SECTION 13 · THE FOURTEEN NAMED CAUSES

**Purpose:** Show rigour and completeness. Demonstrate this is a system, not a hunch.

**Copy:**

> **H2 (display-m):** Waste is not a number. It is a list.
>
> **Body:**
> "You are wasting money" is not actionable. TokenLens attributes wasted spend to fourteen specific, individually detectable causes — each with a way to detect it and a named remedy.

**Layout:** A 14-cell grid. Each cell: an ID, a plain-English name, and one line of explanation. The first six are `DETECTED TODAY OR NEXT PHASE`; the rest carry `SPECIFIED`. On click, a cell expands to show the evidence behind it.

| ID | Plain-English name | One-line explanation |
|---|---|---|
| W1 | **The tool-definition toll** | Paying to describe installed tools on every request, including tools never invoked. |
| W2 | **Reading the same file twice** | The AI re-reads a file it already has in front of it. Measured: 42% of file reads were repeats; one file was read 72 times in a single session. |
| W3 | **Oversized tool results** | A single command returns an enormous result that then rides along in every later step. One observed result cost $0.90 on its own. |
| W4 | **Stale conversations** | A chat left open across unrelated tasks, re-sending irrelevant history forever. |
| W5 | **Over-powered model choice** | The most expensive model used for work a cheaper one handles identically. |
| W6 | **Runaway loops** | Very long agent loops that consume heavily and produce no surviving change. |
| W7 | **Abandoned work** | Credits spent on work that never reached the codebase. |
| W8 | **The same question, fifty times** | Fifty engineers independently asking the same thing about the same internal system. |
| W9 | **Context compaction** | Automatic summarisation triggered by unmanaged context growth — costing tokens *and* a measured 92 seconds of developer waiting, each time. |
| W10 | **Instruction bloat** | Standing instruction files that grew past their usefulness. |
| W11 | **Search-snippet leakage** | Paying for previews of files that were never opened. |
| W12 | **Premium models on trivial work** | Titles, summaries and commit messages generated on the most expensive model available. |
| W13 | **Over-provisioned reasoning** | Deep-reasoning settings applied to work that does not need them. |
| W14 | **Missing context isolation** | Expensive exploration done in the main conversation instead of an isolated cheaper one. |

**Callout under the grid:**
> **W9 is worth pausing on.** In 115 days, automatic summarisation ran 84 times and took a median of **92 seconds** each — about **two hours** of engineers watching a progress indicator. That is not a billing problem. That is a productivity problem you were also not being shown. `[measured]`

---

## SECTION 14 · THE INTERVENTION — WHY THIS IS EASY

**Purpose:** Directly attack the biggest objection: *"we can't get 5,000 engineers to change how they work."*

**Copy:**

> **Kicker:** THE PART THAT SURPRISES PEOPLE
> **H2 (display-l):** Most of the saving needs nobody to do anything differently.

> **Body (body-l, max 780px):**
> The instinctive assumption is that reducing AI spend means asking engineers to use it less. That would be slow, unpopular, and would cost you more in lost productivity than it saved.
>
> That is not the intervention.
>
> The largest savings come from **settings** — which model handles which kind of work, how large a single tool result may be, which integrations stay installed. These are configuration values. They are deployed the same way every other setting in your organisation is deployed, through tooling you already own.
>
> **No training. No policy memo. No behaviour change. Your engineers keep working exactly as they do now.**

**Two-tier comparison panel:**

| | **Tier A — Configuration only** | **Tier B — Live guardrails** |
|---|---|---|
| What it is | Settings deployed through your existing device management | Automatic prevention of specific wasteful actions as they happen |
| Developer effort | **None.** They will not notice. | **None.** Prevention is silent. |
| Modelled reduction in spend | **~35%** `[modelled]` | **up to ~53% combined** `[modelled]` |
| Availability | Roadmap phase D5 | Roadmap phase D6 |

**Below, a hairline-separated honesty note (important — do not remove):**

> Both figures are **modelled** — projected from measured cost shares, not yet observed on a deployed policy. That is precisely why the product's final phase is a **randomised trial on your own fleet**, with a holdout group, so the real figure replaces the projected one. We will report the gap between them, including if it is unflattering. `[modelled]`

---

## SECTION 15 · WHERE WE ARE TODAY

**Purpose:** Honest status. Framed as sequencing discipline, not incompleteness.

**Copy:**

> **H2 (display-m):** Built in order, with the measurement first.
>
> **Body:**
> This product was built in a deliberate sequence: **measure before attributing, attribute before recommending, recommend before enforcing, and prove before claiming.** Each phase is only useful because the one before it is trustworthy.

**Visual:** A horizontal timeline of ten phases, with the first three filled `--measured` and marked complete, the rest as hairline outlines.

| Phase | Name | What it delivers | Status |
|---|---|---|---|
| 1 | Foundation | The honest-measurement guarantees, enforced in code | **Complete** |
| 2 | Credit ledger | Exact, traceable accounting of every credit | **Complete** |
| 3 | Dashboard & reports | The itemised bill, on screen and exportable | **Complete** |
| 4 | Waste attribution | The fourteen named causes, detected and ranked | Next |
| 5 | Simulation | *"This change would have saved N last quarter"* | Specified |
| 6 | Policy compiler | The exact settings file your IT team deploys | Specified |
| 7 | Runtime guardrails | Prevention at the moment of spend | Specified |
| 8 | Editor integration | Live cost visibility for the developer | Specified |
| 9 | Randomised proof | Measured savings with confidence intervals | Specified |
| 10 | Organisation rollup | Fleet-wide view and self-tuning policy | Specified |

**Closing line:**
> Phases 1–3 are working software running on real data today. Everything shown in this presentation as *measured* came out of them. Everything shown as *modelled* is waiting on phase 9 to become measured. `[measured]`

---

## SECTION 16 · THE SCENARIO

**This is the most important section of the site.** It is specified in full in **PART 7**.

---

## SECTION 17 · TRUST, THEN THE ASK

### 17a · Trust panel

> **H2 (display-m):** What we will not do.

Six cards, one per principle, each with the principle stated plainly plus the mechanism that enforces it:

| Principle | Plain statement | How it is enforced |
|---|---|---|
| P1 | **No source code ever leaves the machine.** | Only aggregate counts and one-way hashes. Network access is denied by default. |
| P2 | **Every number is traceable.** | One command prints the file and byte position behind any figure on any report. |
| P3 | **We never present an estimate as a measurement.** | Enforced in the type system — the code physically cannot print an unlabelled estimate. It is why every number on this page carries a chip. |
| P4 | **Read-only on your data.** | Files opened for reading only. Nothing written, moved, or altered. |
| P5 | **We fail loudly.** | If something is not understood, it is reported and counted — never silently reported as zero. |
| P6 | **Nothing to adopt.** | No proxy, no server, no agent, no pipeline. One command on one laptop. |

**Callout beneath:**
> Notice that every figure on this page carries a green or amber chip. That is not a design flourish — it is the product's third principle, applied to our own marketing. If we would not label a number honestly here, you should not trust us to label one honestly in your reports. `[measured]`

### 17b · The ask

> **H2 (display-l):** We are not asking you to buy anything.
>
> **Body (subhead):**
> We are asking for **two weeks and twenty volunteers.**
>
> They run one command. Nothing is installed, nothing is uploaded, nothing changes about how they work. At the end, you get your **own** itemised bill — your requests, your tools, your sessions, your money — with every number traceable to the file it came from.
>
> Then you decide whether the number is big enough to act on.

**Three cards — what you get:**

| | |
|---|---|
| **Your itemised bill** | Where every credit went, decomposed into the five cost centres, for your own engineers. |
| **Your tool-definition tax** | Exactly what your installed integrations cost per request, and which have never once been invoked. |
| **Your projected saving** | Modelled from your own measured shares — clearly labelled as modelled, with the assumptions stated. |

**Primary CTA:** `Start the two-week measurement`
**Secondary:** `Download the one-page summary`

**Final line, alone on the page, large, centred:**

> You have been paying this bill for months.
> **This is the first time anyone has offered to read it to you.**

---

# PART 7 · THE SCENARIO — FULL SPECIFICATION

**This is Section 16 and it is the emotional and commercial centre of the site. Budget the most build effort here after Section 5.**

## 7.1 Why this section exists

Everything before it is evidence. This is where the executive stops evaluating and starts *imagining their own organisation*. It must be concrete, human, specific, and financially precise.

It has **two levels, in this order:**
- **Level 1 — one engineer, one ordinary Tuesday.** Makes it human and believable.
- **Level 2 — one organisation, one quarter.** Makes it financial and decision-shaped.

Going human-first is deliberate. Executives believe organisational numbers only after they believe the individual behaviour that produces them.

## 7.2 Level 1 — "An ordinary Tuesday"

**Format:** A pinned, scroll-scrubbed timeline. A vertical clock line runs down the left from 09:00 to 18:00. Events appear along it. A running credit total sits fixed in the top-right, counting up as the visitor scrolls. The number should feel like a taxi meter — and that is the point.

**Character:** *Priya, a senior engineer.* Introduce her in one line. Do not give her a personality, a photo, or dialogue — she is a lens, not a character.

**Opening copy:**

> **Kicker:** WHAT THIS LOOKS LIKE FROM THE INSIDE
> **H2 (display-l):** An ordinary Tuesday.
>
> **Lead:**
> Priya is a senior engineer. She is good at her job. On this particular Tuesday she does nothing wrong, nothing unusual, and nothing anybody would flag in a review.
>
> Watch the meter.

**The timeline** — each beat is one card appearing beside the clock line, with a running total updating:

| Time | Event | Running total | The quiet note (small, `--text-tertiary`) |
|---|---|---|---|
| 09:12 | Opens yesterday's chat window to pick up where she left off. Asks a small question. | ~52 credits | Yesterday's entire conversation is re-sent with it. |
| 09:40 | The assistant reads the same configuration file for the fourth time this session. | ~110 credits | It already had it. |
| 10:15 | Asks a one-line question: *"what does this function do?"* | ~155 credits | Costs almost the same as a full refactor. The floor, not the work. |
| 11:30 | A command returns a very large output. It stays in context for the rest of the day. | ~290 credits | Every later step re-sends it. |
| 12:05 | Still the same chat window. Now on a completely different task. | ~350 credits | The morning's unrelated discussion is still being paid for, every turn. |
| 14:20 | The assistant pauses for a minute and a half to summarise the conversation so far. | ~410 credits | It ran out of room. She waits. |
| 15:45 | A complex refactor. Genuinely hard work, genuinely well done. | ~520 credits | This one was worth it. |
| 16:30 | Same chat window. Fourth unrelated task of the day. | ~590 credits | |
| 17:50 | Closes the laptop. | **~640 credits · $6.40** | She has no idea. There was never a number. |

**IMPORTANT — provenance of this timeline.** These per-event figures are **illustrative and modelled**, built from the measured medians (a median request is 44.5 credits; a 33rd-turn message is 56.9). They are not a recording of a real day.

**You must label this.** Place a persistent `modelled` chip on the running total and a clear line beneath the section:

> This day is **constructed from measured medians** — a typical request, a typical session penalty, a typical compaction. It is an illustration of measured behaviour, not a recording of one real Tuesday. `[modelled]`

Being explicit here costs nothing and enormously strengthens the section's credibility. An executive who spots an unlabelled invented anecdote will discount everything else on the page.

**The closing beat — the reveal:**

As the timeline completes, the whole day re-renders as a single `<CostCentreBar>` decomposed by cost centre, with a slice highlighted `--waste`:

> Of Priya's Tuesday, roughly **a third** was avoidable — re-reads, a stale window, an oversized result, and a model heavier than the task needed. `[modelled]`
>
> **Priya did nothing wrong.** She was never shown a number. Every decision that created this was made in the absence of information that already existed on her own laptop.

**Then, immediately, the multiplication:**

> Now multiply Priya by five thousand.

Hold that line alone on screen. Then transition to Level 2.

## 7.3 Level 2 — "Meridian Financial Group"

**Fictional but explicitly labelled as such.** A named example is far more persuasive than an abstraction, but the label is mandatory — put `ILLUSTRATIVE EXAMPLE · MODELLED FROM MEASURED RATES` in the section eyebrow.

**Setup card:**

> **MERIDIAN FINANCIAL GROUP** — *illustrative example*
> **5,000 engineers · GitHub Copilot Enterprise · 3,900 credits included per seat per month**

**Format:** Four acts, scroll-driven. Each act is one screen with one dominant number.

---

### ACT I — THE INVOICE

> **September. The first bill after the allowance dropped.**

**The dominant figure:** `$3,613,314` `[modelled]`
**Label:** `ANNUAL OVERAGE · BEYOND THE INCLUDED ALLOWANCE`

Supporting breakdown, as a three-row ledger:

```
ANNUAL CONSUMPTION AT MEASURED RATE      $5,953,200   [modelled]
INCLUDED IN SUBSCRIPTION                −$2,340,000   [measured]
──────────────────────────────────────────────────────
ANNUAL OVERAGE                           $3,613,314   [modelled]
```

**Copy:**
> Nobody at Meridian can explain this number. It is not that they lack the will — the information does not exist. There is a total, a date, and an amount due.
>
> Somewhere inside it is a large amount of money buying nothing at all. Nobody can point at it.

**Basis note (must be visible, small):** *Modelled by applying the measured per-developer run-rate of $99.22/month across 5,000 seats. Real fleets have a long tail of lighter users, so a real total would likely be lower — but spend concentrates in heavy users, and this profile is a heavy user.*

That caveat must be on the page. **An executive who finds a caveat you volunteered trusts the rest of the page. An executive who finds one you hid discards all of it.**

---

### ACT II — THE DIAGNOSIS

> **Week one. Twenty volunteers run one command.**

**Copy:**
> No procurement. No infrastructure. No data leaves anyone's laptop. Twenty engineers run a single command and the aggregate counts are combined.
>
> Four days later Meridian has something they have never had: **an itemised bill.**

**The visual:** the `$3,613,314` figure from Act I physically **decomposes** — the single number breaks apart into a stacked bar of named causes, each labelled and costed. This is the visual echo of Section 3's request decomposition, now at organisational scale. **The same motion, one level up.** That rhyme is the site's most satisfying moment; make it deliberate.

The decomposed findings:

| Finding | Modelled annual value |
|---|---|
| Heavy work on the most expensive model where a cheaper one performs identically | **$1,190,663** `[modelled]` |
| Stale chat sessions re-sending irrelevant history | **$714,398** `[modelled]` |
| Tool descriptions for integrations, including several never once invoked | **$625,098** `[modelled]` |
| Runaway agent loops producing no surviving change | **$297,666** `[modelled]` |
| The same files read repeatedly within one session | **$208,366** `[modelled]` |
| Single oversized tool results | **$119,066** `[modelled]` |

**The line that lands:**

> Three of Meridian's installed integrations had **never been invoked once** in the entire measured period.
>
> They were being described to the model on every request, from every engineer, all year.

*(Present this as an illustrative finding of the example — chip it `modelled`. The underlying mechanism is measured; this specific instance is the illustration.)*

---

### ACT III — THE INTERVENTION

> **Week two. One configuration change.**

**Copy — deliberately anticlimactic:**
> Meridian's platform team receives a settings file. They push it through the same device-management tooling they use for every other setting in the organisation.
>
> It changes which model handles which kind of work, caps how large a single tool result may be, and removes three integrations nobody had ever used.
>
> **Total engineering hours required from the other 4,980 developers: zero.**
> **Number of engineers who need to be told anything: zero.**
> **Number of workflows that change: zero.**

**Visual:** A single settings file rendering line by line, monospaced, on the left. On the right, a fleet of 5,000 tiny dots. A wave of `--measured` colour washes across them as the configuration lands. Then everything goes still. **The stillness is the point** — the intervention is silent.

**Callout:**
> This is the entire intervention for the largest tier of savings. It is a configuration change, deployed by one team, through tooling that already exists.

---

### ACT IV — THE RESULT

> **Three months later.**

**This act contains the site's strongest financial insight. Give it room.**

**The setup:**
> The included allowance is fixed. It does not shrink when you spend less. So **every credit you stop consuming comes off the overage line** — the only line finance actually feels.
>
> That creates leverage: a **35%** reduction in consumption produces a **58%** reduction in the bill.

**The visual — the leverage bar.** A stacked horizontal bar, animated between two states:

```
BEFORE
├──────── INCLUDED $2.34M ────────┼──────── OVERAGE $3.61M ────────┤

AFTER  (35% less consumed)
├──────── INCLUDED $2.34M ────────┼── OVERAGE $1.53M ──┤
                                   └── ▼ 58% ──────────┘
```

The included portion (`--neutral-spend`) stays exactly the same width in both states. The overage portion (`--waste`) shrinks dramatically. **The visitor must see that the fixed part does not move.** That is the insight.

**The three outcome figures:**

| **35%** `[modelled]` | **$2,083,620** `[modelled]` | **58%** `[modelled]` |
|---|---|---|
| less consumed | less consumed per year | **smaller overage bill** |

**Then the range, honestly:**

> With live guardrails as well as configuration, the modelled reduction rises to **53%**, which would take the overage bill from **$3.61M to roughly $0.46M** — an **87%** reduction. `[modelled]`
>
> At a **61%** reduction, the overage disappears entirely and Meridian returns to living inside its subscription. `[modelled]`

**And then — the closing honesty beat, which must be the last word of the scenario:**

> **Every figure in this scenario is modelled.**
>
> They are projections from measured cost shares — not observations of a deployed policy. That is not a hedge; it is the product's central rule, and it is why the final phase of this product is a **randomised trial on your own fleet**, with a holdout group, so that the projected number is replaced by a measured one.
>
> **We will report that measured number even if it is lower than this page.**

**Design note:** Set this final paragraph in the same size as the headline figures, not as fine print. Its prominence *is* the argument. An executive who reaches the bottom of a sales page and finds the vendor volunteering the limits of their own claim will remember that longer than any number above it.

---

# PART 8 · THE INTERACTIVE CALCULATOR

**Placement:** Immediately after the scenario, before Section 17.

**Purpose:** Convert the scenario from *their* story into *the visitor's* story. This is the highest-intent moment on the page.

## 8.1 Inputs

| Control | Range | Default |
|---|---|---|
| Number of engineers | slider, 50 – 20,000 (log scale) | 5,000 |
| Plan | toggle: Business / Enterprise | Enterprise |
| Usage intensity | 3-position: Light / Moderate / Heavy (measured profile) | Heavy |
| Intervention tier | toggle: Configuration only / Configuration + guardrails | Configuration only |

## 8.2 The maths (implement exactly — do not improvise)

```
CREDIT_VALUE_USD        = 0.01
INCLUDED_PER_SEAT       = plan === 'enterprise' ? 3900 : 1900     // credits/month

// Measured monthly run-rate for the heavy profile:
RUNRATE_HEAVY_CREDITS   = 9922        // credits per developer per month  [MEASURED]
RUNRATE_MODERATE        = 9922 * 0.55 // [MODELLED — see note]
RUNRATE_LIGHT           = 9922 * 0.25 // [MODELLED — see note]

REDUCTION = tier === 'config' ? 0.35 : 0.53                        // [MODELLED]

monthlyConsumed   = seats * runrate                                 // credits
monthlyIncluded   = seats * INCLUDED_PER_SEAT
monthlyOverage    = max(0, monthlyConsumed - monthlyIncluded)

annualOverageBefore = monthlyOverage * 12 * CREDIT_VALUE_USD

consumedAfter       = monthlyConsumed * (1 - REDUCTION)
monthlyOverageAfter = max(0, consumedAfter - monthlyIncluded)
annualOverageAfter  = monthlyOverageAfter * 12 * CREDIT_VALUE_USD

annualSaving        = annualOverageBefore - annualOverageAfter
overageReductionPct = annualOverageBefore > 0
                      ? (annualSaving / annualOverageBefore) * 100
                      : 0
```

**Note on Light/Moderate:** the 0.55 and 0.25 factors are **not measured** — they are illustrative tiers. Label the whole calculator `modelled` and state this in the assumptions panel. Do not present them as measured.

**Verify your implementation** against the canonical case: 5,000 seats · Enterprise · Heavy · Configuration only must produce annual overage before ≈ **$3,613,320**, saving ≈ **$2,083,620**, overage reduction ≈ **58%**. If your numbers differ, your implementation is wrong.

## 8.3 Output display

Four `<LedgerLine>` figures, recalculating live as controls move:

```
ANNUAL OVERAGE TODAY            $3,613,320   [modelled]
ANNUAL OVERAGE AFTER            $1,529,700   [modelled]
──────────────────────────────────────────────────────
ANNUAL SAVING                   $2,083,620   [modelled]
OVERAGE BILL REDUCED BY                58%   [modelled]
```

Plus the leverage bar from Act IV, live-updating.

**Handle the zero-overage case gracefully.** At small seat counts or light usage, overage may be zero. Do not show `$0 saved` as a failure. Show:

> At this size and intensity you are **inside your included allowance** — for now. The modelled reduction still buys you **`N` months of additional headroom** before you cross it.

**Mandatory assumptions panel** — always visible, not hidden behind a link:

> **What this calculator assumes**
> · Your engineers' usage resembles the measured profile of a heavy Copilot user.
> · Model prices and allowances stay as they are today.
> · The reduction percentages are modelled from measured cost shares — **they have not yet been observed on a deployed policy.**
> · Real organisations have a long tail of lighter users, so a real total is likely lower than the heavy-profile projection.
>
> **This is a projection, not a quote.**

---

# PART 9 · DATA APPENDIX — THE ONLY NUMBERS YOU MAY USE

**Rule: if a number is not in this appendix, it does not appear on the website.**

The `Chip` column tells you which provenance chip that figure must carry. This is not optional.

## 9.1 Measured findings — the analysed corpus

*Source: 115 days of one real developer's Copilot history — 102 session files, 790 model requests, 10,532 tool-call rounds, 10,124 tool calls. All rows: chip **`measured`**.*

| Figure | Value | Where to use |
|---|---|---|
| Median prompt size, one request | 83,166 tokens | S3 |
| Median cost, one request | 44.5 credits / $0.45 | S3 |
| Smallest request observed | 14,824 tokens / 7.9 credits / $0.079 | S3 optional |
| Largest request observed | 350,361 tokens / 187.5 credits / $1.875 | S3 optional |
| Total measured tokens decomposed | 6,142,177 | S4 footnote |
| Fixed overhead share (analysed corpus) | 27.3% | may use instead of 21% if consistent |
| Tool definitions — median tokens/request | 17,016 | S5 |
| Tool definitions — median share of prompt | 21% | S5 |
| Tool definitions — highest observed share | 74% | S5 |
| Tool definitions — cost per request | 9.1 credits / $0.091 | S5 |
| Re-transmission multiplier | 9.8× | S6 |
| Unique content generated | 6,845,528 tokens | S6 optional |
| Prompt tokens actually billed | 67,180,225 tokens | S6 optional |
| Fresh chat — cost per message | 31.2 credits | S7 |
| 33rd message — cost per message | 56.9 credits | S7 |
| Long-session penalty | +61% | S7 |
| Duplicate file-read rate | 42.0% | S13 (W2) |
| Most re-reads of one file, one session | 72 | S13 (W2) |
| Largest single tool result | 167,990 tokens ≈ 90 credits ≈ $0.90 | S13 (W3) |
| Compaction events in 115 days | 84 | S13 (W9) |
| Median compaction wait | 92,414 ms (~92 seconds) | S13 (W9) |
| Total compaction wait | ~2.15 hours | S13 (W9) |
| Share of sessions holding half the spend | 16% | S8 |
| Most expensive single session | $32.70 | S8 |
| Median session cost | $3.61 | S8 |
| Measured per-developer run-rate | 9,922 credits/month = $99.22/month | S16, calculator |
| Model price spread, most vs least expensive | 15.1× | S13 (W5) |
| Blended measured rate | 0.5353 credits per 1,000 prompt tokens | technical footnote only |
| Share of requests with a published credit figure | 9.4% | technical footnote only |

## 9.2 Live figures — the tool running today

*Source: the current TokenLens ledger on the developer machine it was built on. Period 2026-04-08 → 2026-07-30, 61 active days. Use these in **Section 12** and **Section 8** (the concentration visual).*

**Headline** — chip: **`blended · 24% measured`**

| Figure | Value |
|---|---|
| Total credits | 66,008.2 ( = $660.08 ) |
| Requests | 713 |
| Chat sessions | 57 |
| Active days | 61 |
| Share of total that is measured | 24% |
| Most expensive single session | 8,644.6 credits ( = $86.45 ) |

**Cost centres** — chip: **`measured`** on token shares

| Cost centre | Share | Tokens | Credits |
|---|---:|---:|---:|
| Conversation history (Messages) | 49% | 8,270,722 | 8,242.6 |
| Tool results | 23% | 3,832,965 | 4,325.0 |
| **Tool descriptions** | **16%** | 2,601,022 | 1,930.0 |
| Attached files | 7% | 1,231,513 | 1,021.0 |
| System instructions | 5% | 789,442 | 577.6 |

*Fixed overhead = tool descriptions + system instructions = **21%**.*

**Models** — the `Rate chip` column is the chip that specific rate must carry

| Model | Credits | Requests | Rate (cr/1k) | Rate chip |
|---|---:|---:|---:|---|
| claude-sonnet-4-6 | 18,877.2 | 212 | 0.962 | modelled |
| claude-opus-4-8 | 17,872.4 | 60 | 2.061 | **measured** |
| claude-opus-4-6 | 13,290.2 | 164 | 0.962 | modelled |
| claude-sonnet-5 | 7,505.4 | 37 | 1.005 | **measured** |
| claude-haiku-4-5 | 2,782.2 | 212 | 0.177 | **measured** |
| claude-opus-5 | 2,262.5 | 7 | 2.065 | **measured** |
| gpt-5.6-sol | 1,494.6 | 5 | 2.362 | **measured** |
| gpt-5.5 | 649.9 | 3 | 1.665 | **measured** |
| gpt-5.3-codex | 572.3 | 6 | 0.962 | modelled |
| claude-opus-4-7 | 523.5 | 4 | 0.962 | modelled |
| gpt-5.5-2026-04-23 | 178.1 | 3 | 0.962 | modelled |

**A powerful detail worth surfacing in Section 12:** 60 requests on the most expensive model cost **17,872 credits**. 212 requests on the cheapest model cost **2,782 credits**. *Three and a half times fewer requests, six and a half times more money.* Chip: `measured`.

## 9.3 Pricing facts — chip: `measured`

| Fact | Value |
|---|---|
| 1 AI credit | $0.01 |
| Copilot Business — before 1 Sep 2026 | 3,000 credits/user/month |
| Copilot Business — after | **1,900** |
| Copilot Enterprise — before 1 Sep 2026 | 7,000 credits/user/month |
| Copilot Enterprise — after | **3,900** |
| Allowance reduction | ~37% |
| Credit pool behaviour | Pooled organisation-wide · no carry-over · forfeited monthly · **hard stop when exhausted** |
| Not billed | Inline code completions and next-edit suggestions. Only agent and chat usage is billed. |

## 9.4 Modelled projections — chip: `modelled`, ALWAYS

*Basis: measured cost shares projected across 5,000 seats on Copilot Enterprise at the measured run-rate. **Not observed on a deployed policy.***

| Figure | Value |
|---|---|
| Annual consumption, 5,000 seats | $5,953,200 |
| Annual amount included in subscription | $2,340,000 *(this one is `measured` — it is arithmetic on published allowances)* |
| **Annual overage** | **$3,613,314** |
| Reduction — configuration only (Tier A) | ~35% |
| Reduction — configuration + guardrails (Tier A+B) | up to ~53% |
| Annual saving at 35% | $2,083,620 |
| Overage bill reduction at 35% | 58% |
| Overage bill reduction at 53% | ~87% |
| Reduction that eliminates overage entirely | ~61% |
| Combined modelled annual saving range | $2.1M – $3.2M |

**Per-lever modelled annual values (5,000 seats)** — all `modelled`:

| Lever | Share of spend | Annual value |
|---|---:|---:|
| Model routing | 20.0% | $1,190,663 |
| Session hygiene | 12.0% | $714,398 |
| Tool-definition trim | 10.5% | $625,098 |
| Runaway-loop caps | 5.0% | $297,666 |
| Duplicate-read elimination | 3.5% | $208,366 |
| Tool-result payload caps | 2.0% | $119,066 |

*These overlap; they combine multiplicatively, not additively. Total is 35–53%, not 53%.* State this in a footnote wherever the table appears.

**Fleet overage by size** — all `modelled`:

| Seats | Annual overage |
|---:|---:|
| 100 | $72,266 |
| 500 | $361,331 |
| 1,000 | $722,663 |
| 5,000 | $3,613,314 |
| 10,000 | $7,226,629 |

## 9.5 Numbers you must NOT use

- Any customer count, revenue figure, funding, team size, or company history. **There are none.**
- Any named real customer, logo, testimonial, or quote. **There are none.** Do not create placeholder logos or invented testimonials.
- Any accuracy, uptime, or performance percentage not listed above.
- Any figure describing a *realised* (as opposed to modelled) saving. **None exists yet.** That is what phase 9 is for.
- Any comparison claim against a named competitor product.
- Any award, certification, or compliance badge (SOC 2, ISO, etc.). None have been obtained.

---

# PART 10 · VOICE, TONE & LANGUAGE RULES

## 10.1 Voice

**Calm, precise, quietly confident. Never breathless.**

The tone is a specialist showing you an instrument reading — not a vendor selling you software. The findings are surprising enough on their own; any amplification makes them *less* believable, not more.

**Write like this:**
> One request in this data spent 74% of its budget describing tools before a single word of the developer's question was processed.

**Not like this:**
> 🚀 Unlock MASSIVE savings with revolutionary AI-powered cost intelligence!

## 10.2 Language rules

- **British-neutral English.** "Organisation", "behaviour", "utilise" → prefer "use", "optimise". Be consistent.
- **Currency:** US dollars, comma-separated thousands. Large annual figures may abbreviate as `$3.6M` in headlines, but the precise figure must appear at least once nearby.
- **Numbers:** always in monospace, always tabular. Never spell out a figure that appears elsewhere as a numeral.
- **Second person.** "Your engineers", "your invoice", "you are paying". Direct.
- **Active voice, short sentences.** A sentence over 25 words in body copy should be split.
- **Contractions are fine** in body copy, avoid them in headlines.

## 10.3 Terminology — use these exact terms consistently

| Use | Not |
|---|---|
| credits, AI credits | tokens *(when talking money — tokens is the unit of text, credits is the unit of money)* |
| request | call, query, prompt *(a prompt is what's inside a request)* |
| session, chat session | conversation, thread |
| cost centre | category, bucket, segment |
| tool descriptions / tool definitions | schemas, specs, manifests |
| the Tool-Definition Tax | *(this is the product's proper name for it — capitalise it)* |
| measured / modelled | verified / estimated / approximate |
| overage | overspend, excess |
| engineers, developers | users, devs, resources |

## 10.4 Forbidden words and phrases

Never use: *revolutionary · game-changing · unlock · supercharge · leverage (as a verb) · seamless · cutting-edge · state-of-the-art · robust · empower · disrupt · AI-powered · next-generation · turnkey · best-in-class · effortless · magic ·* any rocket, sparkle, fire, or money-bag emoji · exclamation marks in body copy.

Never claim: *"guaranteed savings" · "proven ROI" · "trusted by leading enterprises" · "industry-standard" · "enterprise-grade"* (unless immediately substantiated).

## 10.5 The honesty beats — do not cut these

There are exactly six places where the site volunteers a weakness. **Every one is load-bearing.** A reviewer will look for the catch; finding that you have already stated it is what converts scepticism into trust.

1. Section 6 — *"Some of this is unavoidable — it is how the technology works."*
2. Section 12 — *"Only 24% of these requests had a credit figure published by GitHub."*
3. Section 14 — *"Both figures are modelled… not yet observed on a deployed policy."*
4. Section 15 — the honest roadmap: three phases complete, seven not.
5. Part 7 Act I — *"Real fleets have a long tail of lighter users, so a real total would likely be lower."*
6. Part 7 Act IV — *"We will report that measured number even if it is lower than this page."*

Do not soften, shrink, or relocate any of them to a footer.

---

# PART 11 · TECHNICAL IMPLEMENTATION NOTES

## 11.1 Structure

Single page, 17 sections, semantic `<section>` elements each with an `id` and `aria-labelledby`. The section navigator uses these ids.

## 11.2 GSAP / ScrollTrigger

**Pin only these five:**
1. Section 3 — Anatomy of one request (~350vh)
2. Section 4 — The five cost centres (~250vh)
3. Section 5 — The Tool-Definition Tax (~300vh)
4. Part 7 Level 1 — Priya's Tuesday (~400vh)
5. Part 7 Level 2 — Meridian, four acts (~500vh)

Everywhere else: simple `ScrollTrigger` entrance animations, `once: true`, trigger at 70% viewport.

**Rules:**
- Use a single global GSAP `context` and clean up on unmount.
- `scrub: 1` (smoothed) for pinned timelines — not `scrub: true`, which feels twitchy on a trackpad during a live presentation.
- Set `anticipatePin: 1` on pinned sections.
- Call `ScrollTrigger.refresh()` after fonts load — the type is large and reflow will break pin calculations otherwise.
- Provide `invalidateOnRefresh: true` on anything using viewport-relative distances.

## 11.3 Optional 3D

3D is **optional and additive**. The site must be complete and compelling without it. If used, restrict it to at most two places:

1. **Hero ambient** — a slowly rotating field of thin vertical bars, extremely dim, suggesting an unread data structure. Very low contrast. Must not compete with the headline.
2. **Section 8 concentration** — the 57 session blocks as extruded volumes on a plane, camera slowly orbiting, the largest nine glowing.

Constraints: cap device pixel ratio at 2; pause rendering when the canvas is off-screen; provide a static fallback image; hard-disable under `prefers-reduced-motion` and on devices reporting fewer than 4 CPU cores.

**Do not put 3D in the Tool-Definition Tax section.** That section needs precision and legibility, and a 3D treatment would weaken it.

## 11.4 Performance budget

- Largest Contentful Paint under 2.0s on a mid-range laptop.
- Total JS under 400KB gzipped excluding any 3D bundle; lazy-load the 3D bundle.
- No layout shift after fonts load — use `size-adjust` font fallbacks and preload the two primary faces.
- Every animated property must be `transform` or `opacity`. Never animate `width`, `height`, `top`, or `left` — with one deliberate exception: the toll-gate slider in Section 5, which may animate width because the physical widening is the point. Use `will-change` there and nowhere else.
- Images: AVIF with WebP fallback. There should be very few images — this site is type, colour, and geometry.

## 11.5 Responsive

| Breakpoint | Behaviour |
|---|---|
| ≥1440px | Full design as specified |
| 1024–1439px | Reduce section padding to 140px; treemap and explanation list stack at 1024px |
| 768–1023px | All pinned sections **unpin** and become stacked static states, each with its final visual and full caption. **Do not attempt scrubbed pinning on tablet.** Hide the section navigator. |
| <768px | Single column. `<CostCentreBar>` rotates to vertical. Figures drop one step in the type scale. Calculator controls become full-width stacked. Treemap becomes a stacked bar list. |

**Mobile is a reading experience, not a presentation instrument.** Prioritise legibility and completeness of copy over choreography.

## 11.6 Print / PDF

Provide a print stylesheet. Executives forward pages. On print: light background, all sections expanded to final state, provenance chips rendered as bracketed text `[measured]` / `[modelled]`, section navigator hidden, URL footer included.

---

# PART 12 · ASSET LIST

Everything can be generated in code. **No photography. No stock illustration.**

| Asset | Notes |
|---|---|
| Logo — "TokenLens" wordmark | Set in the display face, 500 weight, tight tracking. The "Lens" half in `--measured`. Optionally a minimal mark: a thin circle with a horizontal ledger rule through it, suggesting both a lens and a ruled line. |
| Favicon | The mark, `--measured` on `--surface-void` |
| Open Graph image | 1200×630. Black. The wordmark, the line *"Your Copilot invoice has no line items."*, and a small decomposed cost-centre bar. |
| Cost-centre colour chips | Five fixed swatches per Part 4.1 |
| Provenance chip components | Green, amber, and the blended amber variant |
| Icons | Line icons only, 1.5px stroke, 24px grid. Needed for: lock, read-only/eye, server-off, receipt/traceability, warning, arrow. Do not use a filled icon set. |
| Fonts | Instrument Sans (or Space Grotesk), Inter, JetBrains Mono — all self-hosted, subset to Latin |

---

# PART 13 · ACCEPTANCE CHECKLIST

Do not consider the build complete until every box is true.

**Data integrity**
- [ ] Every number on the site appears in Part 9.
- [ ] No number appears without a provenance chip.
- [ ] Every `modelled` chip has a working popover stating its basis and assumptions.
- [ ] The blended chip in Section 12 shows the 24% split.
- [ ] The calculator's canonical case produces $3,613,320 / $2,083,620 / 58%.
- [ ] No invented customer, logo, testimonial, or compliance badge appears anywhere.

**Narrative**
- [ ] All six honesty beats (Part 10.5) are present, prominent, and unaltered.
- [ ] Section 15 states plainly that seven of ten phases are not yet built.
- [ ] The scenario is labelled as an illustrative, modelled example in its eyebrow.
- [ ] Priya's Tuesday is labelled as constructed from measured medians.
- [ ] The scenario's final word is the honesty statement, set at headline size.

**Design**
- [ ] The five cost-centre colours are identical everywhere they appear.
- [ ] Amber is used only for tool definitions and modelled values — never decoratively.
- [ ] All figures are monospaced and tabular.
- [ ] Labels always animate in *after* the thing they label.
- [ ] Body copy is never smaller than 19px on desktop.

**Presentation readiness**
- [ ] Every section is comprehensible if jumped to directly.
- [ ] The section navigator jumps correctly to all 17 sections.
- [ ] Nothing essential requires hover to be understood.
- [ ] Text is legible from three metres on a 1080p projector.

**Technical**
- [ ] `prefers-reduced-motion` renders every pinned section's final state immediately.
- [ ] All pinned sections unpin below 1024px.
- [ ] Keyboard navigable end to end with visible focus rings.
- [ ] `ScrollTrigger.refresh()` fires after font load.
- [ ] Print stylesheet produces a readable document.
- [ ] LCP under 2.0s.

---

## APPENDIX · THE FIFTEEN-SECOND VERSION

If the presenter has only one slide's worth of attention, these are the three sentences the site must have delivered:

> **1.** GitHub now bills you by the token, cuts you off when the budget is gone, and reduced included capacity by 37% in September.
>
> **2.** About a fifth of every credit you spend is fixed overhead — largely descriptions of tools that get sent on every single request whether anyone uses them or not — and nobody has ever shown you this because the data only exists on your own engineers' laptops.
>
> **3.** We read it, itemise it, and hand your IT team a configuration change that models out at a third less consumption and a **58% smaller overage bill** — with no developer changing how they work.

*Everything else on the site exists to make those three sentences believable.*

---

*End of brief. Build with restraint. The findings are strong enough that the design's job is to stay out of their way.*
