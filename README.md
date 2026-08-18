# TokenLens

Measured GitHub Copilot credit ledger, waste attribution, and policy compiler for VS Code.

TokenLens reads the billing telemetry VS Code already writes to local disk, decomposes every
credit into its five cost centres, attributes waste to named causes, simulates a fix before you
adopt it, and compiles the result into a policy artefact your MDM/platform team deploys once —
fleet-wide, with no developer action required.

**Build plan:** ten phases, D0 through D9, tracked internally.
**Current status:** **every phase, D0 through D10, is complete**, with the privacy rule (P7) enforced
across all of them. The full chain now runs end to end: measure the spend exactly, attribute the
waste, price the fix, deploy it as a managed setting, intercept what configuration cannot reach,
show the cost where the decision is made, prove the result against a randomised holdout, roll it up
across a fleet, and re-fit the policy when the fleet moves out from under it.

## What this is (and isn't)

One Node.js/TypeScript binary (`tokenlens`) that runs as a CLI, a local dashboard server, a
runtime hook target, an MCP server, and a policy compiler — one codebase, one build, one version.
**Not** a SaaS, a proxy, a daemon, or an agent. The core makes zero network calls and zero model
calls; AI integration is deliberately excluded from everything except one opt-in, org-tier
feature planned for Phase D9.

## Prerequisites

| | |
|---|---|
| Node.js | ≥ 20 (developed against 24; CI covers 20 / 22 / 24) |
| npm | ≥ 10 (workspaces support) |

## Getting started

```powershell
npm install
npm run build
npm test
npm run lint
```

## Repository layout

```
TokenLens/
├─ packages/
│  ├─ core/                   # the tokenlens binary — CLI, ledger, waste, simulation, policy
│  │  ├─ src/
│  │  │  ├─ model/            # Measured<T> / Modelled<T> provenance discipline
│  │  │  ├─ ingest/           # journal reader, schema pinning, redaction
│  │  │  ├─ store/            # SQLite schema, migrations, queries
│  │  │  ├─ ledger/           # credits, cost centres, rate card, budget
│  │  │  ├─ waste/            # W1..W14 detectors, one file each
│  │  │  ├─ simulate/         # replay engine, policy DSL, levers, ceiling guard
│  │  │  ├─ policy/           # channel detection + emitters + rollback
│  │  │  ├─ hooks/            # runtime guards — protocol, guard state, dispatch, fail-open
│  │  │  ├─ mcp/              # JSON-RPC budget guard over stdio
│  │  │  ├─ outcomes/         # git ingest, survival, effort, displacement, causal estimator
│  │  │  ├─ holdout/          # randomised design, power, pre-registration, guardrails, auto-rollback
│  │  │  ├─ org/              # sync bundle + manifest, fleet rollup, OTel ingest, drift, alerts
│  │  │  ├─ privacy/          # scope, identifier hashing, the report gate
│  │  │  ├─ dashboard/        # fastify + static SPA
│  │  │  ├─ shared/           # logger, config, io, errors, security baseline
│  │  │  └─ cli/              # commander wiring — one file per command
│  │  └─ tests/
│  └─ vscode/                 # status-bar HUD extension — a thin client over the binary
└─ .github/workflows/ci.yml   # format, lint, typecheck, build, test on every push
```

## Commands

```powershell
tokenlens ledger              # credits by day, model, session and cost centre
tokenlens sessions --top 10   # where the spend went
tokenlens verify <requestId>  # every figure back to a file and byte offset
tokenlens budget              # burn-down against the plan allowance
tokenlens dashboard           # local web UI on 127.0.0.1, token-guarded
tokenlens waste               # ranked causes, each with a named fix
tokenlens waste --explain W1  # the full evidence chain behind one cause
tokenlens mcp-roi             # per-server invocation ROI
tokenlens simulate --all      # replay history under a derived policy and price it
tokenlens simulate --emit-policy > .tokenlens/policy.yml
tokenlens policy detect       # which managed-settings channel wins on this machine?
tokenlens policy emit --dry-run   # the diff, with the credits each line saves
tokenlens policy emit --out ./out # .reg / .mobileconfig / settings.json / .agent.md + rollbacks
tokenlens policy verify       # did the deploy actually take effect?
tokenlens outcomes survival   # how much of what is written survives, and where effort goes
tokenlens outcomes displacement   # is work being relocated rather than eliminated?
tokenlens outcomes effect --cohorts licences.csv   # what a dated change in AI availability did
tokenlens hook install        # print the hook config; --out <dir> to write it
tokenlens hook status         # what each guard did, what it reversed, what stood itself down
tokenlens hook disable <guard>    # turn one guard off without disabling the rest
tokenlens mcp                 # budget guard over stdio, for the agent to consult before it spends
tokenlens holdout assign --roster fleet.csv   # stratified randomised holdout + pre-registration hash
tokenlens holdout analyse      # the caveats, then the effect — in that order
tokenlens holdout overrides --policy p.yml    # are developers switching back off the routed model?
tokenlens holdout rollback     # a guardrail broke, so revert without asking
tokenlens holdout pnl --input months.json     # realised saving vs simulated, and the gap
tokenlens org sync --team platform            # aggregate-only bundle, with a manifest of every field
tokenlens org rollup --bundles ./bundles      # fleet view, small teams suppressed
tokenlens org drift --policy p.yml --snapshot fit.json   # has the fleet moved out from under the policy?
tokenlens org alerts --bundles ./bundles      # robust anomaly payload; posts nothing
```

## What's implemented

| Phase | Component | File(s) |
|---|---|---|
| D0 | `Measured<T>` / `Modelled<T>` provenance types, with a footnote-enforcing renderer | `src/model/provenance.ts` |
| D0 | Error taxonomy — loud failure, never a silent zero | `src/shared/errors.ts` |
| D0 | Security baseline — path containment, safe git refs, prompt-injection-safe text fencing | `src/shared/safe.ts` |
| D0 | Structured logger — stderr-only, keeping stdout clean for D6's hook contract | `src/shared/logger.ts` |
| D0 | Architectural import-boundary test — no LLM import permitted in hooks/ledger/policy | `tests/arch.test.ts` |
| D1 | Journal ingest with pinned schema, redaction and incremental skip | `src/ingest/` |
| D1 | SQLite ledger, rate card derived from measured credits, budget forecast | `src/store/`, `src/ledger/` |
| D2 | Local dashboard (Fastify + vanilla SPA) and JSON/HTML export | `src/dashboard/` |
| D3 | Seven waste detectors; seven more declared undetectable **with stated blockers** | `src/waste/` |
| D4 | Counterfactual replay engine, policy DSL, six levers, contract-ceiling guard | `src/simulate/` |
| D5 | Channel detection, emitters for MDM / macOS / file-based / workspace / `.agent.md`, rollbacks | `src/policy/` |
| D6 | Five runtime guards, fail-open dispatch, insistence-based auto-disable, hook config generator | `src/hooks/` |
| D6 | MCP budget guard — hand-rolled JSON-RPC over stdio, no SDK dependency | `src/mcp/` |
| D7 | Status-bar HUD, spend breakdown, one-click fresh chat — zero business logic | `packages/vscode/` |
| D8 | Stratified randomised holdout, pre-registration hash, power/MDE, Benjamini–Hochberg, guardrails, auto-rollback, savings P&L | `src/holdout/` |
| D9 | Manifest-audited sync bundle, fleet rollup with k-anonymity, OTel ingest, drift detection, robust anomaly alerts | `src/org/` |
| D10 | Code survival, effort decomposition, displacement detection, staggered difference-in-differences | `src/outcomes/` |
| P7 | Privacy enforcement — salted-hash identifiers, k-anonymity floor, a gate that throws before a report is written | `src/privacy/` |

Everything above is deterministic: zero network calls, zero model calls, zero telemetry egress.

## Design principles (enforced, not just documented)

No source code leaves the machine, every number is traceable to a file and offset, an estimate
is never presented as a measurement, and failures are always loud.

## License

[MIT](LICENSE)
