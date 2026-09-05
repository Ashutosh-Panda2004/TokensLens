import type Database from 'better-sqlite3';
import { buildLedger, type DaySpend } from './ledger.js';
import { forecastBudget, creditsToUsd, type Allowance, type BudgetForecast } from './budget.js';
import { longestSessionId, projectNextTurnCost, type NextTurnProjection } from './next-turn.js';
import { buildSubstitutionAdvice, type SubstitutionAdvice } from './substitution.js';
import type { ScopeSelection } from '../scope/types.js';
import { VERSION } from '../version.js';

/**
 * **D14.3 — everything the HUD shows, from one read.**
 *
 * The extension used to spawn the binary twice per refresh, once for the
 * ledger and once for the budget. Two reads of a moving database can
 * disagree, and the disagreement would surface as a status bar whose total
 * did not match its own breakdown. One command, one snapshot, one answer.
 *
 * `schemaVersion` exists so that an old extension against a new binary can
 * say so, rather than rendering whichever fields it happens to recognise.
 */
export const HUD_SCHEMA_VERSION = 1;

export interface HudMoney {
  readonly credits: number;
  readonly usd: number;
}

export interface HudModelSpend {
  readonly model: string;
  readonly credits: number;
  readonly usd: number;
  readonly requests: number;
  readonly creditsPerRequest: number;
}

export interface HudSession {
  readonly turns: number;
  readonly credits: number;
  readonly usd: number;
  readonly creditsPerTurn: number;
  /** Absent when the conversation is too short to project from honestly. */
  readonly nextTurn?: {
    readonly credits: number;
    readonly usd: number;
    readonly multipleOfFreshTurn: number;
    readonly freshTurnCredits: number;
    readonly sampleSize: number;
  };
}

export type HudHistoryPeriod = 'daily' | 'weekly' | 'monthly';

export interface HudHistoryPoint {
  /** Inclusive UTC bounds. A point is auditable without reverse-engineering its label. */
  readonly from: string;
  readonly to: string;
  readonly credits: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly requests: number;
}

export interface HudHistorySeries {
  readonly period: HudHistoryPeriod;
  readonly points: readonly HudHistoryPoint[];
}

export interface HudHistory {
  readonly daily: HudHistorySeries;
  readonly weekly: HudHistorySeries;
  readonly monthly: HudHistorySeries;
}

export interface HudSnapshot {
  readonly schemaVersion: number;
  readonly producedBy: string;
  readonly generatedAt: string;
  readonly scope: string;

  readonly month: {
    readonly credits: number;
    readonly usd: number;
    readonly projectedCredits: number;
    readonly projectedUsd: number;
    readonly allowance: number | null;
    readonly unlimited: boolean;
    readonly pooled: boolean;
    readonly allowanceSource: string;
    readonly promotionalUntil?: string;
    readonly remainingCredits: number | null;
    readonly percentUsed: number | null;
    readonly onTrackToExceed: boolean;
    readonly hardBlockDate?: string;
    readonly daysElapsed: number;
    readonly daysInMonth: number;
    /**
     * Credits beyond the allowance, priced. Distinct from `usd` because
     * included credits are prepaid inside the subscription: reporting gross
     * value as the bill would overstate it by the whole allowance.
     */
    readonly incrementalUsd: number;
  };

  readonly workspace: {
    readonly allTime: HudMoney;
    readonly today: HudMoney;
    readonly requests: number;
    readonly activeDays: number;
    readonly measuredPercent: number;
  };

  readonly session?: HudSession;
  readonly topModels: readonly HudModelSpend[];
  /** Bounded chart-ready history. Optional so newer extensions degrade cleanly with older binaries. */
  readonly history?: HudHistory;
  /** D14.9 — the priced model-substitution lever, with its caveats attached. */
  readonly advice: SubstitutionAdvice;
}

export interface BuildHudOptions {
  readonly allowance: Allowance;
  readonly scope?: ScopeSelection | undefined;
  readonly scopeLabel: string;
  readonly now?: Date;
}

function money(credits: number): HudMoney {
  return { credits, usd: creditsToUsd(credits) };
}

export function buildHudSnapshot(db: Database.Database, options: BuildHudOptions): HudSnapshot {
  const now = options.now ?? new Date();
  const ledger = buildLedger(db, options.scope ? { scope: options.scope } : undefined);
  const forecast: BudgetForecast = forecastBudget(ledger, options.allowance, now);

  const today = now.toISOString().slice(0, 10);
  const todayCredits = ledger.byDay.find((day) => day.day === today)?.credits ?? 0;

  const limit = forecast.monthlyAllowance;
  const remaining = limit === null ? null : Math.max(0, limit - forecast.monthToDateCredits);
  const percentUsed = limit === null || limit === 0 ? null : forecast.monthToDateCredits / limit;

  // Only spend beyond the allowance is new money. Inside it, the credits are
  // already paid for by the subscription.
  const incrementalCredits =
    limit === null ? forecast.monthToDateCredits : Math.max(0, forecast.monthToDateCredits - limit);

  return {
    schemaVersion: HUD_SCHEMA_VERSION,
    producedBy: `tokenlens ${VERSION}`,
    generatedAt: now.toISOString(),
    scope: options.scopeLabel,

    month: {
      credits: forecast.monthToDateCredits,
      usd: creditsToUsd(forecast.monthToDateCredits),
      projectedCredits: forecast.projectedMonthEndCredits,
      projectedUsd: creditsToUsd(forecast.projectedMonthEndCredits),
      allowance: limit,
      unlimited: forecast.unlimited,
      pooled: forecast.pooled,
      allowanceSource: forecast.allowanceSource,
      remainingCredits: remaining,
      percentUsed,
      onTrackToExceed: forecast.onTrackToExceedAllowance,
      daysElapsed: forecast.daysElapsedInMonth,
      daysInMonth: forecast.daysInMonth,
      incrementalUsd: creditsToUsd(incrementalCredits),
      ...(forecast.promotionalUntil !== undefined
        ? { promotionalUntil: forecast.promotionalUntil }
        : {}),
      ...(forecast.hardBlockDate !== undefined ? { hardBlockDate: forecast.hardBlockDate } : {}),
    },

    workspace: {
      allTime: money(ledger.totalCredits),
      today: money(todayCredits),
      requests: ledger.requestCount,
      activeDays: ledger.byDay.length,
      measuredPercent: ledger.totalCredits > 0 ? ledger.measuredCredits / ledger.totalCredits : 0,
    },

    ...sessionOf(db, options.scope),

    topModels: ledger.byModel.slice(0, 6).map((model) => ({
      model: model.model,
      credits: model.credits,
      usd: creditsToUsd(model.credits),
      requests: model.requestCount,
      creditsPerRequest: model.requestCount > 0 ? model.credits / model.requestCount : 0,
    })),

    history: buildHudHistory(ledger.byDay, now),

    advice: buildSubstitutionAdvice(ledger),
  };
}

const DAILY_POINT_COUNT = 14;
const WEEKLY_POINT_COUNT = 12;
const MONTHLY_POINT_COUNT = 12;

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function dayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function weekStart(date: Date): Date {
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  return addUtcDays(date, -mondayOffset);
}

function historyPoint(days: readonly DaySpend[], from: Date, to: Date): HudHistoryPoint {
  const fromKey = utcDay(from);
  const toKey = utcDay(to);
  const included = days.filter((day) => day.day >= fromKey && day.day <= toKey);

  return {
    from: fromKey,
    to: toKey,
    credits: included.reduce((sum, day) => sum + day.credits, 0),
    promptTokens: included.reduce((sum, day) => sum + day.promptTokens, 0),
    outputTokens: included.reduce((sum, day) => sum + day.outputTokens, 0),
    requests: included.reduce((sum, day) => sum + day.requestCount, 0),
  };
}

export function buildHudHistory(days: readonly DaySpend[], now: Date = new Date()): HudHistory {
  const today = dayStart(now);
  const currentWeek = weekStart(today);

  const daily = Array.from({ length: DAILY_POINT_COUNT }, (_, index) => {
    const day = addUtcDays(today, index - (DAILY_POINT_COUNT - 1));
    return historyPoint(days, day, day);
  });

  const weekly = Array.from({ length: WEEKLY_POINT_COUNT }, (_, index) => {
    const from = addUtcDays(currentWeek, (index - (WEEKLY_POINT_COUNT - 1)) * 7);
    const naturalEnd = addUtcDays(from, 6);
    return historyPoint(days, from, naturalEnd > today ? today : naturalEnd);
  });

  const monthly = Array.from({ length: MONTHLY_POINT_COUNT }, (_, index) => {
    const from = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + index - (MONTHLY_POINT_COUNT - 1), 1),
    );
    const naturalEnd = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
    return historyPoint(days, from, naturalEnd > today ? today : naturalEnd);
  });

  return {
    daily: { period: 'daily', points: daily },
    weekly: { period: 'weekly', points: weekly },
    monthly: { period: 'monthly', points: monthly },
  };
}

function sessionOf(db: Database.Database, scope?: ScopeSelection): { session?: HudSession } {
  const sessionId = longestSessionId(db, scope);
  if (sessionId === undefined) return {};

  const projection: NextTurnProjection | undefined = projectNextTurnCost(db, sessionId, scope);
  if (projection === undefined) return {};

  return {
    session: {
      turns: projection.turnsSoFar,
      credits: projection.sessionCredits,
      usd: creditsToUsd(projection.sessionCredits),
      creditsPerTurn: projection.meanTurnCredits,
      nextTurn: {
        credits: projection.nextTurnCredits,
        usd: creditsToUsd(projection.nextTurnCredits),
        multipleOfFreshTurn: projection.multipleOfFreshTurn,
        freshTurnCredits: projection.freshTurnCredits,
        sampleSize: projection.sampleSize,
      },
    },
  };
}
