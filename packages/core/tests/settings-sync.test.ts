import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApiRoutes } from '../src/dashboard/routes.js';
import { createSettingsStore } from '../src/dashboard/settings.js';
import { parsePlan } from '../src/ledger/budget.js';
import { ConfigError } from '../src/shared/errors.js';
import { openDatabase } from '../src/store/database.js';
import type Database from 'better-sqlite3';

/**
 * The settings files are written by the dashboard and read by the CLI and the
 * VS Code extension. These tests pin the contract that makes those three
 * agree: one resolver, one precedence order, and a stated source for every
 * settled value.
 */
describe('settings sync across surfaces', () => {
  let dir: string;
  let home: string;
  let previousHome: string | undefined;
  let previousAllowanceEnv: string | undefined;

  const writeProject = async (settings: unknown): Promise<void> => {
    await mkdir(join(dir, '.tokenlens'), { recursive: true });
    await writeFile(join(dir, '.tokenlens', 'config.json'), JSON.stringify(settings), 'utf8');
  };

  const writeUser = async (settings: unknown): Promise<void> => {
    await mkdir(join(home, '.tokenlens'), { recursive: true });
    await writeFile(join(home, '.tokenlens', 'config.json'), JSON.stringify(settings), 'utf8');
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tokenlens-sync-project-'));
    home = await mkdtemp(join(tmpdir(), 'tokenlens-sync-home-'));
    previousHome = process.env.TOKENLENS_HOME;
    previousAllowanceEnv = process.env.TOKENLENS_MONTHLY_ALLOWANCE;
    process.env.TOKENLENS_HOME = home;
    delete process.env.TOKENLENS_MONTHLY_ALLOWANCE;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.TOKENLENS_HOME;
    else process.env.TOKENLENS_HOME = previousHome;
    if (previousAllowanceEnv === undefined) delete process.env.TOKENLENS_MONTHLY_ALLOWANCE;
    else process.env.TOKENLENS_MONTHLY_ALLOWANCE = previousAllowanceEnv;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('names the layer that settled each field', async () => {
    await writeUser({ monthlyAllowance: 'unlimited', plan: 'business' });
    await writeProject({ defaultRange: '30' });

    const settings = await createSettingsStore(dir).read();

    expect(settings.sources).toEqual({
      plan: 'user-config',
      monthlyAllowance: 'user-config',
      defaultScope: 'default',
      defaultRange: 'project-config',
      dashboardPort: 'default',
    });
  });

  it('reports "default" for a field nobody configured, rather than implying it was set', async () => {
    const settings = await createSettingsStore(dir).read();
    expect(settings.sources.plan).toBe('default');
    expect(settings.effective.plan).toBeUndefined();
  });

  it('lets the project layer override the machine layer, and says so', async () => {
    await writeUser({ monthlyAllowance: 5000 });
    await writeProject({ monthlyAllowance: 1000 });

    const settings = await createSettingsStore(dir).read();

    expect(settings.allowance.credits).toBe(1000);
    expect(settings.allowance.source).toBe('config');
    expect(settings.sources.monthlyAllowance).toBe('project-config');
  });

  it('reports the environment variable as the source when it outranks both files', async () => {
    process.env.TOKENLENS_MONTHLY_ALLOWANCE = '2500';
    await writeUser({ monthlyAllowance: 5000 });

    const settings = await createSettingsStore(dir).read();

    expect(settings.allowance.credits).toBe(2500);
    expect(settings.sources.monthlyAllowance).toBe('env');
    expect(settings.overriddenByEnv).toBe('TOKENLENS_MONTHLY_ALLOWANCE');
  });

  it('carries "unlimited" through as a null allowance, never as zero', async () => {
    await writeUser({ monthlyAllowance: 'unlimited' });
    const settings = await createSettingsStore(dir).read();
    expect(settings.allowance.credits).toBeNull();
  });

  it('a dashboard write is visible to the next reader immediately', async () => {
    // The CLI and the extension both re-read on every invocation, so a save
    // in the dashboard must be observable without restarting anything.
    const store = createSettingsStore(dir);
    await store.write('user', { monthlyAllowance: 4200 });

    const reread = await createSettingsStore(dir).read();
    expect(reread.allowance.credits).toBe(4200);
    expect(reread.sources.monthlyAllowance).toBe('user-config');
  });
});

describe('parsePlan', () => {
  it('accepts the known plans', () => {
    expect(parsePlan('business', 'test')).toBe('business');
    expect(parsePlan('enterprise', 'test')).toBe('enterprise');
  });

  it('refuses an unknown plan instead of silently defaulting to enterprise', () => {
    // The previous form coerced every typo to `enterprise`, presenting a
    // wrong allowance with no indication it was a fallback.
    expect(() => parsePlan('buisness', './.tokenlens/config.json')).toThrow(ConfigError);
  });

  it('names the source in the error, so the user knows which file to edit', () => {
    expect(() => parsePlan('gold', '~/.tokenlens/config.json')).toThrow(
      /~\/\.tokenlens\/config\.json/,
    );
  });
});

describe('/api/defaults', () => {
  let db: Database.Database;
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tokenlens-defaults-'));
    db = openDatabase(join(dir, 'ledger.sqlite3'));
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the configured range so the dashboard can open on it', async () => {
    registerApiRoutes(app, db, { range: '30' });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/defaults' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ range: '30' });
  });

  it('serves null when nothing is configured, rather than inventing a range', async () => {
    registerApiRoutes(app, db, {});
    await app.ready();

    expect((await app.inject({ method: 'GET', url: '/api/defaults' })).json()).toEqual({
      range: null,
    });
  });
});
