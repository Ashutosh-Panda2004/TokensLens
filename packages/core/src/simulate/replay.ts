import type { RemediationTier } from '../waste/types.js';
import type { DetectContext } from '../waste/types.js';

/**
 * How much of a lever's theoretical effect actually materialises.
 *
 * Every simulated saving is the product of two things: an arithmetic
 * counterfactual, which this engine computes from recorded data, and an
 * adoption rate, which it cannot. Collapsing the two into one number and
 * presenting it as *the* saving is the standard way these tools mislead —
 * so the second is stated as a band and never resolved to a point
 * (DEVELOPMENT-PLAN.md D4.3).
 *
 * The band is set by **who has to cooperate**, which is the only defensible
 * basis available:
 *
 * - **A — managed setting.** Pushed centrally; nobody has to agree. It
 *   either deploys or it does not, so the band is narrow and high. It is
 *   not 1.0 at the bottom because a setting can be overridden, and on the
 *   losing settings channel it silently does nothing at all (D5.1).
 * - **B — runtime guard.** Deterministic interception, but it has to make a
 *   judgement in the moment and will sometimes be wrong in both directions.
 * - **C — nudge.** A human sees advice and chooses. Historically most of
 *   them do not, and the band says so rather than flattering the estimate.
 *
 * These are judgements, not measurements, and they are the one place in
 * this engine where that is true. Phase D8's holdout replaces them with
 * measured realisation; until then the width of the band is the honest
 * statement of how little is known.
 */
export const REALISATION: Readonly<Record<RemediationTier, { low: number; high: number }>> = {
  A: { low: 0.7, high: 1.0 },
  B: { low: 0.5, high: 0.9 },
  C: { low: 0.1, high: 0.5 },
};

/**
 * `theoretical` is the arithmetic counterfactual with perfect adoption —
 * useful as an upper bound and as the figure the determinism tests pin, but
 * never the headline.
 */
export type RealisationBand = 'theoretical' | 'low' | 'high';

export function realisationFor(tier: RemediationTier, band: RealisationBand): number {
  if (band === 'theoretical') return 1;
  return REALISATION[tier][band];
}

/** A saving as a range, because a point estimate here would be a fiction. */
export interface SavingBand {
  readonly theoretical: number;
  readonly low: number;
  readonly high: number;
}

/**
 * The counterfactual is expressed as **multipliers on what a request
 * actually cost**, never as a re-priced total.
 *
 * ## Why multipliers, and not simply re-costing the request
 *
 * The obvious implementation is to rebuild each request's cost from the
 * rate card under the new policy and subtract. It is also wrong, and wrong
 * in a way that hides: about 9% of requests carry a *measured*
 * `copilotCredits` value while the rest are rate-card estimates, and the
 * measured value never exactly equals what the rate card would have
 * predicted for the same prompt. Re-costing from scratch would therefore
 * produce a non-zero delta for a request **no policy had touched** —
 * scattered noise, some positive and some negative, that a null policy
 * would report as a saving.
 *
 * Multipliers make that impossible. An untouched request keeps a scale of
 * exactly 1, so its counterfactual is bit-identical to its baseline and its
 * contribution to the delta is exactly zero, whatever its provenance.
 * `simulate.replay.test.ts` exists to hold that property.
 */

/**
 * The mutable counterfactual state a set of levers is applied to.
 *
 * Levers compose by **multiplying into the same state**, which is what
 * makes overlap correct rather than approximated: if a payload cap has
 * already removed 20% of a request's tokens, a loop cap applied afterwards
 * operates on the 80% that remain. Two levers cannot both claim the same
 * token, because after the first one it is no longer there.
 *
 * This is why the joint replay, not the multiplicative formula from
 * PLAN.md §20.1, is the number this engine reports. The formula is an
 * approximation for when only marginal shares are known; with the actual
 * per-request data the exact answer is available, and the formula is kept
 * only as a cross-check.
 */
export class Counterfactual {
  private readonly scales = new Map<string, number>();
  private readonly touched = new Set<string>();

  constructor(
    private readonly ctx: DetectContext,
    private readonly band: RealisationBand,
  ) {}

  /**
   * Applies one lever's **net** effect on one request.
   *
   * Net is the important word, and it was a defect before it was a
   * decision. Model routing changes two things at once: the rate falls
   * because the model is cheaper, and the effort rises by the regret
   * measured for that model. Damping those two separately — the rate
   * towards 1 and the regret towards 1, each by the realisation rate —
   * produces a combined multiplier that can exceed 1 even when the lever is
   * plainly beneficial at full adoption. A 20× rate saving turned into a
   * reported *cost increase* at 70% realisation, which is arithmetic
   * nobody could defend.
   *
   * A realisation rate means "this lever lands on this fraction of the
   * work". The whole change lands or none of it does, so the whole change
   * is what gets damped.
   */
  scale(requestId: string, rawScale: number, tier: RemediationTier): void {
    if (!Number.isFinite(rawScale) || rawScale < 0) return;
    if (rawScale === 1) return;

    this.touched.add(requestId);
    const damped = damp(rawScale, realisationFor(tier, this.band));
    this.scales.set(requestId, (this.scales.get(requestId) ?? 1) * damped);
  }

  /** How many requests any lever changed. Band-independent: it counts intent, not degree. */
  get requestsAffected(): number {
    return this.touched.size;
  }

  get baselineCredits(): number {
    let total = 0;
    for (const request of this.ctx.requests) {
      total += this.ctx.creditsByRequest.get(request.requestId) ?? 0;
    }
    return total;
  }

  /**
   * Credits saved, summed per request as `baseline - counterfactual` rather
   * than as the difference of two totals. Per-request differencing is what
   * makes an untouched request contribute an exact zero instead of a
   * rounding artefact that survives into the total.
   *
   * A negative result is possible and is not clamped: a policy can make
   * things more expensive, and a simulator that could only ever find money
   * would be worthless.
   */
  get savedCredits(): number {
    let saved = 0;
    for (const request of this.ctx.requests) {
      const baseline = this.ctx.creditsByRequest.get(request.requestId) ?? 0;
      const scale = this.scales.get(request.requestId);
      if (scale === undefined) continue;
      saved += baseline - baseline * scale;
    }
    return saved;
  }
}

/**
 * Damps a raw counterfactual scale towards "no change" by the realisation
 * rate. At `r = 1` the raw scale passes through untouched; at `r = 0`
 * nothing happens at all.
 *
 * Both short-circuits are load-bearing rather than optimisations:
 * `1 - (1 - raw) * r` is not exactly `raw` in floating point even when
 * `r === 1`, and the determinism and null-policy tests both depend on the
 * identity holding exactly.
 */
function damp(raw: number, r: number): number {
  if (r === 1) return raw;
  if (raw === 1) return 1;
  return 1 - (1 - raw) * r;
}
