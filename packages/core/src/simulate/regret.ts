import { groupBy } from '../waste/scoring.js';
import { bandOf, type ComplexityBand, type ComplexityBands } from '../waste/complexity.js';
import type { DetectContext } from '../waste/types.js';

/**
 * **Measured regret** (DEVELOPMENT-PLAN.md D4.4).
 *
 * A routing simulator that only counts the price difference is telling half
 * the story. Moving work to a cheaper model is only a saving if the cheaper
 * model *finishes the work*. If it needs more attempts, the extra rounds
 * eat into — or exceed — the rate saving, and the reported number is
 * fiction.
 *
 * ## What is actually measurable here
 *
 * Whether a given request would have succeeded on another model is a
 * counterfactual and is not recorded. But something adjacent **is**
 * recorded: how many rounds each model actually needed on work of
 * comparable observable complexity. If low-complexity requests on the cheap
 * model historically took 30% more rounds than low-complexity requests on
 * the premium one, that 30% is a measurement, from this corpus, of the
 * price of routing there.
 *
 * It is a proxy: round count is effort, not quality, and a model that gives
 * up early looks *cheap* by this metric rather than worse. It is still a
 * great deal better than the usual alternative, which is to assume zero
 * regret because zero is easy to compute.
 *
 * ## When it cannot be measured
 *
 * If the target model has too few requests in the relevant complexity band,
 * there is nothing to compare and the regret is **unknown**, not zero. The
 * distinction matters: assuming zero would quietly inflate every routing
 * saving by exactly the amount nobody checked. Unknown regret is reported
 * as a warning on the finding instead.
 */
export interface Regret {
  readonly targetModel: string;
  readonly band: ComplexityBand;
  /**
   * Extra rounds the target model needed, as a ratio (0.3 = 30% more).
   * `undefined` when the corpus cannot support the comparison.
   */
  readonly extraRoundsRatio: number | undefined;
  readonly targetSampleSize: number;
  readonly originSampleSize: number;
  readonly reason: string;
}

/** Below this many requests on the target model in the band, no comparison is attempted. */
const MIN_SAMPLE = 10;

/**
 * Compares mean rounds-per-request between the model a routing rule targets
 * and the models it would route away from, restricted to one complexity
 * band so that the comparison is not confounded by the target model simply
 * having been used for easier work.
 */
export function measureRegret(
  ctx: DetectContext,
  targetModel: string,
  band: ComplexityBand,
  bands: ComplexityBands,
  complexityByRequest: ReadonlyMap<string, number>,
): Regret {
  const roundsByRequest = groupBy(ctx.rounds, (round) => round.requestId);

  const inBand = ctx.requests.filter(
    (request) => bandOf(complexityByRequest.get(request.requestId) ?? 0, bands) === band,
  );
  const onTarget = inBand.filter((request) => request.model === targetModel);
  const onOthers = inBand.filter((request) => request.model !== targetModel);

  const base = {
    targetModel,
    band,
    targetSampleSize: onTarget.length,
    originSampleSize: onOthers.length,
  };

  if (onTarget.length < MIN_SAMPLE || onOthers.length < MIN_SAMPLE) {
    return {
      ...base,
      extraRoundsRatio: undefined,
      reason:
        `Only ${String(onTarget.length)} ${band}-complexity request(s) ran on ${targetModel} in this corpus ` +
        `(${String(onOthers.length)} on other models). Below ${String(MIN_SAMPLE)} on each side the comparison ` +
        'would be noise, so regret is reported as unknown rather than assumed to be zero.',
    };
  }

  const meanRounds = (requests: readonly { requestId: string }[]): number =>
    requests.reduce((sum, r) => sum + (roundsByRequest.get(r.requestId)?.length ?? 0), 0) /
    requests.length;

  const targetMean = meanRounds(onTarget);
  const originMean = meanRounds(onOthers);

  if (originMean <= 0) {
    return {
      ...base,
      extraRoundsRatio: undefined,
      reason: `No ${band}-complexity request on the origin models recorded any tool-call round, so there is no baseline to compare against.`,
    };
  }

  // Clamped at zero on purpose. A cheaper model appearing to need *fewer*
  // rounds is more likely a selection effect than a real advantage, and
  // banking it would let the simulator find money in the noise.
  const ratio = Math.max(0, targetMean / originMean - 1);

  return {
    ...base,
    extraRoundsRatio: ratio,
    reason:
      `${targetModel} averaged ${targetMean.toFixed(1)} round(s) on ${band}-complexity work against ` +
      `${originMean.toFixed(1)} for the models it would replace` +
      (ratio > 0
        ? ` — ${(ratio * 100).toFixed(0)}% more effort, netted off the saving.`
        : ' — no measured penalty, and none is credited either way.'),
  };
}
