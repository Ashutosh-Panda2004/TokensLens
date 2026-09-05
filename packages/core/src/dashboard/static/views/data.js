import { api, token } from '../lib/api.js';
import { card, el } from '../lib/dom.js';
import { toQuery } from '../lib/state.js';

export const meta = { id: 'data', label: 'Data', icon: '↧' };

/**
 * The "where did this come from" view.
 *
 * Export downloads the **currently filtered** data, not a fresh unfiltered
 * pull — an export that silently ignores the scope and range the reader set
 * would hand them a file that disagrees with the screen they exported it
 * from.
 */
export async function render(state) {
  const query = toQuery(state);
  const [ledger, scope, reports] = await Promise.all([
    api.ledger(query),
    api.scope(query),
    api.reports(query).catch(() => ({ periods: [] })),
  ]);

  return [
    card('What you are looking at', null, [
      el('dl', { className: 'tl-budget-grid' }, [
        term(
          'Scope',
          scope.scope.isEverything
            ? 'All projects on this machine'
            : (scope.scope.rootDisplayPath ?? 'current folder'),
        ),
        term(
          'Workspaces',
          `${String(scope.scope.matchedWorkspaceCount)} of ${String(scope.scope.totalWorkspaceCount)}`,
        ),
        term('Range', query.from ? `${query.from} → ${query.to ?? 'today'}` : 'All time'),
        term('Requests', String(ledger.requestCount)),
        term(
          'Measured share',
          `${String(ledger.totalCredits.measuredPercent)}% of credits are read from a recorded value`,
        ),
      ]),
    ]),

    monthlyReportCard(reports.periods, query),

    card(
      'Export this view',
      'JSON and CSV are generated in the browser from exactly the data on screen. The self-contained HTML report is produced by the CLI: tokenlens dashboard --html report.html',
      el('div', { className: 'tl-controls' }, [
        button('Download JSON', () =>
          download('tokenlens-ledger.json', JSON.stringify(ledger, null, 2), 'application/json'),
        ),
        button('Download CSV (daily)', () =>
          download('tokenlens-daily.csv', toCsv(ledger), 'text/csv'),
        ),
      ]),
    ),

    card('Provenance and privacy', null, [
      el('ul', { className: 'tl-list' }, [
        el(
          'li',
          {},
          'Session ids are salted hashes — the raw value was discarded at ingest and never stored.',
        ),
        el(
          'li',
          {},
          'Journal paths are stored relative to workspaceStorage, dropping the home-directory prefix that names a person.',
        ),
        el(
          'li',
          {},
          'Project folders are resolved in memory each run and never written to the database.',
        ),
        el(
          'li',
          {},
          'This server binds to 127.0.0.1, requires a per-run token, and exposes no write route.',
        ),
        el(
          'li',
          {},
          token
            ? 'The launch token was read from the URL and is sent as a bearer header.'
            : 'No token was supplied — API calls will be refused.',
        ),
      ]),
    ]),
  ];
}

function term(label, value) {
  return el('div', { className: 'tl-budget-item' }, [
    el('dt', { className: 'tl-budget-label' }, label),
    el('dd', { className: 'tl-budget-value tl-definition-value' }, value),
  ]);
}

function button(label, onclick) {
  return el('button', { type: 'button', className: 'tl-button', onclick }, label);
}

/**
 * One downloadable Markdown report per month.
 *
 * Markdown rather than JSON or HTML because the intended next step is to
 * paste it into an assistant: it is the one format a person and a model can
 * both read without conversion. The file ends with a written analysis brief,
 * which is a visible section rather than a hidden instruction — a report is a
 * thing people forward, and instructions concealed in a forwarded document
 * would act on somebody else's assistant without their knowledge.
 */
function monthlyReportCard(periods, query) {
  if (!periods || periods.length === 0) {
    return card(
      'Monthly report',
      'No month in this scope has recorded activity yet.',
      el('p', { className: 'tl-subtle' }, 'Use Copilot in this project and a report will appear.'),
    );
  }

  const status = el('p', { className: 'tl-subtle' }, '');

  const rows = periods.map((period) => {
    const action = el(
      'button',
      {
        type: 'button',
        className: 'tl-button tl-button-primary',
        onclick: async () => {
          action.disabled = true;
          status.textContent = `Building ${period}…`;
          try {
            const markdown = await api.report(period, query);
            download(`tokenlens-${period}.md`, markdown, 'text/markdown');
            status.textContent = `Downloaded tokenlens-${period}.md — paste it into your approved assistant for the analysis.`;
          } catch (error) {
            status.textContent = `Could not build ${period}: ${String(error)}`;
          } finally {
            action.disabled = false;
          }
        },
      },
      `Download ${period}`,
    );
    return el('div', { className: 'tl-report-row' }, [
      el('span', { className: 'tl-report-period' }, period),
      action,
    ]);
  });

  return card(
    'Monthly report',
    'A month of spend as Markdown — the decomposition, the detector findings, and a written brief that tells an AI assistant how to analyse it.',
    [
      ...rows,
      status,
      el(
        'p',
        { className: 'tl-subtle' },
        'Per-session detail is withheld so the file is safe to hand to a third-party assistant. For a copy that keeps it, run: tokenlens report --month YYYY-MM --self --out report.md',
      ),
    ],
  );
}

function toCsv(ledger) {
  const header =
    'day,credits,measured_credits,modelled_credits,prompt_tokens,output_tokens,requests';
  const rows = ledger.byDay.map((entry) =>
    [
      entry.day,
      entry.credits.value.toFixed(3),
      entry.credits.measured.toFixed(3),
      entry.credits.modelled.toFixed(3),
      entry.promptTokens,
      entry.outputTokens,
      entry.requestCount,
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
