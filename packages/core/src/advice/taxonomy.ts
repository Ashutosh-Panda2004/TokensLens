import type { LeverId } from '../simulate/levers.js';
import type { WasteClass } from '../waste/types.js';

/**
 * D11 — the tag taxonomy that connects a waste class to a *kind* of fix.
 *
 * Two orthogonal axes, deliberately not one flat tag list. {@link FixMechanism}
 * says what a tool does to reduce tokens; {@link IntegrationSurface} says how it
 * reaches the agent. The second turns out to gate actionability harder than the
 * first: a mechanism that only ships as a proxy is not admissible however good
 * it is, because a proxy terminates and rewrites traffic that TokenLens spent
 * ten phases promising never to move.
 *
 * See D11-PRESCRIPTIVE-ADVICE.md §2.
 */

/** What the tool actually does to reduce tokens. */
export type FixMechanism =
  /** Returns a symbol or AST node rather than a whole file. */
  | 'symbol-scoped-retrieval'
  /** Keeps signatures and structure, drops bodies. */
  | 'structural-compression'
  /** Assembles a size-budgeted context bundle with a token count attached. */
  | 'bounded-context-packing'
  /** Reuses an *exact* prior result. */
  | 'deterministic-cache'
  /** Reuses a *similar* prior result. Needs embeddings. */
  | 'semantic-cache'
  /** Token-level compression of the prompt itself. */
  | 'prompt-compression'
  /** Fewer tool definitions sent per request. */
  | 'tool-surface-reduction'
  /** Cheap model for simple work. */
  | 'model-routing';

/**
 * How the tool reaches the agent — and therefore how much of the machine it
 * touches. Ordered loosely by blast radius.
 */
export type IntegrationSurface =
  /** One config line, reversible by deleting it. The sweet spot. */
  | 'mcp-server'
  /** Invoked manually or from a task. No runtime coupling. */
  | 'cli'
  /** Scoped to the editor, marketplace-reviewed. */
  | 'editor-extension'
  /** Requires writing code. That is a project, not a recommendation. */
  | 'library'
  /** Sits in the path of every model call. Excluded from v1 — see {@link ADMISSIBLE_SURFACES}. */
  | 'proxy';

/**
 * The surfaces a v1 entry may use.
 *
 * `proxy` and `library` are absent on purpose. A proxy sees every prompt, so
 * recommending one asks a security team to accept a man-in-the-middle over
 * exactly the data this tool refuses to move; TokenLens cannot hold a
 * zero-egress line for itself and then recommend one to its users. A library is
 * not an install, it is an engineering project, and "go write some code" is not
 * a remediation.
 */
export const ADMISSIBLE_SURFACES: readonly IntegrationSurface[] = [
  'mcp-server',
  'cli',
  'editor-extension',
];

/**
 * Who fixes a given waste class — decided once, here, rather than inferred per
 * finding.
 *
 * This is the field that stops the engine offering a code-graph MCP server to
 * somebody whose actual problem is that they have been in the same chat session
 * since Tuesday.
 */
export type FixNature =
  /** TokenLens's own tier-A/B lever fully addresses it. Never recommend a tool. */
  | 'self-fixed'
  /** The lever helps but a real gap remains. May recommend, gated on residual. */
  | 'residual-tool-fixable'
  /** The fix is a habit, not software. Emit guidance, never a tool. */
  | 'behaviour-fixable'
  /** The detector is not implemented yet. Record the mapping, emit nothing. */
  | 'dormant';

/**
 * The name of a measurable stand-in for a residual.
 *
 * A probe exists so that "there is a residual here" is a **number read off
 * recorded fields**, not an inference from the fact that the class had a
 * finding at all. Without one, every W2 finding would produce a W2
 * recommendation, including the case where the whole finding is exact repeat
 * reads — which is precisely the case the tier-B guard already denies.
 *
 * Implemented in `residual.ts`. The union is closed so that adding a
 * `residual-tool-fixable` class without a probe fails the build.
 */
export type ResidualProbeId =
  /** Share of first-reads-per-file that fetched the whole file rather than a range. */
  | 'w2-whole-file-first-reads'
  /** Share of tool results that are under the tier-B cap yet far above their tool's own norm. */
  | 'w3-sub-cap-oversize'
  /** Share of fleet spend re-answering a question another developer already asked. */
  | 'w8-cross-developer-repeats'
  /** Share of files shown to the model that it never opened. */
  | 'w11-unopened-references';

/**
 * What TokenLens's own lever already reaches for a class, and what it does not.
 *
 * The engine subtracts the first from the finding and only considers the
 * remainder. A recommendation engine that cannot say "nothing to recommend
 * here" is a marketing surface, not an engineering one.
 */
export interface ResidualModel {
  /**
   * The D4 lever that addresses this class.
   *
   * `undefined` where TokenLens has no lever at all — in which case the residual
   * is the *whole* class, because none of it is being reached. That is not a
   * loophole in the gating rule, it is the rule applied honestly to a class the
   * product cannot fix itself. The probe still has to fire, so "we have no
   * lever" never becomes "therefore recommend something".
   */
  readonly lever: LeverId | undefined;
  /** What that lever genuinely covers. Prose, because it is read by a human. */
  readonly leverReaches: string;
  /** What survives it. This is the only thing a tool may be offered against. */
  readonly residual: string;
  /**
   * The measurable stand-in for {@link residual}.
   *
   * Prose describes the residual; the probe decides whether any of it is
   * present in *this* corpus. Only the probe gates an offer.
   */
  readonly probe: ResidualProbeId;
  /** Mechanisms that plausibly address the residual. */
  readonly mechanisms: readonly FixMechanism[];
}

export interface ClassTaxonomy {
  readonly class: WasteClass;
  readonly nature: FixNature;
  /**
   * Present only when `nature === 'residual-tool-fixable'`. The type does not
   * enforce that pairing; `advice.taxonomy.test.ts` does.
   */
  readonly residual: ResidualModel | undefined;
  /** Why this class has this nature. Required — an unexplained mapping rots. */
  readonly rationale: string;
}

/**
 * The mapping for all fourteen classes.
 *
 * Note how few are tool-fixable even after D12. Of the twelve *implemented*
 * detectors, four are already fixed by a managed setting or a runtime guard,
 * four are habits, and four leave something a third-party tool could address.
 * The catalogue is sized to that reality rather than to a target entry count —
 * and because `MIN_RECOMMENDED_ENTRIES` is derived from this list, growing it
 * raises the bar the catalogue must clear rather than lowering it.
 */
export const CLASS_TAXONOMY: readonly ClassTaxonomy[] = [
  {
    class: 'W1',
    nature: 'self-fixed',
    residual: undefined,
    rationale:
      'Tier A removes unused MCP servers and extensions wholesale, via a setting the platform ' +
      'team already deploys. A third-party tool to trim the tool surface would be a second ' +
      'moving part solving a problem one line of managed configuration has already solved.',
  },
  {
    class: 'W2',
    nature: 'residual-tool-fixable',
    residual: {
      lever: 'dedupe-reads',
      leverReaches:
        'exact re-reads of an already-returned range, within one session, with no intervening edit',
      residual:
        'the first read was whole-file when a symbol would have done; re-reads across session ' +
        'boundaries; re-reads that follow an unrelated edit and so are not deniable',
      probe: 'w2-whole-file-first-reads',
      mechanisms: ['symbol-scoped-retrieval', 'deterministic-cache'],
    },
    rationale:
      'The tier-B guard can deny a repeat read. It cannot stop the agent asking for a 900-line ' +
      'file when it needed one function, because that request is not a repeat of anything.',
  },
  {
    class: 'W3',
    nature: 'residual-tool-fixable',
    residual: {
      lever: 'payload-cap',
      leverReaches: 'truncation and pagination of results above roughly 16000 characters',
      residual:
        'results comfortably under the cap that are still far larger than the question required; ' +
        'repeated whole-file reads that never trip it at all',
      probe: 'w3-sub-cap-oversize',
      mechanisms: ['structural-compression', 'bounded-context-packing', 'symbol-scoped-retrieval'],
    },
    rationale:
      'Capping an outlier is not the same as returning a smaller, better-chosen result. The cap ' +
      'bounds the worst case; the residual is the ordinary case being bigger than it needed to be.',
  },
  {
    class: 'W4',
    nature: 'behaviour-fixable',
    residual: undefined,
    rationale:
      'The fix is "start a new chat when starting a new task". That is a habit. No installable ' +
      'thing changes when a person decides a task has ended.',
  },
  {
    class: 'W5',
    nature: 'self-fixed',
    residual: undefined,
    rationale:
      'Tier A pins a default model and routes low-complexity work to it. The best-known ' +
      'open-source router for this ships only as a proxy, has never cut a release, and would ' +
      'sit in the path of every model call to solve a problem a setting already solves.',
  },
  {
    class: 'W6',
    nature: 'self-fixed',
    residual: undefined,
    rationale:
      'A loop cap is a guard, not a product. Tier B stops a non-converging loop at a measured ' +
      'round threshold; there is nothing left for a tool to do.',
  },
  {
    class: 'W7',
    nature: 'behaviour-fixable',
    residual: undefined,
    rationale:
      'D12 made this detectable by joining edits against the commit history. The fix is still not ' +
      'installable: nothing can tell in advance which work will be discarded, so the remedy is a ' +
      'shorter loop before the spend — ask for a plan on the expensive turns, then commit or ' +
      'discard deliberately.',
  },
  {
    class: 'W8',
    nature: 'residual-tool-fixable',
    residual: {
      lever: undefined,
      leverReaches:
        'nothing — TokenLens has no lever here at all, because one machine cannot deduplicate a ' +
        'question five people asked',
      residual:
        'the whole class: every answer after the first to a question the fleet had already ' +
        'answered, none of which any local setting or guard can prevent',
      probe: 'w8-cross-developer-repeats',
      mechanisms: ['semantic-cache', 'deterministic-cache'],
    },
    rationale:
      'The one class where an external tool is the right shape of answer rather than a fallback. ' +
      'Matching questions by meaning needs an embedding model, which rule AI-3 forbids in core — ' +
      'so the capability has to live outside the product or not exist.',
  },
  {
    class: 'W9',
    nature: 'behaviour-fixable',
    residual: undefined,
    rationale:
      'Compaction is the bill for W4 — the same habit, a later invoice. Keeping sessions short ' +
      'enough that summarisation never fires is a decision, not a dependency.',
  },
  {
    class: 'W10',
    nature: 'behaviour-fixable',
    residual: undefined,
    rationale:
      'D12 made the growth measurable from the System Instructions cost centre. Attributing it to ' +
      'individual rules still needs the files themselves, and deleting a rule is a judgement about ' +
      'what the team means to enforce — which is a conversation, not a dependency.',
  },
  {
    class: 'W11',
    nature: 'residual-tool-fixable',
    residual: {
      lever: undefined,
      leverReaches:
        'nothing yet — no D4 lever caps file references, so none of this class is currently reached',
      residual:
        'the whole class: files put in front of the model by search or attachment and never ' +
        'opened, which is over-broad retrieval rather than an oversized single result',
      probe: 'w11-unopened-references',
      mechanisms: ['symbol-scoped-retrieval', 'bounded-context-packing'],
    },
    rationale:
      'A reference cap would be a tier-B guard and is the obvious fix, but it bounds the symptom: ' +
      'the cause is retrieval that cannot tell which twelve files matter, which is exactly what ' +
      'symbol-scoped and budget-aware retrieval address.',
  },
  {
    class: 'W12',
    nature: 'self-fixed',
    residual: undefined,
    rationale:
      'D12 made this measurable from the model recorded against each compaction. The fix is the ' +
      'existing tier-A routing lever pointed at sub-steps: summarisation inherits the ' +
      'conversation’s model only because nothing has told it otherwise, and a setting tells it.',
  },
  {
    class: 'W13',
    nature: 'dormant',
    residual: undefined,
    rationale:
      'Over-provisioned reasoning needs the effort setting recorded next to the thinking tokens ' +
      'it produced. Without it, high thinking and a hard problem are indistinguishable.',
  },
  {
    class: 'W14',
    nature: 'dormant',
    residual: undefined,
    rationale:
      'Missing context isolation needs per-tool-call cost attribution and an explicit subagent ' +
      'call graph. Neither is recorded.',
  },
];

const BY_CLASS = new Map<WasteClass, ClassTaxonomy>(
  CLASS_TAXONOMY.map((entry) => [entry.class, entry]),
);

export function taxonomyFor(wasteClass: WasteClass): ClassTaxonomy {
  const entry = BY_CLASS.get(wasteClass);
  if (entry === undefined) {
    throw new Error(`No taxonomy entry for waste class ${wasteClass}.`);
  }
  return entry;
}

/**
 * The classes a catalogue entry is permitted to claim. Everything else is
 * either already fixed, a habit, or has no detector behind it yet.
 */
export function toolFixableClasses(): readonly WasteClass[] {
  return CLASS_TAXONOMY.filter((entry) => entry.nature === 'residual-tool-fixable').map(
    (entry) => entry.class,
  );
}

/** Classes whose fix is a habit. These get guidance and are never offered a tool. */
export function behaviourFixableClasses(): readonly WasteClass[] {
  return CLASS_TAXONOMY.filter((entry) => entry.nature === 'behaviour-fixable').map(
    (entry) => entry.class,
  );
}

/** The residual model for a class, or `undefined` when the class is not tool-fixable. */
export function residualModelFor(wasteClass: WasteClass): ResidualModel | undefined {
  return taxonomyFor(wasteClass).residual;
}

/**
 * How many tools the engine will name for a single finding.
 *
 * Two, not five. A recommendation the reader has to choose between three ways
 * is a research task handed back to them, and the point of the residual gate is
 * to have already done the narrowing. Two leaves an alternative when the first
 * does not suit the stack, and stops there.
 *
 * This constant is also the arithmetic behind the catalogue floor \u2014 see
 * `MIN_RECOMMENDED_ENTRIES` in `catalogue.ts`, which is derived from it rather
 * than asserted independently.
 */
export const MAX_CANDIDATES_PER_FINDING = 2;
