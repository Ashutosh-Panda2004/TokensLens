import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { buildDetectContext } from '../src/waste/context.js';
import { DETECTORS, UNAVAILABLE_CLASSES } from '../src/waste/registry.js';
import { buildWasteReport } from '../src/waste/report.js';
import { isModelled } from '../src/model/provenance.js';
import type { CostCentre, TurnRecord } from '../src/model/turn-record.js';
import type { WasteFinding } from '../src/waste/types.js';

function centres(promptTokens: number): CostCentre[] {
  return [
    {
      category: 'System',
      label: 'Tool Definitions',
      percentageOfPrompt: 20,
      tokens: Math.round(promptTokens * 0.2),
    },
    {
      category: 'User Context',
      label: 'Messages',
      percentageOfPrompt: 80,
      tokens: Math.round(promptTokens * 0.8),
    },
  ];
}

function record(overrides: Partial<TurnRecord> & Pick<TurnRecord, 'requestId' | 'ts'>): TurnRecord {
  const promptTokens = overrides.promptTokens ?? 10_000;
  return {
    sessionId: 'session-a',
    model: 'model-cheap',
    promptTokens,
    outputTokens: 500,
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

/**
 * A corpus rich enough that every detector finds something. `scale` shifts
 * the *amount* of waste without changing its shape, which is what the
 * variance test needs.
 */
function buildCorpus(scale: number): Database.Database {
  const db = openDatabase(':memory:');
  const records: TurnRecord[] = [];

  // Measured rates for two models, one much cheaper — feeds W5.
  records.push(
    record({
      requestId: 'rate-cheap',
      ts: 1,
      model: 'model-cheap',
      promptTokens: 10_000,
      credits: 1,
      rounds: [{ id: 'r0', ts: 1, toolCalls: [{ id: 'c0', name: 'read_file' }], retries: 0 }],
    }),
    record({
      requestId: 'rate-premium',
      ts: 2,
      model: 'model-premium',
      promptTokens: 10_000,
      credits: 60,
      rounds: [{ id: 'r1', ts: 2, toolCalls: [{ id: 'c1', name: 'read_file' }], retries: 0 }],
    }),
  );

  // Simple premium-model requests — W5's target.
  for (let i = 0; i < 10 * scale; i++) {
    records.push(
      record({
        requestId: `simple-premium-${String(i)}`,
        ts: 100 + i,
        sessionId: `s-simple-${String(i)}`,
        model: 'model-premium',
        promptTokens: 8_000,
        outputTokens: 10,
      }),
    );
  }

  // A long session with growing prompts — W4.
  for (let turn = 0; turn < 20; turn++) {
    records.push(
      record({
        requestId: `stale-${String(turn)}`,
        ts: 1_000 + turn,
        sessionId: 'session-long',
        turnIndex: turn,
        promptTokens: 5_000 + turn * 1_000 * scale,
      }),
    );
  }

  // Repeated whole-file reads in one session — W2.
  for (let i = 0; i < 6 * scale; i++) {
    records.push(
      record({
        requestId: `dup-${String(i)}`,
        ts: 2_000 + i,
        sessionId: 'session-dup',
        turnIndex: i,
        rounds: [
          {
            id: `dup-r${String(i)}`,
            ts: 2_000 + i,
            retries: 0,
            toolCalls: [
              {
                id: `dup-c${String(i)}`,
                name: 'read_file',
                resultChars: 4_000,
                targetFileHash: 'file-x',
              },
            ],
          },
        ],
      }),
    );
  }

  // A pile of normal tool results plus a few enormous ones — W3.
  for (let i = 0; i < 60; i++) {
    records.push(
      record({
        requestId: `payload-${String(i)}`,
        ts: 3_000 + i,
        sessionId: `s-pay-${String(i)}`,
        rounds: [
          {
            id: `pay-r${String(i)}`,
            ts: 3_000 + i,
            retries: 0,
            toolCalls: [
              {
                id: `pay-c${String(i)}`,
                name: 'run_in_terminal',
                resultChars: i < 3 ? 400_000 * scale : 500,
              },
            ],
          },
        ],
      }),
    );
  }

  // Deep loops producing no edit — W6.
  for (let i = 0; i < 3 * scale; i++) {
    records.push(
      record({
        requestId: `runaway-${String(i)}`,
        ts: 4_000 + i,
        sessionId: `s-run-${String(i)}`,
        promptTokens: 40_000,
        rounds: Array.from({ length: 40 }, (_, r) => ({
          id: `run-${String(i)}-${String(r)}`,
          ts: 4_000 + i,
          retries: 0,
          toolCalls: [],
        })),
      }),
    );
  }

  // Compaction events — W9.
  for (let i = 0; i < 4 * scale; i++) {
    records.push(
      record({
        requestId: `compact-${String(i)}`,
        ts: 5_000 + i,
        sessionId: `s-comp-${String(i)}`,
        compactions: [
          {
            toolCallRoundId: `comp-${String(i)}`,
            model: 'model-cheap',
            numRounds: 12,
            durationMs: 90_000,
            outcome: 'full/success',
            contextLengthBefore: 120_000,
          },
        ],
      }),
    );
  }

  // A tool invoked once across the whole corpus — W1's underused case.
  records.push(
    record({
      requestId: 'rare-tool',
      ts: 6_000,
      sessionId: 's-rare',
      rounds: [
        {
          id: 'rare-r',
          ts: 6_000,
          retries: 0,
          toolCalls: [{ id: 'rare-c', name: 'never_used_tool' }],
        },
      ],
    }),
  );

  saveTurnRecords(db, records);
  return db;
}

describe('detector variance — the test that catches a detector that does not detect', () => {
  // A detector whose output is identical for a small corpus and a corpus with
  // three times the waste is not measuring anything. This is audit defect
  // D-03, and it is the single most important test in the waste engine.
  const small = buildDetectContext(buildCorpus(1));
  const large = buildDetectContext(buildCorpus(3));

  it.each(DETECTORS.map((d) => [d.class, d] as const))(
    '%s produces different credits when the underlying waste changes',
    (_class, detector) => {
      const smallFindings = detector.detect(small);
      const largeFindings = detector.detect(large);

      expect(smallFindings.length).toBeGreaterThan(0);
      expect(largeFindings.length).toBeGreaterThan(0);

      const smallCredits = smallFindings.reduce((sum, f) => sum + f.credits.value, 0);
      const largeCredits = largeFindings.reduce((sum, f) => sum + f.credits.value, 0);

      expect(largeCredits).not.toBeCloseTo(smallCredits, 6);
    },
  );

  it.each(DETECTORS.map((d) => [d.class, d] as const))(
    '%s confidence is derived, not a hardcoded literal',
    (_class, detector) => {
      const smallConfidence = detector.detect(small).map((f) => f.confidence);
      const largeConfidence = detector.detect(large).map((f) => f.confidence);

      for (const value of [...smallConfidence, ...largeConfidence]) {
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      // At least one finding's confidence must move with the evidence.
      expect(largeConfidence).not.toEqual(smallConfidence);
    },
  );
});

describe('finding quality invariants', () => {
  const ctx = buildDetectContext(buildCorpus(2));
  const findings: WasteFinding[] = DETECTORS.flatMap((detector) => detector.detect(ctx));

  it('produces at least one finding per available detector', () => {
    expect(new Set(findings.map((f) => f.class)).size).toBe(DETECTORS.length);
  });

  it.each(DETECTORS.map((d) => d.class))('%s cites concrete evidence', (wasteClass) => {
    const finding = findings.find((f) => f.class === wasteClass);
    expect(finding?.evidence.length).toBeGreaterThan(0);
    for (const item of finding?.evidence ?? []) {
      expect(item.ref).not.toBe('');
      expect(item.detail).not.toBe('');
    }
  });

  it('every finding names a concrete fix and an enforcement tier', () => {
    for (const finding of findings) {
      expect(finding.remediation.action.length).toBeGreaterThan(20);
      expect(['A', 'B', 'C']).toContain(finding.remediation.tier);
    }
  });

  it('every modelled figure states at least one falsifiable assumption', () => {
    // A modelled number with no stated assumption is an unfalsifiable claim,
    // which is exactly what P3 exists to prevent.
    for (const finding of findings) {
      if (isModelled(finding.credits)) {
        expect(finding.credits.provenance.assumptions.length).toBeGreaterThan(0);
        expect(finding.credits.provenance.basis.length).toBeGreaterThan(10);
      }
    }
  });

  it('never attributes negative credits', () => {
    for (const finding of findings) {
      expect(finding.credits.value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('report reconciliation', () => {
  it('either keeps attribution within the ledger total or says why it did not', () => {
    const report = buildWasteReport(buildCorpus(2));

    // Causes genuinely overlap — one request can be both on an over-powered
    // model and inside a stale session. The engine is allowed to exceed the
    // ledger total, but it is never allowed to do so silently.
    if (report.attributedCredits > report.totalLedgerCredits) {
      expect(report.overlapWarning).toBeDefined();
    } else {
      expect(report.overlapWarning).toBeUndefined();
    }
  });

  it('ranks findings by attributed credits, descending', () => {
    const report = buildWasteReport(buildCorpus(2));
    const credits = report.findings.map((f) => f.credits.value);
    expect(credits).toEqual([...credits].sort((a, b) => b - a));
  });

  it('reports classes it cannot assess rather than silently omitting them', () => {
    const report = buildWasteReport(buildCorpus(1));
    expect(report.unavailable.length).toBeGreaterThanOrEqual(UNAVAILABLE_CLASSES.length);

    for (const item of report.unavailable) {
      // "We cannot look" must be distinguishable from "there is nothing there",
      // and must say what would change that.
      expect(item.reason.length).toBeGreaterThan(20);
      expect(item.unblockedBy.length).toBeGreaterThan(10);
    }
  });

  it('an empty ledger yields no findings and no fabricated waste', () => {
    const report = buildWasteReport(openDatabase(':memory:'));
    expect(report.findings).toEqual([]);
    expect(report.attributedCredits).toBe(0);
    expect(report.attributedShare).toBe(0);
    // Still honest about what it could not assess.
    expect(report.unavailable.length).toBeGreaterThan(0);
  });
});
