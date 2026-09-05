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
import type { GitSurvival } from './git-survival.js';
import type { DuplicationReport } from '../org/duplication.js';

/**
 * External inputs a detector cannot fetch for itself.
 *
 * D12 added two classes whose evidence lives outside the journal — W7 needs a
 * commit history, W8 needs an organisation rollup. Both are read by the caller
 * and passed in, so the guarantee that a detector "physically cannot reach the
 * network or the filesystem" survives the addition rather than being quietly
 * relaxed for two special cases.
 */
export interface DetectContextInputs {
  readonly git?: GitSurvival;
  readonly org?: DuplicationReport;
}

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
export function buildDetectContext(
  db: Database.Database,
  inputs: DetectContextInputs = {},
): DetectContext {
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
    ...(inputs.git !== undefined ? { git: inputs.git } : {}),
    ...(inputs.org !== undefined ? { org: inputs.org } : {}),
  };
}
