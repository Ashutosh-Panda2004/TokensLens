# TokenLens

Measured GitHub Copilot credit ledger, waste attribution, and policy compiler for VS Code.

TokenLens reads the billing telemetry VS Code already writes to local disk, decomposes every
credit into its five cost centres, attributes waste to named causes, simulates a fix before you
adopt it, and compiles the result into a policy artefact your MDM/platform team deploys once —
fleet-wide, with no developer action required. It grew out of a companion strategy document
(`PLAN.md`) covering the research and business case; this repository is the build.

**Build plan:** [`DEVELOPMENT-PLAN.md`](DEVELOPMENT-PLAN.md) — ten phases, D0 through D9.
**Current status:** Phases **D0–D4 complete**, plus the privacy rule (P7) enforced across all of
them. The measurement spine is finished: ledger, dashboard, waste attribution and simulation.
Next is **D5 · Policy compiler**, where advisory becomes enforcement.

## What this is (and isn't)

One Node.js/TypeScript binary (`tokenlens`) that runs as a CLI, a local dashboard server, a
runtime hook target, an MCP server, and a policy compiler — one codebase, one build, one version.
**Not** a SaaS, a proxy, a daemon, or an agent. The core makes zero network calls and zero model
calls — see `DEVELOPMENT-PLAN.md` §0 for the full reasoning, including why AI integration is
deliberately excluded from everything except one opt-in, org-tier feature planned for Phase D9.

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
├─ DEVELOPMENT-PLAN.md        # the build plan — read this first
├─ packages/
│  ├─ core/                   # the tokenlens binary — CLI, ledger, waste, simulation, policy
│  │  ├─ src/
│  │  │  ├─ model/            # Measured<T> / Modelled<T> provenance discipline
│  │  │  ├─ ingest/           # journal reader, schema pinning, redaction
│  │  │  ├─ store/            # SQLite schema, migrations, queries
│  │  │  ├─ ledger/           # credits, cost centres, rate card, budget
│  │  │  ├─ waste/            # W1..W14 detectors, one file each
│  │  │  ├─ simulate/         # replay engine, policy DSL, levers, ceiling guard
│  │  │  ├─ privacy/          # scope, identifier hashing, the report gate
│  │  │  ├─ dashboard/        # fastify + static SPA
│  │  │  ├─ shared/           # logger, config, io, errors, security baseline
│  │  │  └─ cli/              # commander wiring — one file per command
│  │  └─ tests/
│  └─ vscode/                 # Phase D7 placeholder — status-bar HUD extension
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
| P7 | Privacy enforcement — salted-hash identifiers, k-anonymity floor, a gate that throws before a report is written | `src/privacy/` |

Everything above is deterministic: zero network calls, zero model calls, zero telemetry egress.

## Design principles (enforced, not just documented)

See `DEVELOPMENT-PLAN.md` §3 for the full list (S1–S10). In short: no source code leaves the
machine, every number is traceable to a file and offset, an estimate is never presented as a
measurement, and failures are always loud.
