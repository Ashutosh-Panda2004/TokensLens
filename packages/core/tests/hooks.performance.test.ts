import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { dispatch } from '../src/hooks/dispatch.js';
import { openGuardState } from '../src/hooks/state.js';
import type { HookInput } from '../src/hooks/protocol.js';

const SALT = 'test-salt';
const NOW = Date.parse('2026-07-31T12:00:00Z');

let db: Database.Database;
let root: string;

beforeEach(() => {
  db = openGuardState(':memory:');
  root = mkdtempSync(join(tmpdir(), 'tokenlens-hook-performance-'));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function input(overrides: Partial<HookInput> & Pick<HookInput, 'event'>): HookInput {
  return { sessionId: 'session-1', ...overrides };
}

function writeFile(relative: string, contents: string): void {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function median(sorted: readonly number[]): number {
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function timeDecisions(samples: number, sessionPrefix: string): number[] {
  const call = input({
    event: 'PreToolUse',
    toolName: 'read_file',
    toolInput: { filePath: 'src/a.ts' },
  });

  const timings: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = process.cpuUsage();
    dispatch(
      { ...call, sessionId: `${sessionPrefix}${String(index)}` },
      { db, salt: SALT, root, now: NOW },
    );
    const elapsed = process.cpuUsage(started);
    timings.push((elapsed.user + elapsed.system) / 1000);
  }
  return timings.sort((left, right) => left - right);
}

/**
 * CI cannot infer production wall latency from a shared runner: scheduler
 * pauses routinely exceed the hook's entire budget. CPU time is stable and
 * still catches a scan, ingest, or computation added to this synchronous hot
 * path. Release smoke tests can measure end-to-end wall p99 separately.
 */
describe('H-1 · latency budget', () => {
  it('uses single-digit milliseconds of CPU per decision', () => {
    writeFile('src/a.ts', 'export const a = 1;\n'.repeat(200));

    expect(median(timeDecisions(200, 'warm'))).toBeLessThan(10);
  });

  it('does not get slower as the state store fills up', () => {
    writeFile('src/a.ts', 'export const a = 1;\n'.repeat(200));
    const cold = median(timeDecisions(100, 'cold'));

    const fill = db.prepare(
      `INSERT OR REPLACE INTO observed_read
         (session_id, file_hash, start_line, end_line, content_hash, turn, ts)
       VALUES (?, ?, 0, 0, 'deadbeef', 1, 1)`,
    );
    const insertMany = db.transaction((count: number) => {
      for (let index = 0; index < count; index += 1) {
        fill.run(`filler-${String(index)}`, `hash-${String(index)}`);
      }
    });
    insertMany(5_000);

    const loaded = median(timeDecisions(100, 'loaded'));
    expect(loaded).toBeLessThan(Math.max(cold * 4, 10));
  });
});
