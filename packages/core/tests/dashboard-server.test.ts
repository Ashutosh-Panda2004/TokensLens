import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { generateDashboardToken } from '../src/dashboard/token.js';
import { MONTHLY_ALLOWANCE } from '../src/ledger/budget.js';
import type { TurnRecord } from '../src/model/turn-record.js';

const TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaa';

function record(overrides: Partial<TurnRecord> & Pick<TurnRecord, 'requestId' | 'ts'>): TurnRecord {
  return {
    sessionId: 'session-a',
    model: 'model-a',
    promptTokens: 1000,
    outputTokens: 100,
    costCentres: [],
    rounds: [],
    edits: [],
    compactions: [],
    contentReferences: [],
    turnIndex: 0,
    source: { file: 'f', offset: 0 },
    ...overrides,
  };
}

describe('dashboard server', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({ requestId: 'req-1', ts: Date.UTC(2026, 5, 1), credits: 12 }),
      record({ requestId: 'req-2', ts: Date.UTC(2026, 5, 2), model: 'model-b' }),
    ]);
    app = createDashboardServer({ db, token: TOKEN });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  describe('authentication', () => {
    it('rejects the dashboard page with no token', async () => {
      const response = await app.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(401);
    });

    it('rejects an API call with no token', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/ledger' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
    });

    it('rejects a wrong token of the same length', async () => {
      const wrong = `${TOKEN.slice(0, -1)}X`;
      expect(wrong).toHaveLength(TOKEN.length);
      const response = await app.inject({ method: 'GET', url: `/api/ledger?token=${wrong}` });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a wrong token of a different length without throwing', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/ledger?token=short' });
      expect(response.statusCode).toBe(401);
    });

    it('rejects an empty token', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/ledger?token=' });
      expect(response.statusCode).toBe(401);
    });

    it('accepts the token as a query parameter, for the initial page load', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/health?token=${TOKEN}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });

    it('accepts the token as an Authorization: Bearer header, for the frontend fetches', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
    });

    it('serves the dashboard page itself once the token is supplied', async () => {
      const response = await app.inject({ method: 'GET', url: `/?token=${TOKEN}` });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('TokenLens');
    });

    it('serves static assets without a token — the browser cannot attach one to <link>/<script>', async () => {
      const css = await app.inject({ method: 'GET', url: '/style.css' });
      const js = await app.inject({ method: 'GET', url: '/app.js' });
      expect(css.statusCode).toBe(200);
      expect(js.statusCode).toBe(200);
    });
  });

  describe('/api/ledger', () => {
    it('returns the provenance-annotated ledger view', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/ledger',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);

      const body = response.json<{
        totalCredits: { value: number; kind: string };
        requestCount: number;
        byDay: unknown[];
        byModel: unknown[];
        bySession: unknown[];
        byCostCentre: unknown[];
      }>();

      expect(body.requestCount).toBe(2);
      expect(body.totalCredits.kind).toBe('blended');
      expect(body.byDay).toHaveLength(2);
      expect(body.byModel).toHaveLength(2);
      expect(body.bySession).toHaveLength(1);
      expect(Array.isArray(body.byCostCentre)).toBe(true);
    });
  });

  describe('/api/budget', () => {
    it('defaults to the enterprise allowance', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/budget',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ plan: string }>().plan).toBe('enterprise');
    });

    it('honours ?plan=business', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/budget?plan=business',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const body = response.json<{ plan: string; monthlyAllowance: number }>();
      expect(body.plan).toBe('business');
      expect(body.monthlyAllowance).toBe(MONTHLY_ALLOWANCE.business);
    });

    it('falls back to enterprise for an unrecognised plan, rather than erroring', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/budget?plan=nonsense',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ plan: string }>().plan).toBe('enterprise');
    });
  });

  describe('waste board and MCP ROI (D2.7 / D2.8)', () => {
    it('/api/waste returns ranked findings and the classes it could not assess', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/waste',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);

      const body = response.json<{
        findings: { class: string; credits: { value: number } }[];
        unavailable: { class: string; reason: string }[];
        attributedCredits: number;
      }>();

      expect(Array.isArray(body.findings)).toBe(true);
      // Classes that cannot be assessed are always reported, even on a tiny corpus.
      expect(body.unavailable.length).toBeGreaterThan(0);
      expect(typeof body.attributedCredits).toBe('number');
    });

    it('/api/mcp-roi returns per-tool-group invocation data', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/mcp-roi',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json())).toBe(true);
    });

    it('both new routes require the token', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/waste' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/mcp-roi' })).statusCode).toBe(401);
    });
  });

  describe('/api/verify/:requestId', () => {
    it('returns the stored row for a known request, so any figure can be traced to source', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/verify/req-1',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);

      const body = response.json<{ requestId: string; credits: number; sourceFile: string }>();
      expect(body.requestId).toBe('req-1');
      expect(body.credits).toBe(12);
      expect(body.sourceFile).toBe('f');
    });

    it('404s an unknown request id rather than inventing a row', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/verify/does-not-exist',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: string }>().error).toBe('not_found');
    });
  });
});

describe('generateDashboardToken', () => {
  it('produces a URL-safe token long enough to resist guessing', () => {
    const token = generateDashboardToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it('produces a different token on every call — a new secret per server run', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateDashboardToken()));
    expect(tokens.size).toBe(50);
  });
});
