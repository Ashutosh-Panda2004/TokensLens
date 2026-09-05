import { describe, expect, it } from 'vitest';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { buildDetectContext } from '../src/waste/context.js';
import { measureResidual, measureResiduals } from '../src/advice/residual.js';
import { toolFixableClasses } from '../src/advice/taxonomy.js';
import type Database from 'better-sqlite3';
import type { CostCentre, TurnRecord } from '../src/model/turn-record.js';

/**
 * The residual probes are the gate the whole feature turns on, so they get the
 * same treatment as a detector: a variance test that fails the build if the
 * number stops responding to the evidence, and an explicit check that a thin
 * sample produces silence rather than a confident percentage.
 */

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

interface ReadShape {
  /** How many distinct files are read once each, whole-file. */
  readonly wholeFileReads: number;
  /** How many distinct files are read once each, with an explicit range. */
  readonly rangedReads: number;
}

function corpusOfReads(shape: ReadShape): Database.Database {
  const db = openDatabase(':memory:');
  const records: TurnRecord[] = [];
  let index = 0;

  const push = (ranged: boolean): void => {
    index += 1;
    records.push(
      record({
        requestId: `read-${String(index)}`,
        ts: 1_000 + index,
        sessionId: 'session-reads',
        turnIndex: index,
        rounds: [
          {
            id: `r-${String(index)}`,
            ts: 1_000 + index,
            retries: 0,
            toolCalls: [
              {
                id: `c-${String(index)}`,
                name: 'read_file',
                resultChars: 4_000,
                targetFileHash: `file-${String(index)}`,
                ...(ranged ? { targetStartLine: 10, targetEndLine: 40 } : {}),
              },
            ],
          },
        ],
      }),
    );
  };

  for (let i = 0; i < shape.wholeFileReads; i++) push(false);
  for (let i = 0; i < shape.rangedReads; i++) push(true);

  saveTurnRecords(db, records);
  return db;
}

/** `oversized` results sit above 3x the tool median but below the 16k tier-B cap. */
function corpusOfPayloads(total: number, oversized: number): Database.Database {
  const db = openDatabase(':memory:');
  const records: TurnRecord[] = [];

  for (let i = 0; i < total; i++) {
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
              {
                id: `pc-${String(i)}`,
                name: 'grep_search',
                resultChars: i < oversized ? 9_000 : 500,
              },
            ],
          },
        ],
      }),
    );
  }

  saveTurnRecords(db, records);
  return db;
}

describe('W2 residual probe — whole-file first reads', () => {
  it('measures the share of first reads that took an entire file', () => {
    const db = corpusOfReads({ wholeFileReads: 30, rangedReads: 10 });
    const signal = measureResidual('w2-whole-file-first-reads', buildDetectContext(db));

    expect(signal.sampleSize).toBe(40);
    expect(signal.sufficientSample).toBe(true);
    expect(signal.value).toBeCloseTo(0.75, 5);
    expect(signal.exceeded).toBe(true);
  });

  it('stays quiet when the reads were already scoped', () => {
    // This is the case the whole gate exists for: a finding is present, but the
    // part a tool could improve is not. Offering a dependency here would be
    // charging for something the reader already does.
    const db = corpusOfReads({ wholeFileReads: 4, rangedReads: 40 });
    const signal = measureResidual('w2-whole-file-first-reads', buildDetectContext(db));

    expect(signal.sufficientSample).toBe(true);
    expect(signal.value).toBeLessThan(signal.threshold);
    expect(signal.exceeded).toBe(false);
  });

  it('refuses to judge a thin sample rather than reporting a confident share', () => {
    const db = corpusOfReads({ wholeFileReads: 5, rangedReads: 0 });
    const signal = measureResidual('w2-whole-file-first-reads', buildDetectContext(db));

    expect(signal.value).toBe(1);
    expect(signal.sufficientSample).toBe(false);
    expect(signal.exceeded).toBe(false);
  });

  it('counts each file once per session, so re-reads cannot inflate the share', () => {
    // Re-reads are the lever's territory. If they counted here, the residual
    // would rise on exactly the waste the tier-B guard already denies.
    const db = openDatabase(':memory:');
    const records: TurnRecord[] = [];
    for (let i = 0; i < 40; i++) {
      records.push(
        record({
          requestId: `rr-${String(i)}`,
          ts: 3_000 + i,
          sessionId: 'session-rr',
          turnIndex: i,
          rounds: [
            {
              id: `rrr-${String(i)}`,
              ts: 3_000 + i,
              retries: 0,
              toolCalls: [
                {
                  id: `rrc-${String(i)}`,
                  name: 'read_file',
                  resultChars: 4_000,
                  targetFileHash: 'one-file',
                },
              ],
            },
          ],
        }),
      );
    }
    saveTurnRecords(db, records);

    const signal = measureResidual('w2-whole-file-first-reads', buildDetectContext(db));
    expect(signal.sampleSize).toBe(1);
    expect(signal.sufficientSample).toBe(false);
  });

  it('varies with the evidence', () => {
    const low = measureResidual(
      'w2-whole-file-first-reads',
      buildDetectContext(corpusOfReads({ wholeFileReads: 10, rangedReads: 30 })),
    );
    const high = measureResidual(
      'w2-whole-file-first-reads',
      buildDetectContext(corpusOfReads({ wholeFileReads: 30, rangedReads: 10 })),
    );
    expect(high.value).toBeGreaterThan(low.value);
  });
});

describe('W3 residual probe — oversized but under the cap', () => {
  it('counts results the tier-B cap is too high to reach', () => {
    const db = corpusOfPayloads(60, 20);
    const signal = measureResidual('w3-sub-cap-oversize', buildDetectContext(db));

    expect(signal.sufficientSample).toBe(true);
    expect(signal.value).toBeCloseTo(20 / 60, 5);
    expect(signal.exceeded).toBe(true);
  });

  it('ignores results the cap already truncates', () => {
    // Above the cap the tier-B guard has it. Counting those here would credit a
    // third-party tool with work TokenLens already does.
    const db = openDatabase(':memory:');
    const records: TurnRecord[] = [];
    for (let i = 0; i < 60; i++) {
      records.push(
        record({
          requestId: `big-${String(i)}`,
          ts: 4_000 + i,
          sessionId: `s-big-${String(i)}`,
          rounds: [
            {
              id: `br-${String(i)}`,
              ts: 4_000 + i,
              retries: 0,
              toolCalls: [
                { id: `bc-${String(i)}`, name: 'grep_search', resultChars: i < 20 ? 400_000 : 500 },
              ],
            },
          ],
        }),
      );
    }
    saveTurnRecords(db, records);

    const signal = measureResidual('w3-sub-cap-oversize', buildDetectContext(db));
    expect(signal.value).toBe(0);
    expect(signal.exceeded).toBe(false);
  });

  it('refuses to judge a thin sample', () => {
    const db = corpusOfPayloads(12, 6);
    const signal = measureResidual('w3-sub-cap-oversize', buildDetectContext(db));
    expect(signal.sufficientSample).toBe(false);
    expect(signal.exceeded).toBe(false);
  });

  it('varies with the evidence', () => {
    const low = measureResidual('w3-sub-cap-oversize', buildDetectContext(corpusOfPayloads(60, 8)));
    const high = measureResidual(
      'w3-sub-cap-oversize',
      buildDetectContext(corpusOfPayloads(60, 25)),
    );
    expect(high.value).toBeGreaterThan(low.value);
  });
});

describe('residual probe set', () => {
  it('produces exactly one signal per tool-fixable class', () => {
    const db = corpusOfReads({ wholeFileReads: 5, rangedReads: 5 });
    const signals = measureResiduals(buildDetectContext(db));
    expect(signals.map((signal) => signal.class)).toEqual([...toolFixableClasses()]);
  });

  it('always states its basis, so a reader can check the arithmetic', () => {
    const db = corpusOfReads({ wholeFileReads: 5, rangedReads: 5 });
    for (const signal of measureResiduals(buildDetectContext(db))) {
      expect(signal.basis.length).toBeGreaterThan(40);
      expect(signal.detail.length).toBeGreaterThan(20);
      expect(signal.threshold).toBeGreaterThan(0);
    }
  });

  it('is silent rather than zero on an empty corpus', () => {
    const db = openDatabase(':memory:');
    for (const signal of measureResiduals(buildDetectContext(db))) {
      expect(signal.sampleSize).toBe(0);
      expect(signal.sufficientSample).toBe(false);
      expect(signal.exceeded).toBe(false);
    }
  });
});
