import { modelled } from '../../model/provenance.js';
import { sampleConfidence, withEffectSize } from '../scoring.js';
import { LOW_COMPLEXITY_PERCENTILE, scoreComplexity } from '../complexity.js';
import { findRate } from '../../ledger/rate-card.js';
import type { DetectContext, Evidence, WasteDetector, WasteFinding } from '../types.js';

/**
 * **W5 · Model over-selection** (F7).
 *
 * The most and least expensive models available differ by more than an
 * order of magnitude per token. Developers pick a model once and leave it,
 * because the cost difference is invisible at the moment of choosing. The
 * result is premium models doing work a cheaper one would have handled
 * identically.
 *
 * ## The honest difficulty
 *
 * Whether a cheaper model *would have sufficed* is not recorded anywhere —
 * it is a counterfactual, and this detector cannot observe it. Claiming
 * otherwise would be the single easiest place in this whole engine to
 * fabricate a confident number.
 *
 * So it does the defensible thing instead: it scores each request's
 * **observable complexity** (round count, tool calls, edits produced,
 * thinking tokens) and flags only requests that scored in the *lowest*
 * complexity band while running on a *premium-rate* model. The saving is
 * priced as the difference between what was paid and what the cheapest
 * model with a **measured** rate would have cost for the same prompt.
 *
 * Requests are only compared against models whose rate was actually
 * measured — pricing a counterfactual against another estimate would
 * compound two guesses into one confident-looking figure.
 */
export class ModelOverSelectionDetector implements WasteDetector {
  readonly class = 'W5' as const;
  readonly name = 'Over-powered model choice';

  detect(ctx: DetectContext): WasteFinding[] {
    const rateCard = ctx.ledger.rateCard;

    // Only models whose rate was genuinely measured are candidates for the
    // counterfactual — otherwise the "saving" is one estimate minus another.
    const measuredRates = rateCard.filter(
      (rate) => rate.provenance.kind === 'measured' && rate.creditsPerKPromptToken > 0,
    );
    if (measuredRates.length < 2) return [];

    const cheapest = measuredRates.reduce((min, rate) =>
      rate.creditsPerKPromptToken < min.creditsPerKPromptToken ? rate : min,
    );

    const complexityByRequest = scoreComplexity(ctx);
    const scores = [...complexityByRequest.values()].sort((a, b) => a - b);
    if (scores.length < MIN_SAMPLE) return [];

    // "Simple" means the bottom third of this corpus's own complexity
    // distribution, not an absolute threshold — what counts as a simple
    // request differs enormously between codebases.
    const simpleThreshold = scores[Math.floor(scores.length * SIMPLE_PERCENTILE)] ?? 0;

    let savableCredits = 0;
    let flagged = 0;
    const byModel = new Map<string, { requests: number; credits: number }>();

    for (const request of ctx.requests) {
      const rate = findRate(rateCard, request.model);
      if (rate?.provenance.kind !== 'measured') continue;

      const premiumMultiple = rate.creditsPerKPromptToken / cheapest.creditsPerKPromptToken;
      if (premiumMultiple < PREMIUM_MULTIPLE_THRESHOLD) continue;

      const complexity = complexityByRequest.get(request.requestId) ?? 0;
      if (complexity > simpleThreshold) continue;

      const paid = ctx.creditsByRequest.get(request.requestId) ?? 0;
      const counterfactual = (request.promptTokens / 1000) * cheapest.creditsPerKPromptToken;
      const saving = paid - counterfactual;
      if (saving <= 0) continue;

      savableCredits += saving;
      flagged += 1;
      const bucket = byModel.get(request.model) ?? { requests: 0, credits: 0 };
      bucket.requests += 1;
      bucket.credits += saving;
      byModel.set(request.model, bucket);
    }

    if (flagged === 0) return [];

    const spread =
      Math.max(...measuredRates.map((r) => r.creditsPerKPromptToken)) /
      cheapest.creditsPerKPromptToken;

    const evidence: Evidence[] = [
      {
        kind: 'model',
        ref: cheapest.model,
        detail:
          `cheapest measured rate: ${cheapest.creditsPerKPromptToken.toFixed(3)} credits per 1k prompt tokens ` +
          `— the most expensive measured model costs ${spread.toFixed(1)}× more`,
      },
      ...[...byModel.entries()]
        .sort((a, b) => b[1].credits - a[1].credits)
        .slice(0, MAX_LISTED)
        .map(([model, bucket]): Evidence => ({
          kind: 'model',
          ref: model,
          detail: `${String(bucket.requests)} low-complexity request(s) ran here rather than on ${cheapest.model}`,
          credits: bucket.credits,
        })),
    ];

    return [
      {
        class: this.class,
        title: `${String(flagged)} low-complexity request(s) ran on a premium model`,
        credits: modelled(
          savableCredits,
          `difference between credits paid and the same prompt priced at ${cheapest.model}'s measured rate`,
          [
            'assumes the cheapest model would have produced an acceptable result for these requests — this is a counterfactual and is not observable in the data',
            `counts only requests in the bottom ${String(Math.round(SIMPLE_PERCENTILE * 100))}% of this corpus's own complexity distribution`,
            'compares only against models whose rate was measured, never against another estimate',
            'complexity is scored from round count, tool calls, edits and thinking tokens — it is a proxy for difficulty, not a measurement of it',
          ],
        ),
        confidence: withEffectSize(
          sampleConfidence(flagged, 30),
          // A wide measured price spread makes the lever more credible.
          spread / 10,
        ),
        evidence,
        remediation: {
          summary: 'Simple requests are being served by expensive models',
          tier: 'A',
          action:
            `Route low-complexity work to ${cheapest.model} by default and reserve premium models ` +
            'for requests that need them. Deployed as a setting; developers can still override.',
        },
      },
    ];
  }
}

/** A model must cost at least this multiple of the cheapest measured rate to be worth flagging. */
const PREMIUM_MULTIPLE_THRESHOLD = 3;
/** Shared with `tokenlens simulate`, so the two commands cannot disagree about what "simple" means. */
const SIMPLE_PERCENTILE = LOW_COMPLEXITY_PERCENTILE;
const MIN_SAMPLE = 20;
const MAX_LISTED = 8;
