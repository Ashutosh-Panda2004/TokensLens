import type { BudgetForecast, CopilotPlan, AllowanceSource } from '../ledger/budget.js';
import { selectMonthToDateDays } from '../ledger/budget.js';
import type {
  CostCentreSpend,
  DaySpend,
  LedgerSummary,
  ModelSpend,
  SessionSpend,
} from '../ledger/ledger.js';
import { modelled, type Modelled, type Value } from '../model/provenance.js';

/**
 * The dashboard's own provenance presentation for an *aggregate* figure —
 * distinct from `model/provenance.ts`'s `Measured<T>`/`Modelled<T>`,
 * which are binary (a single value is measured *or* modelled, never
 * both). A summed aggregate (e.g. "credits this month") is routinely a
 * mix of some measured requests and some rate-card-estimated ones, so it
 * needs a third state — this is what PLAN.md §20.9/D2.9 render as an
 * amber "blended" chip with the exact split on hover, rather than either
 * lying that it's fully measured or hiding that any of it is real.
 */
export interface ProvenanceView {
  readonly value: number;
  readonly measured: number;
  readonly modelled: number;
  /** 0-100, rounded — what share of `value` is measured. */
  readonly measuredPercent: number;
  readonly kind: 'measured' | 'modelled' | 'blended';
}

export function provenanceView(
  value: number,
  measuredPart: number,
  modelledPart: number,
): ProvenanceView {
  const kind: ProvenanceView['kind'] =
    modelledPart === 0 ? 'measured' : measuredPart === 0 ? 'modelled' : 'blended';
  const measuredPercent = value !== 0 ? Math.round((measuredPart / value) * 100) : 100;
  return { value, measured: measuredPart, modelled: modelledPart, measuredPercent, kind };
}

export interface DaySpendView {
  readonly day: string;
  readonly credits: ProvenanceView;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly requestCount: number;
}

function dayView(day: DaySpend): DaySpendView {
  return {
    day: day.day,
    credits: provenanceView(day.credits, day.measuredCredits, day.modelledCredits),
    promptTokens: day.promptTokens,
    outputTokens: day.outputTokens,
    requestCount: day.requestCount,
  };
}

export interface ModelSpendView {
  readonly model: string;
  readonly credits: ProvenanceView;
  readonly requestCount: number;
  /**
   * Credits per 1k prompt tokens. Carried as a tagged `Value`, not a bare
   * number with the provenance in a sibling field: a rate derived from this
   * model's own measured requests and one that rode the fleet-wide blended
   * fallback are different claims, and the rate card's own `basis` and
   * `assumptions` are what say which — flattening them threw that away.
   */
  readonly rate: Value<number>;
  /** How many measured requests the rate is averaged over. 0 means the blended fallback. */
  readonly rateSampleSize: number;
}

function modelView(model: ModelSpend): ModelSpendView {
  return {
    model: model.model,
    credits: provenanceView(model.credits, model.measuredCredits, model.modelledCredits),
    requestCount: model.requestCount,
    rate: { value: model.rate.creditsPerKPromptToken, provenance: model.rate.provenance },
    rateSampleSize: model.rate.sampleSize,
  };
}

export interface SessionSpendView {
  readonly sessionId: string;
  readonly credits: ProvenanceView;
  readonly requestCount: number;
  readonly firstTs: number;
  readonly lastTs: number;
}

function sessionView(session: SessionSpend): SessionSpendView {
  return {
    sessionId: session.sessionId,
    credits: provenanceView(session.credits, session.measuredCredits, session.modelledCredits),
    requestCount: session.requestCount,
    firstTs: session.firstTs,
    lastTs: session.lastTs,
  };
}

export interface CostCentreSpendView {
  readonly label: string;
  readonly tokens: number;
  readonly tokenShare: number; // 0-100, this label's share of total tokens across all centres
  readonly credits: ProvenanceView;
  readonly requestCount: number;
}

function costCentreViews(centres: readonly CostCentreSpend[]): CostCentreSpendView[] {
  const totalTokens = centres.reduce((sum, c) => sum + c.tokens, 0);
  return centres.map((centre) => ({
    label: centre.label,
    tokens: centre.tokens,
    tokenShare: totalTokens > 0 ? Math.round((centre.tokens / totalTokens) * 100) : 0,
    credits: provenanceView(centre.credits, centre.measuredCredits, centre.modelledCredits),
    requestCount: centre.requestCount,
  }));
}

export interface LedgerView {
  readonly totalCredits: ProvenanceView;
  readonly requestCount: number;
  readonly byDay: readonly DaySpendView[];
  readonly byModel: readonly ModelSpendView[];
  readonly bySession: readonly SessionSpendView[];
  readonly byCostCentre: readonly CostCentreSpendView[];
}

/** Maps the raw `LedgerSummary` into the dashboard's provenance-annotated view model. */
export function toLedgerView(summary: LedgerSummary): LedgerView {
  return {
    totalCredits: provenanceView(
      summary.totalCredits,
      summary.measuredCredits,
      summary.modelledCredits,
    ),
    requestCount: summary.requestCount,
    byDay: summary.byDay.map(dayView),
    byModel: summary.byModel.map(modelView),
    bySession: summary.bySession.map(sessionView),
    byCostCentre: costCentreViews(summary.byCostCentre),
  };
}

export interface BudgetView {
  readonly plan: CopilotPlan;
  /** `null` when no monthly limit is enforced. */
  readonly monthlyAllowance: number | null;
  readonly allowanceSource: AllowanceSource;
  readonly unlimited: boolean;
  readonly monthToDateCredits: ProvenanceView;
  readonly daysElapsedInMonth: number;
  readonly daysInMonth: number;
  /** Always `Modelled` — a linear extrapolation is never a measurement, however much of its input is measured. */
  readonly projectedMonthEndCredits: Modelled<number>;
  readonly projectedOverage: Modelled<number>;
  readonly onTrackToExceedAllowance: boolean;
  readonly hardBlockDate?: Modelled<string>;
}

const PROJECTION_ASSUMPTIONS = [
  'linear extrapolation of the month-to-date daily average — not a forecast of behaviour change',
];

/** Maps `BudgetForecast` into the dashboard's provenance-annotated view model. */
export function toBudgetView(
  forecast: BudgetForecast,
  ledger: LedgerSummary,
  now: Date = new Date(),
): BudgetView {
  const monthToDateDays = selectMonthToDateDays(ledger, now);
  const monthToDateMeasured = monthToDateDays.reduce((sum, day) => sum + day.measuredCredits, 0);
  const monthToDateModelled = monthToDateDays.reduce((sum, day) => sum + day.modelledCredits, 0);

  return {
    plan: forecast.plan,
    monthlyAllowance: forecast.monthlyAllowance,
    allowanceSource: forecast.allowanceSource,
    unlimited: forecast.unlimited,
    monthToDateCredits: provenanceView(
      forecast.monthToDateCredits,
      monthToDateMeasured,
      monthToDateModelled,
    ),
    daysElapsedInMonth: forecast.daysElapsedInMonth,
    daysInMonth: forecast.daysInMonth,
    projectedMonthEndCredits: modelled(
      forecast.projectedMonthEndCredits,
      'linear extrapolation of month-to-date daily rate',
      PROJECTION_ASSUMPTIONS,
    ),
    projectedOverage: modelled(
      forecast.projectedOverage,
      'projected month-end credits minus the plan allowance',
      PROJECTION_ASSUMPTIONS,
    ),
    onTrackToExceedAllowance: forecast.onTrackToExceedAllowance,
    ...(forecast.hardBlockDate !== undefined
      ? {
          hardBlockDate: modelled(
            forecast.hardBlockDate,
            'projected allowance-exhaustion date',
            PROJECTION_ASSUMPTIONS,
          ),
        }
      : {}),
  };
}
