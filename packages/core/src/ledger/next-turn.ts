import type Database from 'better-sqlite3';
import { getAllRequests, type RequestRow } from '../store/database.js';
import { deriveRateCard, estimateCredits, type ModelRate } from './rate-card.js';
import { sourceFileInScope, type ScopeSelection } from '../scope/types.js';

/**
 * **D14.6 — what the next turn in this conversation will cost.**
 *
 * Every turn re-sends the whole conversation, so the price of a turn grows
 * with the conversation's length. A developer therefore pays a compounding
 * cost for a decision — "keep going in this chat" — that is invisible at the
 * moment they make it.
 *
 * D7.2 specified a pre-flight estimate and it was never built, because
 * estimating an *unsent* prompt is guesswork. This is the version that is
 * not: the growth is **measured from the session's own history**. Nothing is
 * assumed about how conversations behave in general; the answer comes from
 * how this one has behaved so far.
 *
 * The projection is a least-squares fit over the session's turns, clamped so
 * it can never predict less than the most recent turn actually cost — a
 * downward-sloping fit on a noisy tail would otherwise promise a discount
 * that the mechanism cannot deliver.
 */
export const MINIMUM_TURNS_TO_PROJECT = 4;

export interface NextTurnProjection {
  readonly sessionId: string;
  readonly turnsSoFar: number;
  readonly sessionCredits: number;
  /** Mean cost of the turns observed so far. */
  readonly meanTurnCredits: number;
  readonly lastTurnCredits: number;
  /** Projected cost of the turn after the last one observed. */
  readonly nextTurnCredits: number;
  /**
   * `nextTurnCredits` divided by the median cost of a *first* turn across
   * all sessions. This is the number that makes resetting concrete: "the
   * next turn costs 14x a fresh one" is actionable in a way that a raw
   * credit figure is not.
   */
  readonly multipleOfFreshTurn: number;
  readonly freshTurnCredits: number;
  /** How many turns the fit is based on — a projection without this is not reviewable. */
  readonly sampleSize: number;
}

interface Turn {
  readonly index: number;
  readonly credits: number;
}

function creditsOf(row: RequestRow, rateCard: readonly ModelRate[]): number {
  return row.credits ?? estimateCredits(row.promptTokens, row.model, rateCard).value;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/**
 * Least-squares slope and intercept of credits against turn index.
 *
 * A straight line rather than anything cleverer: the underlying driver is a
 * context window that grows roughly linearly with turns, and a curve fitted
 * to a dozen noisy points would be false precision.
 */
function fitLine(turns: readonly Turn[]): { slope: number; intercept: number } {
  const n = turns.length;
  const meanX = turns.reduce((sum, turn) => sum + turn.index, 0) / n;
  const meanY = turns.reduce((sum, turn) => sum + turn.credits, 0) / n;

  let covariance = 0;
  let variance = 0;
  for (const turn of turns) {
    covariance += (turn.index - meanX) * (turn.credits - meanY);
    variance += (turn.index - meanX) ** 2;
  }

  const slope = variance === 0 ? 0 : covariance / variance;
  return { slope, intercept: meanY - slope * meanX };
}

/**
 * Projects the next turn's cost for one session, or `undefined` when the
 * session is too short to say anything honest about.
 *
 * Refusing below {@link MINIMUM_TURNS_TO_PROJECT} is deliberate: a slope
 * fitted to two or three points is dominated by noise, and a confident
 * number derived from it would be worse than no number at all.
 */
export function projectNextTurnCost(
  db: Database.Database,
  sessionId: string,
  scope?: ScopeSelection,
): NextTurnProjection | undefined {
  const allRows = getAllRequests(db);
  // The rate card stays machine-wide for the same reason `buildLedger`'s
  // does: it calibrates what a model costs here, and narrowing it would make
  // the same request price differently per folder.
  const rateCard = deriveRateCard(
    allRows.map((row) => ({
      model: row.model,
      promptTokens: row.promptTokens,
      ...(row.credits !== null ? { credits: row.credits } : {}),
    })),
  );

  const inScope = allRows.filter((row) => sourceFileInScope(row.sourceFile, scope));

  const turns: Turn[] = inScope
    .filter((row) => row.sessionId === sessionId)
    .sort((a, b) => a.turnIndex - b.turnIndex)
    .map((row) => ({ index: row.turnIndex, credits: creditsOf(row, rateCard) }));

  if (turns.length < MINIMUM_TURNS_TO_PROJECT) return undefined;

  const { slope, intercept } = fitLine(turns);
  const lastIndex = turns[turns.length - 1]?.index ?? 0;
  const lastTurnCredits = turns[turns.length - 1]?.credits ?? 0;

  // Never promise a cheaper next turn than the last one actually cost: the
  // context only grows, so a downward fit is noise, not a saving.
  const projected = Math.max(lastTurnCredits, slope * (lastIndex + 1) + intercept);

  // Compared against fresh turns from the same scope, so the multiple is not
  // distorted by whatever unrelated projects on this machine happen to do.
  const freshTurnCredits = medianFirstTurnCredits(inScope, rateCard);
  const sessionCredits = turns.reduce((sum, turn) => sum + turn.credits, 0);

  return {
    sessionId,
    turnsSoFar: turns.length,
    sessionCredits,
    meanTurnCredits: sessionCredits / turns.length,
    lastTurnCredits,
    nextTurnCredits: projected,
    freshTurnCredits,
    multipleOfFreshTurn: freshTurnCredits > 0 ? projected / freshTurnCredits : 0,
    sampleSize: turns.length,
  };
}

/**
 * The median cost of the first turn of a conversation, across every session
 * on the machine. Median rather than mean because one enormous opening
 * prompt would otherwise make every reset look worthless.
 */
export function medianFirstTurnCredits(
  rows: readonly RequestRow[],
  rateCard: readonly ModelRate[],
): number {
  const firstBySession = new Map<string, RequestRow>();
  for (const row of rows) {
    const existing = firstBySession.get(row.sessionId);
    if (existing === undefined || row.turnIndex < existing.turnIndex) {
      firstBySession.set(row.sessionId, row);
    }
  }

  return median([...firstBySession.values()].map((row) => creditsOf(row, rateCard)));
}

/**
 * The session most worth acting on **within scope**: the one with the most
 * turns, since that is where the compounding is worst and a reset saves
 * most. Scoped because a conversation from an unrelated project is not
 * something the developer looking at this workspace can act on.
 */
export function longestSessionId(
  db: Database.Database,
  scope?: ScopeSelection,
): string | undefined {
  const counts = new Map<string, number>();
  for (const row of getAllRequests(db)) {
    if (!sourceFileInScope(row.sourceFile, scope)) continue;
    counts.set(row.sessionId, (counts.get(row.sessionId) ?? 0) + 1);
  }

  let best: { sessionId: string; turns: number } | undefined;
  for (const [sessionId, turns] of counts) {
    if (best === undefined || turns > best.turns) best = { sessionId, turns };
  }
  return best?.sessionId;
}
