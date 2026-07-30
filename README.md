# TokenLens

Measured GitHub Copilot credit ledger, waste attribution, and policy compiler for VS Code.

TokenLens reads the billing telemetry VS Code already writes to local disk, decomposes every
credit into its five cost centres, attributes waste to named causes, simulates a fix before you
adopt it, and compiles the result into a policy artefact your MDM/platform team deploys once —
fleet-wide, with no developer action required. It grew out of a companion strategy document
(`PLAN.md`) covering the research and business case; this repository is the build.

**Build plan:** [`DEVELOPMENT-PLAN.md`](DEVELOPMENT-PLAN.md) — ten phases, D0 through D9.
**Current status:** Phase **D0 · Foundation & Amputation** — see below.

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
│  ├─ core/                   # the tokenlens binary — CLI, ledger, waste, policy, hooks
│  │  ├─ src/
│  │  │  ├─ model/            # Measured<T> / Modelled<T> provenance discipline
│  │  │  ├─ shared/           # logger, config, io, errors, security baseline
│  │  │  └─ cli/               # commander wiring — one roadmap entry per phase
│  │  └─ tests/
│  └─ vscode/                 # Phase D7 placeholder — status-bar HUD extension
└─ .github/workflows/ci.yml   # format, lint, typecheck, build, test on every push
```

## Phase D0 — what's implemented

| Component | File(s) |
|---|---|
| `Measured<T>` / `Modelled<T>` provenance types, with a footnote-enforcing renderer | `packages/core/src/model/provenance.ts` |
| Error taxonomy — loud failure, never a silent zero | `packages/core/src/shared/errors.ts` |
| Security baseline — path containment, safe git refs, prompt-injection-safe text fencing | `packages/core/src/shared/safe.ts` |
| Structured logger — stderr-only, by design (keeps stdout clean for Phase D6's hook contract) | `packages/core/src/shared/logger.ts` |
| Config loader — `env:VAR` secret indirection, atomic writes | `packages/core/src/shared/config.ts`, `io.ts` |
| CLI shell — every planned command registered; each reports `NotImplementedError` naming its phase until built | `packages/core/src/cli/` |
| Architectural import-boundary test — no LLM import permitted in hooks/ledger/policy | `packages/core/tests/arch.test.ts` |

Everything above is deterministic: zero network calls, zero model calls, zero telemetry egress.

## Design principles (enforced, not just documented)

See `DEVELOPMENT-PLAN.md` §3 for the full list (S1–S10). In short: no source code leaves the
machine, every number is traceable to a file and offset, an estimate is never presented as a
measurement, and failures are always loud.
