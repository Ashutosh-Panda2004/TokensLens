import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isEnvReference,
  resolveEnvReference,
  configFilePath,
  configExists,
  readConfig,
  writeConfig,
} from '../src/shared/config.js';
import { ConfigError } from '../src/shared/errors.js';

describe('env reference indirection', () => {
  it('recognises the env: prefix', () => {
    expect(isEnvReference('env:FOO')).toBe(true);
    expect(isEnvReference('plain-value')).toBe(false);
  });

  it('resolves a set environment variable', () => {
    process.env.TOKENLENS_TEST_VAR = 'secret-value';
    expect(resolveEnvReference('env:TOKENLENS_TEST_VAR')).toBe('secret-value');
    delete process.env.TOKENLENS_TEST_VAR;
  });

  it('passes through values without the env: prefix', () => {
    expect(resolveEnvReference('literal')).toBe('literal');
  });

  it('throws ConfigError for an unset environment variable', () => {
    expect(() => resolveEnvReference('env:TOKENLENS_DOES_NOT_EXIST')).toThrow(ConfigError);
  });
});

describe('config file lifecycle', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tokenlens-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports non-existence and returns the fallback before init', async () => {
    expect(await configExists(dir)).toBe(false);
    expect(await readConfig({ version: 1 }, dir)).toEqual({ version: 1 });
  });

  it('round-trips a written config', async () => {
    await writeConfig({ version: 2 }, dir);
    expect(await configExists(dir)).toBe(true);
    expect(await readConfig({ version: 1 }, dir)).toEqual({ version: 2 });
  });

  it('throws ConfigError for a present-but-malformed config file', async () => {
    await mkdir(join(dir, '.tokenlens'), { recursive: true });
    await writeFile(configFilePath(dir), '{ not valid json', 'utf8');
    await expect(readConfig({ version: 1 }, dir)).rejects.toThrow(ConfigError);
  });
});
