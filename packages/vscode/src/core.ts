import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { HudSnapshot } from '@tokenslens/core';

const run = promisify(execFile);

/**
 * The only thing in this extension that knows anything.
 *
 * D7.5 says the extension carries **zero business logic**, and this file is
 * where that rule is kept: it spawns the core binary, parses its JSON, and
 * has no opinion about any of it. Every figure the HUD shows was computed by
 * the same code the CLI uses, so the status bar and `tokenlens ledger`
 * cannot drift apart — which they would, inevitably, if the arithmetic were
 * reimplemented here.
 *
 * **D14.0c — the payload types are imported, not copied.** They used to be
 * hand-written duplicates of core's interfaces, and core changed one of them
 * to `number | null` without this file noticing; the HUD then coerced `null`
 * to zero and reported an unlimited allowance as "0 cr left". A type-only
 * import cannot drift, and erases completely at emit, so the thin-client
 * rule survives intact.
 */
export type { HudSnapshot } from '@tokenslens/core';

/** Reported settings, from `tokenlens config --json`. */
export interface EffectiveConfig {
  readonly effective: Readonly<Record<string, string | number | undefined>>;
  readonly sources: Readonly<Record<string, string>>;
  readonly allowance: {
    readonly plan: string;
    readonly credits: number | null;
    readonly source: string;
  };
  readonly paths: { readonly project: string; readonly user: string };
  readonly overriddenByEnv?: string;
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
  | { readonly kind: 'schema-mismatch'; readonly found: number; readonly expected: number }
  | { readonly kind: 'failed'; readonly detail: string };

export type CoreResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: CoreFailure };

export interface CoreClientOptions {
  readonly binaryPath: string;
  readonly cwd: string | undefined;
  /**
   * Every folder of a multi-root workspace. Passed as repeated `--at` flags
   * so the figures cover the workspace the developer sees, rather than
   * whichever folder happens to be first.
   */
  readonly roots?: readonly string[];
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** The payload shape this build understands. A newer binary is reported, not guessed at. */
const SUPPORTED_HUD_SCHEMA = 1;

interface Invocation {
  readonly file: string;
  readonly argv: readonly string[];
  readonly shell: boolean;
}

/** Arguments that may reach cmd.exe are restricted to characters a shell cannot act on. */
const SAFE_ARGUMENT = /^[\w.:@=+/\\-]+$/;

/**
 * Finds what `binaryPath` actually names on disk, applying PATHEXT the way
 * the shell would. `execFile` does not do this, so an extensionless command
 * that works in a terminal fails here with ENOENT.
 */
function locateExecutable(command: string): string | undefined {
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(delimiter)
    .filter((entry) => entry.length > 0);
  const candidates = (base: string): string[] =>
    extname(base) === '' ? [...extensions.map((ext) => base + ext), base] : [base];

  if (command.includes('/') || command.includes('\\')) {
    return candidates(command).find((candidate) => existsSync(candidate));
  }

  for (const directory of (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry.length > 0)) {
    const hit = candidates(join(directory, command)).find((candidate) => existsSync(candidate));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * npm installs `tokenlens` on Windows as a `.cmd` shim, and CreateProcess
 * cannot run a batch file. Without this, `execFile` reports ENOENT and the
 * HUD reads "not found" on a machine where the binary is installed and on
 * PATH — the failure this whole class exists to avoid misreporting.
 * Standard npm shims are resolved to their Node script so a timeout owns the
 * actual CLI process; custom batch files retain the guarded shell fallback.
 *
 * `undefined` means an argument was rejected rather than that nothing was
 * found: a missing binary still has to reach `execFile` so it surfaces as
 * ENOENT and gets the install advice.
 */
export function invocationFor(
  binaryPath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Invocation | undefined {
  const direct: Invocation = { file: binaryPath, argv: args, shell: false };
  if (platform !== 'win32') return direct;

  const resolved = locateExecutable(binaryPath);
  if (resolved === undefined) return direct;

  const extension = extname(resolved).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat') {
    return { file: resolved, argv: args, shell: false };
  }

  const npmShim = npmShimInvocation(resolved, args);
  if (npmShim !== undefined) return npmShim;

  // A shell is unavoidable for an unrecognised batch shim, so nothing
  // unvetted may reach it, and the command line is quoted here.
  if (!args.every((arg) => SAFE_ARGUMENT.test(arg))) return undefined;
  const quoted = [resolved, ...args].map((part) => `"${part}"`).join(' ');
  return { file: quoted, argv: [], shell: true };
}

function npmShimInvocation(shim: string, args: readonly string[]): Invocation | undefined {
  let source: string;
  try {
    source = readFileSync(shim, 'utf8');
  } catch {
    return undefined;
  }

  const relative = /&\s*"%_prog%"\s+"%dp0%\\([^"\r\n]+)"\s+%\*\s*$/im.exec(source)?.[1];
  if (relative === undefined || relative.includes('%')) return undefined;

  const script = resolve(dirname(shim), relative.split('\\').join(sep));
  if (!existsSync(script)) return undefined;

  const bundledNode = join(dirname(shim), 'node.exe');
  const node = existsSync(bundledNode) ? bundledNode : locateExecutable('node');
  if (node === undefined) return undefined;

  return { file: node, argv: [script, ...args], shell: false };
}

export class CoreClient {
  constructor(private readonly options: CoreClientOptions) {}

  /**
   * D14.3 — the whole HUD from a single spawn.
   *
   * Previously the HUD ran `ledger` and then `budget`, and two reads of a
   * moving database can disagree: the month total could come from one
   * instant and the breakdown from another.
   */
  async hud(): Promise<CoreResult<HudSnapshot>> {
    const anchors = (this.options.roots ?? []).flatMap((root) => ['--at', root]);
    const result = await this.json<HudSnapshot>(['hud', '--json', ...anchors]);
    if (!result.ok) return result;

    if (result.value.schemaVersion !== SUPPORTED_HUD_SCHEMA) {
      return {
        ok: false,
        failure: {
          kind: 'schema-mismatch',
          found: result.value.schemaVersion,
          expected: SUPPORTED_HUD_SCHEMA,
        },
      };
    }

    return result.value.workspace.requests === 0
      ? { ok: false, failure: { kind: 'no-data' } }
      : result;
  }

  async config(): Promise<CoreResult<EffectiveConfig>> {
    return this.json<EffectiveConfig>(['config', '--json']);
  }

  /**
   * Runs the binary and parses stdout.
   *
   * Arguments stay an array rather than becoming a shell string. Where a
   * Windows batch shim forces a shell, every argument is checked against an
   * allowlist first, so the escaping is a property of this call site rather
   * than a hope about the caller.
   */
  private async json<T>(args: readonly string[]): Promise<CoreResult<T>> {
    if (this.options.cwd === undefined) {
      return { ok: false, failure: { kind: 'no-workspace' } };
    }

    const invocation = invocationFor(this.options.binaryPath, args);
    if (invocation === undefined) {
      return {
        ok: false,
        failure: {
          kind: 'failed',
          detail: 'Refused to run the core binary with an unsafe argument.',
        },
      };
    }

    let stdout: string;
    try {
      const output = await run(invocation.file, [...invocation.argv], {
        cwd: this.options.cwd,
        timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        shell: invocation.shell,
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
