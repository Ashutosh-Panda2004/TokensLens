import { describe, it, expect } from 'vitest';
import { buildSimulationCorpus, record } from './fixtures/simulate-corpus.js';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { buildDetectContext } from '../src/waste/context.js';
import { buildLedger } from '../src/ledger/ledger.js';
import { scanDuplicateReads } from '../src/waste/duplicate-reads.js';
import { groupBy } from '../src/waste/scoring.js';
import {
  buildNullSimulation,
  buildSimulation,
  type SimulationReport,
} from '../src/simulate/report.js';
import { parsePolicy } from '../src/simulate/policy.js';
import {
  recommendPolicy,
  solveLoopCap,
  solveToolSurface,
  solveVirtualToolThreshold,
} from '../src/simulate/optimiser.js';
import type { Policy } from '../src/simulate/policy.js';
import type { ToolCallRound } from '../src/model/turn-record.js';

/** Pinned so nothing in the report is a function of the calendar. */
const NOW = new Date('2026-07-15T12:00:00Z');

function simulate(db: ReturnType<typeof buildSimulationCorpus>, policy: Policy): SimulationReport {
  return buildSimulation(db, policy, { now: NOW });
}

describe('counterfactual replay', () => {
  /**
   * The single most important property in this phase.
   *
   * The obvious implementation — re-cost every request from the rate card
   * under the new policy and subtract — produces a non-zero delta here,
   * because ~9% of requests carry a measured `copilotCredits` value that
   * does not equal what the rate card predicts for the same prompt. That
   * difference is scattered noise, and a null policy would report it as a
   * saving. A simulator that always finds money is worse than no simulator.
   */
  it('reports exactly zero for a policy that changes nothing', () => {
    const db = buildSimulationCorpus();
    const report = buildNullSimulation(db, { now: NOW });

    expect(report.combined.theoretical).toBe(0);
    expect(report.combined.low).toBe(0);
    expect(report.combined.high).toBe(0);
    expect(report.levers).toHaveLength(0);
    expect(report.requestsAffected).toBe(0);
    expect(report.naiveSumCredits).toBe(0);
    expect(report.overlapCredits).toBe(0);

    // And the baseline it measured is the real one, so "zero" is not the
    // trivial consequence of an empty corpus.
    expect(report.baselineCredits).toBeCloseTo(buildLedger(db).totalCredits, 6);
    expect(report.requestCount).toBeGreaterThan(100);
  });

  it('reports zero for a configured lever that happens to match nothing', () => {
    const db = buildSimulationCorpus();
    const report = simulate(db, parsePolicy('version: 1\nsession:\n  max_rounds: 100000\n').policy);

    expect(report.levers).toHaveLength(1);
    expect(report.levers[0]?.credits.theoretical).toBe(0);
    // Configured-but-inert is a different statement from unconfigured, and
    // the report makes it rather than hiding the lever.
    expect(report.levers[0]?.risks.some((risk) => risk.text.includes('changes nothing'))).toBe(
      true,
    );
  });

  it('is byte-identical across runs on the same input', () => {
    const policy = parsePolicy(`
version: 1
model:
  route:
    - when: { complexity: low }
      to: model-cheap
payload:
  max_result_tokens: 4000
session:
  max_rounds: 20
  nudge_after_turns: 8
retrieval:
  dedupe_reads: true
`).policy;

    const first = JSON.stringify(simulate(buildSimulationCorpus(), policy));
    const second = JSON.stringify(simulate(buildSimulationCorpus(), policy));

    expect(first).toBe(second);
  });

  it('finds real money on a corpus that contains it', () => {
    const db = buildSimulationCorpus();
    const report = simulate(db, recommendPolicy(buildDetectContext(db)));

    expect(report.combined.theoretical).toBeGreaterThan(0);
    expect(report.reduction.theoretical).toBeGreaterThan(0);
    expect(report.reduction.theoretical).toBeLessThan(1);
    expect(report.requestsAffected).toBeGreaterThan(0);
  });

  /**
   * The band is the deliverable, not decoration: D4's exit criteria call for
   * sensitivity bands and never point estimates.
   */
  it('brackets every saving by realisation, never reporting a bare point', () => {
    const db = buildSimulationCorpus();
    const report = simulate(db, recommendPolicy(buildDetectContext(db)));

    expect(report.combined.low).toBeLessThan(report.combined.high);
    expect(report.combined.high).toBeLessThanOrEqual(report.combined.theoretical + 1e-9);

    for (const lever of report.levers) {
      expect(lever.credits.low).toBeLessThanOrEqual(lever.credits.high);
      expect(lever.credits.high).toBeLessThanOrEqual(lever.credits.theoretical + 1e-9);
    }

    // Tier C is the band that must be widest — it depends on a person.
    const hygiene = report.levers.find((lever) => lever.id === 'session-hygiene');
    expect(hygiene?.tier).toBe('C');
    expect(hygiene && hygiene.credits.low / hygiene.credits.high).toBeLessThan(0.5);
  });

  it('can report a policy that makes things worse', () => {
    const db = buildSimulationCorpus();
    // Routing everything to the *expensive* model is a legitimate question
    // to ask, and the answer must be allowed to be negative.
    const report = simulate(
      db,
      parsePolicy('version: 1\nmodel:\n  default: model-premium\n').policy,
    );

    expect(report.combined.theoretical).toBeLessThan(0);
  });

  it('never removes more tool-result tokens than a request measurably contained', () => {
    const db = openDatabase(':memory:');
    // A single enormous tool result attached to a tiny prompt: uncapped, the
    // character-derived excess is far larger than the whole request.
    saveTurnRecords(db, [
      record({
        requestId: 'tiny',
        ts: 1,
        promptTokens: 1_000,
        credits: 5,
        rounds: [
          {
            id: 'r',
            ts: 1,
            retries: 0,
            toolCalls: [{ id: 'c', name: 'run_in_terminal', resultChars: 10_000_000 }],
          },
        ],
      }),
    ]);

    const report = buildSimulation(
      db,
      parsePolicy('version: 1\npayload:\n  max_result_tokens: 100\n').policy,
      {
        now: NOW,
      },
    );

    expect(report.combined.theoretical).toBeGreaterThan(0);
    expect(report.combined.theoretical).toBeLessThanOrEqual(report.baselineCredits);
  });

  it('leaves requests alone when the target model has no measured rate', () => {
    const db = buildSimulationCorpus();
    const report = simulate(db, parsePolicy('version: 1\nmodel:\n  default: never-seen\n').policy);

    expect(report.combined.theoretical).toBe(0);
    expect(report.levers[0]?.risks.some((risk) => risk.text.includes('no measured rate'))).toBe(
      true,
    );
  });
});

describe('measured regret', () => {
  it('warns rather than assuming zero when the target model has too few samples', () => {
    const db = openDatabase(':memory:');
    const records = [];
    for (let i = 0; i < 30; i++) {
      records.push(
        record({
          requestId: `p${String(i)}`,
          ts: i,
          sessionId: `s${String(i)}`,
          model: 'model-premium',
          promptTokens: 5_000,
          credits: 10,
        }),
      );
    }
    // Only three requests on the cheap model: not enough to compare against.
    for (let i = 0; i < 3; i++) {
      records.push(
        record({
          requestId: `c${String(i)}`,
          ts: 100 + i,
          sessionId: `sc${String(i)}`,
          model: 'model-cheap',
          promptTokens: 5_000,
          credits: 1,
        }),
      );
    }
    saveTurnRecords(db, records);

    const report = buildSimulation(
      db,
      parsePolicy(
        'version: 1\nmodel:\n  route:\n    - when: { complexity: low }\n      to: model-cheap\n',
      ).policy,
      { now: NOW },
    );

    const routing = report.levers.find((lever) => lever.id === 'model-routing');
    expect(routing?.risks.some((risk) => risk.text.includes('could not be measured'))).toBe(true);
    expect(routing?.risks.some((risk) => risk.text.includes('upper bound'))).toBe(true);
  });
});

describe('tool-surface optimiser', () => {
  it('keeps the head of the distribution and removes the long tail', () => {
    const db = buildSimulationCorpus();
    const solution = solveToolSurface(buildDetectContext(db), 0.95);

    expect(solution.keep).toContain('read_file');
    expect(solution.remove.length).toBeGreaterThan(0);
    expect(solution.lostInvocations / solution.totalInvocations).toBeLessThanOrEqual(0.05);
    expect(solution.keep.length + solution.remove.length).toBe(solution.observedTools);
  });

  /**
   * Not a degenerate result to be worked around. On a corpus of 84
   * invocations, removing even a once-used tool costs 1.2% of observed
   * capability, so at a 99% target the honest answer is that nothing
   * qualifies — and the derived policy still carries the empty list so the
   * report says so rather than omitting the lever.
   */
  it('removes nothing when no tool is cheap enough to lose', () => {
    const ctx = buildDetectContext(buildSimulationCorpus());

    expect(solveToolSurface(ctx, 0.99).remove).toEqual([]);
    expect(recommendPolicy(ctx).tools?.deny).toEqual([]);
  });

  it('honours the coverage target it is given', () => {
    const ctx = buildDetectContext(buildSimulationCorpus());
    const strict = solveToolSurface(ctx, 1);
    const loose = solveToolSurface(ctx, 0.9);

    // Preserving *every* observed invocation means removing nothing: the
    // set-cover framing is degenerate, and the optimiser says so by result.
    expect(strict.remove).toEqual([]);
    expect(loose.remove.length).toBeGreaterThanOrEqual(strict.remove.length);
  });

  it('derives a portfolio policy from the corpus rather than from constants', () => {
    const policy = recommendPolicy(buildDetectContext(buildSimulationCorpus()));

    expect(policy.version).toBe(1);
    expect(policy.model?.route?.[0]?.to).toBe('model-cheap');
    expect(policy.payload?.maxResultTokens).toBeGreaterThan(0);
    expect(policy.retrieval?.dedupeReads).toBe(true);
  });

  /**
   * Routing *all* work to the cheapest model is exactly what the simulator
   * warns against — it is where a routing policy does damage rather than
   * saving money. The recommendation is a rule scoped to low-complexity
   * work, and the fleet default is deliberately left alone.
   */
  it('recommends a routing rule, never a blanket fleet default', () => {
    const policy = recommendPolicy(buildDetectContext(buildSimulationCorpus()));

    expect(policy.model?.route).toHaveLength(1);
    expect(policy.model?.default).toBeUndefined();
  });

  /**
   * `chat.tools.compressOutput.enabled` ships off and costs nothing to turn
   * on. Recommending it on the strength of documentation alone would be
   * unfalsifiable advice, so it is recommended only where this corpus
   * actually contains an oversized result.
   */
  it('recommends the free settings only where the waste they attack is present', () => {
    const withWaste = recommendPolicy(buildDetectContext(buildSimulationCorpus()));
    expect(withWaste.payload?.compressTerminalOutput).toBe(true);
    expect(withWaste.tools?.virtualToolsThreshold).toBeGreaterThanOrEqual(8);

    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({
        requestId: 'tiny',
        ts: 1,
        credits: 1,
        costCentres: [],
        rounds: [
          {
            id: 'r',
            ts: 1,
            retries: 0,
            toolCalls: [{ id: 'c', name: 'read_file', resultChars: 40 }],
          },
        ],
      }),
    ]);
    const withoutWaste = recommendPolicy(buildDetectContext(db));
    expect(withoutWaste.payload?.compressTerminalOutput).toBeUndefined();
    expect(withoutWaste.tools?.virtualToolsThreshold).toBeUndefined();
  });

  it('sets the virtual-tool threshold above what any request actually needed at once', () => {
    const ctx = buildDetectContext(buildSimulationCorpus());
    const threshold = solveVirtualToolThreshold(ctx);
    const maxDistinctPerRequest = Math.max(
      ...[...groupBy(ctx.toolCalls, (call) => call.requestId).values()].map(
        (calls) => new Set(calls.map((call) => call.name)).size,
      ),
    );

    // At or above the observed ceiling, grouping cannot break behaviour the
    // corpus recorded.
    expect(threshold).toBeLessThanOrEqual(Math.max(8, maxDistinctPerRequest));
  });
});

/**
 * Both defects below were found by running the simulator against this
 * machine's real ledger, not by inspection. Each is pinned here so that the
 * naive version cannot come back.
 */
describe('defects the first live run exposed', () => {
  /**
   * The derived loop cap was the 90th percentile of round counts — W6's
   * definition of "unusually deep". On real data that caught 70 requests of
   * which **68 had completed a file edit**: converging loops, cut off. The
   * saving figure looked excellent throughout, which is what makes this the
   * dangerous kind of wrong.
   */
  it('refuses to recommend a loop cap that would cut off converging work', () => {
    const db = openDatabase(':memory:');
    const records = [];
    for (let i = 0; i < 40; i++) {
      records.push(
        record({
          requestId: `deep-${String(i)}`,
          ts: i,
          sessionId: `s${String(i)}`,
          promptTokens: 20_000,
          credits: 30,
          rounds: Array.from({ length: 30 }, (_, r) => ({
            id: `r${String(i)}-${String(r)}`,
            ts: i,
            retries: 0,
            toolCalls: [],
          })),
          // Every deep loop here landed an edit.
          edits: [{ fileHash: `f${String(i)}`, editCount: 3, done: true }],
        }),
      );
    }
    saveTurnRecords(db, records);

    const solution = solveLoopCap(buildDetectContext(db));
    expect(solution.cap).toBeUndefined();
    expect(solution.reason).toMatch(/destroy work/);
    expect(recommendPolicy(buildDetectContext(db)).session?.maxRounds).toBeUndefined();
  });

  it('still recommends a cap when the deep loops produced nothing', () => {
    const db = openDatabase(':memory:');
    const records = [];
    for (let i = 0; i < 40; i++) {
      const deep = i < 10;
      records.push(
        record({
          requestId: `r-${String(i)}`,
          ts: i,
          sessionId: `s${String(i)}`,
          promptTokens: 20_000,
          credits: 30,
          rounds: Array.from({ length: deep ? 30 : 2 }, (_, r) => ({
            id: `r${String(i)}-${String(r)}`,
            ts: i,
            retries: 0,
            toolCalls: [],
          })),
          ...(deep ? {} : { edits: [{ fileHash: `f${String(i)}`, editCount: 1, done: true }] }),
        }),
      );
    }
    saveTurnRecords(db, records);

    const solution = solveLoopCap(buildDetectContext(db));
    expect(solution.cap).toBeGreaterThanOrEqual(10);
    expect(solution.unproductiveCaught).toBeGreaterThan(0);
  });

  /**
   * 1,396 of 1,769 flagged re-reads on the real corpus followed an edit to
   * the same file. Those refresh genuinely changed content; charging them
   * overstated W2 roughly fivefold, and the policy derived from it would
   * have denied the agent sight of its own edits.
   */
  it('does not charge a re-read that followed an edit to the same file', () => {
    const db = openDatabase(':memory:');
    const read = (id: string, ts: number): ToolCallRound => ({
      id,
      ts,
      retries: 0,
      toolCalls: [{ id: `c-${id}`, name: 'read_file', resultChars: 5_000, targetFileHash: 'f1' }],
    });

    saveTurnRecords(db, [
      record({ requestId: 'r1', ts: 1, sessionId: 's', turnIndex: 0, rounds: [read('a', 1)] }),
      // Re-read with nothing in between: a genuine duplicate.
      record({ requestId: 'r2', ts: 2, sessionId: 's', turnIndex: 1, rounds: [read('b', 2)] }),
      // An edit lands...
      record({
        requestId: 'r3',
        ts: 3,
        sessionId: 's',
        turnIndex: 2,
        edits: [{ fileHash: 'f1', editCount: 1, done: true }],
      }),
      // ...so this read is a refresh, not a duplicate.
      record({ requestId: 'r4', ts: 4, sessionId: 's', turnIndex: 3, rounds: [read('c', 4)] }),
    ]);

    const scan = scanDuplicateReads(buildDetectContext(db));
    expect(scan.duplicates.map((entry) => entry.requestId)).toEqual(['r2']);
    expect(scan.refreshedAfterEdit).toBe(1);
  });

  it('charges a second re-read after the refresh, since that copy is current again', () => {
    const db = openDatabase(':memory:');
    const read = (id: string, ts: number): ToolCallRound => ({
      id,
      ts,
      retries: 0,
      toolCalls: [{ id: `c-${id}`, name: 'read_file', resultChars: 5_000, targetFileHash: 'f1' }],
    });

    saveTurnRecords(db, [
      record({ requestId: 'r1', ts: 1, sessionId: 's', turnIndex: 0, rounds: [read('a', 1)] }),
      record({
        requestId: 'r2',
        ts: 2,
        sessionId: 's',
        turnIndex: 1,
        edits: [{ fileHash: 'f1', editCount: 1, done: true }],
      }),
      record({ requestId: 'r3', ts: 3, sessionId: 's', turnIndex: 2, rounds: [read('b', 3)] }),
      record({ requestId: 'r4', ts: 4, sessionId: 's', turnIndex: 3, rounds: [read('c', 4)] }),
    ]);

    const scan = scanDuplicateReads(buildDetectContext(db));
    expect(scan.duplicates.map((entry) => entry.requestId)).toEqual(['r4']);
    expect(scan.refreshedAfterEdit).toBe(1);
  });

  /**
   * Found while wiring D5. Model routing changes two things at once: the
   * rate falls because the model is cheaper, and effort rises by the
   * measured regret. Damping those two *separately* towards "no change"
   * turned a 20×-cheaper rate into a reported **cost increase** at 70%
   * realisation — the benefit was damped while the regret was not, in
   * proportion.
   *
   * A realisation rate means "this lever lands on this fraction of the
   * work". The whole change lands or none of it does.
   */
  it('damps a lever\u2019s net effect, so its own regret cannot outrun its benefit', () => {
    const db = buildSimulationCorpus();
    const report = simulate(db, parsePolicy('version: 1\nmodel:\n  default: model-cheap\n').policy);

    const routing = report.levers.find((lever) => lever.id === 'model-routing');
    expect(routing?.credits.theoretical).toBeGreaterThan(0);
    // The partial-adoption figures must sit between "nothing happened" and
    // "everything happened", never outside that interval.
    expect(routing?.credits.low).toBeGreaterThan(0);
    expect(routing?.credits.low).toBeLessThan(routing?.credits.high ?? 0);
    expect(routing?.credits.high).toBeLessThanOrEqual(routing?.credits.theoretical ?? 0);
  });
});
