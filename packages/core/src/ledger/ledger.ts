import type Database from 'better-sqlite3';
import { getAllCostCentres, getAllRequests, type RequestRow } from '../store/database.js';
import {
  deriveRateCard,
  estimateCredits,
  type ModelRate,
  type RateCardSample,
} from './rate-card.js';
import { measured, type Value } from '../model/provenance.js';

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
export function buildLedger(db: Database.Database): LedgerSummary {
  const rows = getAllRequests(db);
  const rateCard = deriveRateCard(toSamples(rows));

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
    const requestCredits = request?.credits ?? 0;
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
    if (request?.isMeasured) bucket.measuredCredits += attributedCredits;
    else bucket.modelledCredits += attributedCredits;
    bucket.requestCount += 1;
    byLabelMap.set(row.label, bucket);
  }

  return [...byLabelMap.entries()]
    .map(([label, bucket]) => ({ label, ...bucket }))
    .sort((a, b) => b.tokens - a.tokens);
}
