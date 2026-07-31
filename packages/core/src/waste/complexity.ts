import { groupBy } from './scoring.js';
import type { DetectContext } from './types.js';

/**
 * Observable difficulty band, expressed relative to the corpus's own
 * distribution rather than as an absolute threshold. What counts as a
 * simple request differs enormously between a codebase of shell scripts
 * and one of distributed systems, and a fixed cut-off would be wrong for at
 * least one of them.
 */
export type ComplexityBand = 'low' | 'medium' | 'high';

/**
 * Observable difficulty of each request. Deliberately crude and
 * transparent — every input is a count that can be checked, and no
 * component is weighted by anything cleverer than "more of this means
 * harder".
 *
 * ## Why this lives here rather than inside W5
 *
 * Two commands reason about model routing: `tokenlens waste` reports that
 * simple requests ran on expensive models, and `tokenlens simulate` prices
 * the policy that would fix it. If each had its own notion of "simple" they
 * could disagree about the same request, and a user comparing the two
 * outputs would be looking at two different universes. One definition, used
 * by both.
 *
 * It measures *effort expended*, not difficulty intended — those coincide
 * often enough to be useful and not always, which is why every figure
 * derived from it carries that caveat as a stated assumption.
 */
export function scoreComplexity(ctx: DetectContext): Map<string, number> {
  const roundsByRequest = groupBy(ctx.rounds, (round) => round.requestId);
  const callsByRequest = groupBy(ctx.toolCalls, (call) => call.requestId);
  const editsByRequest = groupBy(ctx.edits, (edit) => edit.requestId);

  const scores = new Map<string, number>();
  for (const request of ctx.requests) {
    const rounds = roundsByRequest.get(request.requestId) ?? [];
    const calls = callsByRequest.get(request.requestId) ?? [];
    const edits = editsByRequest.get(request.requestId) ?? [];
    const thinking = rounds.reduce((sum, r) => sum + (r.thinkingTokens ?? 0), 0);

    scores.set(
      request.requestId,
      rounds.length * 2 +
        calls.length +
        edits.reduce((sum, e) => sum + e.editCount, 0) * 3 +
        thinking / 500 +
        request.outputTokens / 500,
    );
  }
  return scores;
}

/** The bottom third of the observed complexity distribution is "low". */
export const LOW_COMPLEXITY_PERCENTILE = 0.33;
const HIGH_COMPLEXITY_PERCENTILE = 0.67;

export interface ComplexityBands {
  /** Scores at or below this are `low`. */
  readonly lowCeiling: number;
  /** Scores above this are `high`. */
  readonly mediumCeiling: number;
  readonly sampleSize: number;
}

/** Terciles of the corpus's own complexity scores. */
export function deriveComplexityBands(scores: Iterable<number>): ComplexityBands {
  const sorted = [...scores].sort((a, b) => a - b);
  return {
    lowCeiling: sorted[Math.floor(sorted.length * LOW_COMPLEXITY_PERCENTILE)] ?? 0,
    mediumCeiling: sorted[Math.floor(sorted.length * HIGH_COMPLEXITY_PERCENTILE)] ?? 0,
    sampleSize: sorted.length,
  };
}

export function bandOf(score: number, bands: ComplexityBands): ComplexityBand {
  if (score <= bands.lowCeiling) return 'low';
  if (score <= bands.mediumCeiling) return 'medium';
  return 'high';
}
