import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseJournalBuffer } from '../src/ingest/reader.js';
import { normaliseJournal } from '../src/ingest/normalise.js';

const FIXTURE_URL = new URL('./fixtures/sessions/malformed-truncated.jsonl', import.meta.url);

describe('a truncated trailing line (process killed mid-append)', () => {
  it('parses every earlier well-formed line, counts the truncated one as malformed, and never throws', () => {
    const buffer = readFileSync(FIXTURE_URL);

    expect(() => parseJournalBuffer(buffer, FIXTURE_URL.pathname)).not.toThrow();
    const parsed = parseJournalBuffer(buffer, FIXTURE_URL.pathname);

    expect(parsed.stats.totalLines).toBe(3);
    expect(parsed.stats.malformedLines).toBe(1);
    expect(parsed.doc).toMatchObject({ sessionId: 'session-malformed' });
  });

  it('still yields the one complete request that preceded the truncation', () => {
    const buffer = readFileSync(FIXTURE_URL);
    const parsed = parseJournalBuffer(buffer, FIXTURE_URL.pathname);
    const { records, driftErrors } = normaliseJournal(parsed, 'salt');

    expect(driftErrors).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]?.requestId).toBe('req-malformed-1');
    expect(records[0]?.promptTokens).toBe(2000);
  });
});
