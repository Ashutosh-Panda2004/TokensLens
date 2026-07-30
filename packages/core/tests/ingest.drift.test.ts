import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseJournalBuffer } from '../src/ingest/reader.js';
import { normaliseJournal, normaliseRequest } from '../src/ingest/normalise.js';
import { SchemaDriftError } from '../src/shared/errors.js';

const DRIFT_FIXTURE_URL = new URL(
  './fixtures/sessions/drift-missing-prompt-tokens.jsonl',
  import.meta.url,
);
const NO_SNAPSHOT_FIXTURE_URL = new URL('./fixtures/sessions/no-snapshot.jsonl', import.meta.url);

describe('schema drift — a missing required field never becomes a silent 0', () => {
  it('collects a SchemaDriftError for the bad request without discarding the good one', () => {
    const buffer = readFileSync(DRIFT_FIXTURE_URL);
    const parsed = parseJournalBuffer(buffer, DRIFT_FIXTURE_URL.pathname);
    const { records, driftErrors } = normaliseJournal(parsed, 'salt');

    expect(driftErrors).toHaveLength(1);
    expect(driftErrors[0]).toBeInstanceOf(SchemaDriftError);
    expect(driftErrors[0]?.context.field).toBe('requests[0].result.metadata.promptTokens');
    expect(driftErrors[0]?.context.sourceFile).toBe(DRIFT_FIXTURE_URL.pathname);

    // The second, well-formed request still comes through.
    expect(records).toHaveLength(1);
    expect(records[0]?.requestId).toBe('req-drift-good');
  });

  it('normaliseRequest throws SchemaDriftError directly for a request missing promptTokens', () => {
    const raw = {
      requestId: 'r1',
      timestamp: 1,
      modelId: 'm',
      result: { metadata: { outputTokens: 1, resolvedModel: 'm' } },
    };

    expect(() =>
      normaliseRequest(raw, { index: 0, sessionId: 's', sourceFile: 'f', offset: 0, salt: 'x' }),
    ).toThrow(SchemaDriftError);
  });

  it('normaliseRequest throws SchemaDriftError for a missing requestId', () => {
    const raw = {
      timestamp: 1,
      result: { metadata: { promptTokens: 1, outputTokens: 1, resolvedModel: 'm' } },
    };

    expect(() =>
      normaliseRequest(raw, { index: 0, sessionId: 's', sourceFile: 'f', offset: 0, salt: 'x' }),
    ).toThrow(SchemaDriftError);
  });

  it('a request with no result at all is skipped silently (incomplete, not drift)', () => {
    const record = normaliseRequest(
      { requestId: 'r1', timestamp: 1 },
      { index: 0, sessionId: 's', sourceFile: 'f', offset: 0, salt: 'x' },
    );
    expect(record).toBeUndefined();
  });

  it('a request with result but no metadata yet is skipped silently (incomplete, not drift)', () => {
    const record = normaliseRequest(
      { requestId: 'r1', timestamp: 1, result: {} },
      { index: 0, sessionId: 's', sourceFile: 'f', offset: 0, salt: 'x' },
    );
    expect(record).toBeUndefined();
  });

  it('an in-progress compaction summary (missing outcome/contextLengthBefore) is dropped, not thrown — the rest still land', () => {
    const record = normaliseRequest(
      {
        requestId: 'r1',
        timestamp: 1,
        result: {
          metadata: {
            promptTokens: 100,
            outputTokens: 10,
            resolvedModel: 'm',
            summaries: [
              {
                toolCallRoundId: 'a',
                model: 'm',
                numRounds: 1,
                durationMs: 1,
                outcome: 'full/success',
                contextLengthBefore: 1,
              },
              { toolCallRoundId: 'b', model: 'm', numRounds: 1, durationMs: 1 }, // in-progress — missing fields
            ],
          },
        },
      },
      { index: 0, sessionId: 's', sourceFile: 'f', offset: 0, salt: 'x' },
    );

    expect(record).toBeDefined();
    expect(record?.compactions).toHaveLength(1);
    expect(record?.compactions[0]?.toolCallRoundId).toBe('a');
  });

  it('a tool-call round missing modelId is kept (empirically absent on some real rounds), while one missing id/timestamp is dropped', () => {
    const record = normaliseRequest(
      {
        requestId: 'r1',
        timestamp: 1,
        result: {
          metadata: {
            promptTokens: 100,
            outputTokens: 10,
            resolvedModel: 'm',
            toolCallRounds: [
              { id: 'round-no-model', timestamp: 1, toolCalls: [] },
              { timestamp: 1, modelId: 'm', toolCalls: [] }, // missing id — genuinely malformed
            ],
          },
        },
      },
      { index: 0, sessionId: 's', sourceFile: 'f', offset: 0, salt: 'x' },
    );

    expect(record?.rounds).toHaveLength(1);
    expect(record?.rounds[0]).toEqual({ id: 'round-no-model', ts: 1, toolCalls: [], retries: 0 });
  });

  it('a textEditGroup response chunk with no resolvable uri is dropped, not thrown', () => {
    const record = normaliseRequest(
      {
        requestId: 'r1',
        timestamp: 1,
        result: { metadata: { promptTokens: 100, outputTokens: 10, resolvedModel: 'm' } },
        response: [{ kind: 'textEditGroup', edits: [[{ text: 'x' }]], done: true }], // no `uri`
      },
      { index: 0, sessionId: 's', sourceFile: 'f', offset: 0, salt: 'x' },
    );

    expect(record?.edits).toEqual([]);
  });

  it('a journal with no snapshot line at all raises a file-level SchemaDriftError', () => {
    const buffer = readFileSync(NO_SNAPSHOT_FIXTURE_URL);
    const parsed = parseJournalBuffer(buffer, NO_SNAPSHOT_FIXTURE_URL.pathname);

    expect(() => normaliseJournal(parsed, 'salt')).toThrow(SchemaDriftError);
  });
});
