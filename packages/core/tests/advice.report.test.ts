import { describe, expect, it } from 'vitest';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { buildAdviceReport } from '../src/advice/report.js';
import { CATALOGUE } from '../src/advice/catalogue.data.js';
import { MIN_RECOMMENDED_ENTRIES, catalogueDigest } from '../src/advice/catalogue.js';
import { toolFixableClasses } from '../src/advice/taxonomy.js';
import type Database from 'better-sqlite3';
import type { CatalogueEntry } from '../src/advice/catalogue.js';
import type { CostCentre, TurnRecord } from '../src/model/turn-record.js';

/**
 * End to end over a real SQLite ledger: detectors, probes, catalogue and gate,
 * assembled the way `tokenlens advise` assembles them.
 *
 * The property under test is mostly a negative one — that the whole pipeline can
 * run against a corpus full of waste and still name nothing, because nothing in
 * the shipped catalogue is signed off. A recommendation engine that cannot reach
 * that state on demand has no gate.
 */

const AS_OF = new Date('2026-08-02T00:00:00.000Z');

function centres(promptTokens: number): CostCentre[] {
  return [
    {
      category: 'System',
      label: 'Tool Definitions',
      percentageOfPrompt: 20,
      tokens: Math.round(promptTokens * 0.2),
    },
  ];
}

function record(overrides: Partial<TurnRecord> & Pick<TurnRecord, 'requestId' | 'ts'>): TurnRecord {
  const promptTokens = overrides.promptTokens ?? 10_000;
  return {
    sessionId: 'session-a',
    model: 'model-cheap',
    promptTokens,
    outputTokens: 200,
    costCentres: centres(promptTokens),
    rounds: [],
    edits: [],
    compactions: [],
    contentReferences: [],
    turnIndex: 0,
    source: { file: 'f', offset: 0 },
    ...overrides,
  };
}

/** Whole-file reads, repeated, plus a spread of payload sizes — W2 and W3 both fire. */
function corpus(): Database.Database {
  const db = openDatabase(':memory:');
  const records: TurnRecord[] = [];

  records.push(record({ requestId: 'rate', ts: 1, credits: 5 }));

  for (let i = 0; i < 60; i++) {
    records.push(
      record({
        requestId: `read-${String(i)}`,
        ts: 100 + i,
        sessionId: 'session-reads',
        turnIndex: i,
        rounds: [
          {
            id: `r-${String(i)}`,
            ts: 100 + i,
            retries: 0,
            toolCalls: [
              {
                id: `c-${String(i)}`,
                name: 'read_file',
                resultChars: 6_000,
                // Two files, read repeatedly and always whole — a large W2
                // finding whose residual is genuinely present.
                targetFileHash: `file-${String(i % 40)}`,
              },
            ],
          },
        ],
      }),
    );
  }

  for (let i = 0; i < 80; i++) {
    records.push(
      record({
        requestId: `pay-${String(i)}`,
        ts: 2_000 + i,
        sessionId: `s-pay-${String(i)}`,
        rounds: [
          {
            id: `pr-${String(i)}`,
            ts: 2_000 + i,
            retries: 0,
            toolCalls: [
              { id: `pc-${String(i)}`, name: 'grep_search', resultChars: i < 25 ? 9_000 : 400 },
            ],
          },
        ],
      }),
    );
  }

  saveTurnRecords(db, records);
  return db;
}

describe('buildAdviceReport', () => {
  it('runs the whole pipeline and names nothing, because nothing is signed off', () => {
    const report = buildAdviceReport(corpus(), { asOf: AS_OF });

    expect(report.readiness.mode).toBe('guidance-only');
    expect(report.match.offers).toEqual([]);
    expect(report.match.mechanisms.length).toBeGreaterThan(0);
  });

  it('identifies the dataset it answered from', () => {
    const report = buildAdviceReport(corpus(), { asOf: AS_OF });
    expect(report.catalogueDigest).toBe(catalogueDigest(CATALOGUE));
    expect(report.asOf).toBe(AS_OF.toISOString());
  });

  it('reports a reason for every class it said nothing about', () => {
    const report = buildAdviceReport(corpus(), { asOf: AS_OF });
    for (const silence of report.match.silences) {
      expect(silence.reason.length, `${silence.class} has an empty reason`).toBeGreaterThan(20);
    }
    expect(report.match.silences.length + report.match.offers.length).toBeGreaterThanOrEqual(14);
  });

  it('measures a residual for each tool-fixable class', () => {
    const report = buildAdviceReport(corpus(), { asOf: AS_OF });
    expect(report.signals.map((signal) => signal.class)).toEqual([...toolFixableClasses()]);
  });

  it('reports W8 as unseen rather than absent when there is no rollup', () => {
    // "Nobody else asked this" and "we cannot see anybody else" are different
    // statements, and a share of zero would render them identically.
    const report = buildAdviceReport(corpus(), { asOf: AS_OF });
    const w8 = report.signals.find((signal) => signal.class === 'W8');
    expect(w8?.sufficientSample).toBe(false);
    expect(w8?.detail).toContain('not the same as it being absent');
  });

  it('lists every entry with why it is or is not offerable today', () => {
    const report = buildAdviceReport(corpus(), { asOf: AS_OF });
    expect(report.catalogue.length).toBe(CATALOGUE.length);
    for (const listing of report.catalogue) {
      expect(listing.offerable).toBe(false);
      expect(listing.blockers.length).toBeGreaterThan(0);
    }
  });

  it('offers a tool once the catalogue is signed off and the residual is real', () => {
    // The positive case, so the negative ones above are not passing by accident.
    // The seed catalogue holds fewer entries than the floor D12 raised, so it is
    // padded here — the floor moving is the intended consequence of two more
    // classes becoming tool-fixable, not something to assert around.
    const signOff = (entry: CatalogueEntry, index: number): CatalogueEntry => ({
      ...entry,
      id: `${entry.id}-${String(index)}`,
      status: 'recommended',
      statusReason: undefined,
      verification: {
        ...entry.verification,
        checkedOn: '2026-08-01',
        checkedBy: 'a named human',
        source: 'maintainer-verified',
        upstreamLastCommit: { date: '2026-07-01', precision: 'day', tag: undefined },
        upstreamLastRelease: { date: '2026-07-01', precision: 'day', tag: 'v1.0.0' },
      },
    });

    const offerable = CATALOGUE.filter((entry) => entry.status !== 'deprecated');
    const signedOff = Array.from({ length: MIN_RECOMMENDED_ENTRIES }, (_, index) => {
      const source = offerable[index % offerable.length];
      if (source === undefined) throw new Error('no offerable seed entries');
      return signOff(source, index);
    });

    const report = buildAdviceReport(corpus(), { asOf: AS_OF, catalogue: signedOff });

    expect(report.readiness.mode).toBe('catalogue');
    expect(report.match.offers.length).toBeGreaterThan(0);
    for (const offer of report.match.offers) {
      expect(offer.signal.exceeded).toBe(true);
      expect(offer.entry.addresses).toContain(offer.class);
    }
  });

  it('is reproducible: the same corpus and date produce the same answer', () => {
    const first = buildAdviceReport(corpus(), { asOf: AS_OF });
    const second = buildAdviceReport(corpus(), { asOf: AS_OF });
    expect(JSON.stringify(second.match)).toBe(JSON.stringify(first.match));
  });
});
