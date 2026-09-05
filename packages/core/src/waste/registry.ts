import { ToolDefinitionTaxDetector } from './detectors/w1-tool-definitions.js';
import { DuplicateRetrievalDetector } from './detectors/w2-duplicate-retrieval.js';
import { OversizedPayloadDetector } from './detectors/w3-oversized-payloads.js';
import { SessionStalenessDetector } from './detectors/w4-session-staleness.js';
import { ModelOverSelectionDetector } from './detectors/w5-model-over-selection.js';
import { RunawayLoopDetector } from './detectors/w6-runaway-loops.js';
import { AbandonedWorkDetector, assessSurvivalCoverage } from './detectors/w7-abandoned-work.js';
import { CrossDeveloperDuplicationDetector } from './detectors/w8-cross-dev-duplication.js';
import { CompactionOverheadDetector } from './detectors/w9-compaction.js';
import { InstructionBloatDetector } from './detectors/w10-instruction-bloat.js';
import {
  ReferenceLeakageDetector,
  assessReferencePricing,
} from './detectors/w11-reference-leakage.js';
import { UtilityModelDriftDetector } from './detectors/w12-utility-model-drift.js';
import type { DetectContext, UnavailableClass, WasteDetector } from './types.js';

/**
 * The detectors that run today, in the plan's build order — by measured
 * value, not by ease of implementation.
 */
export const DETECTORS: readonly WasteDetector[] = [
  new ToolDefinitionTaxDetector(),
  new ModelOverSelectionDetector(),
  new SessionStalenessDetector(),
  new DuplicateRetrievalDetector(),
  new RunawayLoopDetector(),
  new OversizedPayloadDetector(),
  new CompactionOverheadDetector(),
  // D12 — the classes D3 declared undetectable, in wave order.
  new AbandonedWorkDetector(),
  new ReferenceLeakageDetector(),
  new InstructionBloatDetector(),
  new UtilityModelDriftDetector(),
  new CrossDeveloperDuplicationDetector(),
];

/**
 * Waste classes that **cannot honestly be detected** from the data available.
 *
 * These are listed, printed in the report, and given a stated blocker
 * rather than quietly omitted. The distinction between *"we looked and
 * found nothing"* and *"we cannot look"* is exactly the distinction P5
 * exists to preserve — a report that silently skipped these would imply
 * their waste is zero, which is a stronger claim than the data supports and
 * in the wrong direction.
 *
 * ## Two kinds of unavailable, separated by D12
 *
 * D3 held a single frozen list of seven. Five have since been built, and the
 * remainder split into two situations that were being reported in identical
 * language despite being nothing alike:
 *
 * - **Blocked upstream** — the journal does not record the field, and no amount
 *   of local work changes that. W13 and W14 are the whole of this list.
 * - **Conditionally unavailable** ({@link conditionallyUnavailable}) — the
 *   detector exists and works, but this run was not given the input it needs.
 *   That is a fact about the invocation rather than about the product, and
 *   saying which one it is tells the reader whether there is anything they can
 *   do about it.
 */
export const UNAVAILABLE_CLASSES: readonly UnavailableClass[] = [
  {
    class: 'W13',
    name: 'Over-provisioned reasoning',
    reason:
      'Thinking tokens are recorded, but the reasoning-effort *setting* that produced them is not. Without it, a high thinking-token count cannot be distinguished from a genuinely hard problem — and charging the second as though it were the first would penalise exactly the requests that most needed the thinking.',
    unblockedBy:
      'The effort setting recorded alongside the tokens it produced, or read from managed settings and joined by time window.',
  },
  {
    class: 'W14',
    name: 'Missing context isolation',
    reason:
      'Requires attributing cost to individual tool calls and reconstructing the parent/subagent call graph. Neither is recorded, so the counterfactual "this retrieval would have been cheaper in a subagent" has no denominator.',
    unblockedBy: 'Per-tool-call cost attribution and an explicit subagent call graph.',
  },
];

/**
 * Classes whose detector is built but whose input this particular run did not
 * supply.
 *
 * Computed from the context rather than declared, so it cannot drift: the day a
 * caller starts passing commit history, W7 leaves this list on its own and
 * appears among the findings instead. A hand-maintained list would have needed
 * somebody to remember.
 */
export function conditionallyUnavailable(ctx: DetectContext): UnavailableClass[] {
  const unavailable: UnavailableClass[] = [];

  if (ctx.git === undefined) {
    unavailable.push({
      class: 'W7',
      name: 'Abandoned work',
      reason:
        'No commit history was supplied to this run, so whether an edit survived cannot be checked. The journal records that VS Code applied an edit locally, never whether anybody kept it.',
      unblockedBy:
        'Running from inside a git working tree. The join itself needs nothing new — file paths are already hashed with the same per-install salt on both sides.',
    });
  } else {
    // History was supplied and the detector still declined. That is a
    // different statement from "there is no abandoned work", and it has to
    // read like one — with the numbers that produced it.
    const coverage = assessSurvivalCoverage(ctx);
    if (coverage !== undefined && !coverage.sufficient) {
      unavailable.push({
        class: 'W7',
        name: 'Abandoned work',
        reason: `Commit history was read, but ${coverage.reason}.`,
        unblockedBy:
          'Running against the repository the edited files actually belong to. Work spread across several repositories, or in directories none of them track, cannot be judged from one history.',
      });
    }
  }

  if (ctx.org === undefined) {
    unavailable.push({
      class: 'W8',
      name: 'The same question, asked many times',
      reason:
        'Requires comparing questions across developers, which needs organisation-wide data. One machine cannot see a question five people asked, and inferring it from one person’s repeated questions would be measuring W2 and calling it W8.',
      unblockedBy:
        'An opt-in organisation rollup (`tokenlens org sync`). Semantic near-duplicate matching stays out of core regardless — it needs an embedding model, which rule AI-3 forbids.',
    });
  }
  const references = assessReferencePricing(ctx);
  if (ctx.contentReferences.length > 0 && !references.sufficient) {
    unavailable.push({
      class: 'W11',
      name: 'Search-snippet leakage',
      reason: `${references.reason}.`,
      unblockedBy:
        'Per-reference token accounting in the journal, or a decomposed Files cost on every request that carries references. The share of unopened references is still measurable \u2014 run `tokenlens advise --explain W11` \u2014 it is the price that is not.',
    });
  }
  return unavailable;
}
