import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { registerApiRoutes } from '../src/dashboard/routes.js';
import {
  availablePeriods,
  buildMonthlyReport,
  monthBounds,
  renderMonthlyReportMarkdown,
  type MonthlyReport,
} from '../src/report/monthly.js';
import { ANALYSIS_BRIEF } from '../src/report/brief.js';
import type { Allowance } from '../src/ledger/budget.js';
import type { TurnRecord } from '../src/model/turn-record.js';

const TOKEN = 'report-token';

const ALLOWANCE: Allowance = { plan: 'enterprise', credits: 3900, source: 'config' };

function record(id: string, ts: number, credits: number): TurnRecord {
  return {
    requestId: id,
    sessionId: 'session-a',
    ts,
    model: 'claude-sonnet-5',
    promptTokens: 1000,
    outputTokens: 100,
    credits,
    costCentres: [
      { category: 'User Context', label: 'Messages', percentageOfPrompt: 60, tokens: 600 },
      { category: 'System', label: 'Tool Definitions', percentageOfPrompt: 40, tokens: 400 },
    ],
    rounds: [],
    edits: [],
    compactions: [],
    contentReferences: [],
    turnIndex: Number(id.split('-')[1] ?? 0),
    source: { file: 'ws-a/chatSessions/session-a.jsonl', offset: 0 },
  };
}

describe('monthly report', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record('r-0', Date.UTC(2026, 6, 15), 100),
      record('r-1', Date.UTC(2026, 7, 1), 200),
      record('r-2', Date.UTC(2026, 7, 2), 300),
      record('r-3', Date.UTC(2026, 7, 3), 400),
      record('r-4', Date.UTC(2026, 7, 4), 500),
    ]);
  });

  afterEach(() => {
    db.close();
  });

  const build = (period: string, self = false): MonthlyReport =>
    buildMonthlyReport(db, {
      period,
      allowance: ALLOWANCE,
      scopeLabel: 'test scope',
      privacy: { scope: self ? 'self' : 'shared', subjectCount: 1 },
      now: new Date(Date.UTC(2026, 7, 31)),
    });

  it('lists only the months that have activity, newest first', () => {
    expect(availablePeriods(db)).toEqual(['2026-08', '2026-07']);
  });

  it('bounds a month correctly, including its last day', () => {
    expect(monthBounds('2026-08')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('covers only the requested month', () => {
    // July's 100 credits must not leak into August's total.
    expect(build('2026-08').ledger.totalCredits).toBeCloseTo(1400, 6);
    expect(build('2026-07').ledger.totalCredits).toBeCloseTo(100, 6);
  });

  it('renders money at the documented one-credit-is-one-cent rate', () => {
    const markdown = renderMonthlyReportMarkdown(build('2026-08'), db);
    expect(markdown).toContain('$14.00');
    expect(markdown).toContain('1 credit = $0.01 USD');
  });

  it('defaults to the shareable form and says what it withheld', () => {
    // The report exists to be sent somewhere, so the safe scope is the
    // default rather than something the user has to remember to ask for.
    const markdown = renderMonthlyReportMarkdown(build('2026-08'), db);
    expect(markdown).toContain('Per-session detail is withheld');
  });

  it('keeps per-session detail only when explicitly asked', () => {
    const markdown = renderMonthlyReportMarkdown(build('2026-08', true), db);
    expect(markdown).not.toContain('Per-session detail is withheld');
  });

  it('carries no identifier or path field a shared report forbids', () => {
    const markdown = renderMonthlyReportMarkdown(build('2026-08'), db);
    for (const forbidden of ['sessionId', 'rawPath', 'absolutePath', 'userName', 'homeDir']) {
      expect(markdown).not.toContain(forbidden);
    }
  });

  it('states the classes it could not assess, rather than implying they are zero', () => {
    const markdown = renderMonthlyReportMarkdown(build('2026-08'), db);
    expect(markdown).toContain('could not be assessed');
  });

  it('ends with the analysis brief, as a visible titled section', () => {
    // Deliberately not concealed: a report is a thing people forward, and a
    // hidden instruction would act on someone else's assistant unannounced.
    const markdown = renderMonthlyReportMarkdown(build('2026-08'), db);
    expect(markdown).toContain('## Analysis brief');
    expect(markdown.trimEnd().endsWith(ANALYSIS_BRIEF.trim())).toBe(true);
  });

  it('the brief forbids the failure modes these reports invite', () => {
    expect(ANALYSIS_BRIEF).toMatch(/never present an estimate as a measurement/i);
    expect(ANALYSIS_BRIEF).toMatch(/do not sum overlapping attributions/i);
    expect(ANALYSIS_BRIEF).toMatch(
      /not less work|less work is a loss|same work for fewer credits/i,
    );
  });
});

describe('report API', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    saveTurnRecords(db, [record('r-1', Date.UTC(2026, 7, 1), 200)]);
    app = Fastify({ logger: false });
    registerApiRoutes(app, db, { token: TOKEN, allowance: ALLOWANCE });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('lists the downloadable months', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/reports' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ periods: string[] }>().periods).toContain('2026-08');
  });

  it('serves the report as a Markdown attachment', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/report?period=2026-08' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toContain('tokenlens-2026-08.md');
    expect(response.body).toContain('# GitHub Copilot spend — 2026-08');
  });

  it('refuses a period that is not a month, rather than guessing one', async () => {
    for (const period of ['', 'August', '2026', '2026-8-1', '../etc/passwd']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/report?period=${encodeURIComponent(period)}`,
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
