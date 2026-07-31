import type Database from 'better-sqlite3';
import { hashPath } from '../ingest/redact.js';
import { resolveWithinRoot } from './fingerprint.js';
import { GUARDS, DEFAULT_GUARD_CONFIG, type Guard, type GuardConfig } from './guards.js';
import {
  bumpRule,
  bumpSession,
  countDenials,
  disableRule,
  forgetObservedRead,
  getRuleHealth,
  logDecision,
  markSessionHalted,
} from './state.js';
import { allow, readToolTarget, type HookDecision, type HookInput } from './protocol.js';

/**
 * Running the guards, and the two rules that matter more than any of them.
 *
 * ## H-2 · never crash the agent
 *
 * A hook that throws, hangs, or writes malformed JSON does not degrade the
 * agent, it breaks it — and it breaks it in a way the developer will
 * attribute to Copilot rather than to us. So every failure path here ends in
 * a well-formed allow: failures inside a guard, failures opening the state
 * store, and failures nobody anticipated.
 *
 * This inverts the discipline used everywhere else in this codebase, where
 * the rule is *degrade loudly, never silently*. The inversion is deliberate
 * and scoped to exactly this file. A report that quietly returns a wrong
 * number is a lie; a guard that quietly declines to intervene has merely
 * done nothing. Doing nothing is always safe here and never safe there.
 *
 * ## D6.10 · a rule that is wrong too often turns itself off
 *
 * Risk A4. A guard producing false positives will be disabled by the
 * developer — and they will disable *all* of them, because from the outside
 * there is one hook. A rule that notices it is misfiring and stands down
 * keeps the others alive.
 */
export interface DispatchOptions {
  readonly db: Database.Database;
  readonly salt: string;
  readonly root: string;
  readonly now?: number;
  readonly config?: GuardConfig;
  readonly guards?: readonly Guard[];
}

/** A rule is stood down once this share of its interventions has been overridden. */
export const FALSE_POSITIVE_THRESHOLD = 0.05;
/** Below this many interventions the ratio is noise, not evidence. */
const MIN_INTERVENTIONS = 20;

/**
 * How many times a guard may refuse the same thing before it yields.
 *
 * ## Why insistence is the false-positive signal
 *
 * The obvious signal — "the tool call failed after we denied it" — is
 * unusable, and dangerously so: a denial may itself surface to the agent as
 * a tool error, which would make every *correct* denial look like a mistake
 * and stand the guard down within minutes of installing it.
 *
 * What is unambiguous is the agent asking for **the same thing again**. If a
 * read is suppressed as redundant and the agent comes back for exactly that
 * range a third time, the suppression is not working, whatever the hashes
 * say.
 *
 * Yielding matters as much as counting. A guard that refuses the same
 * request indefinitely turns a small waste into a stuck agent, which costs
 * far more than the tokens it was protecting.
 */
const INSIST_THRESHOLD = 2;
/** Insistence only counts within one working window. */
const INSIST_WINDOW_MS = 10 * 60 * 1000;

export function dispatch(input: HookInput, options: DispatchOptions): HookDecision {
  const now = options.now ?? Date.now();
  const config = options.config ?? DEFAULT_GUARD_CONFIG;
  const guards = options.guards ?? GUARDS;

  try {
    updateCounters(input, options, now);

    for (const guard of guards) {
      if (!guard.events.includes(input.event)) continue;
      if (isDisabled(options.db, guard.id)) continue;

      let outcome;
      try {
        outcome = guard.decide({
          input,
          db: options.db,
          salt: options.salt,
          root: options.root,
          now,
          config,
        });
      } catch {
        // One guard failing must not lose the others, and must never reach
        // the agent as an error.
        continue;
      }
      if (!outcome) continue;

      const kind = decisionKind(outcome.decision);

      if (outcome.subject !== undefined && kind === 'deny') {
        const refusals = countDenials(
          options.db,
          input.sessionId,
          guard.id,
          outcome.subject,
          now - INSIST_WINDOW_MS,
        );

        if (refusals >= INSIST_THRESHOLD) {
          yieldToAgent(options.db, guard, input, outcome.subject, refusals, now);
          return allow();
        }
      }

      record(options.db, guard, input, outcome.decision, outcome.subject, kind, now);
      return outcome.decision;
    }
  } catch {
    return allow();
  }

  return allow();
}

/** The agent has asked for this repeatedly. It wins, and the guard records the miss. */
function yieldToAgent(
  db: Database.Database,
  guard: Guard,
  input: HookInput,
  subject: string,
  refusals: number,
  now: number,
): void {
  bumpRule(db, guard.id, 'reversals');
  considerDisabling(db, guard.id, now);
  logDecision(db, {
    ts: now,
    sessionId: input.sessionId,
    rule: guard.id,
    event: input.event,
    decision: 'yielded',
    ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
    subject,
    evidence:
      `Refused ${String(refusals)} time(s) already, and the agent asked again. It needs this whatever the ` +
      'guard believes, so it was allowed through and the refusal counted against the rule.',
  });
}

/**
 * Session counters, updated before any guard runs so every guard sees the
 * same state for this event.
 */
function updateCounters(input: HookInput, options: DispatchOptions, now: number): void {
  const { db } = options;

  switch (input.event) {
    case 'SessionStart':
      bumpSession(db, input.sessionId, 'turns', now, 0);
      break;
    case 'UserPromptSubmit':
      bumpSession(db, input.sessionId, 'turns', now);
      break;
    case 'PostToolUse': {
      bumpSession(db, input.sessionId, 'rounds', now);
      if (isEditTool(input.toolName) && input.toolError !== true) {
        bumpSession(db, input.sessionId, 'edits', now);
      }
      // A read recorded on the way in but which then failed must not
      // suppress the retry that should follow it.
      if (input.toolError === true) forgetFailedRead(input, options);
      break;
    }
    default:
      break;
  }
}

const EDIT_TOOLS = new Set([
  'create_file',
  'replace_string_in_file',
  'multi_replace_string_in_file',
  'apply_patch',
  'edit_notebook_file',
  'insert_edit_into_file',
]);

function isEditTool(toolName: string | undefined): boolean {
  return toolName !== undefined && EDIT_TOOLS.has(toolName);
}

function forgetFailedRead(input: HookInput, options: DispatchOptions): void {
  const target = readToolTarget(input);
  if (!target) return;
  const absolute = resolveWithinRoot(options.root, target.rawPath);
  if (absolute === undefined) return;
  forgetObservedRead(options.db, input.sessionId, hashPath(absolute, options.salt));
}

function considerDisabling(db: Database.Database, rule: string, now: number): void {
  const health = getRuleHealth(db, rule);
  if (health?.disabledAt !== null) return;
  if (health.interventions < MIN_INTERVENTIONS) return;

  const rate = health.reversals / health.interventions;
  if (rate < FALSE_POSITIVE_THRESHOLD) return;

  disableRule(
    db,
    rule,
    `${String(health.reversals)} of ${String(health.interventions)} interventions were overridden ` +
      `(${(rate * 100).toFixed(1)}%, threshold ${(FALSE_POSITIVE_THRESHOLD * 100).toFixed(0)}%). ` +
      'The rule stood itself down rather than have the developer disable every guard at once. ' +
      `Re-enable with \`tokenlens hook enable ${rule}\` once the cause is understood.`,
    now,
  );
}

export function isDisabled(db: Database.Database, rule: string): boolean {
  const health = getRuleHealth(db, rule);
  return health !== undefined && health.disabledAt !== null;
}

function record(
  db: Database.Database,
  guard: Guard,
  input: HookInput,
  decision: HookDecision,
  subject: string | undefined,
  kind: DecisionKind,
  now: number,
): void {
  // Advisory messages are logged but do not count as interventions: a nudge
  // the developer ignores is not a false positive, it is a nudge.
  if (kind === 'deny' || kind === 'halt' || kind === 'rewrite') {
    bumpRule(db, guard.id, 'interventions');
  }
  if (kind === 'halt') markSessionHalted(db, input.sessionId, now);

  logDecision(db, {
    ts: now,
    sessionId: input.sessionId,
    rule: guard.id,
    event: input.event,
    decision: kind,
    ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
    ...(subject !== undefined ? { subject } : {}),
    evidence:
      decision.stopReason ??
      decision.hookSpecificOutput?.permissionDecisionReason ??
      decision.systemMessage ??
      '',
  });
}

export type DecisionKind = 'allow' | 'deny' | 'rewrite' | 'halt' | 'notify';

export function decisionKind(decision: HookDecision): DecisionKind {
  if (!decision.continue) return 'halt';
  const specific = decision.hookSpecificOutput;
  if (specific?.permissionDecision === 'deny') return 'deny';
  if (specific?.updatedInput !== undefined) return 'rewrite';
  if (decision.systemMessage !== undefined) return 'notify';
  return 'allow';
}
