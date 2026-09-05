import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/store/database.js';
import { registerApiRoutes } from '../src/dashboard/routes.js';
import { createSettingsStore } from '../src/dashboard/settings.js';
import {
  consentFilePath,
  consentState,
  CONTRIBUTION_VERSION,
  grantConsent,
  hasActiveConsent,
  readConsent,
  revokeConsent,
} from '../src/contribute/consent.js';
import {
  auditContribution,
  buildContribution,
  CONTRIBUTION_MANIFEST,
  type MonthlyContribution,
} from '../src/contribute/contribution.js';
import { alreadyContributed, outboxDir, writeContribution } from '../src/contribute/outbox.js';

const TOKEN = 'test-token-contribute';

/**
 * Sharing is the one feature where a defect is not a wrong number but a
 * disclosure. Every test here is about refusing rather than producing.
 */
describe('contribution consent', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tokenlens-consent-'));
    previousHome = process.env.TOKENLENS_HOME;
    process.env.TOKENLENS_HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.TOKENLENS_HOME;
    else process.env.TOKENLENS_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it('is off until somebody says otherwise', async () => {
    expect(await hasActiveConsent()).toBe(false);
    expect(consentState(await readConsent()).active).toBe(false);
  });

  it('records consent with a random id that is not derived from anything', async () => {
    const record = await grantConsent();
    expect(record.contributorId).toMatch(/^[0-9a-f]{32}$/);
    expect(record.contributorId).not.toContain(home);
    expect(await hasActiveConsent()).toBe(true);
  });
  it('keeps the same id across opt-out and opt-in, so it is not a new participant', async () => {
    const first = await grantConsent();
    await revokeConsent();
    const second = await grantConsent();
    expect(second.contributorId).toBe(first.contributorId);
  });

  it('stops sharing the moment consent is withdrawn', async () => {
    await grantConsent();
    await revokeConsent();
    const state = consentState(await readConsent());
    expect(state.active).toBe(false);
    expect(state.active ? null : state.reason).toBe('revoked');
  });

  it('invalidates consent when the payload shape changes', async () => {
    // Agreement was to a specific payload. A later version is a different
    // question and has to be asked again.
    const granted = await grantConsent();
    const state = consentState({ ...granted, contributionVersion: CONTRIBUTION_VERSION + 1 });
    expect(state.active).toBe(false);
    expect(state.active ? null : state.reason).toBe('version-changed');
  });

  it('treats an unreadable consent file as no consent, never as consent', async () => {
    await mkdir(join(home, '.tokenlens'), { recursive: true });
    await writeFile(consentFilePath(), '{ this is not json', 'utf8');
    expect(await hasActiveConsent()).toBe(false);
  });

  it('stores consent outside the project layer, so a cloned repo cannot opt anyone in', async () => {
    await grantConsent();
    expect(consentFilePath().startsWith(home)).toBe(true);
    expect(consentFilePath()).toContain('consent.json');
  });
});

describe('contribution payload', () => {
  let dir: string;
  let home: string;
  let db: Database.Database;
  let previousHome: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tokenlens-contribution-'));
    home = await mkdtemp(join(tmpdir(), 'tokenlens-contribution-home-'));
    previousHome = process.env.TOKENLENS_HOME;
    process.env.TOKENLENS_HOME = home;
    db = openDatabase(join(dir, 'ledger.sqlite3'));
  });

  afterEach(async () => {
    db.close();
    if (previousHome === undefined) delete process.env.TOKENLENS_HOME;
    else process.env.TOKENLENS_HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('declares every field it carries', () => {
    const contribution = buildContribution(db, { contributorId: 'abc', period: '2026-08' });
    const audit = auditContribution(contribution);
    expect(audit.undeclaredFields).toEqual([]);
    expect(audit.safe).toBe(true);
  });

  it('carries no identifier, path or content field', () => {
    const contribution = buildContribution(db, { contributorId: 'abc', period: '2026-08' });
    const json = JSON.stringify(contribution);
    for (const forbidden of [
      'sessionId',
      'rawPath',
      'absolutePath',
      'userName',
      'homeDir',
      'sourceFile',
      'filePath',
      'prompt',
      'completion',
    ]) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
  });

  it('reports the month only, never a finer timestamp', () => {
    const contribution = buildContribution(db, { contributorId: 'abc', period: '2026-08' });
    expect(contribution.period).toBe('2026-08');
    // An ISO instant would be a far better fingerprint than a month.
    expect(JSON.stringify(contribution)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('buckets conversation lengths instead of shipping them', () => {
    const contribution = buildContribution(db, { contributorId: 'abc', period: '2026-08' });
    for (const entry of contribution.sessionLengths) {
      expect(entry.bucket).toMatch(/^(1-5|6-20|21-50|51-100|100\+)$/);
    }
  });

  it('the manifest and the payload cannot drift apart unnoticed', () => {
    const contribution = buildContribution(db, { contributorId: 'abc', period: '2026-08' });
    // Cast because the point of the test is a field the type does not allow —
    // which is exactly the mistake the audit exists to catch at runtime.
    const withExtra = { ...contribution, secretNewField: 'oops' } as unknown as MonthlyContribution;
    const audit = auditContribution(withExtra);
    expect(audit.safe).toBe(false);
    expect(audit.undeclaredFields).toContain('secretNewField');
  });

  it('writes to a local outbox and nowhere else', async () => {
    const contribution = buildContribution(db, { contributorId: 'abc', period: '2026-08' });
    const path = await writeContribution(contribution);
    expect(path.startsWith(outboxDir())).toBe(true);
    expect(await alreadyContributed('2026-08')).toBe(true);
    expect(await alreadyContributed('2026-07')).toBe(false);
  });

  it('every manifest entry gives a reason, not just a name', () => {
    for (const entry of CONTRIBUTION_MANIFEST) {
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });
});

describe('consent API', () => {
  let dir: string;
  let home: string;
  let db: Database.Database;
  let app: FastifyInstance;
  let previousHome: string | undefined;

  // Serialised here rather than handed over as an object, so the request
  // under test is byte-for-byte what a browser would actually send.
  function post(body: unknown, headers: Record<string, string>): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/api/consent',
      headers,
      payload: JSON.stringify(body),
    });
  }

  const allowed = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    origin: 'http://127.0.0.1:7331',
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tokenlens-consent-api-'));
    home = await mkdtemp(join(tmpdir(), 'tokenlens-consent-api-home-'));
    previousHome = process.env.TOKENLENS_HOME;
    process.env.TOKENLENS_HOME = home;
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
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('reports sharing as off by default, with the manifest so it can be reviewed', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/consent' });
    const body = response.json<{ sharing: boolean; manifest: unknown[] }>();
    expect(response.statusCode).toBe(200);
    expect(body.sharing).toBe(false);
    expect(body.manifest.length).toBe(CONTRIBUTION_MANIFEST.length);
  });

  it('lets the payload be previewed without consenting first', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/consent/preview' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ audit: { safe: boolean } }>().audit.safe).toBe(true);
  });

  it('turns sharing on and off through the guarded route', async () => {
    const on = await post({ share: true }, allowed);
    expect(on.json<{ sharing: boolean }>().sharing).toBe(true);
    const off = await post({ share: false }, allowed);
    expect(off.json<{ sharing: boolean }>().sharing).toBe(false);
  });

  it('refuses a consent write that a cross-site page could have made', async () => {
    // Same three-part defence as the settings route: no header token, wrong
    // content type, or a foreign origin each block it on their own.
    expect((await post({ share: true }, { 'content-type': 'application/json' })).statusCode).toBe(
      403,
    );
    expect(
      (
        await post(
          { share: true },
          { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await post({ share: true }, { ...allowed, origin: 'https://evil.example' })).statusCode,
    ).toBe(403);
    expect(await hasActiveConsent()).toBe(false);
  });

  it('refuses anything that is not a literal boolean', async () => {
    for (const share of ['true', 1, 'yes', null, {}]) {
      expect((await post({ share }, allowed)).statusCode).toBe(400);
    }
    expect(await hasActiveConsent()).toBe(false);
  });

  it('is absent entirely when the settings surface is disabled', async () => {
    const bare = Fastify({ logger: false });
    registerApiRoutes(bare, db, {});
    await bare.ready();
    expect((await bare.inject({ method: 'GET', url: '/api/consent' })).statusCode).toBe(404);
    await bare.close();
  });
});
