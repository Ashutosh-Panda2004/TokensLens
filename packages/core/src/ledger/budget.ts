import type { DaySpend, LedgerSummary } from './ledger.js';

export type CopilotPlan = 'business' | 'enterprise';

/**
 * Monthly included credits per seat (PLAN.md F12). Business's allowance
 * drops from 3,900 to 1,900 on 2026-09-01; this is the post-drop figure —
 * the more conservative, forward-looking number to plan against.
 */
export const MONTHLY_ALLOWANCE: Readonly<Record<CopilotPlan, number>> = {
  business: 1900,
  enterprise: 3900,
};

export interface BudgetForecast {
  readonly plan: CopilotPlan;
  readonly monthlyAllowance: number;
  readonly monthToDateCredits: number;
  readonly daysElapsedInMonth: number;
  readonly daysInMonth: number;
  /** Linear extrapolation of the month-to-date daily rate to the full month. */
  readonly projectedMonthEndCredits: number;
  readonly projectedOverage: number;
  readonly onTrackToExceedAllowance: boolean;
  /**
   * The date the current daily run-rate would exhaust the full monthly
   * allowance, projected forward from `now` (UTC, `YYYY-MM-DD`).
   * `undefined` when there is no spend yet to project from. A date at or
   * before `now` means the allowance is *already* exhausted, and by how
   * many days.
   */
  readonly hardBlockDate?: string;
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * The `DaySpend` entries that fall within `now`'s UTC calendar month.
 * Exported so callers other than `forecastBudget` itself (the dashboard's
 * view model, in particular) can derive figures — such as the measured
 * vs. modelled split of `monthToDateCredits` — using the exact same
 * month-selection rule, rather than re-deriving (and risking drifting
 * from) it independently.
 */
export function selectMonthToDateDays(ledger: LedgerSummary, now: Date = new Date()): DaySpend[] {
  const monthPrefix = `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return ledger.byDay.filter((day) => day.day.startsWith(monthPrefix));
}

/**
 * Projects month-end spend from the current month's daily run-rate,
 * linearly extrapolated — deliberately the simplest defensible model
 * (PLAN.md's own metric policy: prefer an honest, simple estimate,
 * labelled as one, over false precision).
 */
export function forecastBudget(
  ledger: LedgerSummary,
  plan: CopilotPlan,
  now: Date = new Date(),
): BudgetForecast {
  const monthlyAllowance = MONTHLY_ALLOWANCE[plan];
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const daysInMonth = daysInUtcMonth(year, monthIndex);
  const daysElapsedInMonth = now.getUTCDate();

  const monthToDateCredits = selectMonthToDateDays(ledger, now).reduce(
    (sum, day) => sum + day.credits,
    0,
  );

  const dailyRate = daysElapsedInMonth > 0 ? monthToDateCredits / daysElapsedInMonth : 0;
  const projectedMonthEndCredits = dailyRate * daysInMonth;
  const projectedOverage = Math.max(0, projectedMonthEndCredits - monthlyAllowance);
  const hardBlockDate = computeHardBlockDate(now, monthlyAllowance, monthToDateCredits, dailyRate);

  return {
    plan,
    monthlyAllowance,
    monthToDateCredits,
    daysElapsedInMonth,
    daysInMonth,
    projectedMonthEndCredits,
    projectedOverage,
    onTrackToExceedAllowance: projectedMonthEndCredits > monthlyAllowance,
    ...(hardBlockDate !== undefined ? { hardBlockDate } : {}),
  };
}

/**
 * Projects the UTC calendar date on which `dailyRate` would exhaust
 * `monthlyAllowance`, given `monthToDateCredits` already spent. Returns
 * `undefined` when there is no rate to project from (nothing spent yet).
 */
function computeHardBlockDate(
  now: Date,
  monthlyAllowance: number,
  monthToDateCredits: number,
  dailyRate: number,
): string | undefined {
  if (dailyRate <= 0) return undefined;

  const remainingAllowance = monthlyAllowance - monthToDateCredits;
  const daysUntilExhaustion = Math.ceil(remainingAllowance / dailyRate);

  const exhaustionDate = new Date(now.getTime());
  exhaustionDate.setUTCDate(exhaustionDate.getUTCDate() + daysUntilExhaustion);
  return exhaustionDate.toISOString().slice(0, 10);
}
