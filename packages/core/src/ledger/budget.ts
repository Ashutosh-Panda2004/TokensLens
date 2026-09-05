import type { DaySpend, LedgerSummary } from './ledger.js';
import { ConfigError } from '../shared/errors.js';

/**
 * The plans with a **published** credit allowance.
 *
 * Copilot Free and Copilot Student are deliberately absent: both include
 * "an allowance of AI credits" without GitHub publishing the figure, and
 * inventing one would be exactly the substitution of a guess for a
 * measurement that the rest of this file refuses to make. A user on either
 * sets `monthlyAllowance` explicitly.
 */
export type CopilotPlan = 'pro' | 'pro-plus' | 'max' | 'business' | 'enterprise';

export const COPILOT_PLANS: readonly CopilotPlan[] = [
  'pro',
  'pro-plus',
  'max',
  'business',
  'enterprise',
];

interface PlanAllowance {
  readonly standard: number;
  /**
   * A limited-time amount that supersedes `standard` until `until` (UTC,
   * exclusive). Encoded with its expiry so it lapses on its own rather than
   * quietly outliving the promotion it describes.
   */
  readonly promotional?: { readonly credits: number; readonly until: string };
}

/**
 * Monthly included credits, per GitHub's published figures.
 *
 * Since 1 June 2026 Copilot bills **GitHub AI Credits**, priced from input,
 * output and cached tokens, at a fixed 1 credit = $0.01 USD. Business and
 * Enterprise draw from a **pooled** entitlement at the billing entity, not a
 * per-seat bucket — so a "remaining" figure for those plans is a claim on a
 * shared pool, which is why {@link isPooledPlan} exists and the HUD says so.
 *
 * These remain **defaults of last resort**. A plan's published allowance and
 * the limit an organisation actually enforces are different numbers, and an
 * org may enforce none at all. See {@link resolveAllowance}.
 */
const PLAN_ALLOWANCES: Readonly<Record<CopilotPlan, PlanAllowance>> = {
  pro: { standard: 1500 },
  'pro-plus': { standard: 7000 },
  max: { standard: 20_000 },
  business: {
    standard: 1900,
    promotional: { credits: 3000, until: '2026-09-01' },
  },
  enterprise: {
    standard: 3900,
    promotional: { credits: 7000, until: '2026-09-01' },
  },
};

/** Standard published figures, ignoring any promotion. */
export const MONTHLY_ALLOWANCE: Readonly<Record<CopilotPlan, number>> = {
  pro: PLAN_ALLOWANCES.pro.standard,
  'pro-plus': PLAN_ALLOWANCES['pro-plus'].standard,
  max: PLAN_ALLOWANCES.max.standard,
  business: PLAN_ALLOWANCES.business.standard,
  enterprise: PLAN_ALLOWANCES.enterprise.standard,
};

/** Business and Enterprise credits are pooled across the billing entity, not per seat. */
export function isPooledPlan(plan: CopilotPlan): boolean {
  return plan === 'business' || plan === 'enterprise';
}

export interface PlanAllowanceAt {
  readonly credits: number;
  /** Set only while a promotional figure is in force, so callers can say so. */
  readonly promotionalUntil?: string;
}

/**
 * The published allowance in force at `now`, promotion included.
 *
 * A promotion that outlives its window is a wrong number, and one that is
 * ignored during its window is a budget alarm that will never fire. Both are
 * avoided by carrying the expiry in the data rather than in a release note.
 */
export function planAllowanceAt(plan: CopilotPlan, now: Date = new Date()): PlanAllowanceAt {
  const entry = PLAN_ALLOWANCES[plan];
  const promotion = entry.promotional;
  if (promotion !== undefined && now.toISOString().slice(0, 10) < promotion.until) {
    return { credits: promotion.credits, promotionalUntil: promotion.until };
  }
  return { credits: entry.standard };
}

/**
 * GitHub prices AI credits at a fixed **1 credit = $0.01 USD**, for both
 * individual and organisation plans, and additional-usage budgets are set in
 * dollars. Money is therefore a *conversion* here, not an estimate — the one
 * figure in this project that needs no provenance footnote.
 */
export const USD_PER_CREDIT = 0.01;

export function creditsToUsd(credits: number): number {
  return credits * USD_PER_CREDIT;
}

/**
 * Reads a plan name, refusing anything it does not recognise.
 *
 * The previous form was `value === 'business' ? 'business' : 'enterprise'`,
 * which turned every typo into an enterprise allowance — a wrong number
 * presented with no indication it was a fallback. P5: fail loudly.
 */
export function parsePlan(value: string, source: string): CopilotPlan {
  const plan = COPILOT_PLANS.find((candidate) => candidate === value);
  if (plan === undefined) {
    throw new ConfigError(
      `Unknown Copilot plan "${value}" from ${source}. Expected one of: ${COPILOT_PLANS.join(', ')}.`,
      { reason: 'invalid-plan', source, value },
    );
  }
  return plan;
}

/**
 * Where the effective allowance came from. Reported alongside the figure
 * because "3,900" carries a completely different weight depending on
 * whether somebody configured it or the tool guessed it from a plan name.
 */
export type AllowanceSource = 'flag' | 'env' | 'config' | 'user-config' | 'plan-default';

export interface Allowance {
  readonly plan: CopilotPlan;
  /**
   * Included credits per month, or `null` when no monthly limit is
   * enforced. `null` is not "zero" and not "unknown" — it is the positive
   * statement that there is nothing to exceed, which is what GitHub
   * reports as *"No monthly limit set by your organization"*.
   */
  readonly credits: number | null;
  readonly source: AllowanceSource;
  /** Set only when the figure is a promotional amount still inside its window. */
  readonly promotionalUntil?: string;
}

/** Spellings accepted for "there is no enforced monthly limit". */
const UNLIMITED_ALIASES: ReadonlySet<string> = new Set([
  'unlimited',
  'none',
  'no-limit',
  'nolimit',
  'off',
  'false',
]);

/**
 * Parses an allowance as written by a human — a CLI flag, an environment
 * variable, or a config file. Thousands separators are tolerated because
 * people copy these figures out of a billing page.
 *
 * A value that is present but unintelligible **throws** rather than
 * falling back to the plan default (S5). Silently substituting a guess for
 * a figure the user believes they configured is the exact failure this
 * function exists to prevent.
 */
export function parseAllowanceValue(raw: string | number, source: AllowanceSource): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new ConfigError(`Monthly allowance from ${source} must be a non-negative number.`, {
        reason: 'invalid-allowance',
        source,
        value: String(raw),
      });
    }
    return raw;
  }

  const normalised = raw.trim().toLowerCase();
  if (normalised === '') {
    throw new ConfigError(`Monthly allowance from ${source} is empty.`, {
      reason: 'invalid-allowance',
      source,
      value: raw,
    });
  }
  if (UNLIMITED_ALIASES.has(normalised)) return null;

  const parsed = Number(normalised.replace(/[_,\s]/g, ''));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConfigError(
      `Monthly allowance from ${source} must be a non-negative number or "unlimited", not ${JSON.stringify(raw)}.`,
      { reason: 'invalid-allowance', source, value: raw },
    );
  }
  return parsed;
}

export interface AllowanceInputs {
  readonly plan: CopilotPlan;
  /** `--allowance` on the command line. */
  readonly flag?: string | undefined;
  /** `TOKENLENS_MONTHLY_ALLOWANCE` in the environment. */
  readonly env?: string | undefined;
  /** `monthlyAllowance` in this project's `.tokenlens/config.json`. */
  readonly config?: string | number | undefined;
  /** `monthlyAllowance` in the machine-wide `~/.tokenlens/config.json`. */
  readonly userConfig?: string | number | undefined;
  /** Decides whether a promotional plan figure is still in force. */
  readonly now?: Date | undefined;
}

/**
 * Resolves the allowance actually in force, most specific source first:
 * **flag → environment → project config → machine config → plan default**.
 *
 * The allowance is deliberately *not* fetched from GitHub. Core performs
 * no network calls (AI-1/S1) — the binary reads developers' conversations,
 * and an HTTP client inside it is not reviewable. So the number is
 * declared locally and its origin is reported with it, which also means a
 * change of policy is picked up on the next run rather than baked into a
 * release.
 */
export function resolveAllowance(inputs: AllowanceInputs): Allowance {
  const { plan } = inputs;

  if (inputs.flag !== undefined) {
    return { plan, credits: parseAllowanceValue(inputs.flag, 'flag'), source: 'flag' };
  }
  if (inputs.env !== undefined && inputs.env.trim() !== '') {
    return { plan, credits: parseAllowanceValue(inputs.env, 'env'), source: 'env' };
  }
  if (inputs.config !== undefined) {
    return { plan, credits: parseAllowanceValue(inputs.config, 'config'), source: 'config' };
  }
  if (inputs.userConfig !== undefined) {
    return {
      plan,
      credits: parseAllowanceValue(inputs.userConfig, 'user-config'),
      source: 'user-config',
    };
  }
  const planned = planAllowanceAt(plan, inputs.now);
  return {
    plan,
    credits: planned.credits,
    source: 'plan-default',
    ...(planned.promotionalUntil !== undefined
      ? { promotionalUntil: planned.promotionalUntil }
      : {}),
  };
}

function toAllowance(planOrAllowance: CopilotPlan | Allowance, now?: Date): Allowance {
  if (typeof planOrAllowance !== 'string') return planOrAllowance;
  const planned = planAllowanceAt(planOrAllowance, now);
  return {
    plan: planOrAllowance,
    credits: planned.credits,
    source: 'plan-default',
    ...(planned.promotionalUntil !== undefined
      ? { promotionalUntil: planned.promotionalUntil }
      : {}),
  };
}

export interface BudgetForecast {
  readonly plan: CopilotPlan;
  /** `null` when no monthly limit is enforced — see {@link Allowance}. */
  readonly monthlyAllowance: number | null;
  readonly allowanceSource: AllowanceSource;
  /** Convenience mirror of `monthlyAllowance === null`, for renderers. */
  readonly unlimited: boolean;
  readonly monthToDateCredits: number;
  readonly daysElapsedInMonth: number;
  readonly daysInMonth: number;
  /** Linear extrapolation of the month-to-date daily rate to the full month. */
  readonly projectedMonthEndCredits: number;
  /** Always `0` when unlimited — there is no limit to be over. */
  readonly projectedOverage: number;
  readonly onTrackToExceedAllowance: boolean;
  /**
   * True on Business and Enterprise, where the entitlement is pooled across
   * the billing entity. "Remaining" is then a claim on a shared pool rather
   * than a personal quota, and saying otherwise overstates what is left.
   */
  readonly pooled: boolean;
  /** Set while a promotional plan allowance is in force, with its expiry. */
  readonly promotionalUntil?: string;
  /**
   * The date the current daily run-rate would exhaust the full monthly
   * allowance, projected forward from `now` (UTC, `YYYY-MM-DD`).
   * `undefined` when there is no spend yet to project from, **and when no
   * limit is enforced** — an unlimited allowance is never exhausted, so a
   * date here would be fiction. A date at or before `now` means the
   * allowance is *already* exhausted, and by how many days.
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
  planOrAllowance: CopilotPlan | Allowance,
  now: Date = new Date(),
): BudgetForecast {
  const allowance = toAllowance(planOrAllowance, now);
  const limit = allowance.credits;
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

  // With no enforced limit there is nothing to be over and nothing to
  // exhaust. Reporting a 0 overage against a fabricated ceiling, or a
  // hard-block date that can never arrive, would be an invented number
  // dressed as a measured one.
  const projectedOverage = limit === null ? 0 : Math.max(0, projectedMonthEndCredits - limit);
  const hardBlockDate =
    limit === null ? undefined : computeHardBlockDate(now, limit, monthToDateCredits, dailyRate);

  return {
    plan: allowance.plan,
    monthlyAllowance: limit,
    allowanceSource: allowance.source,
    unlimited: limit === null,
    pooled: isPooledPlan(allowance.plan),
    monthToDateCredits,
    daysElapsedInMonth,
    daysInMonth,
    projectedMonthEndCredits,
    projectedOverage,
    onTrackToExceedAllowance: limit !== null && projectedMonthEndCredits > limit,
    ...(allowance.promotionalUntil !== undefined
      ? { promotionalUntil: allowance.promotionalUntil }
      : {}),
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
