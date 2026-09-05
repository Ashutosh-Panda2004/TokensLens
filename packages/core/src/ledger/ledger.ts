import type Database from 'better-sqlite3';
import { getAllCostCentres, getAllRequests, type RequestRow } from '../store/database.js';
import {
  deriveRateCard,
  estimateCredits,
  type ModelRate,
  type RateCardSample,
} from './rate-card.js';
import { measured, type Value } from '../model/provenance.js';
import { sourceFileInScope, workspaceIdOfSourceFile, type ScopeSelection } from '../scope/types.js';
import type { WorkspaceStats } from '../scope/tree.js';

function toSamples(rows: readonly RequestRow[]): RateCardSample[] {
  return rows.map((row) => ({
    model: row.model,
    promptTokens: row.promptTokens,
    ...(row.credits !== null ? { credits: row.credits } : {}),
  }));
}

function creditsForRow(row: RequestRow, rateCard: readonly ModelRate[]): Value<number> {
  if (row.credits !== null) {
    return measured(row.credits, `request ${row.requestId}`);
  }
  return estimateCredits(row.promptTokens, row.model, rateCard);
}

function requireRate(rateCard: readonly ModelRate[], model: string): ModelRate {
  const rate = rateCard.find((entry) => entry.model === model);
  if (!rate) {
    // A genuine internal invariant violation (deriveRateCard guarantees an
    // entry for every model it sees) — worth a loud, specific failure
    // rather than a silent fallback or a cryptic downstream crash.
    throw new Error(`Internal invariant violated: no rate card entry for model "${model}".`);
  }
  return rate;
}

/** UTC calendar day, `YYYY-MM-DD` — stable regardless of the machine's local timezone. */
function dayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

export interface DaySpend {
  readonly day: string;
  readonly credits: number;
  readonly measuredCredits: number;
  readonly modelledCredits: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly requestCount: number;
}

export interface ModelSpend {
  readonly model: string;
  readonly credits: number;
  readonly measuredCredits: number;
  readonly modelledCredits: number;
  readonly requestCount: number;
  readonly rate: ModelRate;
}

export interface SessionSpend {
  readonly sessionId: string;
  readonly credits: number;
  readonly measuredCredits: number;
  readonly modelledCredits: number;
  readonly requestCount: number;
  readonly firstTs: number;
  readonly lastTs: number;
}

export interface CostCentreSpend {
  // Not `CostCentreLabel | string`: a union with `string` collapses to
  // `string` anyway (TS4116) — unrecognised labels are tolerated by
  // design (normalise.ts logs but keeps them), so this is honestly typed
  // as an open string rather than pretending the 5 known labels are
  // exhaustive.
  readonly label: string;
  readonly tokens: number;
  /** Each request's credits attributed across its cost centres in proportion to `percentageOfPrompt`. */
  readonly credits: number;
  readonly measuredCredits: number;
  readonly modelledCredits: number;
  readonly requestCount: number;
}

export interface LedgerSummary {
  readonly totalCredits: number;
  readonly measuredCredits: number;
  readonly modelledCredits: number;
  readonly requestCount: number;
  readonly byDay: readonly DaySpend[];
  readonly byModel: readonly ModelSpend[];
  /** Sorted by credits descending — index 0 is the single most expensive session (feeds `sessions --top`). */
  readonly bySession: readonly SessionSpend[];
  readonly byCostCentre: readonly CostCentreSpend[];
  readonly rateCard: readonly ModelRate[];
}

/**
 * Builds the full ledger summary from every request the ledger has
 * stored: totals, and breakdowns by day / model / session. Every
 * request's credits are `measured` when `copilotCredits` was actually
 * present, or a rate-card `Modelled` estimate otherwise (F12: only ~9.4%
 * of requests carry a measured value) — so `totalCredits` is always a
 * complete figure, and `measuredCredits`/`modelledCredits` show how much
 * of it is which.
 */
/**
 * Narrows which requests a ledger covers.
 *
 * `scope` is resolved by `src/scope` (which is the layer allowed to touch
 * the filesystem) and arrives here as a plain set of workspace ids, so the
 * ledger stays pure. `from`/`to` are inclusive `YYYY-MM-DD` UTC days.
 */
export interface LedgerQuery {
  readonly scope?: ScopeSelection;
  readonly from?: string;
  readonly to?: string;
}

function inDateRange(day: string, query: LedgerQuery | undefined): boolean {
  if (query?.from !== undefined && day < query.from) return false;
  if (query?.to !== undefined && day > query.to) return false;
  return true;
}

export function buildLedger(db: Database.Database, query?: LedgerQuery): LedgerSummary {
  const allRows = getAllRequests(db);

  // The rate card is deliberately derived from **every** request, not just
  // the ones in scope. It is a calibration of what each model costs on this
  // machine; narrowing it to one project would make the same request price
  // differently depending on which folder the command was run from, and a
  // small project might have no measured sample at all.
  const rateCard = deriveRateCard(toSamples(allRows));

  const rows = allRows.filter(
    (row) => sourceFileInScope(row.sourceFile, query?.scope) && inDateRange(dayKey(row.ts), query),
  );

  const byDayMap = new Map<
    string,
    {
      credits: number;
      measuredCredits: number;
      modelledCredits: number;
      promptTokens: number;
      outputTokens: number;
      requestCount: number;
    }
  >();
  const byModelMap = new Map<
    string,
    { credits: number; measuredCredits: number; modelledCredits: number; requestCount: number }
  >();
  const bySessionMap = new Map<
    string,
    {
      credits: number;
      measuredCredits: number;
      modelledCredits: number;
      requestCount: number;
      firstTs: number;
      lastTs: number;
    }
  >();
  const creditsByRequestId = new Map<string, { credits: number; isMeasured: boolean }>();

  let totalCredits = 0;
  let measuredCredits = 0;
  let modelledCredits = 0;

  for (const row of rows) {
    const creditsValue = creditsForRow(row, rateCard);
    const credits = creditsValue.value;
    const isMeasured = creditsValue.provenance.kind === 'measured';
    creditsByRequestId.set(row.requestId, { credits, isMeasured });

    totalCredits += credits;
    if (isMeasured) measuredCredits += credits;
    else modelledCredits += credits;

    const day = dayKey(row.ts);
    const dayBucket = byDayMap.get(day) ?? {
      credits: 0,
      measuredCredits: 0,
      modelledCredits: 0,
      promptTokens: 0,
      outputTokens: 0,
      requestCount: 0,
    };
    dayBucket.credits += credits;
    if (isMeasured) dayBucket.measuredCredits += credits;
    else dayBucket.modelledCredits += credits;
    dayBucket.promptTokens += row.promptTokens;
    dayBucket.outputTokens += row.outputTokens;
    dayBucket.requestCount += 1;
    byDayMap.set(day, dayBucket);

    const modelBucket = byModelMap.get(row.model) ?? {
      credits: 0,
      measuredCredits: 0,
      modelledCredits: 0,
      requestCount: 0,
    };
    modelBucket.credits += credits;
    if (isMeasured) modelBucket.measuredCredits += credits;
    else modelBucket.modelledCredits += credits;
    modelBucket.requestCount += 1;
    byModelMap.set(row.model, modelBucket);

    const sessionBucket = bySessionMap.get(row.sessionId) ?? {
      credits: 0,
      measuredCredits: 0,
      modelledCredits: 0,
      requestCount: 0,
      firstTs: row.ts,
      lastTs: row.ts,
    };
    sessionBucket.credits += credits;
    if (isMeasured) sessionBucket.measuredCredits += credits;
    else sessionBucket.modelledCredits += credits;
    sessionBucket.requestCount += 1;
    sessionBucket.firstTs = Math.min(sessionBucket.firstTs, row.ts);
    sessionBucket.lastTs = Math.max(sessionBucket.lastTs, row.ts);
    bySessionMap.set(row.sessionId, sessionBucket);
  }

  const byDay = [...byDayMap.entries()]
    .map(([day, bucket]) => ({ day, ...bucket }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const byModel = [...byModelMap.entries()]
    .map(([model, bucket]) => ({ model, ...bucket, rate: requireRate(rateCard, model) }))
    .sort((a, b) => b.credits - a.credits);

  const bySession = [...bySessionMap.entries()]
    .map(([sessionId, bucket]) => ({ sessionId, ...bucket }))
    .sort((a, b) => b.credits - a.credits);

  const byCostCentre = aggregateCostCentres(db, creditsByRequestId);

  return {
    totalCredits,
    measuredCredits,
    modelledCredits,
    requestCount: rows.length,
    byDay,
    byModel,
    bySession,
    byCostCentre,
    rateCard,
  };
}

function aggregateCostCentres(
  db: Database.Database,
  creditsByRequestId: ReadonlyMap<string, { credits: number; isMeasured: boolean }>,
): CostCentreSpend[] {
  const byLabelMap = new Map<
    string,
    {
      tokens: number;
      credits: number;
      measuredCredits: number;
      modelledCredits: number;
      requestCount: number;
    }
  >();

  for (const row of getAllCostCentres(db)) {
    const request = creditsByRequestId.get(row.requestId);
    // A cost centre whose request is outside the scope or date range is not
    // ours to count. Adding its tokens with zero credits would inflate the
    // token column while leaving the credit column right — a breakdown that
    // silently disagrees with its own total.
    if (request === undefined) continue;
    const requestCredits = request.credits;
    const attributedCredits = (row.percentageOfPrompt / 100) * requestCredits;

    const bucket = byLabelMap.get(row.label) ?? {
      tokens: 0,
      credits: 0,
      measuredCredits: 0,
      modelledCredits: 0,
      requestCount: 0,
    };
    bucket.tokens += row.tokens;
    bucket.credits += attributedCredits;
    if (request.isMeasured) bucket.measuredCredits += attributedCredits;
    else bucket.modelledCredits += attributedCredits;
    bucket.requestCount += 1;
    byLabelMap.set(row.label, bucket);
  }

  return [...byLabelMap.entries()]
    .map(([label, bucket]) => ({ label, ...bucket }))
    .sort((a, b) => b.tokens - a.tokens);
}

/** One named series over the shared day axis. Values align to `days` by index. */
export interface TimeseriesBand {
  readonly key: string;
  readonly values: readonly number[];
}

export interface Timeseries {
  readonly days: readonly string[];
  /** Credits per day, split by model. */
  readonly byModel: readonly TimeseriesBand[];
  /** Credits per day, split by cost centre. */
  readonly byCostCentre: readonly TimeseriesBand[];
  readonly totals: readonly number[];
  readonly requestCounts: readonly number[];
}

/**
 * Per-day breakdowns, shaped for stacked charts.
 *
 * `buildLedger` already reports *totals* by day and by model, but never the
 * two crossed — and the crossing is the whole question behind W12 and the
 * routing lever: not "what does the fleet spend on premium models" but
 * "is the premium share growing". A table of daily totals cannot show that;
 * a stacked series can.
 *
 * Every band spans the full day axis, zero-filled, so a renderer can stack
 * by index without reconciling ragged arrays — and a model that appears only
 * in the last week still lines up with the first.
 */
export function buildTimeseries(db: Database.Database, query?: LedgerQuery): Timeseries {
  const allRows = getAllRequests(db);
  const rateCard = deriveRateCard(toSamples(allRows));

  const rows = allRows.filter(
    (row) => sourceFileInScope(row.sourceFile, query?.scope) && inDateRange(dayKey(row.ts), query),
  );

  const creditsByRequest = new Map<string, { day: string; credits: number }>();
  const dayTotals = new Map<string, { credits: number; requests: number }>();
  const modelByDay = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const day = dayKey(row.ts);
    const credits = creditsForRow(row, rateCard).value;
    creditsByRequest.set(row.requestId, { day, credits });

    const total = dayTotals.get(day) ?? { credits: 0, requests: 0 };
    total.credits += credits;
    total.requests += 1;
    dayTotals.set(day, total);

    const models = modelByDay.get(day) ?? new Map<string, number>();
    models.set(row.model, (models.get(row.model) ?? 0) + credits);
    modelByDay.set(day, models);
  }

  const centreByDay = new Map<string, Map<string, number>>();
  for (const centre of getAllCostCentres(db)) {
    const request = creditsByRequest.get(centre.requestId);
    if (request === undefined) continue;
    const attributed = (centre.percentageOfPrompt / 100) * request.credits;
    const centres = centreByDay.get(request.day) ?? new Map<string, number>();
    centres.set(centre.label, (centres.get(centre.label) ?? 0) + attributed);
    centreByDay.set(request.day, centres);
  }

  const days = [...dayTotals.keys()].sort((a, b) => a.localeCompare(b));

  const bandsFrom = (source: Map<string, Map<string, number>>): TimeseriesBand[] => {
    const totalsByKey = new Map<string, number>();
    for (const perDay of source.values()) {
      for (const [key, value] of perDay) {
        totalsByKey.set(key, (totalsByKey.get(key) ?? 0) + value);
      }
    }

    return [...totalsByKey.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => ({
        key,
        values: days.map((day) => source.get(day)?.get(key) ?? 0),
      }));
  };

  return {
    days,
    byModel: bandsFrom(modelByDay),
    byCostCentre: bandsFrom(centreByDay),
    totals: days.map((day) => dayTotals.get(day)?.credits ?? 0),
    requestCounts: days.map((day) => dayTotals.get(day)?.requests ?? 0),
  };
}

/**
 * Per-workspace totals across the **whole** machine, for `tokenlens
 * projects` and the dashboard's Projects view.
 *
 * Deliberately unscoped: its entire job is to show what every project cost
 * so a reader can choose one. Requests whose stored path never carried a
 * workspace id are grouped under `undefined` by the caller's own lookup
 * failing, which is what feeds the unattributed bucket.
 */
export function buildWorkspaceStats(db: Database.Database): WorkspaceStats[] {
  const rows = getAllRequests(db);
  const rateCard = deriveRateCard(toSamples(rows));

  const byWorkspace = new Map<
    string,
    {
      credits: number;
      measuredCredits: number;
      requestCount: number;
      firstTs: number;
      lastTs: number;
      creditsByModel: Map<string, number>;
    }
  >();

  for (const row of rows) {
    const workspaceId = workspaceIdOfSourceFile(row.sourceFile);
    if (workspaceId === undefined) continue;

    const creditsValue = creditsForRow(row, rateCard);
    const credits = creditsValue.value;
    const bucket = byWorkspace.get(workspaceId) ?? {
      credits: 0,
      measuredCredits: 0,
      requestCount: 0,
      firstTs: row.ts,
      lastTs: row.ts,
      creditsByModel: new Map<string, number>(),
    };

    bucket.credits += credits;
    if (creditsValue.provenance.kind === 'measured') bucket.measuredCredits += credits;
    bucket.requestCount += 1;
    bucket.firstTs = Math.min(bucket.firstTs, row.ts);
    bucket.lastTs = Math.max(bucket.lastTs, row.ts);
    bucket.creditsByModel.set(row.model, (bucket.creditsByModel.get(row.model) ?? 0) + credits);
    byWorkspace.set(workspaceId, bucket);
  }

  return [...byWorkspace.entries()]
    .map(([workspaceId, bucket]) => {
      const topModel = [...bucket.creditsByModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      return {
        workspaceId,
        credits: bucket.credits,
        measuredCredits: bucket.measuredCredits,
        requestCount: bucket.requestCount,
        firstTs: bucket.firstTs,
        lastTs: bucket.lastTs,
        ...(topModel !== undefined ? { topModel } : {}),
      };
    })
    .sort((a, b) => b.credits - a.credits);
}
