import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDatabase, saveTurnRecords, getRequestById } from '../src/store/database.js';
import { parseJournalBuffer } from '../src/ingest/reader.js';
import { normaliseJournal } from '../src/ingest/normalise.js';

const FIXTURE_URL = new URL('./fixtures/sessions/golden-basic.jsonl', import.meta.url);

describe('verify — every figure resolves to a real file + byte offset', () => {
  it('getRequestById returns the exact source file and offset the record was normalised from', () => {
    const buffer = readFileSync(FIXTURE_URL);
    const parsed = parseJournalBuffer(buffer, FIXTURE_URL.pathname);
    const { records } = normaliseJournal(parsed, 'salt');

    const db = openDatabase(':memory:');
    saveTurnRecords(db, records);

    for (const record of records) {
      const row = getRequestById(db, record.requestId);
      expect(row).toBeDefined();
      expect(row?.sourceFile).toBe(record.source.file);
      expect(row?.sourceOffset).toBe(record.source.offset);

      // The offset must be a real, readable position in the actual file —
      // not just a number that happens to be present.
      expect(row?.sourceOffset).toBeGreaterThanOrEqual(0);
      expect(row?.sourceOffset).toBeLessThan(buffer.length);
    }
  });

  it('preserves the measured vs. absent distinction for credits through storage', () => {
    const buffer = readFileSync(FIXTURE_URL);
    const parsed = parseJournalBuffer(buffer, FIXTURE_URL.pathname);
    const { records } = normaliseJournal(parsed, 'salt');

    const db = openDatabase(':memory:');
    saveTurnRecords(db, records);

    const withCredits = getRequestById(db, 'req-golden-1');
    const withoutCredits = getRequestById(db, 'req-golden-2');

    expect(withCredits?.credits).toBe(12.5);
    expect(withoutCredits?.credits).toBeNull();
  });

  it('returns undefined for a request id that does not exist', () => {
    const db = openDatabase(':memory:');
    expect(getRequestById(db, 'does-not-exist')).toBeUndefined();
  });
});
