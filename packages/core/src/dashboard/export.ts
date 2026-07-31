import { writeFile } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { buildLedger } from '../ledger/ledger.js';
import { forecastBudget, type CopilotPlan } from '../ledger/budget.js';
import {
  toBudgetView,
  toLedgerView,
  type BudgetView,
  type LedgerView,
  type ProvenanceView,
} from './view-model.js';
import type { Value } from '../model/provenance.js';
import { assertReportSafe, mayIncludeEntityList, suppressionNotice } from '../privacy/guard.js';
import { shortId } from '../privacy/identifiers.js';
import type { PrivacyContext } from '../privacy/scope.js';

export interface ExportData {
  readonly generatedAt: string;
  readonly ledger: LedgerView;
  readonly budget: BudgetView;
}

export interface ExportData {
  readonly generatedAt: string;
  readonly ledger: LedgerView;
  readonly budget: BudgetView;
  /** Scope this artefact was built for, so a reader can tell what was withheld. */
  readonly privacy: PrivacyContext;
}

/**
 * An exported file is the artefact most likely to be forwarded to someone
 * other than its subject, so it defaults to `shared` — the safe scope.
 * A caller wanting their own unredacted copy has to ask for it.
 */
const DEFAULT_EXPORT_PRIVACY: PrivacyContext = { scope: 'shared', subjectCount: 1 };

/** Builds the same provenance-annotated view model the live dashboard and both exporters share. */
export function buildExportData(
  db: Database.Database,
  plan: CopilotPlan = 'enterprise',
  now: Date = new Date(),
  privacy: PrivacyContext = DEFAULT_EXPORT_PRIVACY,
): ExportData {
  const summary = buildLedger(db);
  const forecast = forecastBudget(summary, plan, now);

  const ledger = toLedgerView(summary);

  return {
    generatedAt: now.toISOString(),
    // A per-session breakdown is the sharpest re-identification tool in the
    // report, so it is dropped from the data itself rather than merely
    // hidden at render time — a JSON export has no render step.
    ledger: mayIncludeEntityList(privacy) ? ledger : { ...ledger, bySession: [] },
    budget: toBudgetView(forecast, summary, now),
    privacy,
  };
}

/** `tokenlens dashboard --json <file>` — the raw view model, for scripting/archival. */
export async function exportJson(
  db: Database.Database,
  filePath: string,
  plan?: CopilotPlan,
  now?: Date,
  privacy: PrivacyContext = DEFAULT_EXPORT_PRIVACY,
): Promise<void> {
  const data = buildExportData(db, plan, now, privacy);
  // Runs on the finished artefact, immediately before it is written. Any
  // field that would identify someone stops the write entirely.
  assertReportSafe(data, privacy);
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * `tokenlens dashboard --html <file>` — a single, self-contained HTML
 * file (inline CSS, no external assets, no fetch calls) suitable for
 * e-mailing to finance and opening completely offline (D2.10).
 */
export async function exportHtml(
  db: Database.Database,
  filePath: string,
  plan?: CopilotPlan,
  now?: Date,
  privacy: PrivacyContext = DEFAULT_EXPORT_PRIVACY,
): Promise<void> {
  const data = buildExportData(db, plan, now, privacy);
  assertReportSafe(data, privacy);
  await writeFile(filePath, renderStaticHtmlReport(data), 'utf8');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(n: number, digits = 1): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function chipHtml(view: ProvenanceView): string {
  const label =
    view.kind === 'measured'
      ? 'measured'
      : view.kind === 'modelled'
        ? 'modelled'
        : `~${String(view.measuredPercent)}% measured`;
  const title = `${fmt(view.measured)} measured + ${fmt(view.modelled)} modelled = ${fmt(view.value)} credits`;
  return `<span class="chip chip-${view.kind}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

/** Renders a tagged `Value` (a single figure, measured *or* modelled) as a hoverable chip. */
function taggedChipHtml(value: Value<number> | Value<string>): string {
  const p = value.provenance;
  const title =
    p.kind === 'measured'
      ? p.source
      : `${p.basis}${p.assumptions.length > 0 ? ` \u2014 assumes: ${p.assumptions.join('; ')}` : ''}`;
  return `<span class="chip chip-${p.kind}" title="${escapeHtml(title)}">${p.kind}</span>`;
}

const TREEMAP_COLORS = ['#1f6feb', '#8250df', '#cf222e', '#9a6700', '#1a7f37', '#57606a'];

function renderTotalsSection(ledger: LedgerView): string {
  return `
    <section class="card">
      <h2>Total spend</h2>
      <div class="totals">
        <div><div class="total-value">${fmt(ledger.totalCredits.value)} ${chipHtml(ledger.totalCredits)}</div><div class="total-label">credits</div></div>
        <div><div class="total-value">${String(ledger.requestCount)}</div><div class="total-label">requests</div></div>
      </div>
    </section>`;
}

function renderBurnDownSection(ledger: LedgerView, budget: BudgetView): string {
  const maxDayCredits = Math.max(1, ...ledger.byDay.map((d) => d.credits.value));
  const rows = ledger.byDay
    .map(
      (day) => `
      <tr>
        <td>${escapeHtml(day.day)}</td>
        <td class="num">${fmt(day.credits.value)} ${chipHtml(day.credits)}</td>
        <td class="num">${String(day.requestCount)}</td>
        <td><div class="bar-track"><div class="bar-fill" style="width:${String((day.credits.value / maxDayCredits) * 100)}%"></div></div></td>
      </tr>`,
    )
    .join('');

  const warning = budget.onTrackToExceedAllowance
    ? `<p class="warning">\u26a0 Projected to exceed the allowance by ${fmt(budget.projectedOverage.value)} credits ${taggedChipHtml(budget.projectedOverage)}${budget.hardBlockDate ? ` \u2014 projected exhaustion date: ${escapeHtml(budget.hardBlockDate.value)} ${taggedChipHtml(budget.hardBlockDate)}` : ''}</p>`
    : '';

  return `
    <section class="card">
      <h2>Burn-down</h2>
      <p class="note">Credits per day, month-to-date, and the projected month-end forecast</p>
      <div class="budget-grid">
        <div><div class="budget-label">Plan</div><div class="budget-value">${escapeHtml(budget.plan)}</div></div>
        <div><div class="budget-label">Monthly allowance</div><div class="budget-value">${fmt(budget.monthlyAllowance, 0)} credits</div></div>
        <div><div class="budget-label">Month-to-date</div><div class="budget-value">${fmt(budget.monthToDateCredits.value)} ${chipHtml(budget.monthToDateCredits)}</div></div>
        <div><div class="budget-label">Projected month-end</div><div class="budget-value">${fmt(budget.projectedMonthEndCredits.value)} ${taggedChipHtml(budget.projectedMonthEndCredits)}</div></div>
      </div>
      ${warning}
      <table><thead><tr><th>Day</th><th>Credits</th><th>Requests</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
}

function renderCostCentresSection(ledger: LedgerView): string {
  const segments = ledger.byCostCentre
    .map(
      (centre, i) =>
        `<div class="treemap-segment" style="width:${String(centre.tokenShare)}%;background:${TREEMAP_COLORS[i % TREEMAP_COLORS.length] ?? '#57606a'}" title="${escapeHtml(centre.label)}: ${String(centre.tokenShare)}%">${centre.tokenShare >= 6 ? escapeHtml(`${centre.label} ${String(centre.tokenShare)}%`) : ''}</div>`,
    )
    .join('');

  const rows = ledger.byCostCentre
    .map(
      (centre) => `
      <tr>
        <td>${escapeHtml(centre.label)}</td>
        <td class="num">${fmt(centre.tokens, 0)}</td>
        <td class="num">${String(centre.tokenShare)}%</td>
        <td class="num">${fmt(centre.credits.value)} ${chipHtml(centre.credits)}</td>
      </tr>`,
    )
    .join('');

  return `
    <section class="card">
      <h2>Cost-centre breakdown</h2>
      <p class="note">The five-way split of every prompt \u2014 the Tool Definitions share is the headline finding (F3)</p>
      <div class="treemap">${segments}</div>
      <table><thead><tr><th>Cost centre</th><th>Tokens</th><th>Share</th><th>Credits</th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
}

function renderModelMixSection(ledger: LedgerView): string {
  const maxCredits = Math.max(1, ...ledger.byModel.map((m) => m.credits.value));
  const rows = ledger.byModel
    .map(
      (model) => `
      <tr>
        <td>${escapeHtml(model.model)}</td>
        <td class="num">${fmt(model.credits.value)} ${chipHtml(model.credits)}</td>
        <td class="num">${String(model.requestCount)}</td>
        <td class="num">${fmt(model.rate.value, 3)} ${taggedChipHtml(model.rate)}</td>
        <td><div class="bar-track"><div class="bar-fill" style="width:${String((model.credits.value / maxCredits) * 100)}%"></div></div></td>
      </tr>`,
    )
    .join('');

  return `
    <section class="card">
      <h2>Model mix</h2>
      <p class="note">Requests and credits by model \u2014 note the price spread between them</p>
      <table><thead><tr><th>Model</th><th>Credits</th><th>Requests</th><th>cr / 1k</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
}

function renderSessionsSection(ledger: LedgerView, privacy: PrivacyContext): string {
  // In a shared artefact the ranking is withheld and *said* to be withheld,
  // so the omission reads as a deliberate choice rather than missing data.
  if (!mayIncludeEntityList(privacy)) {
    return `
    <section class="card">
      <h2>Session concentration</h2>
      <p class="note">${escapeHtml(suppressionNotice())}</p>
    </section>`;
  }

  const top = ledger.bySession.slice(0, 10);
  const maxCredits = Math.max(1, ...top.map((s) => s.credits.value));
  const rows = top
    .map(
      (session, index) => `
      <tr>
        <td>${String(index + 1)}</td>
        <td>${escapeHtml(shortId(session.sessionId))}</td>
        <td class="num">${fmt(session.credits.value)} ${chipHtml(session.credits)}</td>
        <td class="num">${String(session.requestCount)}</td>
        <td><div class="bar-track"><div class="bar-fill" style="width:${String((session.credits.value / maxCredits) * 100)}%"></div></div></td>
      </tr>`,
    )
    .join('');

  const share =
    ledger.totalCredits.value > 0
      ? (top.reduce((sum, s) => sum + s.credits.value, 0) / ledger.totalCredits.value) * 100
      : 0;

  return `
    <section class="card">
      <h2>Session leaderboard</h2>
      <p class="note">Top ${String(top.length)} of ${String(ledger.bySession.length)} sessions carry ${fmt(share)}% of all credits</p>
      <table><thead><tr><th>#</th><th>Session</th><th>Credits</th><th>Requests</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
}

const REPORT_STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #f7f8fa; color: #1a1d23; line-height: 1.5; }
  header { padding: 24px 32px 8px; }
  header h1 { margin: 0; font-size: 1.6rem; }
  .subtitle { margin: 4px 0 0; color: #5b6270; font-size: 0.9rem; }
  main { padding: 0 32px 32px; display: flex; flex-direction: column; gap: 20px; max-width: 1100px; }
  .card { background: #fff; border: 1px solid #e2e5ea; border-radius: 8px; padding: 20px 24px; }
  .card h2 { margin: 0 0 4px; font-size: 1.05rem; }
  .note { margin: 0 0 16px; color: #5b6270; font-size: 0.85rem; }
  .totals { display: flex; gap: 32px; flex-wrap: wrap; }
  .total-value { font-size: 2rem; font-weight: 600; }
  .total-label { color: #5b6270; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.72rem; font-weight: 600; }
  .chip-measured { background: #dafbe1; color: #1a7f37; }
  .chip-modelled { background: #fff3d6; color: #9a6700; }
  .chip-blended { background: #ffedc2; color: #7d4e00; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #e2e5ea; vertical-align: middle; }
  th { color: #5b6270; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bar-track { background: #eef0f3; border-radius: 4px; height: 8px; width: 100%; overflow: hidden; }
  .bar-fill { background: #1f6feb; height: 100%; }
  .treemap { display: flex; width: 100%; height: 60px; border-radius: 6px; overflow: hidden; margin-bottom: 16px; }
  .treemap-segment { display: flex; align-items: center; justify-content: center; color: #fff; font-size: 0.78rem; font-weight: 600; overflow: hidden; white-space: nowrap; padding: 0 4px; border-right: 2px solid #fff; }
  .budget-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 16px; }
  .budget-label { color: #5b6270; font-size: 0.8rem; }
  .budget-value { font-size: 1.2rem; font-weight: 600; }
  .warning { background: #ffedc2; color: #7d4e00; border-radius: 6px; padding: 8px 12px; font-size: 0.85rem; font-weight: 600; }
  footer { padding: 8px 32px 32px; color: #5b6270; font-size: 0.78rem; }
`;

/** Renders a complete, self-contained HTML document — no external assets, no network calls, opens fully offline. */
export function renderStaticHtmlReport(data: ExportData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>TokenLens report — ${escapeHtml(data.generatedAt)}</title>
<style>${REPORT_STYLE}</style>
</head>
<body>
<header>
  <h1>TokenLens</h1>
  <p class="subtitle">Measured GitHub Copilot credit ledger \u2014 generated ${escapeHtml(data.generatedAt)}</p>
</header>
<main>
${renderTotalsSection(data.ledger)}
${renderBurnDownSection(data.ledger, data.budget)}
${renderCostCentresSection(data.ledger)}
${renderModelMixSection(data.ledger)}
${renderSessionsSection(data.ledger, data.privacy)}
</main>
<footer>
  <p><span class="chip chip-measured">measured</span> read directly from a field VS Code wrote to disk. &middot;
  <span class="chip chip-blended">~N% measured</span> a mix, exact split on hover. &middot;
  <span class="chip chip-modelled">modelled</span> estimated \u2014 hover for the assumption.</p>
</footer>
</body>
</html>
`;
}
