/**
 * **D8.9 — the savings P&L, and the gap that is never allowed to disappear.**
 *
 * ## What this is for
 *
 * D4 simulates a saving. D5 deploys the policy. Months later somebody asks
 * whether the saving happened. The overwhelmingly common answer in this
 * industry is a chart of spend before and after, which proves nothing — the
 * quarter was different for a dozen reasons.
 *
 * The realised saving here is defined against the **holdout arm**, not
 * against last month:
 *
 * $$\text{realised} = (\bar{c}_{\text{holdout}} - \bar{c}_{\text{treated}}) \times n_{\text{treated}}$$
 *
 * That is the only definition that survives a seasonal quarter, a hiring
 * round, or a big launch, because all of those hit both arms.
 *
 * ## Why the gap is a required field
 *
 * The interesting number is not the realised saving. It is the difference
 * between the realised saving and the one TokenLens promised — because that
 * difference is a measurement of TokenLens itself.
 *
 * The temptation, when the realised saving comes in under the simulation,
 * is to revise the simulation. That is why `gap` is a non-optional field
 * rather than something a renderer can choose to include: a P&L row that
 * cannot be constructed without its own error term is much harder to quietly
 * stop publishing. **An over-promising simulator is reported as a TokenLens
 * defect**, with the offending lever named, and not as an unfortunate
 * quarter.
 */

export interface PnlInput {
  /** `YYYY-MM`. */
  readonly month: string;
  /** What D4 said this policy would save, in credits, for the treated population. */
  readonly simulatedCredits: number;
  /** Mean credits per treated unit, observed. */
  readonly treatedMeanCredits: number;
  /** Mean credits per held-out unit, observed. */
  readonly holdoutMeanCredits: number;
  readonly treatedUnits: number;
  readonly holdoutUnits: number;
}

export interface PnlRow {
  readonly month: string;
  readonly simulatedCredits: number;
  readonly realisedCredits: number;
  /** realised − simulated. Negative means TokenLens over-promised. Never optional. */
  readonly gapCredits: number;
  readonly gapRatio: number | undefined;
  readonly treatedUnits: number;
  readonly holdoutUnits: number;
  readonly estimable: boolean;
  readonly detail: string;
}

export type CalibrationVerdict = 'accurate' | 'over-promised' | 'under-promised' | 'unknown';

export interface SavingsPnl {
  readonly rows: readonly PnlRow[];
  readonly simulatedCredits: number;
  readonly realisedCredits: number;
  readonly gapCredits: number;
  /** realised ÷ simulated over the whole period. */
  readonly calibration: number | undefined;
  readonly verdict: CalibrationVerdict;
  readonly defect: string | undefined;
  readonly detail: string;
}

/** Beyond this relative miss, the simulator is treated as defective rather than imprecise. */
export const CALIBRATION_TOLERANCE = 0.2;

export function buildSavingsPnl(inputs: readonly PnlInput[]): SavingsPnl {
  const rows = inputs.map(toRow);

  const estimable = rows.filter((row) => row.estimable);
  const simulated = estimable.reduce((sum, row) => sum + row.simulatedCredits, 0);
  const realised = estimable.reduce((sum, row) => sum + row.realisedCredits, 0);
  const gap = realised - simulated;
  const calibration = simulated !== 0 ? realised / simulated : undefined;

  const verdict = classify(calibration, estimable.length);
  return {
    rows,
    simulatedCredits: simulated,
    realisedCredits: realised,
    gapCredits: gap,
    calibration,
    verdict,
    defect:
      verdict === 'over-promised'
        ? `The simulator promised ${simulated.toFixed(0)} credits and ${realised.toFixed(0)} were realised — ` +
          `a shortfall of ${Math.abs(gap).toFixed(0)} (${(((calibration ?? 0) - 1) * 100).toFixed(0)}%). ` +
          'This is a TokenLens defect, not a deployment problem. Re-check the realisation bands on the ' +
          'levers that carried this policy: a lever whose adoption assumption is wrong will miss by ' +
          'exactly this shape, every month, in the same direction.'
        : undefined,
    detail: describe(verdict, calibration, estimable.length, rows.length),
  };
}

function toRow(input: PnlInput): PnlRow {
  const estimable = input.holdoutUnits > 0 && input.treatedUnits > 0;

  // No control arm means no counterfactual. Reporting the before/after
  // difference here instead would be exactly the chart this phase exists to
  // replace, so the row is rendered as unknown and contributes nothing.
  if (!estimable) {
    return {
      month: input.month,
      simulatedCredits: input.simulatedCredits,
      realisedCredits: 0,
      gapCredits: -input.simulatedCredits,
      gapRatio: undefined,
      treatedUnits: input.treatedUnits,
      holdoutUnits: input.holdoutUnits,
      estimable: false,
      detail:
        'No usable control arm this month, so the realised saving is not estimable. It is recorded as ' +
        'unknown rather than as zero, and rather than as a before/after difference.',
    };
  }

  const perUnit = input.holdoutMeanCredits - input.treatedMeanCredits;
  const realised = perUnit * input.treatedUnits;
  const gap = realised - input.simulatedCredits;

  return {
    month: input.month,
    simulatedCredits: input.simulatedCredits,
    realisedCredits: realised,
    gapCredits: gap,
    gapRatio: input.simulatedCredits !== 0 ? gap / input.simulatedCredits : undefined,
    treatedUnits: input.treatedUnits,
    holdoutUnits: input.holdoutUnits,
    estimable: true,
    detail:
      `Held-out developers spent ${input.holdoutMeanCredits.toFixed(1)} credits each; treated developers ` +
      `spent ${input.treatedMeanCredits.toFixed(1)}. The difference across ${String(input.treatedUnits)} ` +
      'treated developer(s) is the realised saving.',
  };
}

function classify(calibration: number | undefined, months: number): CalibrationVerdict {
  if (calibration === undefined || months === 0) return 'unknown';
  if (calibration < 1 - CALIBRATION_TOLERANCE) return 'over-promised';
  if (calibration > 1 + CALIBRATION_TOLERANCE) return 'under-promised';
  return 'accurate';
}

function describe(
  verdict: CalibrationVerdict,
  calibration: number | undefined,
  estimableMonths: number,
  totalMonths: number,
): string {
  const coverage =
    estimableMonths === totalMonths
      ? ''
      : ` ${String(totalMonths - estimableMonths)} of ${String(totalMonths)} month(s) had no usable control arm and are excluded.`;

  switch (verdict) {
    case 'accurate':
      return (
        `Realised saving is within ${(CALIBRATION_TOLERANCE * 100).toFixed(0)}% of simulated ` +
        `(ratio ${(calibration ?? 1).toFixed(2)}). The simulator is calibrated on this policy.${coverage}`
      );
    case 'over-promised':
      return (
        `Realised saving is ${(100 - (calibration ?? 0) * 100).toFixed(0)}% below simulated. ` +
        `Reported as a TokenLens defect.${coverage}`
      );
    case 'under-promised':
      return (
        `Realised saving exceeds simulated by ${(((calibration ?? 1) - 1) * 100).toFixed(0)}%. ` +
        'Pleasant, but still a calibration error, and it means the levers cannot be trusted to size the ' +
        `next decision either.${coverage}`
      );
    default:
      return (
        'No month had both arms populated, so no realised saving can be computed. Without a control arm ' +
        'the only available comparison is before-and-after, which cannot separate the policy from the quarter.'
      );
  }
}
