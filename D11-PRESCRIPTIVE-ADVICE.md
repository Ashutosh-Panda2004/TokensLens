# D11 — Prescriptive Advice

**Status:** R1 built and green. R2/R3 designed, not built.
**Depends on:** D3 (waste detectors), D4 (levers), D8 (estimator discipline), D9 (org rollup, for R3 only).
**Companion to:** the internal build plan (tracked outside this repo).

---

## 0. The finding that should change the plan

The brief that commissioned this work assumed a starter catalogue of **15–30 tools**. That number
is wrong, and the reason is worth stating before anything else.

TokenLens already classifies every waste finding by *remediation tier*:

| Tier | Meaning | Who fixes it |
|---|---|---|
| A | managed setting | **TokenLens** — emits a policy artefact your MDM deploys |
| B | runtime guard | **TokenLens** — intercepts at the moment of spend |
| C | nudge | **the developer** — a habit, not a configuration |

Mapping the seven *implemented* detectors onto that:

| Class | Name | Tier | Who fixes it | Room for a third-party tool? |
|---|---|---|---|---|
| W1 | Tool-definition tax | A | TokenLens | **No** — already a one-line managed setting |
| W5 | Over-powered model choice | A | TokenLens | **No** — already a routing policy |
| W2 | Duplicate retrieval | B | TokenLens (partially) | **Yes — residual** |
| W3 | Oversized tool results | B | TokenLens (partially) | **Yes — residual** |
| W6 | Runaway agent loops | B | TokenLens | **No** — a loop cap is a guard, not a product |
| W4 | Stale chat sessions | C | the developer | **No** — behavioural |
| W9 | Context compaction | C | the developer | **No** — behavioural |

So the honest answer is: **exactly two waste classes are genuinely tool-fixable today, and both
only in the residual — the part TokenLens's own guard cannot reach.** A catalogue of thirty tools
would mean twenty-eight entries that can never fire, each one an unvetted liability with a licence
to re-check and a maintainer to chase.

**v1 ships 8–12 entries.** The catalogue grows when the dormant detectors come online (W8 needs
the org rollup; W10 needs instruction-file reading; W12–W14 need richer journal attribution), not
before. A recommendation engine's moat is that every entry is defensible, not that the list is long.

This is also the answer to *"should this be scraped?"* — see §6. It should not.

---

## 1. What this feature is

TokenLens diagnoses waste and fixes what it can reach. Where its own reach ends, it currently stops
and says nothing. D11 closes that gap: for **residual** waste — waste that survives TokenLens's own
tier-A/B fix — it names a specific, vetted, open-source tool, explains in plain language why *this*
finding produced *that* recommendation, and then measures whether the targeted metric actually moved.

Three constraints are load-bearing and non-negotiable:

- **Open-source only.** No proprietary or SaaS entries. This is not ideology; it removes procurement,
  licensing, and vendor data-sharing from the conversation entirely, which is the only way a
  recommendation is actionable inside an enterprise without a six-week review.
- **Local-only, zero egress.** The catalogue ships as a versioned dataset compiled into the binary.
  Nothing in this feature opens a socket. This is enforced by `arch.test.ts`, not by a comment.
- **No new data flow.** D11 reads the same ledger D3 already reads and writes two new local tables.
  It introduces no field that was not already on the machine.

### 1.1 A fourth tier

Tiers A, B and C describe *who acts*. A third-party tool is a fourth answer to that question, so it
gets a fourth tier:

> **Tier D — external tool.** Something TokenLens cannot do itself, that requires installing
> software TokenLens does not control, and that the developer or platform team must choose.

Tier D is strictly weaker than A and B: it costs installation effort, adds a dependency, and its
benefit is inferred rather than enforced. It is therefore **the last resort, not the first offer**.

### 1.2 The residual-gating rule

> **A tool is only ever recommended for waste that remains after TokenLens's own lever is applied.**

This single rule does most of the product work.

Concretely: W5 (over-powered model choice) is fixed by a tier-A routing policy. `RouteLLM` is the
obvious catalogue candidate for W5 — it is the best-known open-source LLM router. Recommending it
anyway would mean asking an enterprise to insert a Python proxy into the path of every model call,
to solve a problem already solved by one line of managed configuration. It would also mean
recommending a repository whose last commit was two years ago and which has never cut a release.

So the engine does not recommend it. Not because RouteLLM is bad, but because **the gate is
residual waste, and there is no residual.** A recommendation engine that cannot say *"nothing to
recommend here"* is a marketing surface, not an engineering one.

---

## 2. Tag taxonomy

### 2.1 Two orthogonal axes, not one flat tag list

A single flat namespace (`context-caching`, `graph-based-file-reference`, …) conflates *what the
tool does* with *how it reaches the agent*, and the second turns out to matter more for whether a
recommendation is actionable. So the taxonomy has two axes.

**Axis 1 — `FixMechanism`: what the tool actually does to reduce tokens.**

| Tag | Meaning | Addresses |
|---|---|---|
| `symbol-scoped-retrieval` | returns a symbol/AST node, not a whole file | W2, W3 |
| `structural-compression` | keeps signatures and structure, drops bodies | W3 |
| `bounded-context-packing` | assembles a size-budgeted context bundle with a token count | W3 |
| `deterministic-cache` | reuses an *exact* prior result | W2 |
| `semantic-cache` | reuses a *similar* prior result (needs embeddings) | W8 (dormant) |
| `prompt-compression` | token-level compression of the prompt itself | W4 (dormant) |
| `tool-surface-reduction` | fewer tool definitions sent per request | W1 (self-fixed) |
| `model-routing` | cheap model for simple work | W5 (self-fixed) |

**Axis 2 — `IntegrationSurface`: how it reaches the agent.**

| Tag | Blast radius | v1 admissible |
|---|---|---|
| `mcp-server` | one config line; reversible by deleting it | **yes** |
| `cli` | invoked manually or from a task; no runtime coupling | **yes** |
| `editor-extension` | scoped to the editor; marketplace-reviewed | **yes** |
| `library` | requires writing code | no — not a recommendation, a project |
| `proxy` | sits in the path of every model call | **no — see below** |

**Proxies are excluded from v1 by policy.** A proxy that terminates and rewrites LLM traffic sees
every prompt. Recommending one would ask a security team to accept a man-in-the-middle over exactly
the data TokenLens spent ten phases promising never to move. TokenLens cannot credibly hold a
zero-egress line for itself and then recommend a proxy to its users. This exclusion removes
`RouteLLM`, `LiteLLM`, and essentially every repository under the `prompt-compression` GitHub topic
from consideration — which is a feature, since almost none of them survive §6's inclusion bar either.

`mcp-server` is the sweet spot: it is the extension mechanism Copilot, Claude Code and Cursor
*already* have, it runs locally, it changes no data flow, and uninstalling it is deleting a line.

### 2.2 Tool-fixable vs behaviour-fixable

Every waste class carries a `FixNature`, decided once, in the taxonomy — not inferred per finding:

| `FixNature` | Meaning | Engine behaviour |
|---|---|---|
| `self-fixed` | TokenLens's own tier-A/B lever fully addresses it | never recommends a tool |
| `residual-tool-fixable` | the lever helps, but a real gap remains | **may** recommend, gated on residual |
| `behaviour-fixable` | the fix is a habit, not software | emits *guidance*, never a tool |
| `dormant` | the detector is not implemented yet | records the mapping, emits nothing |

Assignment for the current detector set:

```
W1  self-fixed              — tier A removes unused MCP servers wholesale
W5  self-fixed              — tier A routing policy
W6  self-fixed              — tier B loop cap
W2  residual-tool-fixable   — guard denies a repeat read; it cannot stop the agent
                              asking for a 900-line file when it needed one function
W3  residual-tool-fixable   — guard caps at ~16k chars; capping is not the same as
                              returning a smaller, better-chosen result
W4  behaviour-fixable       — "start a new chat for a new task"
W9  behaviour-fixable       — compaction is the bill for W4; same habit, later invoice
W7, W8, W10–W14  dormant
PD1–PD6  behaviour-fixable / dormant — displacement is an organisational finding;
                              no tool fixes reviewer concentration
```

The distinction earns its keep immediately: it is what stops the engine offering a code-graph MCP
server to somebody whose actual problem is that they have been in the same chat session since Tuesday.

### 2.3 The residual model, and the probe that makes it real

For a `residual-tool-fixable` class, the taxonomy records what the lever achieves, so the engine can
subtract it:

```
W2 · duplicate retrieval
  lever              dedupe-reads (tier B)
  lever reaches      exact re-reads of an already-returned range, same session, no
                     intervening edit
  residual           the first read was whole-file when a symbol would have done;
                     re-reads across sessions; re-reads after an unrelated edit
  probe              w2-whole-file-first-reads
  mechanisms         symbol-scoped-retrieval, deterministic-cache

W3 · oversized tool results
  lever              payload-cap (tier B)
  lever reaches      truncation and pagination above ~16k chars
  residual           results that are under the cap but still far larger than the
                     question required; repeated full-file reads that never trip it
  probe              w3-sub-cap-oversize
  mechanisms         structural-compression, bounded-context-packing,
                     symbol-scoped-retrieval
```

**Prose alone does not gate anything.** Stated only as a sentence, the residual rule is
unfalsifiable: every W2 finding would produce a W2 recommendation, including the corpus whose entire
W2 figure is exact repeat reads — exactly what the tier-B guard already denies, for free, with no
dependency. So each residual carries a **probe**: a deterministic statistic over recorded fields that
stands in for the part the lever cannot reach.

| Probe | What it counts | Threshold | Minimum sample |
|---|---|---|---|
| `w2-whole-file-first-reads` | share of *first* reads of a file-within-session that requested no line range | 35% | 30 first reads |
| `w3-sub-cap-oversize` | share of results above 3× their own tool's median **and at or below** the 16k tier-B cap | 10% | 50 measured results |

Three properties are deliberate, and each is a test:

- **Measured, not modelled.** Both read fields the journal actually wrote — line ranges, result
  sizes, tool names. Neither is a counterfactual, so neither needs a `Modelled<T>` wrapper to be
  honest about itself.
- **They vary with the evidence.** A probe returning a constant is a defect of the same shape as
  audit defect D-03, and `advice.residual.test.ts` fails the build for it.
- **They refuse a thin sample.** Below the minimum, the probe reports `sufficientSample: false` and
  the engine says nothing. A share computed over eleven reads is noise wearing a percentage sign.

Note the W2 denominator: *distinct file-within-session pairs*, not raw read calls. Counting raw calls
would let one heavily re-read file dominate the share — and re-reads are the lever's territory, not
the probe's. Note also that W3's multiple is 3× where the *detector* uses 20×. That is the point
rather than an inconsistency: the detector prices outliers severe enough to charge for, while the
probe looks for the ordinary result that is merely bigger than the question required. A residual is
by construction milder than the finding it survives.

**A recommendation fires only when the probe clears its threshold on a sufficient sample** — not
merely when the class has a finding.

> Run against this repository's own corpus, `w2-whole-file-first-reads` reads **0 of 1,867** first
> reads (0.0%), so the engine declines to offer a symbol-retrieval tool for W2 and says why. The gate
> is not decorative; on real data it fires.

---

## 3. Catalogue schema

Design goals: every field must be *checkable by a human in under a minute*, must have a defined
staleness behaviour, and must be typed so `tsc` — not a runtime validator — rejects a malformed entry.

```ts
interface CatalogueEntry {
  readonly id: string;                       // stable slug, never reused
  readonly name: string;
  readonly repository: string;               // canonical https URL, the identity of the entry
  readonly summary: string;                  // one sentence, plain language, no marketing
  readonly licence: SpdxLicence;             // 'MIT' | 'Apache-2.0' | 'BSD-3-Clause' | ...
  readonly mechanisms: readonly FixMechanism[];
  readonly surfaces: readonly IntegrationSurface[];
  readonly addresses: readonly WasteClass[];  // residual-tool-fixable only; empty when refused
  readonly wouldAddress: readonly WasteClass[]; // what a refused entry would have covered
  readonly install: InstallProfile;
  readonly requiresLocalModel: boolean;      // changes the story materially — see below
  readonly status: EntryStatus;              // 'recommended' | 'caution' | 'deprecated'
  readonly statusReason: string | undefined; // required when status !== 'recommended'
  readonly evidence: EvidenceLevel;          // how good is our claim that it helps?
  readonly verification: Verification;       // who checked the facts, and when
}

interface InstallProfile {
  readonly command: string;                  // the canonical one-liner from upstream
  readonly complexity: 'one-line' | 'config-edit' | 'multi-step';
  readonly reversible: boolean;              // can it be undone by deleting one thing?
}

interface UpstreamActivity {
  readonly date: string;                     // ISO YYYY-MM-DD
  readonly precision: 'day' | 'month';       // honesty about how precisely it is known
  readonly tag: string | undefined;          // release tag; undefined for commits
}

interface Verification {
  readonly checkedOn: string;                // ISO date
  readonly checkedBy: string;                // a person, not "automation"
  readonly upstreamLastRelease: UpstreamActivity | undefined;
  readonly upstreamLastCommit: UpstreamActivity | undefined;
  readonly source: 'maintainer-verified' | 'primary-fetch' | 'reported-unverified';
}

type EvidenceLevel =
  | 'upstream-claim'    // the project claims a reduction; we have not reproduced it
  | 'mechanism'         // the mechanism plainly reduces tokens; magnitude unknown
  | 'measured-local';   // we measured it against a TokenLens corpus
```

Five fields deserve defending.

**`requiresLocalModel`.** `LLMLingua` compresses prompts up to 20x — genuinely impressive — by
running GPT2-small, phi-2 or a BERT-class encoder locally. That is a different kind of ask: a model
download, GPU or slow CPU inference, and a second thing reading the developer's prompts. It may
still be the right tool, but the recommendation must say so up front. It is a schema field, not a
footnote, so it cannot be quietly omitted.

**`status` + `statusReason`.** Entries do not silently disappear. `deprecated` entries stay in the
dataset with the reason attached, so the engine can *refuse* them by name and so the vetting process
has regression fixtures. `GPTCache`'s own README says *"we no longer add support for new API or
models"* — that sentence is worth more than any heuristic, and it belongs in the record.

**`wouldAddress`.** A refused entry addresses nothing, by definition, so `addresses` is empty for it.
That left the refusals unreachable in the first draft: orphan records with no consumer. `wouldAddress`
is what lets the engine say *"the obvious candidate for W5 is RouteLLM, and here is why it is not
being offered"* — which is the more useful output, and the more defensible one, than silence that
reads as either ignorance or evasion.

**`evidence`.** `measured-local` is the only level that licenses a numeric savings claim. Everything
else is rendered as a mechanism, never a percentage. This is the same discipline as `Measured<T>` vs
`Modelled<T>`: never publish an estimate as a measurement.

**`UpstreamActivity`, and why it is a date.** The first draft held prose here — `'roughly a year
ago'`, `'2 weeks before checkedOn'`. Rule 2 of the inclusion bar is arithmetic, and arithmetic cannot
be performed on an adverb, so the rule could only ever be applied by a human re-reading the sentence.
That is a note, not a rule. Dates make it machine-checkable both in CI and *at match time*. The
`precision` field keeps that honest: a fact read as "roughly a year ago" is recorded to the month,
and any freshness derived from it is reported as approximate rather than quoted back as a day nobody
observed.

### 3.1 Admissibility is re-evaluated on every run

The inclusion bar splits in two, and the split matters more than it first appears.

Rules 1, 3, 4, 5 and 6 are **structural**: a licence, a maintainer, an integration surface, a
reversible install, a tool-fixable target. None can change after the build, so they are enforced once
in `advice.catalogue.test.ts`, where a breach fails CI.

Rules 2 and 7 are **temporal**, and the catalogue is compiled into a binary that outlives its build.
A user installing this release eighteen months from now would otherwise be handed entries verified
against a world that no longer exists, stated with exactly the confidence they carried on the day
they were checked. So `entryAdmissibility(entry, asOf)` re-applies them on every run, against a
caller-supplied instant rather than a hidden clock — which also makes every result reproducible in a
test. A third rule joins them: `MAX_MONTHS_SINCE_VERIFICATION = 6`. A sign-off ages too.

### 3.2 What is deliberately *not* in the schema

- **No score or ranking weight.** Ordering is derived from `status`, `evidence`, `install.complexity`
  and residual fit at match time. A stored score is a number nobody can re-derive six months later.
- **No star count.** It decays daily, it is not causal, and — see §6 — it is exactly the field
  automated collection got wrong.
- **No "popularity" or "trending".** The engine recommends on fit, not fashion.

### 3.3 The ordering, since it is derived rather than stored

A total, documented, lexicographic tuple, recomputed at match time so any placement can be
re-derived from the entry itself:

1. **status** — a caveated entry never outranks an uncaveated one.
2. **evidence** — measured beats claimed.
3. **mechanism fit**, descending — an entry covering both of a residual's mechanisms beats one
   covering half of it.
4. **install complexity** — between two comparable answers, prefer the one that costs a line.
   Effort is a real cost and the reader pays it.
5. **`requiresLocalModel`** — running a model over your own prompts is a materially larger ask, so
   it loses every tie up to here.
6. **`id`** — a meaningless, stable tie-break. Determinism is what makes an output quotable.

At most `MAX_CANDIDATES_PER_FINDING = 2` entries are named per finding. Two, not five: a
recommendation the reader has to choose between three ways is a research task handed back to them,
and the narrowing is supposed to have already happened. Two leaves an alternative when the first does
not suit the stack, and stops.

### 3.4 Silence is an output, not an absence

Every one of the fourteen classes appears in exactly one of `offers`, `silences` or `behaviour` on
every run, with a `SilenceCode` naming the reason: `self-fixed`, `behaviour-fixable`, `dormant`,
`no-finding`, `insufficient-sample`, `residual-below-threshold`, `guidance-only`,
`no-admissible-entry`. This is P5 — *degrade loudly* — applied to advice: “we looked and there is
nothing to offer” and “we did not look” must not render identically.

### 3.5 Guidance-only is a product, not a consolation prize

Two of the design's own rules guarantee that most runs name nothing: behaviour-fixable classes never
get a tool, and while the catalogue is below its floor nothing is offered for anything. A feature
that answered with silence in both cases would be a feature that is usually silent.

So the fallback is a real answer. **Mechanism guidance** describes the shape of the fix — *“ask for
the symbol, not the file”* — without naming anything to install, and it is deliberately **not gated
on the catalogue**: no sign-off, no staleness, nothing to rot, because a mechanism does not go out of
date the way a repository does. **Behaviour guidance** covers the habits. Both state *how the reader
would know it worked*, because advice with no observable consequence is indistinguishable from advice
nobody took.

---

## 4. Adoption inference

This is the part most likely to be wrong in a way nobody notices, so it gets the most care.

### 4.1 Four reasons the naive method fails

The naive method — *the metric fell after we showed the recommendation, therefore it was adopted and
therefore we caused the saving* — fails for four independent reasons, and all four are present
simultaneously:

1. **Regression to the mean.** The recommendation fires *because a metric crossed a threshold*.
   Selecting on an extreme value guarantees the next observation is lower on average, with no
   intervention whatsoever. This is not a risk; it is a certainty, and it is the single largest
   source of false credit.
2. **Concurrent causes.** Different repository, different sprint, a fortnight of meetings, a
   holiday. Waste-per-week falls when work falls.
3. **Co-intervention.** TokenLens itself may have emitted a tier-A policy or enabled a tier-B guard
   in the same window. Its own fix would otherwise be booked as the tool's.
4. **Multiplicity.** Many recommendations across many metrics across many windows. Some will move.

### 4.2 The method

**Reuse D8. Do not build a second, weaker statistics stack.** The holdout subsystem already contains
difference-in-differences estimation, pre-trend validation, Benjamini–Hochberg correction and a
pre-registration hash. D11's estimator is a *caller* of those, not a reimplementation.

**(a) Normalise by exposure.** Every metric is expressed per unit of work — per request, per
session, or per 1 000 prompt tokens — before any comparison. This alone removes most of cause (2).

**(b) Control with the developer's own untreated metrics.** The recommendation targeted one class.
Measure the targeted class *and* the untargeted ones over the same window, for the same person.

> If W2-per-request fell 40% while W1, W5 and W9 per-request held steady, the drop is *specific*.
> If everything fell 40%, the developer simply did less. That is volume, not remediation.

This is a difference-in-differences where the control arm is the same human being at the same time,
which removes the person, the project and the calendar as confounders for free. **It is the single
cheapest and strongest control available, and critically it works on one machine** — no org rollup,
no cohort, no fleet. It is what makes R2 shippable to a solo beta user.

**(c) Subtract expected mean reversion.** Because the trigger is a threshold crossing, the estimator
requires *two* pre-windows. Window −2 establishes the developer's ordinary level; window −1 is the
spike that triggered the recommendation. The counterfactual is the *ordinary level*, not the spike.
Only the drop below window −2 counts. A return from spike to normal is scored as exactly what it is:
nothing.

**(d) Refuse when confounded.** Every tier-A policy emission and tier-B guard change is written to a
local **co-intervention register** with a timestamp. Any evaluation window overlapping one is
`CONFOUNDED` and yields no estimate. Cheap to implement, and it eliminates the worst class of false
positive outright.

**(e) Pre-register the evaluation.** At the moment the recommendation is shown — *before the outcome
data exists* — record the targeted metric, the window length, and the threshold, and hash it with
the same canonicalisation D8 uses. At evaluation, re-hash and compare. This prevents metric-shopping
after the fact. It is the same defence, for the same reason, as the holdout pre-registration.

### 4.3 The verdict ladder

The output is never a boolean and never contains the word *adopted*, because adoption is not
observable and the product must not imply that it is.

| Verdict | Condition | Booked into savings? |
|---|---|---|
| `NO SIGNAL` | window too short, or too few requests for the class | no |
| `CONFOUNDED` | a TokenLens intervention overlapped the window | no |
| `CONSISTENT (weak)` | targeted metric fell, but untargeted metrics fell comparably | no |
| `CONSISTENT (moderate)` | targeted fell, untargeted stable, drop exceeds the window −2 baseline | **yes, flagged** |
| `CONSISTENT (strong)` | as moderate, sustained ≥2 consecutive windows, effect beyond historical variability | **yes** |
| `CONTRADICTED` | targeted metric rose | no — and the entry's `evidence` is reviewed |

`CONTRADICTED` matters. A catalogue that can only ever confirm itself is not measuring anything. A
recommendation that repeatedly precedes a *rise* in the metric it targeted is evidence about the
entry, and it should force a human back to the record.

Every verdict is a `Modelled<T>` carrying its assumption list, so it can never be rendered as a
measurement — `render()` throws if it is.

### 4.4 Impact reporting

Savings attributed here appear as their own line, **"waste reduced after recommended tooling"** —
*after*, not *by*. They are:

- excluded from headline totals below `CONSISTENT (moderate)`;
- never added to tier-A/B savings, which would double-count the same credits (D3's existing
  `overlapWarning` framing applies unchanged);
- always printed with the counterfactual stated in words, not just a confidence interval.

---

## 5. What could still be wrong

Stated plainly, because a design that lists no residual risk has not been examined.

- **Cross-metric control assumes the classes are independent.** They are not, entirely. A tool that
  makes retrieval symbol-scoped (W2) also shrinks payloads (W3), so W3 is a contaminated control
  for a W2 recommendation. Mitigation: the taxonomy records each entry's *full* `addresses` set, and
  the estimator excludes every class the entry touches from the control group. Classes with no
  mechanistic link to the entry (W4, W5, W9 for a retrieval tool) remain valid controls.
- **Single-machine samples are small.** Many developers will never accumulate enough requests in a
  window for anything above `NO SIGNAL`. That is the correct output, and it must not be softened.
  It is also the honest argument for the R3 org tier.
- **A developer may adopt a tool we never recommended.** The metric moves, we take credit. Partly
  mitigated by pre-registration and by requiring specificity, not eliminated. The `after`/`by`
  wording is doing real work here.
- **Catalogue selection bias.** We can only recommend tools we know about. §6's addition process is
  therefore a product surface, not an internal chore.

---

## 6. Curation, scraping, and maintenance

### 6.1 Evidence against scraping — from this project's own research

While preparing this brief, tool metadata was collected two ways: by fetching repository pages
directly, and by delegating collection to an agent. The delegated pass returned, among correct
facts:

- an owner of `scip-code/scip` for a repository believed to live under `sourcegraph/scip`;
- `anomalyco/opencode` at **192 000 stars**, which is not a plausible figure;
- an owner of `aaif-goose/goose` for a repository believed to live under `block/goose`.

Every one of those is *plausible-looking*. None would have been caught by a schema check, a type,
or a lint rule. All three would have shipped as fact in a product database, and the first one would
have sent a developer to the wrong repository — the single worst failure mode a recommendation
engine has, because it converts a helpful suggestion into a supply-chain hazard.

**Conclusion: automated collection is not admissible as a source of truth for this catalogue.** The
identity fields — owner, repository, licence, install command — are exactly the fields that are
security-relevant and exactly the fields automation got wrong.

### 6.2 What automation *is* for

One narrow job: **noticing decay**. A CI-only workflow, running weekly:

- reads a small, objective field set — default-branch last-commit date, latest release date,
  SPDX licence string, `archived` flag;
- compares them against `verification` in the dataset;
- **opens an issue.** It never edits the catalogue, never merges, never adds an entry.

And two hard constraints:

- it lives in `.github/workflows/`, **not** in `packages/core` — the shipped binary contains no code
  capable of fetching anything;
- `arch.test.ts` gains `src/advice` to its `FORBIDDEN_PACKAGES` list, so the zero-egress property is
  a failing test rather than a promise. This matches the house rule already applied to `src/hooks`
  and `src/mcp`.

### 6.3 Inclusion bar

An entry is admissible only if **all** hold:

| # | Rule | Enforced |
|---|---|---|
| 1 | OSI-approved licence, recorded as an SPDX identifier | structurally, in the catalogue test |
| 2 | A commit within the last 6 months **and** a release within the last 12 | temporally, on every run |
| 3 | An identifiable maintaining person or organisation | structurally |
| 4 | `surfaces` ⊆ {`mcp-server`, `cli`, `editor-extension`} — no proxies (§2.1) | structurally |
| 5 | `install.reversible === true` | structurally |
| 6 | It addresses a class marked `residual-tool-fixable` | structurally |
| 7 | Its facts were confirmed by a named human, within the last 6 months | temporally, on every run |

Rule 2 is not decoration. Applied today it demotes two of the five best-known tools in this space:

| Tool | Stars | Last commit | Last release | Verdict |
|---|---|---|---|---|
| `zilliztech/GPTCache` | 8.1k | last year | **2 years ago** | `deprecated` — README: *"we no longer add support for new API or models"* |
| `lm-sys/RouteLLM` | 5.3k | **2 years ago** | **none published** | `deprecated` — also a proxy (§2.1) |
| `microsoft/LLMLingua` | 6.5k | 10 months ago | **2 years ago** | `deprecated` — and requires a local model |

A catalogue assembled from search rankings or star counts would have led with all three.

### 6.4 Ownership and cadence

| | |
|---|---|
| Owner | one named maintainer (initially Ashutosh) |
| Cadence | quarterly full review; weekly automated decay issues |
| SLA | a decay issue is triaged within one release cycle |
| Demotion | rule-2 breach → `caution`; unresolved next cycle → `deprecated` |
| Removal | only on licence change to non-OSI, or upstream archival |
| Addition | issue → human verification → PR touching the dataset → catalogue test must pass |

Escalation, stated in advance so it is not improvised: the catalogue must sustain at least
`MIN_RECOMMENDED_ENTRIES` entries at `recommended`. That number is **derived, not chosen** —
`MAX_CANDIDATES_PER_FINDING × toolFixableClasses().length`, which is 2 × 2 = 4 today. The engine
names at most two candidates per finding and a class served by a single entry has a single point of
failure; deriving the floor means it cannot drift away from that reasoning, and it rises on its own
the day a dormant detector makes a third class tool-fixable. Below the floor the feature ships as
*guidance-only* (§3.5) rather than shipping a thin catalogue. This is not a failing build;
`catalogueReadiness()` computes it and the CLI degrades by itself. A recommendation engine with three
stale entries is worse than none, because it spends trust it cannot rebuild.

---

## 7. Phased scope

### R1 — *built*

Taxonomy, residual probes, catalogue, residual-gated matching, and a read-only `tokenlens advise`.

```
tokenlens advise                 residual-gated recommendations for this corpus
tokenlens advise --explain W2    why this finding produced this suggestion
tokenlens advise --catalogue     every entry, its status, and when it was last verified
tokenlens advise --json          machine-readable, carrying the catalogue digest
```

No statistics, no writes, no inference. Fully demonstrable, and its worst failure mode is saying
*"nothing to recommend"* — which is a correct answer, not a defect.

New files: `src/advice/{taxonomy,catalogue,catalogue.data,residual,guidance,match,report}.ts`,
`src/cli/commands/advise.ts`, `tests/advice.*.test.ts`. Re-exported from `src/index.ts`; registered
in `src/cli/program.ts`; `src/advice` added to `arch.test.ts`.

### R2 — *inference, single machine*

Pre-registration, the co-intervention register, two new append-only migrations (`advice_shown`,
`advice_window`), and the cross-metric difference-in-differences estimator with the §4.3 verdict
ladder.

```
tokenlens advise impact          per recommendation: verdict, caveats first, then the number
```

Depends on nothing outside the machine. This is the whole feature for a solo user.

### R3 — *org tier, needs D9*

Cross-developer control via stepped-wedge assignment (some developers see a recommendation a
fortnight later — a real experiment, not an inference); catalogue-level effectiveness (*which
entries actually precede a sustained drop, across the fleet*); and W8, which needs the org rollup to
exist at all. Subject to the D9 privacy gate unchanged: `MIN_GROUP_SIZE = 5`, aggregate-only bundles,
every field declared in the manifest.

### Explicitly out of scope, in every phase

- Detecting installation of third-party software. TokenLens does not scan the machine.
- Auto-installing, auto-configuring, or writing to any file the recommendation names.
- Proxies (§2.1).
- Any network call from the binary (§6.2).
- Semantic near-duplicate matching in core — it needs an embedding model, which rule AI-3 forbids.
  That is precisely why a *tool* recommendation is the right shape for W8 when it lands.

---

## 8. Summary of decisions

| # | Decision | Because |
|---|---|---|
| 1 | Tier D — external tool, as a fourth remediation tier | it answers the same question A/B/C answer: who acts |
| 2 | Recommend only against **residual** waste | never offer a dependency for a problem a setting already fixes |
| 3 | The residual is a **measured probe**, not prose | stated only as a sentence the rule is unfalsifiable and fires on every finding |
| 4 | Two taxonomy axes: mechanism × integration surface | how a tool reaches the agent gates actionability more than what it does |
| 5 | No proxies in v1 | TokenLens cannot hold a zero-egress line and recommend a man-in-the-middle |
| 6 | v1 catalogue is 8–12 entries, not 15–30 | only two waste classes are tool-fixable today; the rest would be ballast |
| 7 | Upstream activity stored as **dates**, with a precision flag | rule 2 is arithmetic, and arithmetic cannot be performed on an adverb |
| 8 | Rules 2 and 7 re-applied **at match time**, not only in CI | a compiled-in catalogue outlives its build; CI does not run on the user's machine |
| 9 | Ordering derived at match time; no stored score | a stored weight is a number nobody can defend once its author has moved on |
| 10 | The floor is **derived** from the offer cap | it then cannot drift from its own justification, and rises on its own |
| 11 | Refusals carry `wouldAddress`, so they can be made by name | silence about the obvious candidate reads as ignorance or evasion |
| 12 | Guidance-only emits mechanisms, not silence | most runs name nothing by design; a usually-silent feature is not one |
| 13 | Reuse D8's estimator rather than rebuild (R2) | DiD, pre-trend and BH already exist and are already tested |
| 14 | Control = the developer's own untargeted metrics (R2) | removes person, project and calendar; works on one machine |
| 15 | Two pre-windows, counterfactual is the *ordinary* level (R2) | the trigger is a threshold crossing, so mean reversion is guaranteed |
| 16 | Verdict ladder, never the word "adopted" (R2) | adoption is not observable and must not be implied |
| 17 | Curation is human-verified; automation only opens issues | agent-collected metadata produced three plausible-looking errors here |
| 18 | Zero egress enforced in `arch.test.ts` | privacy is a property, not a promise — the house rule |
| 19 | Ship guidance-only rather than a thin catalogue | a handful of stale entries spends trust that cannot be rebuilt |

---

## 9. What is built

**R1 is complete and green.** It is deliberately the part with no statistics in it.

| File | What it is |
|---|---|
| `src/advice/taxonomy.ts` | both axes, the `FixNature` mapping for all fourteen classes, the residual model and probe id for W2 and W3, and the offer cap |
| `src/advice/residual.ts` | the two probes, measured from recorded fields, with sample floors and thresholds |
| `src/advice/catalogue.ts` | the entry schema, the provenance ladder, dated upstream activity, `entryAdmissibility()`, the derived floor, `catalogueReadiness()`, `catalogueDigest()` |
| `src/advice/catalogue.data.ts` | the eight seed entries — five candidates, three recorded refusals |
| `src/advice/guidance.ts` | mechanism guidance for all eight mechanisms, behaviour guidance for W4 and W9 |
| `src/advice/match.ts` | the residual gate, the derived ordering, named silences, named refusals |
| `src/advice/report.ts` | `buildAdviceReport()` — read-only, `asOf` injected, digest attached |
| `src/cli/commands/advise.ts` | `advise` / `--explain` / `--catalogue` / `--json` |
| `scripts/advice-decay.mjs` + `.github/workflows/advice-decay.yml` | the CI-only decay check that opens an issue and never edits the dataset |
| `tests/advice.{catalogue,residual,match,report}.test.ts` | 84 tests turning §3, §2.3 and §6.3 into build failures |
| `tests/arch.test.ts` | `src/advice` in `FORBIDDEN_PACKAGES` — zero egress is a test, not a promise |

Suite: **682 tests across 52 files, all passing** (was 621 / 49). Typecheck, `eslint src tests` and
`prettier --check` clean.

### What the gate does on this repository's own data

```
$ tokenlens advise --explain W2

W2 · residual-tool-fixable
lever:            dedupe-reads
residual probe:
  first reads that fetched a whole file: 0.0% — at or below the 35.0% threshold
  detail: 0 of 1,867 first reads took the whole file (0.0%), carrying 0 characters
          the dedupe guard never sees

not offered [residual-below-threshold]: TokenLens’s own dedupe-reads lever already
reaches this waste, so a third-party dependency would be paid for twice and would
earn nothing.
```

That is the design working. The agent producing this corpus already passes line ranges on essentially
every read, so the residual a symbol-retrieval tool would address is genuinely absent — and the engine
declines to recommend one, by name, with the number that decided it. A version of this feature without
the probe would have offered Serena here, and been wrong.

The catalogue reports `mode: 'guidance-only'`, because nothing in it is `maintainer-verified` yet.
That is the correct starting state rather than a defect: the seed entries record exactly what is known
and exactly how directly it is known, and the readiness function refuses to offer any of them until a
named human has signed the facts off. Reaching `mode: 'catalogue'` is a bounded task — confirm owner,
licence, install command and dates for four entries — not an open-ended one.

### Still to build

- pre-registration, the co-intervention register, two append-only migrations, the estimator (R2)
- stepped-wedge assignment and catalogue-level effectiveness (R3)
