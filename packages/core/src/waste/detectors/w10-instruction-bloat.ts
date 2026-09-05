import { creditsForTokens, sampleConfidence, withEffectSize } from '../scoring.js';
import { formatCount, formatPercent } from '../format.js';
import type { DetectContext, Evidence, WasteDetector, WasteFinding } from '../types.js';

/**
 * **W10 · Instruction bloat** (H3) — standing instructions that grew and were
 * never trimmed.
 *
 * Every rule in a workspace instruction file, every line of a chatmode
 * preamble, is re-sent on **every single request** for as long as it exists.
 * That is the cheapest waste to create and the easiest to forget: nobody
 * deletes a rule, because deleting it costs a conversation and keeping it
 * appears to cost nothing.
 *
 * ## Why this was undetectable until now, and what is still missing
 *
 * D3 recorded the blocker as *"requires reading the standing instruction files
 * themselves and attributing cost to individual rules"*. That is the blocker
 * for the *interesting* version — "rule 14 costs you $400 a year" — and it is
 * still true. It is not the blocker for the useful version. The journal records
 * a **`System Instructions` cost centre per request**, so what a workspace's
 * standing instructions cost is already measured; only the split across rules
 * is not.
 *
 * So this detector answers the smaller, honest question: **has it grown?** It
 * charges the excess over the corpus's own early baseline, never the whole
 * figure — a large but stable instruction set may be entirely load-bearing, and
 * charging it would be a style opinion wearing a credit figure.
 *
 * ## Why growth rather than size, in one sentence
 *
 * A baseline drawn from the same corpus controls for the model, the agent mode
 * and the way this developer works, none of which this detector can see; a
 * fixed threshold would control for none of them and would be a different
 * number for every reader.
 *
 * This is the same shape as W4, which charges prompt tokens above each
 * *session's* own early-turn baseline. The unit differs because the cause does:
 * session staleness accumulates within a conversation, instruction bloat
 * accumulates across all of them.
 */
export class InstructionBloatDetector implements WasteDetector {
  readonly class = 'W10' as const;
  readonly name = 'Instruction bloat';

  detect(ctx: DetectContext): WasteFinding[] {
    const byRequest = new Map<string, number>();
    for (const centre of ctx.costCentres) {
      if (centre.label !== 'System Instructions') continue;
      byRequest.set(centre.requestId, (byRequest.get(centre.requestId) ?? 0) + centre.tokens);
    }

    // Chronological, because the whole question is whether the figure moved.
    const series = ctx.requests
      .map((request) => ({
        requestId: request.requestId,
        tokens: byRequest.get(request.requestId),
      }))
      .filter(
        (point): point is { requestId: string; tokens: number } => point.tokens !== undefined,
      );

    if (series.length < MIN_REQUESTS) return [];

    const baselineSize = Math.max(MIN_BASELINE, Math.floor(series.length * BASELINE_SHARE));
    const baseline = median(series.slice(0, baselineSize).map((point) => point.tokens));
    if (baseline <= 0) return [];

    const later = series.slice(baselineSize);
    if (later.length < MIN_BASELINE) return [];

    const current = median(later.map((point) => point.tokens));
    const growth = (current - baseline) / baseline;
    if (growth < MIN_GROWTH) return [];

    // Only the excess, and only where a request is actually above the
    // baseline: a request below it must not net off against one above, or a
    // noisy series would price as if nothing had happened.
    const excessTokens = later.reduce(
      (sum, point) => sum + Math.max(0, point.tokens - baseline),
      0,
    );
    const requestsAbove = later.filter((point) => point.tokens > baseline).length;

    const evidence: Evidence[] = [
      {
        kind: 'request',
        ref: 'BASELINE',
        detail:
          `the first ${formatCount(baselineSize)} requests carried a median of ` +
          `${formatCount(baseline)} system-instruction tokens each`,
      },
      {
        kind: 'request',
        ref: 'CURRENT',
        detail:
          `the remaining ${formatCount(later.length)} carried a median of ${formatCount(current)} ` +
          `\u2014 a ${formatPercent(growth)} increase, re-sent on every request`,
      },
      {
        kind: 'request',
        ref: 'ALL',
        detail:
          `${formatCount(requestsAbove)} request(s) sat above the baseline, for ` +
          `${formatCount(excessTokens)} tokens above it in total`,
      },
    ];

    return [
      {
        class: this.class,
        title: `Standing instructions grew ${formatPercent(growth)} and are re-sent every request`,
        credits: creditsForTokens(
          excessTokens,
          ctx,
          'measured System Instructions tokens above this corpus\u2019s own early-window median, summed over the requests that exceeded it',
          [
            'charges only the growth, never the whole instruction set \u2014 a large but stable set may be entirely load-bearing, and charging it would be a style opinion wearing a credit figure',
            'the baseline is drawn from this same corpus, which controls for model and agent mode but assumes the early window was itself reasonable',
            'cannot attribute cost to individual rules \u2014 that needs the instruction files themselves, which this tool does not read',
            'a deliberate, useful addition to the instructions is indistinguishable here from an accumulated one',
          ],
        ),
        confidence: withEffectSize(
          sampleConfidence(series.length, 200),
          // Doubling is unambiguous; 100% growth saturates.
          growth / 1.0,
        ),
        evidence,
        remediation: {
          summary: `System instructions are ${formatPercent(growth)} larger than they were`,
          tier: 'C',
          action:
            'Read the workspace instruction files and delete what no longer applies. Every rule ' +
            'is billed on every request forever, so a rule that is merely nice to have is the ' +
            'most expensive kind of documentation there is.',
        },
      },
    ];
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Below this, a "baseline" and a "current" would be the same handful of requests. */
const MIN_REQUESTS = 60;
const MIN_BASELINE = 20;
const BASELINE_SHARE = 0.25;
/** Instruction sets wobble with agent mode. This is where wobble becomes growth. */
const MIN_GROWTH = 0.15;
