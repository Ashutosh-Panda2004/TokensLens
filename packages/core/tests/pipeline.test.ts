import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, cp, utimes, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, getAllRequests } from '../src/store/database.js';
import { ingestFile, ingestAllDiscovered } from '../src/ingest/pipeline.js';

const GOLDEN_FIXTURE = new URL('./fixtures/sessions/golden-basic.jsonl', import.meta.url);
const DRIFT_FIXTURE = new URL(
  './fixtures/sessions/drift-missing-prompt-tokens.jsonl',
  import.meta.url,
);
const NO_SNAPSHOT_FIXTURE = new URL('./fixtures/sessions/no-snapshot.jsonl', import.meta.url);

const tempDirectories: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function database(): ReturnType<typeof openDatabase> {
  const db = openDatabase(':memory:');
  databases.push(db);
  return db;
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ingestFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDirectory('tokenlens-pipeline-');
  });

  it('ingests a fresh file and persists its records', async () => {
    const filePath = join(dir, 'session.jsonl');
    await cp(GOLDEN_FIXTURE, filePath);

    const db = database();
    const result = await ingestFile(db, filePath, 'test-salt');

    expect(result.skippedUnchanged).toBe(false);
    expect(result.recordCount).toBe(2);
    expect(result.driftErrors).toEqual([]);
    expect(getAllRequests(db)).toHaveLength(2);
  });

  it('skips a second ingest of the same unchanged file (Phase D1.7)', async () => {
    const filePath = join(dir, 'session.jsonl');
    await cp(GOLDEN_FIXTURE, filePath);

    const db = database();
    const first = await ingestFile(db, filePath, 'test-salt');
    const second = await ingestFile(db, filePath, 'test-salt');

    expect(first.skippedUnchanged).toBe(false);
    expect(second.skippedUnchanged).toBe(true);
    expect(second.recordCount).toBe(0);
  });

  it('re-ingests after the file changes (mtime/size/hash no longer match)', async () => {
    const filePath = join(dir, 'session.jsonl');
    await cp(GOLDEN_FIXTURE, filePath);

    const db = database();
    await ingestFile(db, filePath, 'test-salt');

    // Simulate a modification: bump mtime forward and append a byte via a
    // fresh copy of a different fixture (different content + size).
    await cp(DRIFT_FIXTURE, filePath);
    const stats = await stat(filePath);
    await utimes(filePath, stats.atime, new Date(stats.mtime.getTime() + 60_000));

    const second = await ingestFile(db, filePath, 'test-salt');
    expect(second.skippedUnchanged).toBe(false);
  });

  it('reports drift errors for a file with a genuinely malformed request', async () => {
    const filePath = join(dir, 'session.jsonl');
    await cp(DRIFT_FIXTURE, filePath);

    const db = database();
    const result = await ingestFile(db, filePath, 'test-salt');

    expect(result.driftErrors).toHaveLength(1);
    expect(result.recordCount).toBe(1); // the one well-formed request still lands
  });
});

describe('ingestAllDiscovered', () => {
  let root: string;

  beforeEach(async () => {
    root = await tempDirectory('tokenlens-discovered-');
  });

  it('discovers and ingests across multiple isolated workspace roots, never touching the real machine', async () => {
    const wsA = join(root, 'ws-a', 'chatSessions');
    const wsB = join(root, 'ws-b', 'chatSessions');
    await mkdir(wsA, { recursive: true });
    await mkdir(wsB, { recursive: true });
    await cp(GOLDEN_FIXTURE, join(wsA, 'session-a.jsonl'));
    await cp(GOLDEN_FIXTURE, join(wsB, 'session-b.jsonl'));

    const db = database();
    const cwd = await tempDirectory('tokenlens-cwd-');
    const summary = await ingestAllDiscovered(db, cwd, [root]);

    expect(summary.filesConsidered).toBe(2);
    expect(summary.filesIngested).toBe(2);
    expect(summary.filesSkippedUnchanged).toBe(0);
    expect(summary.totalRecords).toBe(4); // 2 records per file
    expect(summary.totalDriftErrors).toBe(0);
  });

  it('a file-level SchemaDriftError is folded into the summary rather than aborting the sweep', async () => {
    const wsBad = join(root, 'ws-bad', 'chatSessions');
    const wsGood = join(root, 'ws-good', 'chatSessions');
    await mkdir(wsBad, { recursive: true });
    await mkdir(wsGood, { recursive: true });
    await cp(NO_SNAPSHOT_FIXTURE, join(wsBad, 'no-snapshot.jsonl'));
    await cp(GOLDEN_FIXTURE, join(wsGood, 'session.jsonl'));

    const db = database();
    const cwd = await tempDirectory('tokenlens-cwd-');

    const summary = await ingestAllDiscovered(db, cwd, [root]);

    // Both files were considered; the bad one contributed zero records and
    // one drift error, the good workspace's two records still land.
    expect(summary.filesConsidered).toBe(2);
    expect(summary.totalDriftErrors).toBe(1);
    expect(summary.totalRecords).toBe(2);
    expect(getAllRequests(db)).toHaveLength(2);
  });

  it('a file that fails at the whole-document level is not retried on a second run (marked ingested)', async () => {
    const wsBad = join(root, 'ws-bad', 'chatSessions');
    await mkdir(wsBad, { recursive: true });
    await cp(NO_SNAPSHOT_FIXTURE, join(wsBad, 'no-snapshot.jsonl'));

    const db = database();
    const cwd = await tempDirectory('tokenlens-cwd-');

    const first = await ingestAllDiscovered(db, cwd, [root]);
    const second = await ingestAllDiscovered(db, cwd, [root]);

    expect(first.totalDriftErrors).toBe(1);
    expect(second.filesSkippedUnchanged).toBe(1);
    expect(second.totalDriftErrors).toBe(0);
  });

  it('returns an empty summary when the injected roots contain no workspaces', async () => {
    const db = database();
    const cwd = await tempDirectory('tokenlens-cwd-');
    const summary = await ingestAllDiscovered(db, cwd, [join(root, 'does-not-exist')]);

    expect(summary.filesConsidered).toBe(0);
    expect(summary.totalRecords).toBe(0);
  });
});
