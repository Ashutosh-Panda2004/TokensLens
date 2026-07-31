import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The only thing in this extension that knows anything.
 *
 * D7.5 says the extension carries **zero business logic**, and this file is
 * where that rule is kept: it spawns the core binary, parses its JSON, and
 * has no opinion about any of it. Every figure the HUD shows was computed
 * by the same code that `tokenlens ledger` uses, so the status bar and the
 * command line can never disagree — which they would, inevitably, if the
 * arithmetic were reimplemented here.
 *
 * It also means the extension inherits the privacy and provenance
 * guarantees rather than having to restate them.
 */
export interface BudgetForecast {
  readonly plan: string;
  readonly monthlyAllowance: number;
  readonly monthToDateCredits: number;
  readonly daysElapsedInMonth: number;
  readonly daysInMonth: number;
  readonly projectedMonthEndCredits: number;
  readonly projectedOverage: number;
  readonly onTrackToExceedAllowance: boolean;
  readonly hardBlockDate?: string;
}

export interface ModelSpend {
  readonly model: string;
  readonly credits: number;
  readonly requestCount: number;
}

export interface SessionSpend {
  readonly sessionId: string;
  readonly credits: number;
  readonly requestCount: number;
  readonly lastTs: number;
}

export interface LedgerSummary {
  readonly totalCredits: number;
  readonly measuredCredits: number;
  readonly modelledCredits: number;
  readonly requestCount: number;
  readonly byModel: readonly ModelSpend[];
  readonly bySession: readonly SessionSpend[];
}

/**
 * Why the binary might not answer.
 *
 * Distinguished rather than collapsed into one failure, because the actions
 * are different: a missing binary needs installing, an empty ledger needs
 * Copilot to be used, and a crash needs reporting. A status bar reading
 * "TokenLens: error" would tell the developer none of that.
 */
export type CoreFailure =
  | { readonly kind: 'not-installed'; readonly command: string }
  | { readonly kind: 'no-workspace' }
  | { readonly kind: 'no-data' }
  | { readonly kind: 'failed'; readonly detail: string };

export type CoreResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: CoreFailure };

export interface CoreClientOptions {
  readonly binaryPath: string;
  readonly cwd: string | undefined;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class CoreClient {
  constructor(private readonly options: CoreClientOptions) {}

  async ledger(): Promise<CoreResult<LedgerSummary>> {
    const result = await this.json<LedgerSummary>(['ledger', '--json']);
    if (!result.ok) return result;
    return result.value.requestCount === 0 ? { ok: false, failure: { kind: 'no-data' } } : result;
  }

  async budget(plan: string): Promise<CoreResult<BudgetForecast>> {
    return this.json<BudgetForecast>(['budget', '--plan', plan, '--json']);
  }

  /**
   * Runs the binary and parses stdout.
   *
   * `execFile` with an argument array, never a shell string. The arguments
   * here are constants and a workspace path, but a shell would make that a
   * property of this call site rather than of the API — and the workspace
   * path is attacker-influenced on a machine that opened a hostile folder.
   */
  private async json<T>(args: readonly string[]): Promise<CoreResult<T>> {
    if (this.options.cwd === undefined) {
      return { ok: false, failure: { kind: 'no-workspace' } };
    }

    let stdout: string;
    try {
      const output = await run(this.options.binaryPath, [...args], {
        cwd: this.options.cwd,
        timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      });
      stdout = output.stdout;
    } catch (error) {
      const code = (error as { code?: string | number }).code;
      if (code === 'ENOENT') {
        return { ok: false, failure: { kind: 'not-installed', command: this.options.binaryPath } };
      }
      return {
        ok: false,
        failure: { kind: 'failed', detail: error instanceof Error ? error.message : String(error) },
      };
    }

    try {
      return { ok: true, value: JSON.parse(stdout) as T };
    } catch {
      return {
        ok: false,
        failure: { kind: 'failed', detail: 'The core binary produced output that was not JSON.' },
      };
    }
  }
}
