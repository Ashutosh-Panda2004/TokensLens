/**
 * **D8.7 · Power — what this fleet is capable of detecting, computed before
 * the experiment runs.**
 *
 * The single most likely way this programme fails is not a bad policy. It
 * is a good policy deployed to a fleet too small to prove it worked,
 * producing an interval that straddles zero, which is then read out as
 * *"no effect"*. The minimum detectable effect is the antidote, and it is
 * only honest if it is computed **in advance** — after the fact it becomes
 * an excuse for whatever result arrived.
 *
 * So the design step prints the MDE and compares it against what the
 * simulator promised. If the simulator says a policy saves 20% and the
 * fleet can only detect 45%, that is knowable on day zero, and the correct
 * response is to change the design — lengthen the period, randomise at team
 * level, or accept the result will be descriptive — rather than to run the
 * experiment and be disappointed.
 */

/**
 * Inverse standard-normal CDF (Acklam's rational approximation, refined by
 * one Halley step). Accurate to roughly 1e-15 across the useful range.
 *
 * Hand-rolled because the alternative is a statistics dependency for one
 * function, on a project whose whole claim is that it adds no
 * infrastructure. The refinement step needs `erfc`, which is also not in
 * the standard library, so that is approximated too.
 */
const A0 = -3.969683028665376e1;
const A1 = 2.209460984245205e2;
const A2 = -2.759285104469687e2;
const A3 = 1.38357751867269e2;
const A4 = -3.066479806614716e1;
const A5 = 2.506628277459239;

const B0 = -5.447609879822406e1;
const B1 = 1.615858368580409e2;
const B2 = -1.556989798598866e2;
const B3 = 6.680131188771972e1;
const B4 = -1.328068155288572e1;

const C0 = -7.784894002430293e-3;
const C1 = -3.223964580411365e-1;
const C2 = -2.400758277161838;
const C3 = -2.549732539343734;
const C4 = 4.374664141464968;
const C5 = 2.938163982698783;

const D0 = 7.784695709041462e-3;
const D1 = 3.224671290700398e-1;
const D2 = 2.445134137142996;
const D3 = 3.754408661907416;

const P_LOW = 0.02425;

function tail(q: number): number {
  return (
    (((((C0 * q + C1) * q + C2) * q + C3) * q + C4) * q + C5) /
    ((((D0 * q + D1) * q + D2) * q + D3) * q + 1)
  );
}

export function inverseNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) return Number.NaN;

  let x: number;
  if (p < P_LOW) {
    x = tail(Math.sqrt(-2 * Math.log(p)));
  } else if (p <= 1 - P_LOW) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((A0 * r + A1) * r + A2) * r + A3) * r + A4) * r + A5) * q) /
      (((((B0 * r + B1) * r + B2) * r + B3) * r + B4) * r + 1);
  } else {
    x = -tail(Math.sqrt(-2 * Math.log(1 - p)));
  }

  // One Halley refinement, which takes the approximation from ~1e-9 to
  // machine precision.
  const e = 0.5 * erfc(-x / Math.SQRT2) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** Complementary error function — Numerical Recipes' Chebyshev `erfcc`. */
const ERFC_COEFFICIENTS: readonly number[] = [
  -1.3026537197817094, 0.6419697923564903, 0.019476473204185836, -0.009561514786808631,
  -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
  -1.624290004647e-6, 1.30365583558e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
  5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11, 2.394038e-12, -6.886027e-12,
  8.94487e-13, 3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
];

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;

  let d = 0;
  let dd = 0;
  for (let j = ERFC_COEFFICIENTS.length - 1; j > 0; j -= 1) {
    const tmp = d;
    d = ty * d - dd + (ERFC_COEFFICIENTS[j] ?? 0);
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * ((ERFC_COEFFICIENTS[0] ?? 0) + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}

export interface PowerInputs {
  /** Standard deviation of the outcome, **observed in the pre-period**. Never assumed. */
  readonly standardDeviation: number;
  readonly treatedUnits: number;
  readonly holdoutUnits: number;
  readonly alpha?: number;
  readonly power?: number;
  /** Baseline level of the outcome, so the MDE can also be expressed as a percentage. */
  readonly baseline?: number;
}

export interface PowerVerdict {
  /** Smallest true effect this design would detect with the stated power. `undefined` when not computable. */
  readonly minimumDetectableEffect: number | undefined;
  readonly minimumDetectableRelative: number | undefined;
  readonly alpha: number;
  readonly power: number;
  readonly treatedUnits: number;
  readonly holdoutUnits: number;
  readonly detail: string;
}

export const DEFAULT_ALPHA = 0.05;
export const DEFAULT_POWER = 0.8;

/**
 * Two-sample MDE under a normal approximation:
 *
 * $$\mathrm{MDE} = (z_{1-\alpha/2} + z_{\text{power}}) \cdot \sigma \cdot \sqrt{\tfrac{1}{n_1} + \tfrac{1}{n_2}}$$
 *
 * The normal approximation is stated rather than hidden: at fewer than
 * roughly thirty units per arm it is optimistic, and the verdict says so
 * instead of quietly reporting a number that is too small.
 */
export function assessPower(inputs: PowerInputs): PowerVerdict {
  const alpha = inputs.alpha ?? DEFAULT_ALPHA;
  const power = inputs.power ?? DEFAULT_POWER;
  const { treatedUnits, holdoutUnits, standardDeviation } = inputs;

  if (treatedUnits < 1 || holdoutUnits < 1) {
    return {
      minimumDetectableEffect: undefined,
      minimumDetectableRelative: undefined,
      alpha,
      power,
      treatedUnits,
      holdoutUnits,
      detail:
        'One arm is empty, so no effect of any size is detectable. This is a design failure, not a small sample.',
    };
  }

  if (!(standardDeviation > 0)) {
    return {
      minimumDetectableEffect: undefined,
      minimumDetectableRelative: undefined,
      alpha,
      power,
      treatedUnits,
      holdoutUnits,
      detail:
        'The pre-period outcome has no observed variance, so there is nothing to compute a detectable ' +
        'effect against. Either the metric is constant or there is not yet enough history to measure it.',
    };
  }

  const z = inverseNormalCdf(1 - alpha / 2) + inverseNormalCdf(power);
  const mde = z * standardDeviation * Math.sqrt(1 / treatedUnits + 1 / holdoutUnits);
  const relative =
    inputs.baseline !== undefined && inputs.baseline !== 0
      ? Math.abs(mde / inputs.baseline)
      : undefined;

  const small = Math.min(treatedUnits, holdoutUnits) < 30;

  return {
    minimumDetectableEffect: mde,
    minimumDetectableRelative: relative,
    alpha,
    power,
    treatedUnits,
    holdoutUnits,
    detail:
      `With ${String(treatedUnits)} treated and ${String(holdoutUnits)} held out, a true effect smaller than ` +
      `${mde.toFixed(4)}${relative === undefined ? '' : ` (${(relative * 100).toFixed(1)}% of baseline)`} ` +
      `would go undetected more often than ${((1 - power) * 100).toFixed(0)}% of the time.` +
      (small
        ? ' Fewer than 30 units in an arm: this figure uses a normal approximation and is therefore optimistic. ' +
          'Treat it as a floor on what is detectable, not a promise.'
        : ''),
  };
}

/**
 * Units per arm needed to detect `effect`, given equal allocation.
 * The inverse question, asked when the answer to `assessPower` is "not
 * enough" and somebody wants to know how much more would be.
 */
export function requiredUnitsPerArm(
  effect: number,
  standardDeviation: number,
  alpha: number = DEFAULT_ALPHA,
  power: number = DEFAULT_POWER,
): number | undefined {
  if (!(effect > 0) || !(standardDeviation > 0)) return undefined;
  const z = inverseNormalCdf(1 - alpha / 2) + inverseNormalCdf(power);
  return Math.ceil((2 * (z * standardDeviation) ** 2) / effect ** 2);
}

export interface FeasibilityVerdict {
  readonly feasible: boolean;
  readonly expectedEffect: number;
  readonly minimumDetectableEffect: number | undefined;
  readonly unitsNeededPerArm: number | undefined;
  readonly detail: string;
}

/**
 * The comparison that decides whether it is worth running at all: what the
 * simulator promised, against what the fleet can see.
 */
export function assessFeasibility(
  verdict: PowerVerdict,
  expectedEffect: number,
  standardDeviation: number,
): FeasibilityVerdict {
  const mde = verdict.minimumDetectableEffect;
  if (mde === undefined) {
    return {
      feasible: false,
      expectedEffect,
      minimumDetectableEffect: undefined,
      unitsNeededPerArm: undefined,
      detail: verdict.detail,
    };
  }

  const feasible = Math.abs(expectedEffect) >= mde;
  const needed = requiredUnitsPerArm(
    Math.abs(expectedEffect),
    standardDeviation,
    verdict.alpha,
    verdict.power,
  );

  return {
    feasible,
    expectedEffect,
    minimumDetectableEffect: mde,
    unitsNeededPerArm: needed,
    detail: feasible
      ? `The simulated effect (${expectedEffect.toFixed(4)}) is larger than the smallest this design can ` +
        `detect (${mde.toFixed(4)}). If the policy works as simulated, this experiment will show it.`
      : `The simulated effect (${expectedEffect.toFixed(4)}) is smaller than the smallest this design can ` +
        `detect (${mde.toFixed(4)}). Running as-is will most likely produce an interval straddling zero, ` +
        'which will be read as "it did not work" when it in fact means "we could not tell". ' +
        (needed === undefined ? '' : `Roughly ${String(needed)} units per arm would be needed. `) +
        'Randomising at team level, or extending the observation window, is cheaper than a null result.',
  };
}
