import { ToolDefinitionTaxDetector } from './detectors/w1-tool-definitions.js';
import { DuplicateRetrievalDetector } from './detectors/w2-duplicate-retrieval.js';
import { OversizedPayloadDetector } from './detectors/w3-oversized-payloads.js';
import { SessionStalenessDetector } from './detectors/w4-session-staleness.js';
import { ModelOverSelectionDetector } from './detectors/w5-model-over-selection.js';
import { RunawayLoopDetector } from './detectors/w6-runaway-loops.js';
import { CompactionOverheadDetector } from './detectors/w9-compaction.js';
import type { UnavailableClass, WasteDetector } from './types.js';

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
];

/**
 * Waste classes that are specified but **cannot honestly be detected** from
 * the data available today.
 *
 * These are listed, printed in the report, and given a stated blocker
 * rather than quietly omitted. The distinction between *"we looked and
 * found nothing"* and *"we cannot look"* is exactly the distinction P5
 * exists to preserve — a report that silently skipped these would imply
 * their waste is zero, which is a stronger claim than the data supports and
 * in the wrong direction.
 */
export const UNAVAILABLE_CLASSES: readonly UnavailableClass[] = [
  {
    class: 'W7',
    name: 'Abandoned work',
    reason:
      'Requires knowing whether an edit survived to the current git HEAD. The journal records that VS Code applied an edit locally, not whether it was kept.',
    unblockedBy:
      'Joining edit file hashes against git history — a data source outside the journal.',
  },
  {
    class: 'W8',
    name: 'The same question, asked many times',
    reason:
      'Requires comparing prompts across developers, which needs organisation-wide data. A single machine cannot see it.',
    unblockedBy: 'Opt-in organisation rollup with semantic near-duplicate detection (phase D9).',
  },
  {
    class: 'W10',
    name: 'Instruction bloat',
    reason:
      'Requires reading the standing instruction files themselves and attributing cost to individual rules.',
    unblockedBy: 'Reading the workspace instruction files alongside the journal.',
  },
  {
    class: 'W11',
    name: 'Search-snippet leakage',
    reason:
      'File references shown to the model are recorded, but the token cost of each preview is not, so the leaked amount cannot be priced.',
    unblockedBy:
      'Per-reference token accounting in the journal, or estimating from the referenced file itself.',
  },
  {
    class: 'W12',
    name: 'Premium models on trivial work',
    reason:
      'Only the model that handled compaction is recorded per sub-step. Titles, summaries and commit messages are not attributed to a model.',
    unblockedBy: 'Per-sub-step model attribution in the journal.',
  },
  {
    class: 'W13',
    name: 'Over-provisioned reasoning',
    reason:
      'Thinking tokens are recorded, but the reasoning-effort *setting* that produced them is not. Without it, high thinking-token counts cannot be distinguished from a genuinely hard problem.',
    unblockedBy: 'The effort setting being recorded alongside the tokens it produced.',
  },
  {
    class: 'W14',
    name: 'Missing context isolation',
    reason:
      'Requires attributing cost to individual tool calls and reconstructing the parent/subagent call graph. Neither is recorded.',
    unblockedBy: 'Per-tool-call cost attribution and an explicit subagent call graph.',
  },
];
