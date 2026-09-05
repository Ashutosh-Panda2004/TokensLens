import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { HudSnapshot } from './core.js';
import { toHudView, type HudView } from './render.js';

/**
 * **The sidebar panel.**
 *
 * A `TreeView` cannot carry a meter, a share bar or a hero figure — it is a
 * list of labels — so this is a webview. That buys layout at the cost of a
 * sandbox to keep honest, which is why:
 *
 * - the content security policy allows **no** inline script, no remote
 *   anything, and only this extension's own `media/` directory;
 * - the HTML is a fixed template with no interpolated data at all. Every
 *   figure arrives later over `postMessage` and is written with
 *   `textContent`, so a model id or a workspace path can never be parsed as
 *   markup. The same rule the dashboard already follows.
 *
 * Colours come from the editor's own theme variables rather than a palette
 * of our own, so the panel belongs to whatever theme the user chose instead
 * of fighting it.
 */
export class HudViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'tokenlens.hud';

  private view: vscode.WebviewView | undefined;
  private latest: { view: HudView } | { message: string } | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onCommand: (command: string) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((message: { command?: unknown }) => {
      if (typeof message.command === 'string') this.onCommand(message.command);
    });

    // A hidden webview is torn down, so the state has to be replayed rather
    // than assumed to have survived.
    view.onDidChangeVisibility(() => {
      if (view.visible) this.post();
    });

    this.post();
  }

  update(snapshot: HudSnapshot | undefined, message?: string): void {
    this.latest =
      snapshot === undefined
        ? { message: message ?? 'TokenLens is unavailable.' }
        : { view: toHudView(snapshot) };
    this.post();
  }

  private post(): void {
    if (this.view === undefined || this.latest === undefined) return;
    void this.view.webview.postMessage(this.latest);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const asset = (name: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name));

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${asset('hud.css').toString()}" rel="stylesheet" />
    <title>TokenLens</title>
  </head>
  <body>
    <div id="root" class="loading">
      <div class="loading-state" role="status" aria-live="polite">
        <span class="loading-mark" aria-hidden="true"></span>
        <p class="message" id="message">Waiting for TokenLens…</p>
      </div>

      <div class="panel" id="panel" aria-live="polite">
        <section class="summary">
          <div class="status">
            <span class="pulse" aria-hidden="true"></span>
            <span id="freshness"></span>
          </div>

          <div class="hero">
            <div class="hero-value" id="hero-value"></div>
            <div class="hero-label" id="hero-label"></div>
            <div class="hero-sub" id="hero-sub"></div>
          </div>

          <div class="meter" id="meter" hidden>
            <div class="meter-track"><div class="meter-fill" id="meter-fill"></div></div>
            <div class="meter-label" id="meter-label"></div>
          </div>
        </section>

        <section class="tiles" id="tiles"></section>

        <section class="card history" id="history-card" hidden>
          <div class="history-toolbar">
            <div class="history-heading">
              <h2>Consumption</h2>
              <p class="history-summary" id="history-summary"></p>
            </div>
            <div class="history-metrics" role="group" aria-label="Chart metric">
              <button type="button" data-metric="credits" aria-pressed="true">Credits</button>
              <button type="button" data-metric="tokens" aria-pressed="false">Tokens</button>
            </div>
          </div>

          <div class="history-periods" role="tablist" aria-label="Consumption period">
            <button type="button" role="tab" data-period="daily" aria-selected="true">
              Daily
            </button>
            <button type="button" role="tab" data-period="weekly" aria-selected="false">
              Weekly
            </button>
            <button type="button" role="tab" data-period="monthly" aria-selected="false">
              Monthly
            </button>
          </div>

          <div class="history-plot" id="history-plot">
            <div class="history-chart" id="history-chart"></div>
            <div class="history-tooltip" id="history-tooltip" role="status" hidden></div>
          </div>
        </section>

        <section class="card session" id="session" hidden>
          <h2>Next turn will cost</h2>
          <div class="session-figure">
            <span id="session-next"></span>
            <span class="badge" id="session-multiple"></span>
          </div>
          <p class="muted" id="session-detail"></p>
          <button class="action" id="fresh-chat" type="button">Start a fresh chat</button>
        </section>

        <section class="card" id="models-card">
          <h2>Where it goes</h2>
          <div id="models"></div>
        </section>

        <section class="card saving" id="saving" hidden>
          <h2>Available saving</h2>
          <div class="saving-figure" id="saving-value"></div>
          <p class="muted" id="saving-detail"></p>
        </section>

        <footer class="meta">
          <p class="notes" id="notes"></p>
          <p class="scope" id="scope"></p>
        </footer>
      </div>

      <button class="primary" id="open-dashboard" type="button">
        <span>View full dashboard</span><span class="button-arrow" aria-hidden="true">→</span>
      </button>
    </div>
    <script nonce="${nonce}" src="${asset('hud.js').toString()}"></script>
  </body>
</html>`;
  }
}
