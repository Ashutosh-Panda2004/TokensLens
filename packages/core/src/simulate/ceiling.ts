import { MONTHLY_ALLOWANCE, type CopilotPlan } from '../ledger/budget.js';

/**
 * **The contract ceiling** (DEVELOPMENT-PLAN.md D4.8, PLAN.md §20.5).
 *
 * Copilot bills an included monthly allowance per seat and charges only for
 * what exceeds it. That has a consequence every savings model gets wrong if
 * nobody stops it: **credits saved below the allowance line are not money.**
 *
 * Above the line, a credit saved is a credit not invoiced, 1:1. Below it,
 * the credit was already paid for as part of the seat, and "saving" it just
 * means the allowance goes unused. A simulator that reports one 60%
 * reduction as though it were worth twice a 30% one is describing
 * arithmetic, not a bill.
 *
 * So the split is computed and reported explicitly. The ceiling is stated
 * whether or not the simulated policy reaches it — an executive who
 * discovers this constraint after the business case has been signed off
 * discovers it from someone else, which is the worst way for it to come
 * out.
 */
export interface ContractCeiling {
  readonly plan: CopilotPlan;
  readonly seats: number;
  /** Credits included in the contract per month across all seats. */
  readonly includedCredits: number;
  /** Baseline monthly run-rate this ceiling is measured against. */
  readonly projectedMonthlyCredits: number;
  /** Credits billed above the allowance today. This is the entire cash pool available. */
  readonly overageCredits: number;
  /**
   * The reduction that exactly eliminates the overage. Every point of
   * reduction beyond this converts to unused allowance rather than cash.
   * `undefined` when there is no overage — nothing here is billable at all.
   */
  readonly reductionThatEliminatesOverage: number | undefined;
}

export interface CeilingSplit {
  /** Reduction actually simulated, as a fraction of baseline spend. */
  readonly reduction: number;
  readonly savedCredits: number;
  /** The part that comes off an invoice. */
  readonly cashCredits: number;
  /** The part that does not: allowance that would simply go unused. */
  readonly unusedAllowanceCredits: number;
  /** True when the policy saves more than the contract can pay back. */
  readonly exceedsCeiling: boolean;
  /** Share of the maximum achievable cash saving this policy captures. */
  readonly shareOfMaxCashSaving: number;
}

export interface CeilingOptions {
  readonly plan: CopilotPlan;
  /**
   * Seats to extrapolate this machine's measured run-rate across. Defaults
   * to 1 — the only figure that is measured rather than assumed. Anything
   * above it assumes every other seat spends like this one, which is stated
   * on the output rather than buried here.
   */
  readonly seats: number;
}

export function assessCeiling(
  projectedMonthlyCreditsPerSeat: number,
  options: CeilingOptions,
): ContractCeiling {
  const seats = Math.max(1, Math.floor(options.seats));
  const includedCredits = MONTHLY_ALLOWANCE[options.plan] * seats;
  const projectedMonthlyCredits = projectedMonthlyCreditsPerSeat * seats;
  const overageCredits = Math.max(0, projectedMonthlyCredits - includedCredits);

  return {
    plan: options.plan,
    seats,
    includedCredits,
    projectedMonthlyCredits,
    overageCredits,
    reductionThatEliminatesOverage:
      projectedMonthlyCredits > 0 && overageCredits > 0
        ? overageCredits / projectedMonthlyCredits
        : undefined,
  };
}

/**
 * Splits a simulated reduction into the part that is cash and the part that
 * is not.
 *
 * `reduction` is a dimensionless fraction of baseline spend, deliberately:
 * the replay measures a corpus that may span any number of weeks, while the
 * contract is monthly. Carrying the ratio across rather than a credit total
 * is what keeps the two from being silently mixed.
 */
export function splitAtCeiling(ceiling: ContractCeiling, reduction: number): CeilingSplit {
  const savedCredits = ceiling.projectedMonthlyCredits * reduction;
  const cashCredits = Math.min(Math.max(0, savedCredits), ceiling.overageCredits);
  const unusedAllowanceCredits = Math.max(0, savedCredits - cashCredits);

  return {
    reduction,
    savedCredits,
    cashCredits,
    unusedAllowanceCredits,
    exceedsCeiling: unusedAllowanceCredits > 0,
    shareOfMaxCashSaving: ceiling.overageCredits > 0 ? cashCredits / ceiling.overageCredits : 0,
  };
}
