import { describe, it, expect } from 'vitest';
import { detectDisplacement, type DisplacementReport } from '../src/outcomes/displacement.js';
import { measureDurability, DAY_MS } from '../src/outcomes/durability.js';
import { readGitHistory, isGitRepository } from '../src/outcomes/git.js';
import { hashPath } from '../src/ingest/redact.js';
import { buildPanel } from '../src/outcomes/report.js';
import type { CommitRecord, FileChange, GitRunner } from '../src/outcomes/git.js';

const NOW = Date.parse('2026-07-01T00:00:00Z');
const day = (n: number): number => NOW - n * DAY_MS;

function file(pathHash: string, added: number, deleted = 0): FileChange {
  return { pathHash, extension: 'ts', added, deleted };
}

function commit(overrides: Partial<CommitRecord> & Pick<CommitRecord, 'sha' | 'ts'>): CommitRecord {
  return { authorId: 'a', parents: ['p'], isMerge: false, files: [], ...overrides };
}

/**
 * Builds two comparable 90-day windows so a signature can be planted in the
 * second and absent from the first. `shape` decides what the recent window
 * does differently.
 */
function twoWindows(shape: {
  recentDeleteEvery?: number;
  priorDeleteEvery?: number;
  recentSize?: number;
  priorSize?: number;
  recentReverts?: number;
  merges?: { priorLatencyHours: number; recentLatencyHours: number };
}): CommitRecord[] {
  const commits: CommitRecord[] = [];
  const count = 40;

  const build = (offsetDays: number, prefix: string, size: number, deleteEvery: number): void => {
    for (let i = 0; i < count; i += 1) {
      const ts = day(offsetDays - i * 2);
      const deletes = deleteEvery > 0 && i % deleteEvery === 0 ? Math.floor(size * 0.9) : 0;
      commits.push(
        commit({
          sha: `${prefix}${String(i)}`,
          ts,
          files: [file(`f${String(i % 6)}`, size, deletes)],
        }),
      );
    }
  };

  build(170, 'old', shape.priorSize ?? 50, shape.priorDeleteEvery ?? 8);
  build(80, 'new', shape.recentSize ?? 50, shape.recentDeleteEvery ?? 8);

  for (let i = 0; i < (shape.recentReverts ?? 0); i += 1) {
    commits.push(
      commit({
        sha: `revert${String(i)}`,
        ts: day(70 - i),
        revertsSha: `new${String(i)}`,
        files: [file('f0', 1)],
      }),
    );
  }

  if (shape.merges) {
    for (let i = 0; i < 10; i += 1) {
      const priorTip = day(160 - i);
      const recentTip = day(70 - i);
      commits.push(commit({ sha: `ptip${String(i)}`, ts: priorTip }));
      commits.push(
        commit({
          sha: `pmerge${String(i)}`,
          ts: priorTip + shape.merges.priorLatencyHours * 3600_000,
          isMerge: true,
          parents: ['main', `ptip${String(i)}`],
        }),
      );
      commits.push(commit({ sha: `rtip${String(i)}`, ts: recentTip }));
      commits.push(
        commit({
          sha: `rmerge${String(i)}`,
          ts: recentTip + shape.merges.recentLatencyHours * 3600_000,
          isMerge: true,
          parents: ['main', `rtip${String(i)}`],
        }),
      );
    }
  }

  return commits;
}

function report(commits: CommitRecord[]): DisplacementReport {
  const durability = measureDurability(commits, { now: NOW, horizonDays: 30 });
  return detectDisplacement(commits, durability.changes, { now: NOW, windowDays: 90 });
}

/**
 * Each of these plants one signature and asserts the detector notices. A
 * detector nobody has seen fire is a detector nobody has checked — the same
 * argument the waste detectors' variance test rests on.
 */
describe('displacement detectors', () => {
  it('PD2 — notices when less of what is written survives', () => {
    const found = report(twoWindows({ priorDeleteEvery: 0, recentDeleteEvery: 2 })).findings.find(
      (finding) => finding.class === 'PD2',
    );

    expect(found).toBeDefined();
    expect(found?.magnitude).toBeGreaterThan(0);
    expect(found?.confidence).toBeGreaterThan(0);
    expect(found?.assumptions.join(' ')).toMatch(/most recently added lines first/);
  });

  it('PD3 — notices changes growing faster than the time spent waiting on them', () => {
    const found = report(
      twoWindows({
        priorSize: 20,
        recentSize: 200,
        merges: { priorLatencyHours: 10, recentLatencyHours: 11 },
      }),
    ).findings.find((finding) => finding.class === 'PD3');

    expect(found).toBeDefined();
    expect(found?.detail).toMatch(/under-review/);
    // The caveat travels with the finding, because latency is not attention.
    expect(found?.assumptions.join(' ')).toMatch(/not reviewer attention/);
  });

  it('PD5 — notices more of what ships being taken back out', () => {
    const found = report(twoWindows({ recentReverts: 8 })).findings.find(
      (finding) => finding.class === 'PD5',
    );

    expect(found).toBeDefined();
    expect(found?.magnitude).toBeGreaterThan(0);
    // Fix-forward is invisible, so the figure understates. It says so.
    expect(found?.assumptions.join(' ')).toMatch(/understates/);
  });

  it('stays quiet when nothing changed between the windows', () => {
    const quiet = report(twoWindows({}));

    expect(quiet.findings).toEqual([]);
    expect(quiet.compositeAlarm).toBe(false);
    // Absence of a signature is not evidence of a gain, and the wording says so.
    expect(quiet.compositeDetail).toMatch(/absence of evidence/);
  });

  it('does not compare windows too thin to compare', () => {
    const sparse = report([
      commit({ sha: 'x', ts: day(10), files: [file('f', 10)] }),
      commit({ sha: 'y', ts: day(100), files: [file('f', 10)] }),
    ]);

    expect(sparse.findings).toEqual([]);
  });

  it('always declares the classes git cannot see', () => {
    const any = report(twoWindows({}));

    expect(any.unavailable.map((item) => item.class).sort()).toEqual(['PD1', 'PD6']);
    for (const item of any.unavailable) {
      expect(item.unblockedBy).toMatch(/API/);
    }
  });
});

describe('git history reading', () => {
  const FIELD = '\u001f';
  const RECORD = '\u001e';

  const runner = (log: string, reverts = ''): GitRunner => {
    return (args) => Promise.resolve(args.includes('--grep=This reverts commit') ? reverts : log);
  };

  it('reads a history and joins the revert body back to its commit', async () => {
    // Realistic abbreviated SHAs: the revert pattern requires 7–40 hex
    // characters, so that a commit message merely containing the words
    // cannot be mistaken for one.
    const log =
      `${RECORD}aaa1111${FIELD}p${FIELD}dev@x.io${FIELD}1750000000${FIELD}Fix\n5\t1\tsrc/a.ts\n` +
      `${RECORD}bbb2222${FIELD}p${FIELD}dev@x.io${FIELD}1750000100${FIELD}Revert "Fix"\n1\t5\tsrc/a.ts\n`;
    const reverts = `${RECORD}bbb2222${FIELD}This reverts commit aaa1111.\n`;

    const commits = await readGitHistory({ cwd: '.' }, 'salt', runner(log, reverts));

    expect(commits).toHaveLength(2);
    expect(commits.find((c) => c.sha === 'bbb2222')?.revertsSha).toBe('aaa1111');
  });

  it('does not mistake prose about reverting for an actual revert', async () => {
    const log = `${RECORD}ccc3333${FIELD}p${FIELD}dev@x.io${FIELD}1750000000${FIELD}Explain how this reverts commit ordering\n1\t0\ta.ts\n`;

    const commits = await readGitHistory({ cwd: '.' }, 'salt', runner(log));
    expect(commits[0]?.revertsSha).toBeUndefined();
  });

  it('treats a repository with no reverts as having none, not as an error', async () => {
    const log = `${RECORD}aaa1111${FIELD}p${FIELD}dev@x.io${FIELD}1750000000${FIELD}Fix\n5\t1\tsrc/a.ts\n`;
    const failing: GitRunner = (args) =>
      args.includes('--grep=This reverts commit')
        ? Promise.reject(new Error('bad grep'))
        : Promise.resolve(log);

    const commits = await readGitHistory({ cwd: '.' }, 'salt', failing);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.revertsSha).toBeUndefined();
  });

  it('passes through the window and limit it was asked for', async () => {
    let captured: readonly string[] = [];
    const capture: GitRunner = (args) => {
      // Three git invocations now: the log, the revert grep, and the
      // `rev-parse` that finds the repository root. Only the first carries the
      // window and the limit.
      if (args[0] === 'log' && !args.includes('--grep=This reverts commit')) captured = args;
      return Promise.resolve('');
    };

    await readGitHistory(
      { cwd: '.', since: new Date('2026-01-01T00:00:00Z'), maxCommits: 500 },
      'salt',
      capture,
    );

    expect(captured.join(' ')).toContain('--since=2026-01-01T00:00:00.000Z');
    expect(captured.join(' ')).toContain('-n500');
  });

  it('hashes a commit path to the same value the journal would produce', async () => {
    // The defect D12 found: git emits repository-relative POSIX paths and the
    // journal records absolute, often Windows-shaped ones. Two hashes for one
    // file, and a join that could never match — invisibly, because the hashes
    // are opaque.
    const log = `${RECORD}aaa1111${FIELD}p${FIELD}dev@x.io${FIELD}1750000000${FIELD}Fix\n5\t1\tsrc/a.ts\n`;
    const withRoot: GitRunner = (args) =>
      Promise.resolve(args[0] === 'rev-parse' ? 'C:/Users/me/proj\n' : log);

    const commits = await readGitHistory({ cwd: '.' }, 'salt', withRoot);

    expect(commits[0]?.files[0]?.pathHash).toBe(hashPath('c:\\Users\\me\\proj\\src\\a.ts', 'salt'));
    expect(commits[0]?.files[0]?.pathHash).toBe(
      hashPath('file:///c%3A/Users/me/proj/src/a.ts', 'salt'),
    );
  });

  it('reports a directory that is not a repository as one, without throwing', async () => {
    const refuses: GitRunner = () => Promise.reject(new Error('not a git repository'));
    expect(await isGitRepository('.', refuses)).toBe(false);
    expect(await isGitRepository('.', () => Promise.resolve('true\n'))).toBe(true);
  });
});

describe('panel construction', () => {
  const changes = measureDurability(
    Array.from({ length: 20 }, (_, i) =>
      commit({
        sha: `c${String(i)}`,
        ts: day(120 - i * 3),
        authorId: `author-${String(i % 2)}`,
        files: [file(`f${String(i)}`, 100, i % 4 === 0 ? 60 : 0)],
      }),
    ),
    { now: NOW, horizonDays: 30 },
  ).changes;

  it('buckets changes into unit-by-period cells', () => {
    const panel = buildPanel(
      changes,
      (bucket) => bucket.reduce((sum, c) => sum + c.survivingFraction, 0) / bucket.length,
      { periodDays: 7, groupOf: (change) => change.authorId },
    );

    expect(panel.length).toBeGreaterThan(0);
    expect(new Set(panel.map((point) => point.unit)).size).toBe(2);
    // Sorted, so a panel is reproducible rather than insertion-ordered.
    expect([...panel].sort((a, b) => a.unit.localeCompare(b.unit) || a.period - b.period)).toEqual(
      panel,
    );
  });

  it('drops a cell whose outcome is undefined rather than substituting a zero', () => {
    const panel = buildPanel(changes, () => undefined, { periodDays: 7 });
    expect(panel).toEqual([]);
  });

  it('puts everything in one unit when no grouping is given', () => {
    const panel = buildPanel(changes, (bucket) => bucket.length, { periodDays: 30 });
    expect(new Set(panel.map((point) => point.unit))).toEqual(new Set(['repository']));
  });
});
