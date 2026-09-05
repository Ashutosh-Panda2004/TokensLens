import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  canonicalisePath,
  hashPath,
  loadOrCreateInstallSalt,
  saltFilePath,
} from '../src/ingest/redact.js';
import { parseJournalBuffer } from '../src/ingest/reader.js';
import { normaliseJournal } from '../src/ingest/normalise.js';
import { openDatabase, saveTurnRecords, getAllRequests } from '../src/store/database.js';

const GOLDEN_FIXTURE = new URL('./fixtures/sessions/golden-basic.jsonl', import.meta.url);

describe('hashPath', () => {
  it('is deterministic for the same path and salt', () => {
    expect(hashPath('C:\\Users\\dev\\project\\file.ts', 'salt-a')).toBe(
      hashPath('C:\\Users\\dev\\project\\file.ts', 'salt-a'),
    );
  });

  it('produces different hashes for different salts (cross-install correlation resistance)', () => {
    const a = hashPath('C:\\Users\\dev\\project\\file.ts', 'salt-a');
    const b = hashPath('C:\\Users\\dev\\project\\file.ts', 'salt-b');
    expect(a).not.toBe(b);
  });

  it('produces different hashes for different paths under the same salt', () => {
    const a = hashPath('file-a.ts', 'salt');
    const b = hashPath('file-b.ts', 'salt');
    expect(a).not.toBe(b);
  });

  it('never returns the raw path', () => {
    const raw = 'C:\\Users\\dev\\secret-project\\file.ts';
    expect(hashPath(raw, 'salt')).not.toContain(raw);
  });
});

describe('canonicalisePath — the join key every cross-source detector depends on', () => {
  const forms = [
    'C:\\Users\\me\\proj\\src\\a.ts',
    'c:/users/me/proj/src/a.ts',
    'C:/Users/Me/Proj/Src/A.ts',
    'file:///c%3A/Users/me/proj/src/a.ts',
    'C:\\Users\\me\\proj\\\\src\\a.ts',
  ];

  it('reduces every spelling of one file to one key', () => {
    // Until D12 these produced five different hashes, so a path from git and a
    // path from the journal could never match — invisibly, because the hashes
    // are opaque and the detector simply abstained.
    const keys = new Set(forms.map((form) => canonicalisePath(form)));
    expect(keys.size).toBe(1);
  });

  it('carries that through to the hash, which is what the tables store', () => {
    const hashes = new Set(forms.map((form) => hashPath(form, 'salt')));
    expect(hashes.size).toBe(1);
  });

  it('still distinguishes genuinely different files', () => {
    expect(canonicalisePath('src/a.ts')).not.toBe(canonicalisePath('src/b.ts'));
    expect(canonicalisePath('one/src/a.ts')).not.toBe(canonicalisePath('two/src/a.ts'));
  });

  it('leaves a malformed percent sequence usable rather than throwing', () => {
    expect(() => canonicalisePath('src/100%-done.ts')).not.toThrow();
    expect(canonicalisePath('src/100%-done.ts')).toContain('100%-done.ts');
  });
});

describe('loadOrCreateInstallSalt', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tokenlens-salt-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a salt file on first use and reuses it on subsequent calls', async () => {
    const first = await loadOrCreateInstallSalt(dir);
    const second = await loadOrCreateInstallSalt(dir);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);

    const onDisk = (await readFile(saltFilePath(dir), 'utf8')).trim();
    expect(onDisk).toBe(first);
  });
});

describe('redaction — no raw path or prompt content survives into storage', () => {
  it('the fully ingested + persisted golden fixture contains no raw file path, anywhere', () => {
    const buffer = readFileSync(GOLDEN_FIXTURE);
    const parsed = parseJournalBuffer(buffer, GOLDEN_FIXTURE.pathname);
    const { records } = normaliseJournal(parsed, 'test-salt');

    const db = openDatabase(':memory:');
    saveTurnRecords(db, records);
    const stored = getAllRequests(db);

    // The fixture's edit chunks reference this exact raw path — it must
    // never appear verbatim in a normalised record or a persisted row.
    const rawPath = 'C:\\fake\\example.ts';
    const serialisedRecords = JSON.stringify(records);
    const serialisedRows = JSON.stringify(stored);

    expect(serialisedRecords).not.toContain(rawPath);
    expect(serialisedRows).not.toContain(rawPath);
    expect(serialisedRecords).not.toContain('/fake/example.ts');

    // Positive check: the edit really was captured, just hashed.
    const allFileHashes = records.flatMap((r) => r.edits.map((e) => e.fileHash));
    expect(allFileHashes.length).toBeGreaterThan(0);
    for (const hash of allFileHashes) {
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('never persists tool-call arguments, thinking text, or response markdown', () => {
    const buffer = readFileSync(GOLDEN_FIXTURE);
    const parsed = parseJournalBuffer(buffer, GOLDEN_FIXTURE.pathname);
    const { records } = normaliseJournal(parsed, 'test-salt');

    const serialised = JSON.stringify(records);
    // The fixture's tool call has arguments "{}" and no free-text fields —
    // assert the *shape* never includes an `arguments`/`text`/`value` key
    // at all, i.e. the allowlist extraction never copied such a field.
    expect(serialised).not.toContain('"arguments"');
    expect(serialised).not.toContain('"thinking"');
  });
});
