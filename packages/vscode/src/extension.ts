import * as vscode from 'vscode';
import { CoreClient, type BudgetForecast, type CoreFailure, type LedgerSummary } from './core.js';

/**
 * **Phase D7 — the status-bar HUD.**
 *
 * ## What problem this closes
 *
 * R7: there is no cost feedback at the moment cost is incurred. A developer
 * choosing a model, or continuing a forty-turn conversation, has no idea
 * what either costs until a bill arrives at the end of the month for
 * somebody else's attention. Every other phase measures spend after the
 * fact; this is the only place it is visible *while the decision is being
 * made*.
 *
 * ## Zero business logic (D7.5)
 *
 * Nothing here computes a credit. Every figure comes from the core binary,
 * so the status bar and `tokenlens ledger` cannot disagree — and the
 * privacy and provenance guarantees are inherited rather than restated.
 *
 * ## Degrading gracefully is an exit criterion, not politeness
 *
 * The extension may be installed where the binary is not. It must then be
 * quiet and useful — say what is missing and how to fix it — rather than
 * erroring on a timer. An extension that produces notifications nobody can
 * act on gets uninstalled, and takes the measurement programme with it.
 */
const REFRESH_COMMAND = 'tokenlens.refresh';

export function activate(context: vscode.ExtensionContext): void {
  const hud = new Hud(context);
  context.subscriptions.push(hud);

  context.subscriptions.push(
    vscode.commands.registerCommand(REFRESH_COMMAND, () => hud.refresh()),
    vscode.commands.registerCommand('tokenlens.showBreakdown', () => hud.showBreakdown()),
    vscode.commands.registerCommand('tokenlens.openDashboard', () => openDashboard()),
    vscode.commands.registerCommand('tokenlens.newChat', () => startFreshChat()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('tokenlens')) hud.reconfigure();
    }),
  );
}

export function deactivate(): void {
  // Everything is registered as a disposable on the extension context.
}

interface Snapshot {
  readonly ledger: LedgerSummary;
  readonly budget: BudgetForecast | undefined;
}

class Hud implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private snapshot: Snapshot | undefined;
  /** Reported once per cause, not once per refresh. */
  private lastReportedFailure: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'tokenlens.showBreakdown';
    this.reconfigure();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }

  reconfigure(): void {
    const config = vscode.workspace.getConfiguration('tokenlens');
    if (this.timer) clearInterval(this.timer);

    if (config.get<boolean>('enabled', true) !== true) {
      this.item.hide();
      return;
    }

    this.item.show();
    // Each refresh spawns the core binary. Polling faster than this costs
    // more than the figure is worth.
    const seconds = Math.max(30, config.get<number>('refreshSeconds', 120));
    this.timer = setInterval(() => void this.refresh(), seconds * 1000);
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const client = this.client();
    const plan = vscode.workspace.getConfiguration('tokenlens').get<string>('plan', 'enterprise');

    const ledger = await client.ledger();
    if (!ledger.ok) {
      this.renderFailure(ledger.failure);
      return;
    }

    const budget = await client.budget(plan);
    this.snapshot = { ledger: ledger.value, budget: budget.ok ? budget.value : undefined };
    this.lastReportedFailure = undefined;
    this.render();
  }

  private client(): CoreClient {
    const config = vscode.workspace.getConfiguration('tokenlens');
    return new CoreClient({
      binaryPath: config.get<string>('binaryPath', 'tokenlens'),
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });
  }

  /**
   * D7.1 — month-to-date, remaining allowance, and the run-rate warning.
   *
   * The status bar shows **remaining**, not spent. Spent is a fact about the
   * past; remaining is the constraint on what to do next, and only one of
   * those changes a decision.
   */
  private render(): void {
    if (!this.snapshot) return;
    const { ledger, budget } = this.snapshot;

    if (!budget) {
      this.item.text = `$(graph) ${formatCredits(ledger.totalCredits)} cr`;
      this.item.tooltip = this.tooltip();
      this.item.backgroundColor = undefined;
      return;
    }

    const remaining = Math.max(0, budget.monthlyAllowance - budget.monthToDateCredits);
    const overspending = budget.onTrackToExceedAllowance;

    this.item.text = `${overspending ? '$(warning)' : '$(graph)'} ${formatCredits(remaining)} cr left`;

    // Amber only when the run-rate is the problem, red only once the
    // allowance is actually gone. A status bar that is always coloured
    // stops being a signal.
    this.item.backgroundColor =
      remaining <= 0
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : overspending
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;

    this.item.tooltip = this.tooltip();
  }

  private tooltip(): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;
    if (!this.snapshot) return markdown;

    const { ledger, budget } = this.snapshot;
    markdown.appendMarkdown('**TokenLens**\n\n');

    if (budget) {
      markdown.appendMarkdown(
        `Month to date: **${formatCredits(budget.monthToDateCredits)}** of ` +
          `${formatCredits(budget.monthlyAllowance)} credits ` +
          `(day ${String(budget.daysElapsedInMonth)} of ${String(budget.daysInMonth)})\n\n`,
      );
      markdown.appendMarkdown(
        `Projected month end: **${formatCredits(budget.projectedMonthEndCredits)}**\n\n`,
      );
      if (budget.onTrackToExceedAllowance) {
        markdown.appendMarkdown(
          `⚠ On track to exceed the allowance by ${formatCredits(budget.projectedOverage)} credits.\n\n`,
        );
      }
      if (budget.hardBlockDate !== undefined) {
        markdown.appendMarkdown(
          `At this rate the allowance runs out around **${budget.hardBlockDate}**. ` +
            'There is no fallback model when it does.\n\n',
        );
      }
    }

    // The provenance split is carried into the HUD rather than dropped.
    // Most of a credit figure is a rate-card estimate, and a tooltip that
    // hid that would be presenting an estimate as a measurement — the one
    // thing this project refuses to do anywhere else.
    const measuredShare =
      ledger.totalCredits > 0 ? ledger.measuredCredits / ledger.totalCredits : 0;
    markdown.appendMarkdown(
      `${(measuredShare * 100).toFixed(0)}% of this is measured; the rest is rate-card estimated.\n\n`,
    );
    markdown.appendMarkdown('[Breakdown](command:tokenlens.showBreakdown) · ');
    markdown.appendMarkdown('[Dashboard](command:tokenlens.openDashboard) · ');
    markdown.appendMarkdown(`[Refresh](command:${REFRESH_COMMAND})`);
    return markdown;
  }

  /**
   * Degradation, stated in terms of what to do about it, and notified at
   * most once per cause. A background timer raising a notification every
   * two minutes because a binary is missing is worse than one that says
   * nothing at all.
   */
  private renderFailure(failure: CoreFailure): void {
    this.item.backgroundColor = undefined;

    switch (failure.kind) {
      case 'not-installed':
        this.item.text = '$(circle-slash) TokenLens not found';
        this.item.tooltip = `\`${failure.command}\` is not on PATH. Install the core binary, or set \`tokenlens.binaryPath\`.`;
        break;
      case 'no-workspace':
        this.item.text = '$(circle-slash) TokenLens';
        this.item.tooltip = 'Open a folder — the ledger is per workspace.';
        break;
      case 'no-data':
        this.item.text = '$(graph) TokenLens: no spend yet';
        this.item.tooltip = 'No Copilot requests have been recorded in this workspace yet.';
        break;
      default:
        this.item.text = '$(circle-slash) TokenLens';
        this.item.tooltip = `The core binary did not answer: ${failure.detail}`;
        break;
    }

    const signature = `${failure.kind}:${'detail' in failure ? failure.detail : ''}`;
    const alreadyReported = this.lastReportedFailure === signature;
    this.lastReportedFailure = signature;
    void this.context.globalState.update('tokenlens.lastFailure', signature);

    if (failure.kind === 'not-installed' && !alreadyReported) {
      void vscode.window
        .showWarningMessage(
          `TokenLens cannot find \`${failure.command}\`. The status bar will stay quiet until it can.`,
          'Open settings',
        )
        .then((choice) => {
          if (choice === 'Open settings') {
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'tokenlens.binaryPath',
            );
          }
        });
    }
  }

  /** D7.2 / D7.3 — what the spend is made of, and how old the longest chat is. */
  async showBreakdown(): Promise<void> {
    if (!this.snapshot) await this.refresh();
    if (!this.snapshot) {
      await vscode.window.showInformationMessage('TokenLens has no figures to show yet.');
      return;
    }

    const { ledger } = this.snapshot;
    const items: vscode.QuickPickItem[] = ledger.byModel.slice(0, 8).map((model) => ({
      label: model.model,
      description: `${formatCredits(model.credits)} credits`,
      detail:
        `${String(model.requestCount)} request(s) — ` +
        `${(model.credits / Math.max(1, model.requestCount)).toFixed(1)} credits per request`,
    }));

    const longest = [...ledger.bySession].sort((a, b) => b.requestCount - a.requestCount)[0];
    if (longest) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: NEW_CHAT_LABEL,
        description: `${String(longest.requestCount)} turns · ${formatCredits(longest.credits)} credits`,
        detail:
          'Every turn re-sends the whole history, so a long chat costs more per turn than a short one. ' +
          'Pick this to start fresh.',
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: `TokenLens — ${formatCredits(ledger.totalCredits)} credits over ${String(ledger.requestCount)} requests`,
      placeHolder: 'Spend by model',
    });

    if (picked?.label === NEW_CHAT_LABEL) await startFreshChat();
  }
}

const NEW_CHAT_LABEL = '$(comment-discussion) Longest conversation';

/** D7.3 — one click from noticing a chat is expensive to starting a cheap one. */
async function startFreshChat(): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.chat.newChat');
  } catch {
    // The chat command id is not stable across VS Code versions, and a
    // failure here must not surface as an extension error.
    await vscode.window.showInformationMessage(
      'Start a new chat from the Chat view to reset the conversation cost.',
    );
  }
}

/**
 * D7.4 — the dashboard.
 *
 * Opened in a browser rather than embedded in a webview, deliberately. The
 * dashboard server binds to 127.0.0.1 with a per-run token; a webview would
 * need that token routed through the extension host, adding a place for it
 * to leak in exchange for a slightly tidier window.
 */
async function openDashboard(): Promise<void> {
  const config = vscode.workspace.getConfiguration('tokenlens');
  const binary = config.get<string>('binaryPath', 'tokenlens');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (cwd === undefined) {
    await vscode.window.showInformationMessage(
      'Open a folder first — the ledger is per workspace.',
    );
    return;
  }

  const terminal = vscode.window.createTerminal({ name: 'TokenLens dashboard', cwd });
  terminal.sendText(`${binary} dashboard`);
  terminal.show();
}

function formatCredits(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
