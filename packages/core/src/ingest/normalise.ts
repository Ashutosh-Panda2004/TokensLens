import { SchemaDriftError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { asArray, asBoolean, asFiniteNumber, asRecord, asString } from '../shared/guards.js';
import { hashPath } from './redact.js';
import { measureResultChars } from './tool-results.js';
import { extractToolCallTarget } from './tool-target.js';
import type { ParsedJournal } from './reader.js';
import type {
  CompactionEvent,
  ContentReference,
  CostCentre,
  CostCentreCategory,
  CostCentreLabel,
  EditRecord,
  ToolCallInvocation,
  ToolCallRound,
  TurnRecord,
} from '../model/turn-record.js';

export interface NormaliseResult {
  readonly records: readonly TurnRecord[];
  /** One per request that failed to normalise for a genuine schema-drift reason (not a merely-incomplete request). */
  readonly driftErrors: readonly SchemaDriftError[];
}

/**
 * Maps a fully-replayed journal document into `TurnRecord[]`.
 *
 * Two very different "this request has no numbers" cases are
 * distinguished deliberately:
 *
 *  - **Incomplete** (no `result`, or `result` with no `metadata` yet) —
 *    normal for an in-flight or abandoned request. Silently excluded from
 *    the output; not an error.
 *  - **Drift** (`metadata` exists but is missing a field it should always
 *    have, e.g. `promptTokens`) — the shape genuinely changed. Raised as
 *    {@link SchemaDriftError} per request, collected in `driftErrors`
 *    rather than aborting the whole file, so one bad request doesn't
 *    discard everything else in the session. Callers (Phase D1.8's CI
 *    gate) compare `driftErrors.length` against `records.length` to
 *    decide whether the *extraction rate* has dropped too far.
 */
export function normaliseJournal(parsed: ParsedJournal, salt: string): NormaliseResult {
  const root = asRecord(parsed.doc);
  const sessionId = root && asString(root.sessionId);
  const requests = root && asArray(root.requests);

  if (!root || !sessionId || !requests) {
    throw new SchemaDriftError(
      `${parsed.sourceFile} does not contain a recognisable session document ` +
        `(expected an object with string "sessionId" and array "requests").`,
      {
        field: 'sessionId|requests',
        expected: 'object with sessionId: string, requests: array',
        actual: parsed.doc,
        sourceFile: parsed.sourceFile,
      },
    );
  }

  const records: TurnRecord[] = [];
  const driftErrors: SchemaDriftError[] = [];

  requests.forEach((raw, index) => {
    let record: TurnRecord | undefined;
    try {
      record = normaliseRequest(raw, {
        index,
        sessionId,
        sourceFile: parsed.sourceFile,
        offset: parsed.requestOffsets.get(index) ?? 0,
        salt,
      });
    } catch (error) {
      if (error instanceof SchemaDriftError) {
        driftErrors.push(error);
        return;
      }
      throw error;
    }
    if (record) records.push(record);
  });

  return { records, driftErrors };
}

interface NormaliseContext {
  readonly index: number;
  readonly sessionId: string;
  readonly sourceFile: string;
  readonly offset: number;
  readonly salt: string;
}

const KNOWN_COST_CENTRE_LABELS: ReadonlySet<string> = new Set<CostCentreLabel>([
  'System Instructions',
  'Tool Definitions',
  'Messages',
  'Files',
  'Tool Results',
]);

/**
 * Normalises a single raw request object. Returns `undefined` when the
 * request is merely incomplete (never finished); throws
 * {@link SchemaDriftError} when a field that should be present, given the
 * surrounding structure, is not.
 */
export function normaliseRequest(raw: unknown, ctx: NormaliseContext): TurnRecord | undefined {
  const request = asRecord(raw);
  if (!request) return undefined;

  const result = asRecord(request.result);
  if (!result) return undefined; // never completed — not drift, just incomplete

  const metadata = asRecord(result.metadata);
  if (!metadata) return undefined; // result exists but hasn't been populated yet

  // From here on, `metadata` exists — its core fields are now required.
  const requestId = asString(request.requestId);
  if (!requestId) {
    throw driftError(ctx, 'requestId', 'string', request.requestId);
  }

  const ts = asFiniteNumber(request.timestamp);
  if (ts === undefined) {
    throw driftError(ctx, 'timestamp', 'finite number', request.timestamp);
  }

  const promptTokens = asFiniteNumber(metadata.promptTokens);
  if (promptTokens === undefined) {
    throw driftError(ctx, 'result.metadata.promptTokens', 'finite number', metadata.promptTokens);
  }

  const outputTokens = asFiniteNumber(metadata.outputTokens);
  if (outputTokens === undefined) {
    throw driftError(ctx, 'result.metadata.outputTokens', 'finite number', metadata.outputTokens);
  }

  const model = asString(metadata.resolvedModel) ?? asString(request.modelId);
  if (!model) {
    throw driftError(
      ctx,
      'result.metadata.resolvedModel|modelId',
      'string',
      metadata.resolvedModel,
    );
  }

  const credits = asFiniteNumber(request.copilotCredits);
  const costCentres = normaliseCostCentres(request.promptTokenDetails, promptTokens, ctx);
  const rounds = normaliseToolCallRounds(metadata.toolCallRounds, metadata.toolCallResults, ctx);
  const compactions = normaliseCompactions(metadata.summaries, ctx);
  const edits = normaliseEdits(request.response, ctx.salt, ctx);
  const contentReferences = normaliseContentReferences(request.contentReferences, ctx.salt);

  return {
    sessionId: ctx.sessionId,
    requestId,
    ts,
    model,
    promptTokens,
    outputTokens,
    ...(credits !== undefined ? { credits } : {}),
    costCentres,
    rounds,
    edits,
    compactions,
    contentReferences,
    turnIndex: ctx.index,
    source: { file: ctx.sourceFile, offset: ctx.offset },
  };
}

/**
 * Extracts the files the model was shown as references. Each is reduced to a
 * salted path hash immediately; the reference's display name, preview text
 * and raw URI are all discarded. Duplicates within one request are collapsed
 * — a file referenced three times in one turn is one referenced file.
 */
function normaliseContentReferences(raw: unknown, salt: string): ContentReference[] {
  const items = asArray(raw) ?? [];
  const seen = new Set<string>();

  for (const item of items) {
    const record = asRecord(item);
    const reference = record && asRecord(record.reference);
    if (!reference) continue;

    // Real journals nest the URI one level deeper under `value`; some
    // reference kinds put it directly on the reference itself.
    const uri = asRecord(reference.value) ?? reference;
    const filePath = asString(uri.fsPath) ?? asString(uri.path);
    if (!filePath) continue;

    seen.add(hashPath(filePath, salt));
  }

  return [...seen].map((fileHash) => ({ fileHash }));
}

function driftError(
  ctx: NormaliseContext,
  field: string,
  expected: string,
  actual: unknown,
): SchemaDriftError {
  return new SchemaDriftError(
    `requests[${String(ctx.index)}].${field} is missing or the wrong type in ${ctx.sourceFile}.`,
    {
      field: `requests[${String(ctx.index)}].${field}`,
      expected,
      actual,
      sourceFile: ctx.sourceFile,
    },
  );
}

function normaliseCostCentres(
  raw: unknown,
  promptTokens: number,
  ctx: NormaliseContext,
): CostCentre[] {
  const items = asArray(raw) ?? [];
  const centres: CostCentre[] = [];

  for (const [i, item] of items.entries()) {
    const record = asRecord(item);
    const category = record && asString(record.category);
    const label = record && asString(record.label);
    const percentageOfPrompt = record && asFiniteNumber(record.percentageOfPrompt);

    if (!category || !label || percentageOfPrompt === undefined) {
      logger.debug(
        `Skipping malformed cost-centre entry ${String(i)} in requests[${String(ctx.index)}] (${ctx.sourceFile})`,
      );
      continue;
    }
    if (!KNOWN_COST_CENTRE_LABELS.has(label)) {
      logger.debug(
        `Unrecognised cost-centre label "${label}" in ${ctx.sourceFile} — kept, not dropped`,
      );
    }

    centres.push({
      category: category as CostCentreCategory,
      label: label as CostCentreLabel,
      percentageOfPrompt,
      tokens: Math.round((percentageOfPrompt / 100) * promptTokens),
    });
  }

  return centres;
}

function normaliseToolCallRounds(
  raw: unknown,
  rawResults: unknown,
  ctx: NormaliseContext,
): ToolCallRound[] {
  const items = asArray(raw) ?? [];
  const rounds: ToolCallRound[] = [];

  for (const [i, item] of items.entries()) {
    const record = asRecord(item);
    const id = record && asString(record.id);
    const timestamp = record && asFiniteNumber(record.timestamp);
    // modelId is empirically absent on some rounds (not every session
    // records a per-round model) — optional, not a malformed-entry signal.
    const modelId = record && asString(record.modelId);

    if (!record || !id || timestamp === undefined) {
      logger.debug(
        `Skipping malformed tool-call round ${String(i)} in requests[${String(ctx.index)}] (${ctx.sourceFile})`,
      );
      continue;
    }

    const rawToolCalls = asArray(record.toolCalls) ?? [];
    const results = asRecord(rawResults);
    const toolCalls = rawToolCalls
      .map((call): ToolCallInvocation | undefined => {
        const callRecord = asRecord(call);
        const callId = callRecord && asString(callRecord.id);
        const name = callRecord && asString(callRecord.name);
        if (!callRecord || !callId || !name) return undefined;

        // `arguments` is parsed only to lift one file path out of it, which
        // is hashed on the spot — see ingest/tool-target.ts. The raw string
        // is never retained.
        const target = extractToolCallTarget(asString(callRecord.arguments), ctx.salt);

        // The result payload is measured, then dropped. Only the length survives.
        const resultChars =
          results && callId in results ? measureResultChars(results[callId]) : undefined;

        return {
          id: callId,
          name,
          ...(resultChars !== undefined ? { resultChars } : {}),
          ...(target ? { targetFileHash: target.fileHash } : {}),
          ...(target?.startLine !== undefined ? { targetStartLine: target.startLine } : {}),
          ...(target?.endLine !== undefined ? { targetEndLine: target.endLine } : {}),
        };
      })
      .filter((call): call is ToolCallInvocation => call !== undefined);

    const thinking = asRecord(record.thinking);
    const thinkingTokens = thinking ? asFiniteNumber(thinking.tokens) : undefined;
    const retries = asFiniteNumber(record.toolInputRetry) ?? 0;

    rounds.push({
      id,
      ts: timestamp,
      ...(modelId ? { modelId } : {}),
      toolCalls,
      ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
      retries,
    });
  }

  return rounds;
}

function normaliseCompactions(raw: unknown, ctx: NormaliseContext): CompactionEvent[] {
  const items = asArray(raw) ?? [];
  const compactions: CompactionEvent[] = [];

  for (const [i, item] of items.entries()) {
    const record = asRecord(item);
    const toolCallRoundId = record && asString(record.toolCallRoundId);
    const model = record && asString(record.model);
    const numRounds = record && asFiniteNumber(record.numRounds);
    const durationMs = record && asFiniteNumber(record.durationMs);
    const outcome = record && asString(record.outcome);
    const contextLengthBefore = record && asFiniteNumber(record.contextLengthBefore);

    if (
      !toolCallRoundId ||
      !model ||
      numRounds === undefined ||
      durationMs === undefined ||
      !outcome ||
      contextLengthBefore === undefined
    ) {
      logger.debug(
        `Skipping malformed compaction summary ${String(i)} in requests[${String(ctx.index)}] (${ctx.sourceFile})`,
      );
      continue;
    }

    compactions.push({
      toolCallRoundId,
      model,
      numRounds,
      durationMs,
      outcome,
      contextLengthBefore,
    });
  }

  return compactions;
}

/**
 * Scans `response[]` for `kind: "textEditGroup"` chunks (VS Code's name
 * for a file-edit event) and aggregates them per file, hashing the path
 * (never storing it raw) and counting individual edit operations without
 * retaining their text.
 */
function normaliseEdits(raw: unknown, salt: string, ctx: NormaliseContext): EditRecord[] {
  const chunks = asArray(raw) ?? [];
  const byFile = new Map<string, { editCount: number; done: boolean }>();

  for (const chunk of chunks) {
    const record = asRecord(chunk);
    if (!record || asString(record.kind) !== 'textEditGroup') continue;

    const uri = asRecord(record.uri);
    const filePath = (uri && (asString(uri.fsPath) ?? asString(uri.path))) ?? undefined;
    if (!filePath) {
      logger.debug(
        `textEditGroup chunk with no resolvable uri in requests[${String(ctx.index)}] (${ctx.sourceFile})`,
      );
      continue;
    }

    const fileHash = hashPath(filePath, salt);
    const editBatches = asArray(record.edits) ?? [];
    const editCount = editBatches.reduce(
      (sum: number, batch) => sum + (asArray(batch)?.length ?? 0),
      0,
    );
    const done = asBoolean(record.done) ?? false;

    const existing = byFile.get(fileHash);
    byFile.set(fileHash, {
      editCount: (existing?.editCount ?? 0) + editCount,
      done: (existing?.done ?? false) || done,
    });
  }

  return [...byFile.entries()].map(([fileHash, { editCount, done }]) => ({
    fileHash,
    editCount,
    done,
  }));
}
