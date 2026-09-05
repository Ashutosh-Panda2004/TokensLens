import { writeFile } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { buildLedger } from '../ledger/ledger.js';
import { forecastBudget, type Allowance, type CopilotPlan } from '../ledger/budget.js';
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
  plan: CopilotPlan | Allowance = 'enterprise',
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
  plan?: CopilotPlan | Allowance,
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
  plan?: CopilotPlan | Allowance,
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

const TREEMAP_COLORS = ['#1467df', '#087f8c', '#1f8b57', '#d18a12', '#c44d43', '#68717e'];

function renderTotalsSection(ledger: LedgerView): string {
  return `
    <section class="card report-total">
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
    <section class="card report-budget">
      <h2>Burn-down</h2>
      <p class="note">Credits per day, month-to-date, and the projected month-end forecast</p>
      <div class="budget-grid">
        <div><div class="budget-label">Plan</div><div class="budget-value">${escapeHtml(budget.plan)}</div></div>
        <div><div class="budget-label">Monthly allowance</div><div class="budget-value">${budget.monthlyAllowance === null ? 'unlimited — no monthly limit set' : `${fmt(budget.monthlyAllowance, 0)} credits`}</div></div>
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
    <section class="card report-breakdown">
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
    <section class="card report-models">
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
    <section class="card report-sessions">
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
    <section class="card report-sessions">
      <h2>Session leaderboard</h2>
      <p class="note">Top ${String(top.length)} of ${String(ledger.bySession.length)} sessions carry ${fmt(share)}% of all credits</p>
      <table><thead><tr><th>#</th><th>Session</th><th>Credits</th><th>Requests</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
}

const REPORT_STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #f2f4f6;
    --surface: #ffffff;
    --surface-alt: #f7f9fb;
    --line: #dfe3e8;
    --line-strong: #cbd1d8;
    --text: #181b20;
    --muted: #68717e;
    --accent: #1467df;
    --accent-deep: #0d54bc;
    --accent-soft: #e8f1ff;
    --secondary: #087f8c;
    --measured: #177245;
    --measured-bg: #e2f6eb;
    --modelled: #8a5a00;
    --modelled-bg: #fff3d8;
    --blended: #7a4c00;
    --blended-bg: #ffedc2;
    --warning-line: #d18a12;
    --shadow: 0 1px 2px rgba(20, 28, 40, 0.04), 0 12px 32px rgba(20, 28, 40, 0.06);
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101113;
      --surface: #191b1f;
      --surface-alt: #22252a;
      --line: #30343a;
      --line-strong: #42474f;
      --text: #f0f2f4;
      --muted: #9ca4ae;
      --accent: #6ba2ff;
      --accent-deep: #8bb6ff;
      --accent-soft: rgba(73, 132, 230, 0.18);
      --secondary: #55bec5;
      --measured: #70d69a;
      --measured-bg: rgba(51, 165, 101, 0.16);
      --modelled: #e7bd68;
      --modelled-bg: rgba(191, 133, 24, 0.16);
      --blended: #f1c778;
      --blended-bg: rgba(206, 143, 25, 0.2);
      --warning-line: #e7bd68;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.28), 0 14px 34px rgba(0, 0, 0, 0.18);
    }
  }

  * { box-sizing: border-box; }
  html { min-width: 320px; background: var(--bg); }
  body {
    margin: 0;
    font-family: Aptos, 'Segoe UI Variable Text', 'Segoe UI', sans-serif;
    background:
      linear-gradient(90deg, color-mix(in srgb, var(--line) 32%, transparent) 1px, transparent 1px),
      linear-gradient(color-mix(in srgb, var(--line) 24%, transparent) 1px, transparent 1px),
      var(--bg);
    background-size: 48px 48px;
    color: var(--text);
    line-height: 1.5;
    letter-spacing: 0;
    -webkit-font-smoothing: antialiased;
  }
  header {
    position: relative;
    padding: 34px max(24px, calc((100vw - 1180px) / 2)) 72px;
    overflow: hidden;
    color: #f7f8fa;
    background: #17191d;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  header::after {
    content: '';
    position: absolute;
    inset: auto 0 0;
    height: 3px;
    background: linear-gradient(90deg, #2678ec, #0c8790, #1f8b57, #d18a12);
  }
  header h1 {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0;
    font-size: 1.6rem;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: 0;
  }
  header h1::before {
    content: '';
    width: 30px;
    height: 30px;
    border-radius: 7px;
    background: linear-gradient(145deg, #2678ec, #0c8790);
    box-shadow: 0 7px 20px rgba(20, 103, 223, 0.3), inset 0 1px rgba(255, 255, 255, 0.22);
  }
  .subtitle { margin: 8px 0 0 42px; color: #aeb5bf; font-size: 0.82rem; }
  main {
    position: relative;
    width: min(1180px, calc(100% - 48px));
    margin: -42px auto 0;
    padding: 0 0 34px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .card {
    position: relative;
    min-width: 0;
    padding: 20px 22px 22px;
    overflow-x: auto;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: var(--shadow);
    animation: report-enter 420ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .card:nth-child(2) { animation-delay: 45ms; }
  .card:nth-child(3) { animation-delay: 90ms; }
  .card:nth-child(4) { animation-delay: 135ms; }
  .card:nth-child(5) { animation-delay: 180ms; }
  .card::before {
    content: '';
    position: absolute;
    inset: 0 0 auto;
    height: 2px;
    background: linear-gradient(90deg, var(--accent), var(--secondary));
    opacity: 0;
  }
  .card:hover { border-color: var(--line-strong); }
  .card:hover::before { opacity: 1; }
  .card h2 { margin: 0 0 5px; font-size: 1rem; font-weight: 700; letter-spacing: 0; }
  .note { max-width: 88ch; margin: 0 0 18px; color: var(--muted); font-size: 0.8rem; }
  .report-total {
    overflow: visible;
    color: #f7f8fa;
    background:
      linear-gradient(135deg, rgba(38, 120, 236, 0.18), transparent 48%),
      #202329;
    border-color: rgba(255, 255, 255, 0.08);
    box-shadow: 0 18px 48px rgba(8, 10, 14, 0.2);
  }
  .report-total::before { opacity: 1; }
  .totals { display: flex; gap: 42px; flex-wrap: wrap; }
  .total-value {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 2rem;
    font-weight: 720;
    line-height: 1.15;
    font-variant-numeric: tabular-nums;
  }
  .total-label {
    margin-top: 4px;
    color: #aeb5bf;
    font-size: 0.72rem;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    min-height: 19px;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 0.68rem;
    font-weight: 650;
    line-height: 1.3;
    white-space: nowrap;
  }
  .chip-measured { background: var(--measured-bg); color: var(--measured); }
  .chip-modelled { background: var(--modelled-bg); color: var(--modelled); }
  .chip-blended { background: var(--blended-bg); color: var(--blended); }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th {
    color: var(--muted);
    background: var(--surface-alt);
    border-top: 1px solid var(--line);
    font-weight: 650;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0;
  }
  tbody tr { transition: background-color 120ms ease; }
  tbody tr:hover { background: var(--accent-soft); }
  tbody tr:last-child td { border-bottom: 0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bar-track {
    min-width: 70px;
    width: 100%;
    height: 6px;
    overflow: hidden;
    background: var(--line);
    border-radius: 999px;
  }
  .bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--secondary));
    border-radius: inherit;
    transform-origin: left center;
    animation: bar-enter 600ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .treemap {
    display: flex;
    width: 100%;
    height: 68px;
    margin-bottom: 18px;
    overflow: hidden;
    border: 3px solid var(--surface-alt);
    border-radius: 8px;
    background: var(--surface-alt);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .treemap-segment {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 2px;
    overflow: hidden;
    padding: 0 5px;
    border-right: 2px solid var(--surface);
    color: #fff;
    font-size: 0.72rem;
    font-weight: 650;
    white-space: nowrap;
  }
  .budget-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 9px;
    margin-bottom: 18px;
  }
  .budget-grid > div {
    padding: 11px 12px;
    background: var(--surface-alt);
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  .budget-label { color: var(--muted); font-size: 0.7rem; font-weight: 620; text-transform: uppercase; }
  .budget-value { margin-top: 3px; font-size: 1.05rem; font-weight: 680; overflow-wrap: anywhere; }
  .warning {
    margin: 14px 0 18px;
    padding: 10px 12px;
    color: var(--modelled);
    background: var(--modelled-bg);
    border: 1px solid color-mix(in srgb, var(--warning-line) 28%, transparent);
    border-left: 3px solid var(--warning-line);
    border-radius: 6px;
    font-size: 0.8rem;
    font-weight: 620;
  }
  footer {
    width: min(1180px, calc(100% - 48px));
    margin: 0 auto;
    padding: 0 0 34px;
    color: var(--muted);
    font-size: 0.72rem;
  }

  @keyframes report-enter {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes bar-enter {
    from { transform: scaleX(0); }
    to { transform: scaleX(1); }
  }

  @media (max-width: 640px) {
    header { padding: 24px 16px 62px; }
    .subtitle { margin-left: 0; }
    main { width: calc(100% - 24px); gap: 12px; }
    .card { padding: 16px; border-radius: 7px; }
    .totals { gap: 22px; }
    .total-value { font-size: 1.65rem; }
    footer { width: calc(100% - 32px); }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }

  @media print {
    :root {
      color-scheme: light;
      --bg: #ffffff;
      --surface: #ffffff;
      --surface-alt: #f7f8fa;
      --line: #d8dde3;
      --line-strong: #c5cbd3;
      --text: #181b20;
      --muted: #5f6875;
      --accent: #1467df;
      --accent-soft: #edf4ff;
      --secondary: #087f8c;
      --measured: #177245;
      --measured-bg: #e2f6eb;
      --modelled: #795100;
      --modelled-bg: #fff3d8;
      --blended: #704600;
      --blended-bg: #ffedc2;
    }
    body { background: #fff; font-size: 10pt; }
    header { padding: 20px 0 28px; color: var(--text); background: #fff; border-bottom: 2px solid var(--text); }
    header::after { display: none; }
    header h1::before { box-shadow: none; print-color-adjust: exact; }
    .subtitle { color: var(--muted); }
    main { width: 100%; margin: 16px 0 0; padding: 0; gap: 12px; }
    .card { break-inside: avoid; padding: 14px; box-shadow: none; animation: none; }
    .report-total { color: var(--text); background: var(--surface-alt); border-color: var(--line); box-shadow: none; }
    .report-total .total-label { color: var(--muted); }
    .treemap-segment, .bar-fill, .chip { print-color-adjust: exact; }
    footer { width: 100%; padding: 16px 0 0; }
  }
`;

/** Renders a complete, self-contained HTML document — no external assets, no network calls, opens fully offline. */
export function renderStaticHtmlReport(data: ExportData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light dark" />
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
