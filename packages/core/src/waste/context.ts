import type Database from 'better-sqlite3';
import {
  getAllCompactions,
  getAllContentReferences,
  getAllCostCentres,
  getAllEdits,
  getAllRequests,
  getAllRounds,
  getAllToolCalls,
} from '../store/database.js';
import { buildLedger } from '../ledger/ledger.js';
import { deriveRateCard, estimateCredits } from '../ledger/rate-card.js';
import type { DetectContext } from './types.js';

/**
 * Assembles the shared read-only view every detector runs against.
 *
 * `creditsByRequest` is computed here, once, rather than per detector. That
 * is deliberate: if two detectors derived per-request credits independently
 * they could disagree about what a single request cost, and the
 * reconciliation property test ("attributed credits never exceed the
 * ledger total") would then be checking two different universes against
 * each other. One source of truth makes that test meaningful.
 */
export function buildDetectContext(db: Database.Database): DetectContext {
  const requests = getAllRequests(db);
  const rateCard = deriveRateCard(
    requests.map((r) => ({
      model: r.model,
      promptTokens: r.promptTokens,
      ...(r.credits !== null ? { credits: r.credits } : {}),
    })),
  );

  const creditsByRequest = new Map<string, number>();
  for (const request of requests) {
    creditsByRequest.set(
      request.requestId,
      request.credits ?? estimateCredits(request.promptTokens, request.model, rateCard).value,
    );
  }

  return {
    requests,
    toolCalls: getAllToolCalls(db),
    rounds: getAllRounds(db),
    edits: getAllEdits(db),
    compactions: getAllCompactions(db),
    contentReferences: getAllContentReferences(db),
    costCentres: getAllCostCentres(db),
    ledger: buildLedger(db),
    creditsByRequest,
  };
}
