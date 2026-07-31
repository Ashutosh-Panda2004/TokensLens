import type { Value } from '../model/provenance.js';
import type {
  CompactionRow,
  ContentReferenceRow,
  CostCentreRow,
  EditRow,
  RequestRow,
  RoundRow,
  ToolCallRow,
} from '../store/database.js';
import type { LedgerSummary } from '../ledger/ledger.js';

/**
 * The fourteen named waste classes (PLAN.md §18 / DEVELOPMENT-PLAN.md D3).
 * The point of naming them is that "you are wasting money" is not
 * actionable, but "these three integrations were never invoked" is.
 */
export type WasteClass =
  | 'W1'
  | 'W2'
  | 'W3'
  | 'W4'
  | 'W5'
  | 'W6'
  | 'W7'
  | 'W8'
  | 'W9'
  | 'W10'
  | 'W11'
  | 'W12'
  | 'W13'
  | 'W14';

/**
 * Which enforcement tier a fix belongs to. This is the field an executive
 * actually cares about: tier A costs a config push and nobody's attention,
 * tier C requires a human to change a habit.
 */
export type RemediationTier =
  /** Managed settings — deployed centrally, zero developer action. */
  | 'A'
  /** Runtime guard — deterministic interception at the moment of spend. */
  | 'B'
  /** Nudge — advice only; the developer chooses. */
  | 'C';

export interface Remediation {
  readonly summary: string;
  readonly tier: RemediationTier;
  /** The concrete thing to change — a setting name, a server to remove, a cap to set. */
  readonly action: string;
}

/**
 * One concrete, checkable fact supporting a finding. Never prose: a
 * reference the user can look up with `tokenlens verify`, plus the credits
 * attributed to it. `provenance.ui.test`-style discipline applies — a
 * finding with no evidence is not a finding.
 */
export interface Evidence {
  readonly kind: 'request' | 'session' | 'tool' | 'file' | 'model';
  /** requestId · sessionId · tool name · salted file hash · model id. */
  readonly ref: string;
  readonly detail: string;
  readonly credits?: number;
}

export interface WasteFinding {
  readonly class: WasteClass;
  readonly title: string;
  /**
   * Credits attributable to this cause. Nearly always `Modelled` — waste is
   * a counterfactual ("this would not have been spent"), and a
   * counterfactual is never a measurement however exact its inputs.
   */
  readonly credits: Value<number>;
  /**
   * 0..1. **Must vary with the evidence.** A detector that returns a
   * constant here is a defect, not a detector, and `detector.variance.test`
   * fails the build for it — this is the test that would have caught audit
   * defect D-03 on day one.
   */
  readonly confidence: number;
  readonly evidence: readonly Evidence[];
  readonly remediation: Remediation;
}

/**
 * Everything a detector may read. Assembled once and shared, so that
 * fourteen detectors do not each re-query SQLite — and so that a detector
 * physically cannot reach the network or the filesystem.
 */
export interface DetectContext {
  readonly requests: readonly RequestRow[];
  readonly toolCalls: readonly ToolCallRow[];
  readonly rounds: readonly RoundRow[];
  readonly edits: readonly EditRow[];
  readonly compactions: readonly CompactionRow[];
  readonly contentReferences: readonly ContentReferenceRow[];
  readonly costCentres: readonly CostCentreRow[];
  readonly ledger: LedgerSummary;
  /**
   * Credits per request — measured where GitHub published a figure,
   * rate-card estimated otherwise. Pre-computed because every detector
   * needs it and re-deriving it per detector risks the classes disagreeing
   * about what a request cost.
   */
  readonly creditsByRequest: ReadonlyMap<string, number>;
}

export interface WasteDetector {
  readonly class: WasteClass;
  /** Short human name, used as the report heading. */
  readonly name: string;
  detect(ctx: DetectContext): WasteFinding[];
}

/**
 * A waste class we have specified but **cannot honestly detect** with the
 * data available. Reported explicitly rather than silently omitted, so the
 * report distinguishes "we looked and found nothing" from "we cannot look"
 * — PLAN.md P5, degrade loudly.
 */
export interface UnavailableClass {
  readonly class: WasteClass;
  readonly name: string;
  /** What is missing, in plain terms. */
  readonly reason: string;
  /** What would have to change for this to become detectable. */
  readonly unblockedBy: string;
}
