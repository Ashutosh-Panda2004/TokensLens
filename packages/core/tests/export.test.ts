import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import {
  buildExportData,
  exportHtml,
  exportJson,
  renderStaticHtmlReport,
  type ExportData,
} from '../src/dashboard/export.js';
import type { CostCentre, TurnRecord } from '../src/model/turn-record.js';

function record(overrides: Partial<TurnRecord> & Pick<TurnRecord, 'requestId' | 'ts'>): TurnRecord {
  return {
    sessionId: 'session-a',
    model: 'model-a',
    promptTokens: 1000,
    outputTokens: 100,
    costCentres: [
      { category: 'System', label: 'System Instructions', percentageOfPrompt: 30, tokens: 300 },
      { category: 'System', label: 'Tool Definitions', percentageOfPrompt: 70, tokens: 700 },
    ] satisfies CostCentre[],
    rounds: [],
    edits: [],
    compactions: [],
    contentReferences: [],
    turnIndex: 0,
    source: { file: 'f', offset: 0 },
    ...overrides,
  };
}

const NOW = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));

describe('report export', () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({ requestId: 'r1', ts: Date.UTC(2026, 5, 1), credits: 12 }),
      record({
        requestId: 'r2',
        ts: Date.UTC(2026, 5, 2),
        model: 'model-b',
        sessionId: 'session-b',
      }),
    ]);
    dir = await mkdtemp(join(tmpdir(), 'tokenlens-export-'));
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe('buildExportData', () => {
    it('bundles the ledger and budget views with the generation timestamp', () => {
      const data = buildExportData(db, 'enterprise', NOW);
      expect(data.generatedAt).toBe(NOW.toISOString());
      expect(data.ledger.requestCount).toBe(2);
      expect(data.budget.plan).toBe('enterprise');
    });

    it('honours the requested plan', () => {
      expect(buildExportData(db, 'business', NOW).budget.plan).toBe('business');
    });
  });

  describe('exportJson', () => {
    it('writes parseable JSON matching the in-memory export data', async () => {
      const file = join(dir, 'report.json');
      await exportJson(db, file, 'enterprise', NOW);

      const parsed = JSON.parse(await readFile(file, 'utf8')) as ExportData;
      expect(parsed).toEqual(JSON.parse(JSON.stringify(buildExportData(db, 'enterprise', NOW))));
      expect(parsed.ledger.totalCredits.kind).toBe('blended');
    });

    it('ends with a trailing newline, so the file is well-formed for diffing and piping', async () => {
      const file = join(dir, 'report.json');
      await exportJson(db, file, 'enterprise', NOW);
      expect(await readFile(file, 'utf8')).toMatch(/\n$/);
    });
  });

  describe('exportHtml', () => {
    it('writes a complete HTML document', async () => {
      const file = join(dir, 'report.html');
      await exportHtml(db, file, 'enterprise', NOW);

      const html = await readFile(file, 'utf8');
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html.trimEnd().endsWith('</html>')).toBe(true);
    });

    it('is self-contained — it opens offline, with no external asset or network call', async () => {
      const file = join(dir, 'report.html');
      await exportHtml(db, file, 'enterprise', NOW);
      const html = await readFile(file, 'utf8');

      expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet["']/i);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/https?:\/\//);
      expect(html).toContain('<style>');
    });
  });

  describe('renderStaticHtmlReport', () => {
    it('renders every section', () => {
      const html = renderStaticHtmlReport(buildExportData(db, 'enterprise', NOW));
      for (const heading of [
        'Total spend',
        'Burn-down',
        'Cost-centre breakdown',
        'Model mix',
        // Shared is the default scope for an export, so the ranked
        // leaderboard is replaced by the aggregate concentration section.
        'Session concentration',
      ]) {
        expect(html).toContain(heading);
      }
    });

    it('keeps the session leaderboard when the export is explicitly for oneself', () => {
      const html = renderStaticHtmlReport(
        buildExportData(db, 'enterprise', NOW, { scope: 'self', subjectCount: 1 }),
      );
      expect(html).toContain('Session leaderboard');
    });

    it('renders a provenance chip for every figure, and the legend that explains them', () => {
      const html = renderStaticHtmlReport(buildExportData(db, 'enterprise', NOW));
      expect(html).toContain('chip-measured');
      expect(html).toContain('chip-modelled');
      expect(html).toContain('chip-blended');
      // Each of the two models contributes a rate chip and a credits chip,
      // on top of the totals, days, sessions, cost centres and projections.
      expect(html.split('class="chip').length - 1).toBeGreaterThan(10);
    });

    it('escapes data that would otherwise inject markup', () => {
      const hostileDb = openDatabase(':memory:');
      saveTurnRecords(hostileDb, [
        record({
          requestId: 'r1',
          ts: Date.UTC(2026, 5, 1),
          credits: 1,
          // Model names reach the report verbatim; session ids do not
          // survive redaction, so they are no longer a useful probe here.
          model: '<img src=x onerror="alert(1)"><script>alert(2)</script>',
        }),
      ]);

      const html = renderStaticHtmlReport(buildExportData(hostileDb, 'enterprise', NOW));
      hostileDb.close();

      expect(html).not.toContain('<script>alert(2)</script>');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img src=x');
      expect(html).toContain('&lt;script&gt;');
    });

    it('renders an empty ledger without dividing by zero or emitting NaN', () => {
      const emptyDb = openDatabase(':memory:');
      const html = renderStaticHtmlReport(buildExportData(emptyDb, 'enterprise', NOW));
      emptyDb.close();

      expect(html).not.toContain('NaN');
      expect(html).not.toContain('Infinity');
      expect(html).toContain('Total spend');
    });

    it('warns when the projection exceeds the allowance, naming the exhaustion date', () => {
      const heavyDb = openDatabase(':memory:');
      saveTurnRecords(heavyDb, [
        record({ requestId: 'r1', ts: Date.UTC(2026, 5, 1), credits: 5000 }),
      ]);

      const html = renderStaticHtmlReport(buildExportData(heavyDb, 'business', NOW));
      heavyDb.close();

      expect(html).toContain('class="warning"');
      expect(html).toContain('Projected to exceed the allowance');
      expect(html).toMatch(/projected exhaustion date: \d{4}-\d{2}-\d{2}/);
    });

    it('omits the warning when spend is within the allowance', () => {
      const html = renderStaticHtmlReport(buildExportData(db, 'enterprise', NOW));
      expect(html).not.toContain('class="warning"');
    });
  });
});
