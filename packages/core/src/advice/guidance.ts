import { CLASS_TAXONOMY } from './taxonomy.js';
import type { FixMechanism } from './taxonomy.js';
import type { WasteClass } from '../waste/types.js';

/**
 * D11 — what the engine says when it will not name a tool.
 *
 * ## Why this file is not a consolation prize
 *
 * Two of the design's own rules guarantee that *most* runs produce no tool name
 * at all. Behaviour-fixable classes never get one by construction, and while the
 * catalogue sits below its floor nothing is offered for any class. A feature
 * that answers with silence in both of those cases would be a feature that is
 * usually silent.
 *
 * So the fallback is a real answer rather than an absence. Two kinds:
 *
 * - **Mechanism guidance** describes the *shape* of the fix for a residual —
 *   "what would help here is retrieval scoped to a symbol" — without naming
 *   anything to install. It is useful on its own, it is exactly what a
 *   competent engineer would want before being handed a dependency, and
 *   critically it is **not gated on the catalogue**: no sign-off, no staleness,
 *   nothing to rot. A mechanism does not go out of date the way a repository
 *   does.
 * - **Behaviour guidance** covers the classes where the fix is a habit. It also
 *   states how the reader would *know it worked*, because advice with no
 *   observable consequence is indistinguishable from advice nobody took.
 *
 * See D11-PRESCRIPTIVE-ADVICE.md §2.2 and §7.
 */

export interface MechanismGuidance {
  /** One line, imperative, no tool named. */
  readonly headline: string;
  /** What adopting this mechanism changes about what reaches the model. */
  readonly whatItDoes: string;
  /** The observable that should move if it worked. Keeps the advice falsifiable. */
  readonly howYouWouldKnow: string;
}

/**
 * Guidance for every mechanism in the taxonomy — including the ones no
 * admissible entry currently implements.
 *
 * Complete rather than partial on purpose. `semantic-cache` and `model-routing`
 * have no offerable entry behind them and may never have one, but the reader
 * whose finding points that way still deserves to be told what would help.
 * Withholding the explanation because the shop has nothing to sell would be the
 * catalogue driving the advice, which is precisely backwards.
 */
export const MECHANISM_GUIDANCE: Readonly<Record<FixMechanism, MechanismGuidance>> = {
  'symbol-scoped-retrieval': {
    headline: 'Ask for the symbol, not the file.',
    whatItDoes:
      'Retrieval that resolves a definition or reference through a language server or syntax ' +
      'tree returns the twenty lines that answer the question instead of the nine hundred ' +
      'that contain them. The saving is on the first read, which is the one no cache can help.',
    howYouWouldKnow:
      'the share of first reads that fetch a whole file falls, while the number of reads ' +
      'stays roughly flat — fewer characters per question, not fewer questions',
  },
  'structural-compression': {
    headline: 'Send the shape of the code, not every line of it.',
    whatItDoes:
      'Keeping signatures, types and structure while dropping function bodies preserves almost ' +
      'everything an agent needs to navigate, at a fraction of the tokens. Bodies can be ' +
      'fetched for the one function that turns out to matter.',
    howYouWouldKnow:
      'median result size per tool falls without the number of tool calls rising to compensate',
  },
  'bounded-context-packing': {
    headline: 'Choose the size of the context instead of discovering it.',
    whatItDoes:
      'Assembling a bundle against an explicit token budget makes the size of the ask a ' +
      'decision. Today it is an outcome — whatever the files happened to weigh.',
    howYouWouldKnow:
      'the spread of prompt sizes narrows; the expensive tail is what a budget removes',
  },
  'deterministic-cache': {
    headline: 'Return the earlier answer rather than fetching it again.',
    whatItDoes:
      'An exact-match cache over retrieval results replaces a repeat fetch with a pointer. ' +
      'TokenLens\u2019s own tier-B guard already does this within a session; the gap is across ' +
      'sessions, where it has no memory.',
    howYouWouldKnow:
      'repeat reads of unchanged content fall while first reads do not — if both fall, ' +
      'the cause is less work, not better retrieval',
  },
  'semantic-cache': {
    headline: 'Recognise the question that has already been answered.',
    whatItDoes:
      'Matching a new prompt against previous ones by meaning rather than by exact text lets a ' +
      'near-duplicate reuse an earlier answer. It needs an embedding model, which is why ' +
      'TokenLens will not do it in core.',
    howYouWouldKnow:
      'at the team level, the count of near-identical questions answered from scratch falls',
  },
  'prompt-compression': {
    headline: 'Shorten the prompt before it is sent.',
    whatItDoes:
      'Token-level compression drops what a small model judges non-essential. It treats the ' +
      'symptom rather than the cause: a prompt is usually long because a session was never ' +
      'ended, and compressing it leaves that intact.',
    howYouWouldKnow:
      'prompt tokens per request fall while the number of turns per session does not — if ' +
      'both fall, ending sessions earlier was the fix, and it was free',
  },
  'tool-surface-reduction': {
    headline: 'Send fewer tool definitions.',
    whatItDoes:
      'Every enabled integration is described on every request whether or not it is used. ' +
      'Removing the unused ones is a managed setting, which is why TokenLens emits it directly ' +
      'rather than recommending something to install.',
    howYouWouldKnow: 'the tool-definition share of prompt tokens falls on the very next request',
  },
  'model-routing': {
    headline: 'Send simple work to a cheaper model.',
    whatItDoes:
      'Routing by observed complexity keeps the expensive model for the requests that need it. ' +
      'This is a setting your platform team can deploy, not a dependency worth adding.',
    howYouWouldKnow: 'credits per request fall while rounds per request stay flat',
  },
};

export interface BehaviourGuidance {
  readonly class: WasteClass;
  readonly headline: string;
  readonly why: string;
  readonly howYouWouldKnow: string;
}

/**
 * The habit-shaped fixes.
 *
 * Kept deliberately short and free of hedging. These cost nothing, need no
 * approval and no install, and dressing them up as a programme would obscure
 * that they are the cheapest interventions in the entire product.
 */
export const BEHAVIOUR_GUIDANCE: readonly BehaviourGuidance[] = [
  {
    class: 'W4',
    headline: 'Start a new chat when you start a new task.',
    why:
      'Everything already said in a session is re-sent on every later turn, so an old ' +
      'conversation is charged again on each new question put to it. Nothing installable ' +
      'changes when a person decides a task has ended.',
    howYouWouldKnow:
      'the longest session in a week gets shorter, and prompt tokens per turn stop climbing',
  },
  {
    class: 'W9',
    headline: 'End sessions before the assistant has to summarise them.',
    why:
      'Compaction is the bill for W4 arriving later. When a conversation outgrows the window it ' +
      'is summarised, which costs tokens and time and quietly loses detail you were relying on.',
    howYouWouldKnow:
      'compaction events per week fall to zero, and the waiting they caused goes with them',
  },
];

const BEHAVIOUR_BY_CLASS = new Map<WasteClass, BehaviourGuidance>(
  BEHAVIOUR_GUIDANCE.map((entry) => [entry.class, entry]),
);

export function behaviourGuidanceFor(wasteClass: WasteClass): BehaviourGuidance | undefined {
  return BEHAVIOUR_BY_CLASS.get(wasteClass);
}

/**
 * The mechanisms worth describing for a class, in taxonomy order.
 *
 * Empty for anything that is not `residual-tool-fixable`: describing
 * `tool-surface-reduction` to somebody whose W1 is already handled by a managed
 * setting would be advice to solve a solved problem.
 */
export function mechanismsFor(wasteClass: WasteClass): readonly FixMechanism[] {
  return CLASS_TAXONOMY.find((entry) => entry.class === wasteClass)?.residual?.mechanisms ?? [];
}
