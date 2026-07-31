import type Database from 'better-sqlite3';
import { hashPath } from '../ingest/redact.js';
import { fileSize, fingerprintFile, resolveWithinRoot, MAX_HASH_BYTES } from './fingerprint.js';
import { bumpSession, findObservedRead, getSessionState, recordObservedRead } from './state.js';
import {
  allow,
  deny,
  halt,
  notify,
  rewrite,
  type HookDecision,
  type HookInput,
} from './protocol.js';
import { readToolTarget } from './protocol.js';

/**
 * The Tier B guards: deterministic interception at the moment of spend.
 *
 * Each one is a pure decision over `(input, state)` so it can be tested
 * without a subprocess, and each declares the automation it implements so a
 * denial can be traced back to the finding that justified it.
 */
export interface Guard {
  /** Stable id — the key for the audit log and the auto-disable ledger. */
  readonly id: string;
  readonly automation: string;
  /** The waste class this attacks. */
  readonly attacks: string;
  readonly events: readonly HookInput['event'][];
  decide(ctx: GuardContext): GuardOutcome | undefined;
}

/**
 * What a guard decided, and what it decided it about.
 *
 * `subject` is what makes the false-positive check possible. A guard that
 * names the thing it refused can be told when the agent asks for that exact
 * thing again — which is the only honest evidence available that the
 * refusal was wrong. A guard that returns no subject simply does not
 * participate in that check.
 */
export interface GuardOutcome {
  readonly decision: HookDecision;
  readonly subject?: string;
}

export interface GuardContext {
  readonly input: HookInput;
  readonly db: Database.Database;
  readonly salt: string;
  readonly root: string;
  readonly now: number;
  readonly config: GuardConfig;
}

export interface GuardConfig {
  /** Tool results larger than this are narrowed rather than passed through. */
  readonly maxResultBytes: number;
  /** Rounds after which a session producing no edit is halted. */
  readonly maxRounds: number;
  /** Turns after which the session-age nudge fires. */
  readonly nudgeAfterTurns: number;
  /** Lines a narrowed read is rewritten to request. */
  readonly narrowToLines: number;
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  maxResultBytes: 16_000,
  maxRounds: 30,
  nudgeAfterTurns: 20,
  narrowToLines: 400,
};

/** Tools whose result is file content, and which can therefore be a no-op. */
const READ_TOOLS = new Set(['read_file', 'get_errors', 'read_notebook_cell_output']);

const WHOLE_FILE = { start: 0, end: 0 } as const;

/**
 * **AUTO-14 · Re-read suppressor** — attacks W2.
 *
 * Denies a read whose result is already in the conversation *and provably
 * unchanged*.
 *
 * ## What "provable" means, and why it is not negotiable
 *
 * H-4 says deny only on provable no-ops, and the proof is a content hash of
 * the file **as it is right now**, compared against the hash recorded when
 * the same range was last read in this session. If the file changed by so
 * much as a byte the hashes differ and the read goes through.
 *
 * That is the runtime form of the lesson D10 learned the expensive way: an
 * earlier version of the duplicate-read detector counted the agent reading
 * back its own edits, and 79% of what it flagged was legitimate. A guard
 * built on the same mistake would deny the agent sight of the file it had
 * just written, which is not a saving — it is a broken agent.
 *
 * Anything the guard cannot prove — a file too large to hash, a path
 * outside the workspace, an unreadable file — is allowed. Silence is the
 * safe answer.
 */
export const rereadSuppressor: Guard = {
  id: 'reread-suppressor',
  automation: 'AUTO-14',
  attacks: 'W2',
  events: ['PreToolUse'],

  decide(ctx) {
    const { input } = ctx;
    if (input.toolName === undefined || !READ_TOOLS.has(input.toolName)) return undefined;

    const target = readToolTarget(input);
    if (!target) return undefined;

    const absolute = resolveWithinRoot(ctx.root, target.rawPath);
    if (absolute === undefined) return undefined;

    const fingerprint = fingerprintFile(absolute, target.startLine, target.endLine);
    if (!fingerprint) return undefined;

    const fileHash = hashPath(absolute, ctx.salt);
    const start = target.startLine ?? WHOLE_FILE.start;
    const end = target.endLine ?? WHOLE_FILE.end;
    const seen = findObservedRead(ctx.db, input.sessionId, fileHash, start, end);
    const subject = `${fileHash}:${String(start)}:${String(end)}`;

    if (seen?.contentHash === fingerprint.contentHash) {
      return {
        subject,
        decision: deny(
          input.event,
          `This range is already in context and has not changed since turn ${String(seen.turn)} ` +
            `(sha ${seen.contentHash.slice(0, 8)}…). Re-reading it appends a second identical copy, ` +
            'which is then re-sent on every later step of this turn. Use the copy you already have.',
        ),
      };
    }

    // Recorded on the way past. If the tool then fails, `PostToolUse`
    // forgets it — otherwise a read that never happened would suppress a
    // later one that should.
    recordObservedRead(
      ctx.db,
      input.sessionId,
      fileHash,
      start,
      end,
      fingerprint.contentHash,
      input.turn ?? 0,
      ctx.now,
    );
    return undefined;
  },
};

/**
 * **AUTO-15 · Payload guard** — attacks W3.
 *
 * A tool result does not cost once. It enters the conversation and is
 * re-sent on every subsequent round of the turn, so an oversized payload is
 * billed many times over (F6, ~9.8× amplification).
 *
 * ## Why it narrows rather than denies
 *
 * The agent asked for the file because it wants the file. Refusing leaves it
 * to guess, and it will usually ask again — spending the tokens anyway and
 * a round on top. Rewriting the call to a bounded range gives it something
 * useful and lets it ask for more if it needs more.
 *
 * Only file reads are narrowed, because only their size is knowable before
 * the call. A terminal command's output length cannot be estimated in
 * advance, and guessing would deny work on a prediction the guard cannot
 * make.
 */
export const payloadGuard: Guard = {
  id: 'payload-guard',
  automation: 'AUTO-15',
  attacks: 'W3',
  events: ['PreToolUse'],

  decide(ctx) {
    const { input } = ctx;
    if (input.toolName === undefined || !READ_TOOLS.has(input.toolName)) return undefined;

    const target = readToolTarget(input);
    if (!target) return undefined;
    // Already bounded: the agent has made the decision this guard would.
    if (target.startLine !== undefined || target.endLine !== undefined) return undefined;

    const absolute = resolveWithinRoot(ctx.root, target.rawPath);
    if (absolute === undefined) return undefined;

    const size = fileSize(absolute);
    if (size === undefined || size <= ctx.config.maxResultBytes) return undefined;

    return {
      subject: hashPath(absolute, ctx.salt),
      decision: rewrite(
        input.event,
        { ...input.toolInput, startLine: 1, endLine: ctx.config.narrowToLines },
        `This file is ${formatBytes(size)}, above the ${formatBytes(ctx.config.maxResultBytes)} cap. ` +
          `The call was narrowed to the first ${String(ctx.config.narrowToLines)} lines rather than refused. ` +
          'Request a specific range if you need more — an oversized result is re-sent on every later step of this turn.',
      ),
    };
  },
};

/**
 * **AUTO-16 · Runaway halt** — attacks W6.
 *
 * Stops a session that has run deep and produced nothing.
 *
 * ## Depth alone is not the signal
 *
 * A sixty-round refactor that lands a large change is exactly what the tool
 * is for. Depth **without output** is the failure mode, and the difference
 * is the whole design — D10's loop-cap optimiser found that capping on
 * depth alone would have cut off 68 of 70 converging loops on real data.
 *
 * So the halt requires both: past the round cap *and* no edit recorded in
 * this session. It halts once and records that it has, so a session cannot
 * be stopped repeatedly by the same condition.
 */
export const runawayHalt: Guard = {
  id: 'runaway-halt',
  automation: 'AUTO-16',
  attacks: 'W6',
  events: ['PostToolUse'],

  decide(ctx) {
    const state = getSessionState(ctx.db, ctx.input.sessionId);
    if (!state || state.halted === 1) return undefined;
    if (state.rounds < ctx.config.maxRounds) return undefined;
    if (state.edits > 0) return undefined;

    return {
      decision: halt(
        `${String(state.rounds)} tool rounds in this session with no completed edit. ` +
          'Deep loops that produce nothing are the most expensive failure mode there is, so this one has been ' +
          'stopped rather than left to continue spending. Start a fresh conversation with what you have learned, ' +
          'or narrow the task.',
      ),
    };
  },
};

/**
 * **AUTO-20 · Session-age nudge** — attacks W4. Tier C.
 *
 * The whole conversation is re-sent on every turn, so a chat gets steadily
 * more expensive the longer it stays open. This is advice, not enforcement:
 * whether the current task still needs the earlier context is a judgement
 * only the developer can make, and the message says what it costs rather
 * than telling them what to do.
 */
export const sessionAgeNudge: Guard = {
  id: 'session-age-nudge',
  automation: 'AUTO-20',
  attacks: 'W4',
  events: ['UserPromptSubmit'],

  decide(ctx) {
    const state = getSessionState(ctx.db, ctx.input.sessionId);
    if (!state) return undefined;

    const turns = state.turns;
    if (turns < ctx.config.nudgeAfterTurns) return undefined;
    // Once per further ten turns, not on every prompt.
    if ((turns - ctx.config.nudgeAfterTurns) % 10 !== 0) return undefined;

    return {
      decision: notify(
        `Turn ${String(turns)} of this conversation. Every turn re-sends the whole history, so each one now ` +
          'costs more than the last. If you have moved on to a different task, a new chat starts from nothing ' +
          'and is measurably cheaper per turn.',
      ),
    };
  },
};

/**
 * **AUTO-18 · Compaction sentinel** — attacks W9.
 *
 * Compaction is not free: it costs a model call and, in the measured
 * corpus, a median 92 seconds of waiting. Recording it is what lets W9
 * price it; the message fires only on a repeat, because the first
 * compaction in a session is ordinary and the second is a signal that the
 * conversation has outgrown the window.
 */
export const compactionSentinel: Guard = {
  id: 'compaction-sentinel',
  automation: 'AUTO-18',
  attacks: 'W9',
  events: ['PreCompact'],

  decide(ctx) {
    const state = getSessionState(ctx.db, ctx.input.sessionId);
    const priorCompactions = state?.compactions ?? 0;
    bumpSession(ctx.db, ctx.input.sessionId, 'compactions', ctx.now);
    if (priorCompactions < 1) return undefined;

    return {
      decision: notify(
        `This conversation is being summarised for the ${ordinal(priorCompactions + 1)} time. ` +
          'Each one costs a model call and roughly a minute and a half of waiting, and the summary is lossy. ' +
          'A fresh chat carrying only what matters is cheaper than compacting this one again.',
      ),
    };
  },
};

export const GUARDS: readonly Guard[] = [
  rereadSuppressor,
  payloadGuard,
  runawayHalt,
  sessionAgeNudge,
  compactionSentinel,
];

/** Automations specified for this phase that the available signals cannot support. */
export interface UnavailableGuard {
  readonly automation: string;
  readonly name: string;
  readonly reason: string;
  readonly unblockedBy: string;
}

export const UNAVAILABLE_GUARDS: readonly UnavailableGuard[] = [
  {
    automation: 'AUTO-19',
    name: 'Subagent accounting',
    reason:
      'The `SubagentStart` and `SubagentStop` events carry no cost figure, and the parent/child call graph is not ' +
      'reconstructable from the hook payload alone. Attributing spend to an isolated context would be invention.',
    unblockedBy:
      'A subagent identifier on the tool-call events, so rounds can be attributed to the agent that made them.',
  },
  {
    automation: 'AUTO-21',
    name: 'Fork suggestion',
    reason:
      'Suggesting a fork rather than a restart requires knowing which part of the conversation the current task ' +
      'depends on. Nothing in the hook payload distinguishes relevant history from stale history.',
    unblockedBy:
      'Task-boundary detection over the session transcript, which is a measurement problem, not a hook one.',
  },
];

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024).toString()} KB`;
}

function ordinal(value: number): string {
  const names = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth'];
  return names[value] ?? `${String(value)}th`;
}

export { MAX_HASH_BYTES, allow };
