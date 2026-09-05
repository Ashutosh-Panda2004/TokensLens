import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { registerApiRoutes } from '../src/dashboard/routes.js';
import { createSettingsStore, validateSettingsPatch } from '../src/dashboard/settings.js';
import { openDatabase } from '../src/store/database.js';
import type Database from 'better-sqlite3';

const TOKEN = 'test-token-value';

describe('validateSettingsPatch', () => {
  it('accepts every declared field', () => {
    const { value, errors } = validateSettingsPatch({
      plan: 'business',
      monthlyAllowance: '3,900',
      defaultScope: 'all',
      defaultRange: '30',
      dashboardPort: 7500,
    });

    expect(errors).toEqual([]);
    expect(value).toEqual({
      plan: 'business',
      monthlyAllowance: 3900,
      defaultScope: 'all',
      defaultRange: '30',
      dashboardPort: 7500,
    });
  });

  it('stores "unlimited" as a word, not as an absent key', () => {
    // Absent would fall through to the layer below rather than overriding
    // it, which is the opposite of what the user asked for.
    const { value } = validateSettingsPatch({ monthlyAllowance: 'unlimited' });
    expect(value.monthlyAllowance).toBe('unlimited');
  });

  it('rejects an unknown key rather than dropping it', () => {
    // A silently ignored key writes a file the user believes contains their
    // setting, and they conclude the setting does not work.
    const { errors } = validateSettingsPatch({ sendTelemetryTo: 'https://evil.example' });
    expect(errors[0]).toContain('Unknown setting');
  });

  it('rejects out-of-range and unintelligible values', () => {
    expect(validateSettingsPatch({ dashboardPort: 80 }).errors).toHaveLength(1);
    expect(validateSettingsPatch({ dashboardPort: 70000 }).errors).toHaveLength(1);
    expect(validateSettingsPatch({ plan: 'platinum' }).errors).toHaveLength(1);
    expect(validateSettingsPatch({ monthlyAllowance: 'lots' }).errors).toHaveLength(1);
    expect(validateSettingsPatch({ defaultScope: 'everything' }).errors).toHaveLength(1);
  });

  it('treats an empty value as "unset", not as zero', () => {
    const { value, errors } = validateSettingsPatch({ monthlyAllowance: '', plan: null });
    expect(errors).toEqual([]);
    expect(value).toEqual({});
  });
});

describe('settings API', () => {
  let dir: string;
  let home: string;
  let db: Database.Database;
  let app: FastifyInstance;
  let previousHome: string | undefined;
  let previousAllowanceEnv: string | undefined;

  const projectConfig = (): string => join(dir, '.tokenlens', 'config.json');
  const userConfig = (): string => join(home, '.tokenlens', 'config.json');

  beforeEach(async () => {
    // Two directories, not one: with a shared root the project and machine
    // layers would resolve to the same file and the precedence test would
    // pass for the wrong reason.
    dir = await mkdtemp(join(tmpdir(), 'tokenlens-project-'));
    home = await mkdtemp(join(tmpdir(), 'tokenlens-home-'));

    // Without this the store reads — and the write tests would *overwrite* —
    // the real `~/.tokenlens/config.json` of whoever runs the suite.
    previousHome = process.env.TOKENLENS_HOME;
    previousAllowanceEnv = process.env.TOKENLENS_MONTHLY_ALLOWANCE;
    process.env.TOKENLENS_HOME = home;
    delete process.env.TOKENLENS_MONTHLY_ALLOWANCE;

    db = openDatabase(join(dir, 'ledger.sqlite3'));
    app = Fastify({ logger: false });
    registerApiRoutes(app, db, { settings: createSettingsStore(dir), token: TOKEN });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    if (previousHome === undefined) delete process.env.TOKENLENS_HOME;
    else process.env.TOKENLENS_HOME = previousHome;
    if (previousAllowanceEnv === undefined) delete process.env.TOKENLENS_MONTHLY_ALLOWANCE;
    else process.env.TOKENLENS_MONTHLY_ALLOWANCE = previousAllowanceEnv;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  // The payload is serialised here rather than handed over as an object, so
  // the request under test is byte-for-byte what the browser actually sends.
  async function write(
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/api/settings',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        ...headers,
      },
      payload: JSON.stringify(body),
    });
  }

  it('reports the plan default when nothing has been configured', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = response.json<{ allowance: { source: string } }>();
    expect(body.allowance.source).toBe('plan-default');
  });

  it('saves to the project layer and reflects it immediately', async () => {
    const response = await write({
      layer: 'project',
      settings: { monthlyAllowance: 'unlimited' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ allowance: { credits: number | null; source: string } }>();
    expect(body.allowance.credits).toBeNull();
    expect(body.allowance.source).toBe('config');

    // Written to disk, not just held in memory.
    const onDisk = JSON.parse(await readFile(projectConfig(), 'utf8')) as Record<string, unknown>;
    expect(onDisk.monthlyAllowance).toBe('unlimited');
  });

  it('saves to the machine layer by default, and reports it as such', async () => {
    const response = await write({ settings: { monthlyAllowance: 4200 } });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ layer: string; allowance: { source: string } }>();
    expect(body.layer).toBe('user');
    expect(body.allowance.source).toBe('user-config');

    const onDisk = JSON.parse(await readFile(userConfig(), 'utf8')) as Record<string, unknown>;
    expect(onDisk.monthlyAllowance).toBe(4200);
  });

  it('lets a project file override the machine file', async () => {
    await write({ layer: 'user', settings: { monthlyAllowance: 4200 } });
    const response = await write({ layer: 'project', settings: { monthlyAllowance: 'unlimited' } });

    const body = response.json<{ allowance: { credits: number | null; source: string } }>();
    // The narrower layer wins, and the report names the file that won.
    expect(body.allowance.credits).toBeNull();
    expect(body.allowance.source).toBe('config');
  });

  it('refuses the whole patch when any field is invalid', async () => {
    // Partially applying would leave a settings file nobody can reason about.
    const response = await write({
      layer: 'project',
      settings: { monthlyAllowance: 3900, dashboardPort: 22 },
    });

    expect(response.statusCode).toBe(400);
    expect(await pathMissing(projectConfig())).toBe(true);
  });

  describe('the write guard', () => {
    it('refuses a token supplied only as a query parameter', async () => {
      // A cross-site form post can reach 127.0.0.1 but cannot set a header.
      const response = await app.inject({
        method: 'POST',
        url: `/api/settings?token=${TOKEN}`,
        headers: { 'content-type': 'application/json' },
        payload: { layer: 'user', settings: {} },
      });
      expect(response.statusCode).toBe(403);
    });

    it('refuses a form content type', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/settings',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: 'layer=user',
      });
      expect(response.statusCode).toBe(415);
    });

    it('refuses a cross-origin write', async () => {
      const response = await write(
        { layer: 'project', settings: {} },
        { origin: 'https://evil.example' },
      );
      expect(response.statusCode).toBe(403);
      expect(response.json<{ detail: string }>().detail).toContain('evil.example');
    });

    it('allows a same-origin write', async () => {
      const response = await write(
        { layer: 'project', settings: { plan: 'business' } },
        { origin: 'http://127.0.0.1:7331' },
      );
      expect(response.statusCode).toBe(200);
    });
  });

  it('has no settings surface at all when the store is not supplied', async () => {
    const bare: FastifyInstance = Fastify({ logger: false });
    registerApiRoutes(bare, db, {});
    await bare.ready();

    expect((await bare.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(404);
    await bare.close();
  });
});

async function pathMissing(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, 'utf8');
    return false;
  } catch {
    return true;
  }
}
