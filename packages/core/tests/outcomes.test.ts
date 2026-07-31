import { describe, it, expect } from 'vitest';
import {
  kaplanMeier,
  survivalAt,
  isEstimableAt,
  atRiskAt,
  logRankTest,
} from '../src/outcomes/survival.js';
import { measureDurability, summariseDurability, DAY_MS } from '../src/outcomes/durability.js';
import { decomposeEffort, familiarityByChange, reviewLatencies } from '../src/outcomes/effort.js';
import { parseGitLog, extensionOf } from '../src/outcomes/git.js';
import { assembleOutcomeReport } from '../src/outcomes/report.js';
import type { CommitRecord, FileChange } from '../src/outcomes/git.js';

const NOW = Date.parse('2026-07-01T00:00:00Z');
const day = (n: number): number => NOW - n * DAY_MS;

function file(pathHash: string, added: number, deleted = 0): FileChange {
  return { pathHash, extension: 'ts', added, deleted };
}

function commit(overrides: Partial<CommitRecord> & Pick<CommitRecord, 'sha' | 'ts'>): CommitRecord {
  return {
    authorId: 'author-a',
    parents: ['parent'],
    isMerge: false,
    files: [],
    ...overrides,
  };
}

describe('Kaplan–Meier', () => {
  /**
   * The reason to use survival analysis rather than a ratio. A change merged
   * yesterday has not been reverted, and counting that as a success makes the
   * newest work look perfect every single time the report runs.
   */
  it('does not treat a censored subject as a survivor', () => {
    const curve = kaplanMeier([
      { duration: 10, event: true, weight: 1 },
      // Observed for only 1 day: absence of an event says nothing.
      { duration: 1, event: false, weight: 99 },
    ]);

    expect(curve.events).toBe(1);
    expect(curve.censored).toBe(99);
    // With 99 subjects leaving the risk set before day 10, the single event
    // at day 10 falls on a risk set of 1 and takes survival to zero.
    expect(survivalAt(curve, 10)).toBe(0);
  });

  it('is the empirical survivor function when nothing is censored', () => {
    const curve = kaplanMeier([
      { duration: 1, event: true, weight: 25 },
      { duration: 2, event: true, weight: 25 },
      { duration: 3, event: false, weight: 50 },
    ]);

    expect(survivalAt(curve, 1)).toBeCloseTo(0.75, 9);
    expect(survivalAt(curve, 2)).toBeCloseTo(0.5, 9);
  });

  it('returns 1 before any event, because nothing has died yet', () => {
    const curve = kaplanMeier([{ duration: 30, event: true, weight: 10 }]);
    expect(survivalAt(curve, 0)).toBe(1);
    expect(survivalAt(curve, 29)).toBe(1);
  });

  /**
   * Past the point where the risk set has emptied, the estimator repeats its
   * last value forever. That flat tail looks like evidence and is not.
   */
  it('refuses to be quoted once the risk set has collapsed', () => {
    const curve = kaplanMeier([
      { duration: 1, event: true, weight: 5 },
      { duration: 2, event: true, weight: 5 },
    ]);

    expect(isEstimableAt(curve, 2, 10)).toBe(false);
    expect(isEstimableAt(curve, 0, 10)).toBe(true);
  });

  /**
   * Found by running the tool on its own two-day-old repository, where it
   * cheerfully reported "96.1% of added lines were still present at 30 days".
   *
   * Every line was censored at day 2. The last *event* was at day 1 with
   * thousands still at risk, so a check that looked only at event points saw
   * a healthy curve. Censorings have to count too, or the horizon nobody has
   * lived through is reported as though they had.
   */
  it('is not estimable past a horizon everything was censored before', () => {
    const curve = kaplanMeier([
      { duration: 1, event: true, weight: 40 },
      { duration: 2, event: false, weight: 960 },
    ]);

    expect(isEstimableAt(curve, 1, 10)).toBe(true);
    expect(isEstimableAt(curve, 30, 10)).toBe(false);
    expect(atRiskAt(curve, 30)).toBe(0);
  });

  it('declines a log-rank test that would be computed on too few subjects', () => {
    const tiny = [{ duration: 1, event: true, weight: 3 }];
    expect(logRankTest(tiny, tiny).comparable).toBe(false);
    expect(logRankTest(tiny, tiny).pValue).toBe(1);
  });

  it('separates two genuinely different survival curves', () => {
    const dies = Array.from({ length: 50 }, (_, i) => ({
      duration: 1 + (i % 3),
      event: true,
      weight: 1,
    }));
    const lives = Array.from({ length: 50 }, () => ({ duration: 30, event: false, weight: 1 }));

    const result = logRankTest(dies, lives);
    expect(result.comparable).toBe(true);
    expect(result.pValue).toBeLessThan(0.01);
  });
});

describe('durability', () => {
  it('attributes a deletion back to the change that added the lines', () => {
    const report = measureDurability(
      [
        commit({ sha: 'a', ts: day(60), files: [file('f1', 100)] }),
        commit({ sha: 'b', ts: day(58), files: [file('f1', 0, 80)] }),
      ],
      { now: NOW, horizonDays: 30 },
    );

    const first = report.changes.find((change) => change.changeId === 'a');
    expect(first?.linesChurned).toBe(80);
    expect(first?.linesSurviving).toBe(20);
    expect(first?.survivingFraction).toBeCloseTo(0.2, 9);
    expect(report.attributedDeletions).toBe(80);
  });

  /**
   * The bound on the attribution assumption. A deletion landing on code older
   * than the horizon is maintenance, not churn, and counting it would let one
   * refactor of a decade-old file indict every recent change in it.
   */
  it('does not attribute deletions to code older than the horizon', () => {
    const report = measureDurability(
      [
        commit({ sha: 'ancient', ts: day(300), files: [file('f1', 100)] }),
        commit({ sha: 'cleanup', ts: day(10), files: [file('f1', 0, 100)] }),
      ],
      { now: NOW, horizonDays: 30 },
    );

    expect(report.changes.find((c) => c.changeId === 'ancient')?.linesChurned).toBe(0);
    expect(report.attributedDeletions).toBe(0);
    expect(report.backgroundDeletions).toBe(100);
  });

  it('reports a change younger than the horizon as unknown, never as durable', () => {
    const report = measureDurability(
      [
        commit({ sha: 'fresh', ts: day(2), files: [file('f1', 50)] }),
        commit({ sha: 'settled', ts: day(90), files: [file('f2', 50)] }),
      ],
      { now: NOW, horizonDays: 30 },
    );

    expect(report.changes.find((c) => c.changeId === 'fresh')?.durable).toBeUndefined();
    expect(report.changes.find((c) => c.changeId === 'settled')?.durable).toBe(true);

    const summary = summariseDurability(report.changes);
    expect(summary.unknown).toBe(1);
    expect(summary.durable).toBe(1);
    // The rate is over decided changes only, and the undecided count is
    // reported beside it rather than folded in either direction.
    expect(summary.durableRate).toBe(1);
  });

  it('marks a reverted change as not durable however well its lines survived', () => {
    const report = measureDurability(
      [
        commit({ sha: 'bad', ts: day(90), files: [file('f1', 100)] }),
        commit({ sha: 'undo', ts: day(89), revertsSha: 'bad', files: [file('f2', 1)] }),
      ],
      { now: NOW, horizonDays: 30 },
    );

    const bad = report.changes.find((change) => change.changeId === 'bad');
    expect(bad?.survivingFraction).toBe(1);
    expect(bad?.reverted).toBe(true);
    expect(bad?.durable).toBe(false);
  });

  it('treats a merge as a boundary, not as a change', () => {
    const report = measureDurability(
      [
        commit({ sha: 'work', ts: day(90), files: [file('f1', 10)] }),
        commit({ sha: 'merge', ts: day(89), isMerge: true, parents: ['main', 'work'] }),
      ],
      { now: NOW },
    );

    expect(report.changes.map((change) => change.changeId)).toEqual(['work']);
  });
});

describe('effort decomposition', () => {
  it('closes the identity — the terms sum to the effort observed', () => {
    const commits = [
      commit({ sha: 'a', ts: day(90), files: [file('f1', 100)] }),
      commit({ sha: 'b', ts: day(90) + 60 * 60 * 1000, files: [file('f1', 20, 50)] }),
      commit({ sha: 'c', ts: day(80), revertsSha: 'a', files: [file('f1', 0, 10)] }),
    ];
    const durability = measureDurability(commits, { now: NOW });
    const effort = decomposeEffort(commits, durability.changes);

    expect(effort.measurableHours).toBeCloseTo(
      effort.authorHours + effort.reworkHours + effort.failureHours,
      9,
    );
    expect(effort.failureHours).toBeGreaterThan(0);
  });

  it('reports review latency but never folds it into effort', () => {
    const commits = [
      commit({ sha: 'tip', ts: day(50) }),
      commit({ sha: 'merge', ts: day(48), isMerge: true, parents: ['main', 'tip'] }),
    ];

    expect(reviewLatencies(commits)).toHaveLength(1);
    expect(reviewLatencies(commits)[0]).toBeCloseTo(48, 0);

    const effort = decomposeEffort(commits, []);
    // Latency is not attention: a pull request open across a weekend
    // consumed no reviewer time.
    expect(effort.measurableHours).toBeCloseTo(
      effort.authorHours + effort.reworkHours + effort.failureHours,
      9,
    );
  });

  /**
   * The confounder almost nobody controls for. Without it, "AI helped" is
   * indistinguishable from "they already knew this code".
   */
  it('measures how much of a change touched files its author had seen before', () => {
    const commits = [
      commit({ sha: 'first', ts: day(90), files: [file('f1', 10), file('f2', 10)] }),
      commit({ sha: 'second', ts: day(80), files: [file('f1', 5), file('f3', 5)] }),
      commit({ sha: 'stranger', ts: day(70), authorId: 'author-b', files: [file('f1', 5)] }),
    ];

    const familiarity = familiarityByChange(commits);
    expect(familiarity.get('first')).toBe(0);
    expect(familiarity.get('second')).toBe(0.5);
    // A different author has never seen f1, however well-trodden it is.
    expect(familiarity.get('stranger')).toBe(0);
  });
});

describe('git parsing', () => {
  const FIELD = '\u001f';
  const RECORD = '\u001e';

  it('parses a log record into a privacy-safe commit', () => {
    const stdout =
      `${RECORD}abc123${FIELD}p1${FIELD}Dev@Example.com${FIELD}1750000000${FIELD}Add a thing (#42)\n` +
      `10\t2\tsrc/index.ts\n`;

    const [parsed] = parseGitLog(stdout, 'salt');

    expect(parsed?.sha).toBe('abc123');
    expect(parsed?.pullRequest).toBe(42);
    expect(parsed?.files[0]?.added).toBe(10);
    expect(parsed?.files[0]?.extension).toBe('ts');
    // The e-mail is hashed at ingest and the raw value never stored.
    expect(parsed?.authorId).not.toContain('Example');
    expect(parsed?.authorId).toMatch(/^[0-9a-f]{16}$/);
    // Nor is the path.
    expect(parsed?.files[0]?.pathHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hashes the same author consistently however they cased their e-mail', () => {
    const make = (email: string): string =>
      parseGitLog(`${RECORD}s${FIELD}p${FIELD}${email}${FIELD}1${FIELD}x\n`, 'salt')[0]?.authorId ??
      '';

    expect(make('Dev@Example.com')).toBe(make('dev@example.com'));
  });

  it('recognises a merge and the pull request behind it', () => {
    const stdout = `${RECORD}m1${FIELD}p1 p2${FIELD}a@b.c${FIELD}1750000000${FIELD}Merge pull request #7 from x\n`;
    const [parsed] = parseGitLog(stdout, 'salt');

    expect(parsed?.isMerge).toBe(true);
    expect(parsed?.parents).toEqual(['p1', 'p2']);
    expect(parsed?.pullRequest).toBe(7);
  });

  it('keeps a binary file as touched even though its line counts say nothing', () => {
    const stdout = `${RECORD}b1${FIELD}p${FIELD}a@b.c${FIELD}1${FIELD}assets\n-\t-\tlogo.png\n`;
    const [parsed] = parseGitLog(stdout, 'salt');

    expect(parsed?.files).toHaveLength(1);
    expect(parsed?.files[0]?.added).toBe(0);
    expect(parsed?.files[0]?.extension).toBe('png');
  });

  it('extracts extensions without leaking the path', () => {
    expect(extensionOf('src/a/b/thing.test.ts')).toBe('ts');
    expect(extensionOf('Makefile')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
  });
});

describe('outcome report', () => {
  const corpus = (): CommitRecord[] => {
    const commits: CommitRecord[] = [];
    for (let i = 0; i < 60; i += 1) {
      commits.push(
        commit({
          sha: `c${String(i)}`,
          ts: day(200 - i * 2),
          authorId: `author-${String(i % 4)}`,
          files: [file(`f${String(i % 10)}`, 40, i % 3 === 0 ? 20 : 0)],
        }),
      );
    }
    return commits;
  };

  it('passes the privacy gate and names no individual', () => {
    const report = assembleOutcomeReport(corpus(), { now: NOW });
    const serialised = JSON.stringify(report);

    for (const key of ['sessionId', 'authorId', 'email', 'sourceFile', 'path']) {
      expect(serialised).not.toContain(`"${key}"`);
    }
    expect(report.authorCount).toBe(4);
  });

  it('reports what git cannot supply rather than approximating it', () => {
    const report = assembleOutcomeReport(corpus(), { now: NOW });
    const terms = report.unavailable.map((term) => term.term);

    expect(terms).toContain('review effort');
    for (const term of report.unavailable) {
      expect(term.reason.length).toBeGreaterThan(20);
      expect(term.unblockedBy.length).toBeGreaterThan(10);
    }
  });

  it('states how much of the deletion activity the attribution actually carried', () => {
    const report = assembleOutcomeReport(corpus(), { now: NOW });

    expect(report.attributionCoverage).toBeGreaterThan(0);
    expect(report.attributionCoverage).toBeLessThanOrEqual(1);
  });

  it('is a pure function of the history and the clock', () => {
    const first = JSON.stringify(assembleOutcomeReport(corpus(), { now: NOW }));
    const second = JSON.stringify(assembleOutcomeReport(corpus(), { now: NOW }));

    expect(first).toBe(second);
  });
});
