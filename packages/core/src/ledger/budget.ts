import type { LedgerSummary } from './ledger.js';

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
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
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

  const monthPrefix = `${String(year)}-${String(monthIndex + 1).padStart(2, '0')}`;
  const monthToDateCredits = ledger.byDay
    .filter((day) => day.day.startsWith(monthPrefix))
    .reduce((sum, day) => sum + day.credits, 0);

  const dailyRate = daysElapsedInMonth > 0 ? monthToDateCredits / daysElapsedInMonth : 0;
  const projectedMonthEndCredits = dailyRate * daysInMonth;
  const projectedOverage = Math.max(0, projectedMonthEndCredits - monthlyAllowance);

  return {
    plan,
    monthlyAllowance,
    monthToDateCredits,
    daysElapsedInMonth,
    daysInMonth,
    projectedMonthEndCredits,
    projectedOverage,
    onTrackToExceedAllowance: projectedMonthEndCredits > monthlyAllowance,
  };
}
