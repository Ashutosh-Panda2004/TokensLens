import { openDatabase, saveTurnRecords } from '../../src/store/database.js';
import type { CostCentre, TurnRecord } from '../../src/model/turn-record.js';
import type Database from 'better-sqlite3';

/**
 * Shared corpus for the D4 simulation tests.
 *
 * Deliberately built so that some requests are hit by **more than one**
 * lever — that overlap is the thing the joint replay exists to resolve, and
 * a fixture where every lever touched a disjoint set of requests would make
 * the overlap test pass without testing anything.
 *
 * It also mixes requests that carry a measured `copilotCredits` value with
 * ones that do not, because the null-policy property is only interesting
 * where the two provenances coexist: that is exactly the case a re-costing
 * implementation would get wrong.
 */
export function centres(promptTokens: number): CostCentre[] {
  return [
    {
      category: 'System',
      label: 'Tool Definitions',
      percentageOfPrompt: 20,
      tokens: Math.round(promptTokens * 0.2),
    },
    {
      category: 'User Context',
      label: 'Tool Results',
      percentageOfPrompt: 40,
      tokens: Math.round(promptTokens * 0.4),
    },
    {
      category: 'User Context',
      label: 'Messages',
      percentageOfPrompt: 40,
      tokens: Math.round(promptTokens * 0.4),
    },
  ];
}

export function record(
  overrides: Partial<TurnRecord> & Pick<TurnRecord, 'requestId' | 'ts'>,
): TurnRecord {
  const promptTokens = overrides.promptTokens ?? 10_000;
  return {
    sessionId: 'session-a',
    model: 'model-premium',
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

export function buildSimulationCorpus(): Database.Database {
  const db = openDatabase(':memory:');
  const records: TurnRecord[] = [];

  // Measured rates for two models, 20x apart. Both must be *measured*, or
  // the routing lever will refuse to price against them.
  for (let i = 0; i < 12; i++) {
    records.push(
      record({
        requestId: `rate-cheap-${String(i)}`,
        ts: 1 + i,
        sessionId: `s-rate-c-${String(i)}`,
        model: 'model-cheap',
        promptTokens: 10_000,
        credits: 1,
        rounds: [{ id: `rc${String(i)}`, ts: 1, retries: 0, toolCalls: [] }],
      }),
      record({
        requestId: `rate-premium-${String(i)}`,
        ts: 50 + i,
        sessionId: `s-rate-p-${String(i)}`,
        model: 'model-premium',
        promptTokens: 10_000,
        credits: 20,
        rounds: [{ id: `rp${String(i)}`, ts: 50, retries: 0, toolCalls: [] }],
      }),
    );
  }

  // Low-complexity premium work — the routing lever's target. No measured
  // credits, so these exercise the rate-card estimate path too.
  for (let i = 0; i < 25; i++) {
    records.push(
      record({
        requestId: `simple-${String(i)}`,
        ts: 100 + i,
        sessionId: `s-simple-${String(i)}`,
        model: 'model-premium',
        promptTokens: 8_000,
        outputTokens: 10,
      }),
    );
  }

  // Deep loops that ALSO carry oversized payloads: one request, two levers.
  for (let i = 0; i < 6; i++) {
    records.push(
      record({
        requestId: `runaway-${String(i)}`,
        ts: 200 + i,
        sessionId: `s-run-${String(i)}`,
        model: 'model-premium',
        promptTokens: 60_000,
        rounds: Array.from({ length: 40 }, (_, r) => ({
          id: `run-${String(i)}-${String(r)}`,
          ts: 200 + i,
          retries: 0,
          toolCalls:
            r === 0
              ? [{ id: `run-c${String(i)}`, name: 'run_in_terminal', resultChars: 400_000 }]
              : [],
        })),
      }),
    );
  }

  // Ordinary tool traffic, so the payload cap has a distribution to sit in
  // and the tool-surface optimiser has a head to keep.
  for (let i = 0; i < 60; i++) {
    records.push(
      record({
        requestId: `normal-${String(i)}`,
        ts: 400 + i,
        sessionId: `s-normal-${String(i)}`,
        rounds: [
          {
            id: `n-r${String(i)}`,
            ts: 400 + i,
            retries: 0,
            toolCalls: [{ id: `n-c${String(i)}`, name: 'read_file', resultChars: 2_000 }],
          },
        ],
      }),
    );
  }

  // A long tail of tools invoked once each — the trim lever's target.
  for (let i = 0; i < 8; i++) {
    records.push(
      record({
        requestId: `rare-tool-${String(i)}`,
        ts: 600 + i,
        sessionId: `s-rare-${String(i)}`,
        rounds: [
          {
            id: `rare-r${String(i)}`,
            ts: 600 + i,
            retries: 0,
            toolCalls: [
              { id: `rare-c${String(i)}`, name: `mcp_vendor${String(i)}_lookup`, resultChars: 900 },
            ],
          },
        ],
      }),
    );
  }

  // One long session with growing prompts — session hygiene.
  for (let turn = 0; turn < 20; turn++) {
    records.push(
      record({
        requestId: `stale-${String(turn)}`,
        ts: 700 + turn,
        sessionId: 'session-long',
        turnIndex: turn,
        promptTokens: 5_000 + turn * 2_000,
      }),
    );
  }

  // Repeated whole-file reads in one session — duplicate-read elimination.
  for (let i = 0; i < 10; i++) {
    records.push(
      record({
        requestId: `dup-${String(i)}`,
        ts: 900 + i,
        sessionId: 'session-dup',
        turnIndex: i,
        rounds: [
          {
            id: `dup-r${String(i)}`,
            ts: 900 + i,
            retries: 0,
            toolCalls: [
              {
                id: `dup-c${String(i)}`,
                name: 'read_file',
                resultChars: 6_000,
                targetFileHash: 'file-x',
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
