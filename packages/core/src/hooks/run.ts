import { loadOrCreateInstallSalt } from '../ingest/redact.js';
import { hashIdentifier } from '../privacy/identifiers.js';
import { dispatch, type DispatchOptions } from './dispatch.js';
import { guardStatePath, openGuardState } from './state.js';
import { allow, parseHookInput, type HookDecision } from './protocol.js';
import type Database from 'better-sqlite3';

/**
 * The hook entry point: stdin in, one decision out, always exit 0.
 *
 * ## The latency budget is the design constraint
 *
 * This runs before every tool call, with a hard budget of 50 ms at p99. That
 * rules out the ingest pipeline, the ledger database, and anything that
 * touches the network — and it is why the guards have a small state store of
 * their own. What remains is: read stdin, open a ~1 ms database, run a few
 * integer comparisons and at most one file hash, write a line.
 *
 * ## Nothing here is allowed to fail
 *
 * Every error becomes an allow. There is no error path that reaches the
 * agent, no non-zero exit, and no partial write. See `dispatch.ts` for why
 * this file inverts the project's usual "degrade loudly" rule.
 */
export interface RunHookOptions {
  readonly event?: string;
  readonly cwd?: string;
  readonly now?: number;
  /** Overrides stdin. Used by the tests, which must not depend on a pipe. */
  readonly stdin?: string;
  /** Milliseconds to wait for stdin before giving up and allowing. */
  readonly stdinTimeoutMs?: number;
}

const DEFAULT_STDIN_TIMEOUT_MS = 2_000;

export async function runHook(options: RunHookOptions = {}): Promise<HookDecision> {
  let db: Database.Database | undefined;
  try {
    const raw =
      options.stdin ?? (await readStdin(options.stdinTimeoutMs ?? DEFAULT_STDIN_TIMEOUT_MS));
    const parsed = parseHookInput(raw, options.event);
    if (!parsed) return allow();

    const cwd = options.cwd ?? process.cwd();
    const salt = await loadOrCreateInstallSalt(cwd);

    // The conversation id is hashed before it reaches the store, exactly as
    // it is at ingest. The guards need it only as a grouping key, and a
    // hook state file is no place for a raw identifier.
    const input = { ...parsed, sessionId: hashIdentifier(parsed.sessionId, salt) };

    db = openGuardState(guardStatePath(cwd));
    const dispatchOptions: DispatchOptions = {
      db,
      salt,
      root: cwd,
      ...(options.now !== undefined ? { now: options.now } : {}),
    };
    return dispatch(input, dispatchOptions);
  } catch {
    return allow();
  } finally {
    try {
      db?.close();
    } catch {
      // Closing failed; the process is about to exit anyway.
    }
  }
}

/**
 * Reads stdin to completion, or gives up.
 *
 * The timeout is not defensive padding. If the agent opens the pipe and
 * never writes, an un-timed read blocks forever and the tool call never
 * happens — the hook would have hung the very thing it exists to protect.
 */
export function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    };

    const timer = setTimeout(finish, timeoutMs);
    // Do not keep the process alive purely to wait for input.
    timer.unref();

    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/**
 * Writes the decision and nothing else.
 *
 * stdout is the wire protocol, which is why `shared/logger.ts` has been
 * stderr-only since D0 — a stray log line here would be parsed by the agent
 * as a malformed decision.
 */
export function writeDecision(decision: HookDecision): void {
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}
