import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { buildExportData, exportJson, renderStaticHtmlReport } from '../src/dashboard/export.js';
import { buildWasteReport } from '../src/waste/report.js';
import {
  assertReportSafe,
  findPrivacyViolations,
  mayIncludeEntityList,
} from '../src/privacy/guard.js';
import {
  assertSharedReportAllowed,
  mayListIndividuals,
  MIN_GROUP_SIZE,
  type PrivacyContext,
} from '../src/privacy/scope.js';
import {
  hashIdentifier,
  isPathRedacted,
  shortId,
  toJournalRelativePath,
} from '../src/privacy/identifiers.js';
import { normaliseJournal } from '../src/ingest/normalise.js';
import { parseJournalBuffer } from '../src/ingest/reader.js';
import { PrivacyError } from '../src/shared/errors.js';
import type { TurnRecord } from '../src/model/turn-record.js';

const SELF: PrivacyContext = { scope: 'self', subjectCount: 1 };
const SHARED_SOLO: PrivacyContext = { scope: 'shared', subjectCount: 1 };
const SHARED_SMALL: PrivacyContext = { scope: 'shared', subjectCount: 3 };
const SHARED_LARGE: PrivacyContext = { scope: 'shared', subjectCount: 12 };

function record(overrides: Partial<TurnRecord> & Pick<TurnRecord, 'requestId' | 'ts'>): TurnRecord {
  return {
    sessionId: 'hashed-session',
    model: 'model-a',
    promptTokens: 10_000,
    outputTokens: 500,
    credits: 5,
    costCentres: [],
    rounds: [],
    edits: [],
    compactions: [],
    contentReferences: [],
    turnIndex: 0,
    source: { file: 'ws-id/chatSessions/s.jsonl', offset: 0 },
    ...overrides,
  };
}

describe('identifier redaction', () => {
  it('strips the home directory from a Windows journal path', () => {
    const raw =
      'C:\\Users\\alice\\AppData\\Roaming\\Code\\User\\workspaceStorage\\abc123\\chatSessions\\s.jsonl';
    const redacted = toJournalRelativePath(raw);

    expect(redacted).toBe('abc123/chatSessions/s.jsonl');
    expect(redacted).not.toContain('alice');
    expect(redacted).not.toContain('Users');
  });

  it('strips the home directory from a POSIX journal path', () => {
    const raw = '/home/bob/.config/Code/User/workspaceStorage/xyz/chatSessions/s.jsonl';
    const redacted = toJournalRelativePath(raw);

    expect(redacted).toBe('xyz/chatSessions/s.jsonl');
    expect(redacted).not.toContain('bob');
  });

  it('recognises an unredacted path so the guard can refuse it', () => {
    expect(isPathRedacted('C:/Users/alice/x.jsonl')).toBe(false);
    expect(isPathRedacted('/home/bob/x.jsonl')).toBe(false);
    expect(isPathRedacted('/Users/carol/x.jsonl')).toBe(false);
    expect(isPathRedacted('abc123/chatSessions/s.jsonl')).toBe(true);
  });

  it('hashes an identifier stably within a salt and differently across salts', () => {
    expect(hashIdentifier('session-1', 'salt-a')).toBe(hashIdentifier('session-1', 'salt-a'));
    expect(hashIdentifier('session-1', 'salt-a')).not.toBe(hashIdentifier('session-1', 'salt-b'));
    expect(hashIdentifier('session-1', 'salt-a')).not.toBe(hashIdentifier('session-2', 'salt-a'));
  });

  it('never returns the original value from a hash', () => {
    const hashed = hashIdentifier('a-very-distinctive-session-id', 'salt');
    expect(hashed).not.toContain('distinctive');
    expect(hashed).toMatch(/^[0-9a-f]{16}$/);
    expect(shortId(hashed)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('ingest never stores a raw identifier', () => {
  // The strongest form of this guarantee: run the real ingest path over a
  // journal whose session id and file path both contain obvious personal
  // markers, and assert neither survives into the record.
  const journal = [
    JSON.stringify({
      kind: 0,
      v: {
        sessionId: 'alices-private-session',
        requests: [
          {
            requestId: 'req-1',
            timestamp: 1735689600000,
            modelId: 'm',
            result: { metadata: { promptTokens: 100, outputTokens: 10, resolvedModel: 'm' } },
          },
        ],
      },
    }),
  ].join('\n');

  const parsed = parseJournalBuffer(
    Buffer.from(journal, 'utf8'),
    'C:/Users/alice/AppData/Roaming/Code/User/workspaceStorage/ws-1/chatSessions/s.jsonl',
  );
  const { records } = normaliseJournal(parsed, 'a-salt');

  it('hashes the session id', () => {
    expect(records[0]?.sessionId).not.toContain('alice');
    expect(records[0]?.sessionId).toBe(hashIdentifier('alices-private-session', 'a-salt'));
  });

  it('drops the username from the source path while keeping it resolvable', () => {
    const file = records[0]?.source.file ?? '';
    expect(file).not.toContain('alice');
    expect(file).not.toContain('Users');
    // Still enough to find the file locally by joining the journal root.
    expect(file).toBe('ws-1/chatSessions/s.jsonl');
  });
});

describe('k-anonymity', () => {
  it('allows a report about a single subject — there is nobody to single out', () => {
    // The subject is the author. Refusing would stop a developer sharing
    // their own figures with their own manager, protecting nobody.
    expect(() => {
      assertSharedReportAllowed(SHARED_SOLO);
    }).not.toThrow();
  });

  it('refuses a small group, where aggregates decompose back to a person', () => {
    expect(() => {
      assertSharedReportAllowed(SHARED_SMALL);
    }).toThrow(PrivacyError);
  });

  it.each([2, 3, 4])('refuses a group of %i', (subjectCount) => {
    expect(() => {
      assertSharedReportAllowed({ scope: 'shared', subjectCount });
    }).toThrow(PrivacyError);
  });

  it('allows a group at or above the floor', () => {
    expect(() => {
      assertSharedReportAllowed({ scope: 'shared', subjectCount: MIN_GROUP_SIZE });
    }).not.toThrow();
  });

  it('never restricts self scope', () => {
    expect(() => {
      assertSharedReportAllowed({ scope: 'self', subjectCount: 3 });
    }).not.toThrow();
  });

  it('suppresses per-entity lists in every shared scope below the floor', () => {
    expect(mayListIndividuals(SELF)).toBe(true);
    expect(mayListIndividuals(SHARED_SOLO)).toBe(false);
    expect(mayListIndividuals(SHARED_SMALL)).toBe(false);
    expect(mayListIndividuals(SHARED_LARGE)).toBe(true);
  });
});

describe('the guard blocks a leak it was not told about', () => {
  it('catches a raw session id anywhere in the payload', () => {
    const violations = findPrivacyViolations({ rows: [{ sessionId: 'abc' }] }, SHARED_SOLO);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.at).toBe('$.rows[0].sessionId');
  });

  it('catches an absolute path that ingest failed to redact', () => {
    const violations = findPrivacyViolations(
      { source: { sourceFile: 'C:/Users/alice/x.jsonl' } },
      SHARED_SOLO,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain('identifies a machine');
  });

  it('accepts a redacted path', () => {
    expect(
      findPrivacyViolations({ source: { sourceFile: 'ws/chatSessions/s.jsonl' } }, SHARED_SOLO),
    ).toEqual([]);
  });

  it('does not restrict self scope', () => {
    expect(findPrivacyViolations({ sessionId: 'abc' }, SELF)).toEqual([]);
  });

  it('throws with every offending field named, so the leak can be found', () => {
    expect(() => {
      assertReportSafe({ a: { sessionId: 'x' }, b: { sessionId: 'y' } }, SHARED_SOLO);
    }).toThrow(/2 field\(s\) would expose an individual/);
  });
});

describe('exports are safe by default', () => {
  const db = openDatabase(':memory:');
  saveTurnRecords(db, [
    record({ requestId: 'r1', ts: Date.UTC(2026, 5, 1) }),
    record({ requestId: 'r2', ts: Date.UTC(2026, 5, 2), sessionId: 'hashed-session-2' }),
  ]);

  it('withholds the per-session breakdown unless self scope is asked for', () => {
    expect(buildExportData(db, 'enterprise', new Date()).ledger.bySession).toEqual([]);
    expect(
      buildExportData(db, 'enterprise', new Date(), SELF).ledger.bySession.length,
    ).toBeGreaterThan(0);
  });

  it('says in the report that detail was withheld, rather than looking like no data', () => {
    const html = renderStaticHtmlReport(buildExportData(db, 'enterprise', new Date()));
    expect(html).toContain('Per-session detail is withheld');
    expect(html).not.toContain('Session leaderboard');
  });

  it('writes a JSON export that contains no identifier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenlens-privacy-'));
    try {
      const file = join(dir, 'report.json');
      await exportJson(db, file, 'enterprise');
      const text = await readFile(file, 'utf8');

      expect(text).not.toContain('hashed-session');
      expect(text).not.toContain('C:/Users');
      expect(text).not.toContain('C:\\\\Users');
      expect(JSON.parse(text)).toHaveProperty('privacy.scope', 'shared');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the waste report withholds individual evidence when shared', () => {
  function corpus(): Database.Database {
    const db = openDatabase(':memory:');
    const records: TurnRecord[] = [];
    for (let turn = 0; turn < 20; turn++) {
      records.push(
        record({
          requestId: `stale-${String(turn)}`,
          ts: 1_000 + turn,
          sessionId: 'session-long',
          turnIndex: turn,
          promptTokens: 5_000 + turn * 2_000,
        }),
      );
    }
    saveTurnRecords(db, records);
    return db;
  }

  it('keeps aggregate evidence but drops per-session refs', () => {
    const db = corpus();
    const shared = buildWasteReport(db, SHARED_SOLO);
    const own = buildWasteReport(db, SELF);

    const sharedKinds = shared.findings.flatMap((f) => f.evidence.map((e) => e.kind));
    const ownKinds = own.findings.flatMap((f) => f.evidence.map((e) => e.kind));

    expect(sharedKinds).not.toContain('session');
    expect(sharedKinds).not.toContain('request');
    expect(ownKinds).toContain('session');

    // The finding itself survives — only the list of named offenders goes.
    expect(shared.findings.length).toBe(own.findings.length);
    expect(shared.findings[0]?.credits.value).toBeCloseTo(own.findings[0]?.credits.value ?? 0, 6);
  });

  it('records that evidence was withheld rather than silently shortening the list', () => {
    const shared = buildWasteReport(corpus(), SHARED_SOLO);
    const refs = shared.findings.flatMap((f) => f.evidence.map((e) => e.ref));
    expect(refs).toContain('WITHHELD');
  });

  it('passes its own guard — the shared report contains nothing identifying', () => {
    const shared = buildWasteReport(corpus(), SHARED_SOLO);
    expect(() => {
      assertReportSafe(shared, SHARED_SOLO);
    }).not.toThrow();
  });
});

describe('mayIncludeEntityList', () => {
  it('mirrors the scope rule', () => {
    expect(mayIncludeEntityList(SELF)).toBe(true);
    expect(mayIncludeEntityList(SHARED_SOLO)).toBe(false);
    expect(mayIncludeEntityList(SHARED_LARGE)).toBe(true);
  });
});
