import { modelled, type Modelled } from '../model/provenance.js';
import { estimateTokensFromChars } from '../ingest/tool-results.js';
import type { DetectContext } from './types.js';

/**
 * Confidence that rises with the amount of evidence and never reaches 1.
 *
 * `n / (n + halfPoint)` is deliberately boring: it is monotonic, bounded,
 * and — the part that matters — it **varies**, which is the property
 * `detector.variance.test.ts` exists to enforce. A detector that hardcodes
 * `confidence: 0.8` is asserting the same certainty from one observation as
 * from ten thousand, which is the exact defect (D-03) that test was written
 * to catch.
 *
 * `halfPoint` is the sample size at which we are half-confident. Detectors
 * with cheap, unambiguous signals (a tool was invoked or it was not) use a
 * low half-point; detectors reasoning about intent use a high one.
 */
export function sampleConfidence(n: number, halfPoint = 20): number {
  if (n <= 0) return 0;
  return n / (n + halfPoint);
}

/**
 * Scales a confidence by how pronounced the effect is, so that a large
 * sample of *marginal* cases does not read as confidently as a large sample
 * of blatant ones.
 */
export function withEffectSize(confidence: number, effect: number): number {
  return clamp01(confidence * clamp01(effect));
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * The ledger's own blended credits-per-1k-prompt-token, used to price
 * token-denominated waste in credits.
 *
 * Every figure derived through this is `Modelled` twice over — once because
 * the rate is an average across models, and once because the token count
 * behind it is itself estimated from a character length. Both assumptions
 * are stated on the returned value rather than left implicit.
 */
export function creditsPerToken(ctx: DetectContext): number {
  const totalPromptTokens = ctx.requests.reduce((sum, r) => sum + r.promptTokens, 0);
  if (totalPromptTokens <= 0) return 0;
  return ctx.ledger.totalCredits / totalPromptTokens;
}

/** Prices a token count in credits, tagged `Modelled` with its assumptions stated. */
export function creditsForTokens(
  tokens: number,
  ctx: DetectContext,
  basis: string,
  extraAssumptions: readonly string[] = [],
): Modelled<number> {
  return modelled(tokens * creditsPerToken(ctx), basis, [
    'priced at the blended credits-per-prompt-token rate across all observed models',
    ...extraAssumptions,
  ]);
}

/** Prices a measured character length in credits. Both conversions are estimates; both are stated. */
export function creditsForChars(
  chars: number,
  ctx: DetectContext,
  basis: string,
  extraAssumptions: readonly string[] = [],
): Modelled<number> {
  return creditsForTokens(estimateTokensFromChars(chars), ctx, basis, [
    'token count estimated from a measured character length at ~4 characters per token',
    ...extraAssumptions,
  ]);
}

/** Groups an iterable by a key, preserving insertion order. */
export function groupBy<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** The value at `q` (0..1) of a sorted-ascending numeric array. */
export function quantile(sortedAscending: readonly number[], q: number): number {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.ceil(q * sortedAscending.length) - 1),
  );
  return sortedAscending[index] ?? 0;
}
