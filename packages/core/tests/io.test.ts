import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pathExists,
  readJsonl,
  readJsonFileOrDefault,
  writeJsonFileAtomic,
} from '../src/shared/io.js';

describe('io', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tokenlens-io-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('pathExists', () => {
    it('is false for a missing path and true after a write', async () => {
      const file = join(dir, 'x.json');
      expect(await pathExists(file)).toBe(false);
      await writeJsonFileAtomic(file, { a: 1 });
      expect(await pathExists(file)).toBe(true);
    });
  });

  describe('writeJsonFileAtomic + readJsonFileOrDefault', () => {
    it('round-trips a value and creates parent directories', async () => {
      const file = join(dir, 'nested', 'config.json');
      await writeJsonFileAtomic(file, { version: 1 });
      const read = await readJsonFileOrDefault(file, { version: 0 });
      expect(read).toEqual({ version: 1 });
    });

    it('leaves no temporary files behind after a successful write', async () => {
      const file = join(dir, 'clean.json');
      await writeJsonFileAtomic(file, { ok: true });
      const entries = await readdir(dir);
      expect(entries).toEqual(['clean.json']);
    });

    it('returns the fallback for a missing file', async () => {
      const read = await readJsonFileOrDefault(join(dir, 'missing.json'), { version: 0 });
      expect(read).toEqual({ version: 0 });
    });

    it('warns and returns the fallback for malformed JSON by default', async () => {
      const file = join(dir, 'bad.json');
      await writeFile(file, '{ not valid json', 'utf8');
      const read = await readJsonFileOrDefault(file, { version: 0 });
      expect(read).toEqual({ version: 0 });
    });

    it('throws on malformed JSON when onParseError is "throw"', async () => {
      const file = join(dir, 'bad.json');
      await writeFile(file, '{ not valid json', 'utf8');
      await expect(
        readJsonFileOrDefault(file, { version: 0 }, { onParseError: 'throw' }),
      ).rejects.toThrow();
    });
  });

  describe('readJsonl', () => {
    it('returns [] for a missing file', async () => {
      expect(await readJsonl(join(dir, 'missing.jsonl'))).toEqual([]);
    });

    it('skips malformed and blank lines, keeping the rest', async () => {
      const file = join(dir, 'x.jsonl');
      await writeFile(file, '{"a":1}\n\nnot json\n{"a":2}\n', 'utf8');
      expect(await readJsonl(file)).toEqual([{ a: 1 }, { a: 2 }]);
    });
  });
});
