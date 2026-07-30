import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseJournalBuffer } from '../src/ingest/reader.js';
import { normaliseJournal } from '../src/ingest/normalise.js';

const FIXTURE_URL = new URL('./fixtures/sessions/golden-basic.jsonl', import.meta.url);
const SALT = 'golden-test-salt';

/** Byte offset of the start of the given 1-based line number in `content`. */
function offsetOfLine(content: Buffer, lineNumber: number): number {
  const text = content.toString('utf8');
  const lines = text.split('\n');
  const prefix = lines.slice(0, lineNumber - 1).join('\n') + (lineNumber > 1 ? '\n' : '');
  return Buffer.byteLength(prefix, 'utf8');
}

describe('ingest golden fixture', () => {
  const buffer = readFileSync(FIXTURE_URL);
  const parsed = parseJournalBuffer(buffer, FIXTURE_URL.pathname);
  const { records, driftErrors } = normaliseJournal(parsed, SALT);

  it('produces exactly the two known TurnRecords, with zero drift', () => {
    expect(driftErrors).toEqual([]);
    expect(records).toHaveLength(2);
  });

  it('req-golden-1: field-for-field, including the multi-line-updated source offset', () => {
    const record = records[0];
    expect(record).toBeDefined();
    if (!record) return;

    expect(record.sessionId).toBe('session-golden');
    expect(record.requestId).toBe('req-golden-1');
    expect(record.ts).toBe(1735689600000);
    expect(record.model).toBe('copilot/claude-sonnet-5');
    expect(record.promptTokens).toBe(10000);
    expect(record.outputTokens).toBe(500);
    expect(record.credits).toBe(12.5);
    expect(record.turnIndex).toBe(0);

    // This request's data is assembled across lines 2-6 (append, then
    // three further patches); the source offset must point at the LAST
    // line that touched it (line 6: the kind=2 append to `.response`),
    // not the line that first created it.
    expect(record.source.file).toBe(FIXTURE_URL.pathname);
    expect(record.source.offset).toBe(offsetOfLine(buffer, 6));
  });

  it('req-golden-1: cost centres sum to promptTokens exactly', () => {
    const record = records[0];
    expect(record?.costCentres).toHaveLength(5);
    const totalTokens = record?.costCentres.reduce((sum, c) => sum + c.tokens, 0);
    expect(totalTokens).toBe(record?.promptTokens);
    expect(record?.costCentres.map((c) => c.label)).toEqual([
      'System Instructions',
      'Tool Definitions',
      'Messages',
      'Files',
      'Tool Results',
    ]);
  });

  it('req-golden-1: one tool-call round, with arguments dropped (redaction)', () => {
    const record = records[0];
    expect(record?.rounds).toHaveLength(1);
    const round = record?.rounds[0];
    expect(round?.id).toBe('round-1');
    expect(round?.modelId).toBe('copilot/claude-sonnet-5');
    expect(round?.thinkingTokens).toBe(42);
    expect(round?.retries).toBe(0);
    expect(round?.toolCalls).toEqual([{ id: 'call-1', name: 'read_file' }]);
    // Never `arguments` — dropped by allowlist extraction.
    expect(round).not.toHaveProperty('arguments');
  });

  it('req-golden-1: edits across two response chunks for the same file are merged', () => {
    const record = records[0];
    expect(record?.edits).toHaveLength(1);
    const edit = record?.edits[0];
    expect(edit?.editCount).toBe(2); // one edit operation per chunk
    expect(edit?.done).toBe(true); // second chunk reported done: true
    expect(edit?.fileHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('req-golden-2: no measured credits, has a compaction event, empty edits', () => {
    const record = records[1];
    expect(record).toBeDefined();
    if (!record) return;

    expect(record.requestId).toBe('req-golden-2');
    expect(record.credits).toBeUndefined();
    expect(record.turnIndex).toBe(1);
    expect(record.rounds).toEqual([]);
    expect(record.edits).toEqual([]);

    expect(record.compactions).toHaveLength(1);
    expect(record.compactions[0]).toEqual({
      toolCallRoundId: 'round-x',
      model: 'copilot/claude-haiku-4-5',
      numRounds: 12,
      durationMs: 92000,
      outcome: 'full/success',
      contextLengthBefore: 120000,
    });

    // Created entirely by the single append line (line 7).
    expect(record.source.offset).toBe(offsetOfLine(buffer, 7));
  });
});
