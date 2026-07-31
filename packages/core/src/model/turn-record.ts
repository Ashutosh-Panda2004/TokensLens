/**
 * The normalised, public shape every downstream phase (ledger, waste
 * attribution, simulation, policy) consumes. This is deliberately a
 * narrow *allowlist* of fields, not a pass-through of the raw journal:
 * anything not modelled here (message text, tool-call arguments, thinking
 * content, response markdown) is never extracted from the journal in the
 * first place — see `ingest/normalise.ts`. Redaction is enforced by
 * construction, not by a best-effort scrub after the fact.
 *
 * Field names and shapes are grounded in empirical inspection of a real
 * `chatSessions/*.jsonl` journal (DEVELOPMENT-PLAN.md Phase D1; see
 * `ingest/raw-types.ts` for the wire shapes this is derived from).
 */
export interface TurnRecord {
  readonly sessionId: string;
  readonly requestId: string;
  /** Epoch milliseconds. */
  readonly ts: number;
  /** `result.metadata.resolvedModel`, falling back to the request's `modelId`. */
  readonly model: string;
  readonly promptTokens: number;
  readonly outputTokens: number;
  /** `copilotCredits` — present on a minority of requests (F12: ~9.4%). */
  readonly credits?: number;
  /** `promptTokenDetails` — the five-way cost-centre split (F2). */
  readonly costCentres: readonly CostCentre[];
  readonly rounds: readonly ToolCallRound[];
  readonly edits: readonly EditRecord[];
  readonly compactions: readonly CompactionEvent[];
  /** Files the model was shown as references — drives W11 (search-snippet leakage). */
  readonly contentReferences: readonly ContentReference[];
  /** 0-based position of this request within its session — drives W4 (session staleness). */
  readonly turnIndex: number;
  /** Where this record's numbers came from, for `tokenlens verify`. */
  readonly source: TurnRecordSource;
}

export interface TurnRecordSource {
  readonly file: string;
  /** Byte offset (not character offset) of the JSONL line this record was built from. */
  readonly offset: number;
}

export type CostCentreCategory = 'System' | 'User Context';

export type CostCentreLabel =
  'System Instructions' | 'Tool Definitions' | 'Messages' | 'Files' | 'Tool Results';

export interface CostCentre {
  readonly category: CostCentreCategory;
  readonly label: CostCentreLabel;
  readonly percentageOfPrompt: number;
  /** Derived: `round(percentageOfPrompt / 100 * promptTokens)`. */
  readonly tokens: number;
}

export interface ToolCallInvocation {
  readonly id: string;
  readonly name: string;
  /**
   * Characters of text in this call's recorded result. **Measured and
   * exact** — it is a length, not an estimate. Converting it to tokens is
   * an approximation and is done downstream, tagged `Modelled`
   * (`ingest/tool-results.ts`). Absent when the journal recorded no result
   * for this call (the tool errored, or the file was truncated mid-write).
   *
   * The payload itself is never stored — only its length. This is what
   * lets W3 price an oversized tool result without retaining a byte of it.
   */
  readonly resultChars?: number;
  /**
   * Salted hash of the file this call targeted, when its arguments named
   * one. Drives W2 (duplicate retrieval). The raw path is hashed inside
   * `ingest/tool-target.ts` and never leaves it.
   */
  readonly targetFileHash?: string;
  /** Line range for range-scoped reads — lets W2 tell a genuine re-read from a different slice of the same file. */
  readonly targetStartLine?: number;
  readonly targetEndLine?: number;
}

/**
 * A file surfaced to the model as a reference (`contentReferences[]` in the
 * journal) — attachments, search hits and previews the model was shown.
 * Drives W11: tokens billed for files that were referenced but never opened.
 */
export interface ContentReference {
  /** Salted hash of the referenced file's path — never the raw path. */
  readonly fileHash: string;
}

export interface ToolCallRound {
  readonly id: string;
  readonly ts: number;
  /** Absent on some rounds empirically — not every session records a per-round model id. */
  readonly modelId?: string;
  readonly toolCalls: readonly ToolCallInvocation[];
  /** Reasoning/thinking token count, when the model reports one. */
  readonly thinkingTokens?: number;
  readonly retries: number;
}

export interface EditRecord {
  /** Salted hash of the edited file's path — never the raw path (redaction). */
  readonly fileHash: string;
  /** Count of individual edit operations across all batches for this file in this turn. */
  readonly editCount: number;
  readonly done: boolean;
}

/**
 * One auto-compaction event (F9). Sourced from `result.metadata.summaries[]`
 * — VS Code's own name for a compaction is a context "summary".
 */
export interface CompactionEvent {
  readonly toolCallRoundId: string;
  readonly model: string;
  readonly numRounds: number;
  readonly durationMs: number;
  readonly outcome: string;
  readonly contextLengthBefore: number;
}
