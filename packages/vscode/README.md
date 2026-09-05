# tokenlens-vscode

The status-bar HUD for TokenLens (Phase D7). It puts the one number that changes a decision —
**credits left this month** — where the decision is being made, instead of in a report somebody
reads after the month has ended.

## What it shows

| Surface                           | Content                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Status bar                        | Remaining allowance, amber when the run-rate will exceed it, red when it is gone                                       |
| Tooltip                           | Month-to-date vs allowance, projected month end, projected exhaustion date, and the measured/estimated split           |
| Sidebar consumption chart         | Credits or tokens over selectable daily, weekly, and monthly UTC periods, with exact values on hover or keyboard focus |
| `TokenLens: Show spend breakdown` | Spend per model with credits per request, plus the longest conversation                                                |
| `TokenLens: Start a fresh chat`   | Resets conversation history, which is re-sent in full on every turn                                                    |
| `TokenLens: Open dashboard`       | Runs `tokenlens dashboard` in a terminal                                                                               |

## Zero business logic

The extension computes nothing. Every figure and every daily, weekly, or monthly bucket comes from
one versioned `tokenlens hud --json` snapshot, spawned via `execFile` with an argument array. Period
switches reuse that bounded snapshot and never start another process. This is deliberate:
the status bar and the command line read from the same code, so they cannot drift apart, and the
extension inherits the privacy and provenance guarantees rather than restating them.

Consequently the extension is **useless without the core binary**, and says so plainly rather
than failing on a timer — a missing binary produces one actionable warning with a link to the
setting, not a notification every two minutes.

## Install

Install the MIT-licensed core, which provides the `tokenlens` command:

```powershell
npm install --global @tokenslens/core
tokenlens --version
```

Then install TokenLens from the VS Code Marketplace when published, or install the `.vsix` attached
to the same GitHub release:

```powershell
code --install-extension ./tokenlens-vscode-0.1.0.vsix
```

If the command is not on `PATH`, set `tokenlens.binaryPath` to the approved executable or wrapper.

## Workspace trust

TokenLens runs as a workspace extension because it starts the configured core binary and requires
a local filesystem. It is disabled in untrusted and virtual workspaces. Trust the workspace only
when you intend locally configured tools to run; changing `tokenlens.binaryPath` changes the
executable the extension invokes.

## Settings

| Setting                      | Default     | Notes                                                       |
| ---------------------------- | ----------- | ----------------------------------------------------------- |
| `tokenlens.binaryPath`       | `tokenlens` | Set this if the binary is not on `PATH`                     |
| `tokenlens.plan`             | inherited   | Overrides the plan shared with the CLI and dashboard        |
| `tokenlens.refreshSeconds`   | `300`       | Safety-net polling; journal changes normally refresh sooner |
| `tokenlens.statusBar.metric` | `auto`      | Chooses the single status-bar figure                        |
| `tokenlens.multiRoot`        | `aggregate` | Covers every folder or only the active editor's folder      |
| `tokenlens.enabled`          | `true`      | Hides the status-bar item when false                        |

## Building

From the repository root:

```powershell
npm run build
npm run test -w tokenlens-vscode
npm run package -w tokenlens-vscode
```

Use Node.js 22 or newer when packaging. The current VSCE toolchain resolves publishing
dependencies that require Node 22; the installed extension and `@tokenslens/core` runtime still
support Node 20.

The extension aggregates every folder in a multi-root workspace by default and can follow the
active editor instead. It reports an explicit no-workspace state when no folder is open.
