# tokenlens-vscode

The status-bar HUD for TokenLens (Phase D7). It puts the one number that changes a decision —
**credits left this month** — where the decision is being made, instead of in a report somebody
reads after the month has ended.

## What it shows

| Surface | Content |
| --- | --- |
| Status bar | Remaining allowance, amber when the run-rate will exceed it, red when it is gone |
| Tooltip | Month-to-date vs allowance, projected month end, projected exhaustion date, and the measured/estimated split |
| `TokenLens: Show spend breakdown` | Spend per model with credits per request, plus the longest conversation |
| `TokenLens: Start a fresh chat` | Resets conversation history, which is re-sent in full on every turn |
| `TokenLens: Open dashboard` | Runs `tokenlens dashboard` in a terminal |

## Zero business logic

The extension computes nothing. Every figure comes from `tokenlens ledger --json` and
`tokenlens budget --json`, spawned via `execFile` with an argument array. This is deliberate:
the status bar and the command line read from the same code, so they cannot drift apart, and the
extension inherits the privacy and provenance guarantees rather than restating them.

Consequently the extension is **useless without the core binary**, and says so plainly rather
than failing on a timer — a missing binary produces one actionable warning with a link to the
setting, not a notification every two minutes.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `tokenlens.binaryPath` | `tokenlens` | Set this if the binary is not on `PATH` |
| `tokenlens.plan` | `enterprise` | Sets the included monthly allowance |
| `tokenlens.refreshSeconds` | `120` | Each refresh spawns the binary; the floor is 30s |
| `tokenlens.enabled` | `true` | Hides the status-bar item when false |

## Building

```
npm run build --workspace packages/vscode
npm run package --workspace packages/vscode   # requires vsce
```

The ledger is per workspace, so the extension reads the first workspace folder and shows nothing
useful when no folder is open.
