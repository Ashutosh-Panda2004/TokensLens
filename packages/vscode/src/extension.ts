import * as vscode from 'vscode';
import { CoreClient, type CoreFailure, type EffectiveConfig, type HudSnapshot } from './core.js';
import { HudViewProvider } from './webview.js';
import { barTextFor, credits, money, multiple, tooltipFor, type BarMetric } from './render.js';

/**
 * **Phase D7/D14 — the status-bar HUD.**
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
 * Nothing here computes a credit. The entire payload comes from one
 * `tokenlens hud --json` call, so the HUD and the CLI cannot disagree — and
 * the privacy and provenance guarantees are inherited rather than restated.
 *
 * ## Degrading gracefully is an exit criterion, not politeness
 *
 * The extension may be installed where the binary is not. It must then be
 * quiet and useful — say what is missing and how to fix it — rather than
 * erroring on a timer.
 */
const REFRESH_COMMAND = 'tokenlens.refresh';

export function activate(context: vscode.ExtensionContext): void {
  // The panel's buttons run the same commands as the palette rather than
  // reaching into the HUD directly, so a webview cannot invoke anything a
  // user could not invoke themselves.
  const panel = new HudViewProvider(context.extensionUri, (command) => {
    void vscode.commands.executeCommand(command);
  });
  const hud = new Hud(context, panel);

  context.subscriptions.push(
    hud,
    vscode.window.registerWebviewViewProvider(HudViewProvider.viewType, panel),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => hud.refresh()),
    vscode.commands.registerCommand('tokenlens.showBreakdown', () => hud.showBreakdown()),
    vscode.commands.registerCommand('tokenlens.showSettings', () => hud.showSettings()),
    vscode.commands.registerCommand('tokenlens.openDashboard', () => openDashboard()),
    vscode.commands.registerCommand('tokenlens.newChat', () => startFreshChat()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('tokenlens')) hud.reconfigure();
    }),
    // Returning to an editor left open overnight is the common case, and the
    // figures behind it are certainly stale.
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) void hud.refresh();
    }),
  );
}

export function deactivate(): void {
  // Everything is registered as a disposable on the extension context.
}

class Hud implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private snapshot: HudSnapshot | undefined;
  private settings: EffectiveConfig | undefined;
  private watchers: vscode.FileSystemWatcher[] = [];
  private pending: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  /** Reported once per cause, not once per refresh. */
  private lastReportedFailure: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: HudViewProvider,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'tokenlens.showBreakdown';
    this.reconfigure();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.disposeWatchers();
    this.item.dispose();
  }

  reconfigure(): void {
    const config = vscode.workspace.getConfiguration('tokenlens');
    if (this.timer) clearInterval(this.timer);

    if (!config.get<boolean>('enabled', true)) {
      this.item.hide();
      this.disposeWatchers();
      return;
    }

    this.item.show();

    // D14.4 — polling is now a slow safety net, not the primary mechanism.
    // The watcher below reacts within seconds of a turn finishing, so a fast
    // poll would only spend process starts to learn nothing.
    const seconds = Math.max(30, config.get<number>('refreshSeconds', 300));
    this.timer = setInterval(() => void this.refresh(), seconds * 1000);

    this.watchJournals();
    void this.syncSettings();
    void this.refresh();
  }

  private client(): CoreClient {
    const config = vscode.workspace.getConfiguration('tokenlens');
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = folders.map((folder) => folder.uri.fsPath);

    // Following the active editor is offered for people who work in one
    // folder of a large workspace at a time; aggregating is the default
    // because it matches what the window claims to be showing.
    const active =
      config.get<string>('multiRoot', 'aggregate') === 'active-editor'
        ? activeEditorRoot()
        : undefined;

    return new CoreClient({
      binaryPath: config.get<string>('binaryPath', 'tokenlens'),
      cwd: active ?? roots[0],
      roots: active === undefined && roots.length > 1 ? roots : [],
    });
  }

  async refresh(): Promise<void> {
    // A watcher burst and the poll timer can land together; a second spawn
    // would produce an identical answer at twice the cost.
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const result = await this.client().hud();
      if (!result.ok) {
        this.renderFailure(result.failure);
        return;
      }
      this.snapshot = result.value;
      this.lastReportedFailure = undefined;
      this.render();
      this.panel.update(result.value);
      this.checkThresholds(result.value);
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * D14.4 — liveness, with its honest floor.
   *
   * Credits are written to the journal when a turn *completes*: streaming is
   * visible but uncosted, so "seconds after the turn ends" is the floor, and
   * no amount of polling moves it. Watching beats polling anyway, because it
   * reacts to the event rather than to the clock.
   */
  private watchJournals(): void {
    this.disposeWatchers();

    const storage = vscode.Uri.joinPath(this.context.globalStorageUri, '..', '..');
    const pattern = new vscode.RelativePattern(storage, '**/chatSessions/*.jsonl');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const bump = (): void => {
      this.scheduleRefresh();
    };
    watcher.onDidChange(bump);
    watcher.onDidCreate(bump);
    this.watchers.push(watcher);
  }

  /** A finishing turn writes several times; one refresh per burst is enough. */
  private scheduleRefresh(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => void this.refresh(), 2000);
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
  }

  private async syncSettings(): Promise<void> {
    const result = await this.client().config();
    if (!result.ok) return;
    this.settings = result.value;
    this.watchConfigFiles(result.value.paths);
  }

  /**
   * A setting saved in the dashboard must reach the HUD without waiting out
   * the poll interval, or the two surfaces disagree for minutes at a time.
   * The paths come from the binary rather than being guessed, because
   * `TOKENLENS_HOME` would break a guess.
   */
  private watchConfigFiles(paths: { readonly project: string; readonly user: string }): void {
    for (const file of new Set([paths.project, paths.user])) {
      const uri = vscode.Uri.file(file);
      const pattern = new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), '*.json');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const onChange = (): void => {
        void this.onConfigChanged();
      };
      watcher.onDidChange(onChange);
      watcher.onDidCreate(onChange);
      watcher.onDidDelete(onChange);
      this.watchers.push(watcher);
    }
  }

  private async onConfigChanged(): Promise<void> {
    const result = await this.client().config();
    if (result.ok) this.settings = result.value;
    await this.refresh();
  }

  private render(): void {
    if (!this.snapshot) return;
    const metric = vscode.workspace
      .getConfiguration('tokenlens')
      .get<BarMetric>('statusBar.metric', 'auto');

    const bar = barTextFor(this.snapshot, metric);
    const icon =
      bar.severity === 'error'
        ? '$(error)'
        : bar.severity === 'warning'
          ? '$(warning)'
          : '$(graph)';

    this.item.text = `${icon} ${bar.text}`;
    // Colour is reserved: amber only when the run-rate is the problem, red
    // only once the allowance is gone. A permanently coloured status bar has
    // stopped being a signal.
    this.item.backgroundColor =
      bar.severity === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : bar.severity === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    this.item.tooltip = tooltipFor(this.snapshot);
  }

  /**
   * D14.8 — thresholds that fire once and mean something.
   *
   * Mirrors GitHub's own 75/90/100 alert points, keyed by month so a new
   * month re-arms them, and persisted so a window reload does not.
   */
  private checkThresholds(snapshot: HudSnapshot): void {
    const config = vscode.workspace.getConfiguration('tokenlens');
    if (!config.get<boolean>('notifications', true)) return;

    const used = snapshot.month.percentUsed;
    if (used === null) return;

    const month = snapshot.generatedAt.slice(0, 7);
    for (const threshold of [1, 0.9, 0.75]) {
      if (used < threshold) continue;

      const key = `tokenlens.notified.${month}.${String(threshold)}`;
      if (this.context.globalState.get<boolean>(key) === true) return;
      void this.context.globalState.update(key, true);

      const headline =
        threshold >= 1
          ? `TokenLens: this month's allowance is spent. ${money(snapshot.month.incrementalUsd)} beyond it so far.`
          : `TokenLens: ${String(Math.round(threshold * 100))}% of this month's allowance is used, on day ${String(snapshot.month.daysElapsed)} of ${String(snapshot.month.daysInMonth)}.`;

      // Every notification carries an action; bare information on a timer is
      // what gets an extension muted.
      void vscode.window
        .showWarningMessage(headline, 'Show breakdown', 'Open dashboard')
        .then((choice) => {
          if (choice === 'Show breakdown') void this.showBreakdown();
          if (choice === 'Open dashboard') void openDashboard();
        });
      return;
    }
  }

  private renderFailure(failure: CoreFailure): void {
    this.item.backgroundColor = undefined;
    this.snapshot = undefined;

    let panelMessage = 'TokenLens is unavailable.';
    switch (failure.kind) {
      case 'not-installed':
        this.item.text = '$(circle-slash) TokenLens not found';
        this.item.tooltip = `\`${failure.command}\` is not on PATH. Install the core binary, or set \`tokenlens.binaryPath\`.`;
        panelMessage = `${failure.command} is not on PATH.`;
        break;
      case 'no-workspace':
        this.item.text = '$(circle-slash) TokenLens';
        this.item.tooltip = 'Open a folder — the ledger is per workspace.';
        panelMessage = 'Open a folder — the ledger is per workspace.';
        break;
      case 'no-data':
        this.item.text = '$(graph) TokenLens: no spend yet';
        this.item.tooltip = 'No Copilot requests have been recorded in this workspace yet.';
        panelMessage = 'No Copilot requests recorded here yet.';
        break;
      case 'schema-mismatch':
        // Rendering whichever fields happen to be recognised would be worse
        // than saying the two halves no longer match.
        this.item.text = '$(circle-slash) TokenLens: update needed';
        this.item.tooltip = `The core binary speaks HUD schema ${String(failure.found)}; this extension understands ${String(failure.expected)}. Update the extension.`;
        panelMessage = 'The extension and the core binary are different versions.';
        break;
      default:
        this.item.text = '$(circle-slash) TokenLens';
        this.item.tooltip = `The core binary did not answer: ${failure.detail}`;
        panelMessage = failure.detail;
        break;
    }

    this.panel.update(undefined, panelMessage);

    const signature = `${failure.kind}:${'detail' in failure ? failure.detail : ''}`;
    const alreadyReported = this.lastReportedFailure === signature;
    this.lastReportedFailure = signature;

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

  /** D7.2 / D7.3 — what the spend is made of, and what continuing will cost. */
  async showBreakdown(): Promise<void> {
    if (!this.snapshot) await this.refresh();
    const snapshot = this.snapshot;
    if (!snapshot) {
      await vscode.window.showInformationMessage('TokenLens has no figures to show yet.');
      return;
    }

    const items: vscode.QuickPickItem[] = snapshot.topModels.map((model) => ({
      label: model.model,
      description: `${credits(model.credits)} cr · ${money(model.usd)}`,
      detail: `${String(model.requests)} request(s) — ${credits(model.creditsPerRequest)} credits each`,
    }));

    const best = snapshot.advice.substitutions[0];
    if (best !== undefined) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: `$(lightbulb) ${best.from} → ${best.to}`,
        description: `would have saved ${money(best.savedUsd)} all time`,
        detail:
          `Priced from ${String(best.targetSampleSize)} measured requests on ${best.to}. ` +
          'Assumes the cheaper model would have done the job — that is a counterfactual, not a measurement.',
      });
    }

    if (snapshot.session?.nextTurn) {
      const next = snapshot.session.nextTurn;
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: NEW_CHAT_LABEL,
        description: `${String(snapshot.session.turns)} turns · ${money(snapshot.session.usd)} so far`,
        detail:
          `The next turn projects at ${money(next.usd)} — ${multiple(next.multipleOfFreshTurn)} what a fresh chat's ` +
          `first turn costs, measured over ${String(next.sampleSize)} turns. Pick this to start fresh.`,
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: `TokenLens — ${credits(snapshot.month.credits)} credits this month · ${money(snapshot.month.usd)}`,
      placeHolder: snapshot.scope,
    });

    if (picked?.label === NEW_CHAT_LABEL) await startFreshChat();
  }

  /** What is in force, and which file set it — the same answer `tokenlens config` gives. */
  async showSettings(): Promise<void> {
    await this.syncSettings();
    const settings = this.settings;
    if (!settings) {
      await vscode.window.showInformationMessage(
        'TokenLens could not read its settings. Check that the core binary is installed.',
      );
      return;
    }

    const items: vscode.QuickPickItem[] = Object.entries(settings.sources).map(([key, source]) => ({
      label: key,
      description: String(settings.effective[key] ?? '(not set)'),
      detail: `set by ${SOURCE_LABEL[source] ?? source}`,
    }));

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: EDIT_SETTINGS_LABEL,
      detail: 'Settings are shared: the dashboard writes them, the CLI and this HUD both follow.',
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: 'TokenLens — settings in force',
      placeHolder: settings.overriddenByEnv ?? 'Shared by the CLI, dashboard and this extension',
    });

    if (picked?.label === EDIT_SETTINGS_LABEL) await openDashboard();
  }
}

const NEW_CHAT_LABEL = '$(comment-discussion) Start a fresh chat';
const EDIT_SETTINGS_LABEL = '$(gear) Edit these in the dashboard';

/** The workspace folder containing the active editor, when there is one. */
function activeEditorRoot(): string | undefined {
  const document = vscode.window.activeTextEditor?.document;
  if (document === undefined) return undefined;
  return vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
}

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  env: 'an environment variable',
  'project-config': './.tokenlens/config.json',
  'user-config': '~/.tokenlens/config.json',
  default: 'the built-in default',
};

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
