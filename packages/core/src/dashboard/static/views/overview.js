import { api } from '../lib/api.js';
import { card, el, empty, table } from '../lib/dom.js';
import {
  calendarHeatmap,
  colourFor,
  donutChart,
  legend,
  lineChart,
  stackedAreaChart,
} from '../lib/charts.js';
import { fmt, fmtInt, pct, provenanceChip } from '../lib/format.js';
import { setState, toQuery } from '../lib/state.js';

export const meta = { id: 'overview', label: 'Overview', icon: '◈' };

export async function render(state) {
  const query = toQuery(state);
  const [ledger, budget, anomalies, series] = await Promise.all([
    api.ledger(query),
    api.budget(query),
    api.anomalies(query),
    api.timeseries(query),
  ]);

  if (ledger.requestCount === 0) return [emptyScopeCard(ledger.scope)];

  return [
    kpiRow(ledger, budget, anomalies, series),
    trendCard(series, anomalies),
    el('div', { className: 'tl-grid-2' }, [costCentreCard(ledger), modelMixCard(series)]),
    calendarCard(series),
    topDaysCard(series, anomalies),
  ];
}

/**
 * The empty-scope statement — the case that created the whole scoping phase.
 * A blank dashboard reads as "you have spent nothing", which is the opposite
 * of the truth.
 */
function emptyScopeCard(scope) {
  return card(
    'Nothing recorded for this scope',
    'The ledger covers every VS Code workspace on this machine. This one has no chat history yet.',
    [
      el('p', {}, [
        'Scope: ',
        el('strong', {}, scope?.rootDisplayPath ?? 'current folder'),
        ` — ${String(scope?.matchedWorkspaceCount ?? 0)} of ${String(scope?.totalWorkspaceCount ?? 0)} workspace(s).`,
      ]),
      el('p', { className: 'tl-subtle' }, 'Switch Scope to “All projects” above to see the rest.'),
    ],
  );
}

function kpi(label, value, sub, chip) {
  return el('div', { className: 'tl-kpi' }, [
    el('div', { className: 'tl-kpi-label' }, label),
    el('div', { className: 'tl-kpi-value' }, [value, chip ?? null]),
    sub ? el('div', { className: 'tl-kpi-sub' }, sub) : null,
  ]);
}

function kpiRow(ledger, budget, anomalies, series) {
  const days = series.days.length || 1;
  const perDay = ledger.totalCredits.value / days;
  const busiest = series.totals.reduce(
    (best, value, index) => (value > series.totals[best] ? index : best),
    0,
  );

  return el('div', { className: 'tl-grid-3' }, [
    kpi(
      'Credits',
      fmt(ledger.totalCredits.value),
      `${fmtInt(ledger.requestCount)} requests over ${fmtInt(days)} active day(s)`,
      provenanceChip(ledger.totalCredits),
    ),
    kpi('Per active day', fmt(perDay), `Busiest: ${series.days[busiest] ?? '—'}`),
    kpi(
      'Month to date',
      fmt(budget.monthToDateCredits.value),
      budget.unlimited ? 'No monthly limit set' : `of ${fmt(budget.monthlyAllowance, 0)} allowance`,
      provenanceChip(budget.monthToDateCredits),
    ),
    kpi(
      'Models in use',
      fmtInt(ledger.byModel.length),
      ledger.byModel[0] ? `Top: ${ledger.byModel[0].model}` : null,
    ),
    kpi(
      'Measured share',
      pct(ledger.totalCredits.measuredPercent, 0),
      'the rest is a rate-card estimate',
    ),
    kpi(
      'Flagged days',
      fmtInt(anomalies?.anomalies?.length ?? 0),
      'median absolute deviation, not σ',
    ),
  ]);
}

function trendCard(series, anomalies) {
  const flagged = new Set((anomalies?.anomalies ?? []).map((entry) => entry.date));

  return card(
    'Daily spend',
    flagged.size > 0
      ? `${String(flagged.size)} day(s) sit far enough from the median to be worth a look — they are listed below.`
      : 'Hover for the exact figure on any day.',
    [
      lineChart({
        labels: series.days,
        series: [{ key: 'Credits', colour: colourFor(0), values: series.totals }],
        area: true,
        height: 260,
      }),
    ],
  );
}

function costCentreCard(ledger) {
  const segments = ledger.byCostCentre.map((centre, index) => ({
    label: centre.label,
    value: centre.credits.value,
    colour: colourFor(index),
  }));

  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  return card('Where the prompt goes', 'The five-way split VS Code records on every request.', [
    donutChart({
      segments,
      centreValue: fmt(total, 0),
      centreLabel: 'credits',
      height: 220,
    }),
    legend(segments.map((segment) => ({ label: segment.label, colour: segment.colour }))),
    table(
      [
        { key: 'label', label: 'Cost centre' },
        { key: 'tokens', label: 'Tokens', numeric: true, render: (row) => fmtInt(row.tokens) },
        {
          key: 'tokenShare',
          label: 'Share',
          numeric: true,
          render: (row) => pct(row.tokenShare, 0),
        },
      ],
      ledger.byCostCentre,
      { sortKey: 'tokens' },
    ),
  ]);
}

/**
 * Model mix over time.
 *
 * The chart that answers the question a daily total cannot: not "what do we
 * spend on premium models" but "is the premium share growing" — which is
 * exactly what W12 prices and what the routing lever moves.
 */
function modelMixCard(series) {
  const bands = series.byModel.slice(0, 8).map((band, index) => ({
    key: band.key,
    colour: colourFor(index),
    values: band.values,
  }));

  return card('Model mix over time', 'Stacked credits per day, biggest model at the bottom.', [
    stackedAreaChart({ labels: series.days, series: bands, height: 250 }),
    legend(bands.map((band) => ({ label: band.key, colour: band.colour }))),
  ]);
}

function calendarCard(series) {
  const first = series.days[0];
  const last = series.days[series.days.length - 1];
  // Stated because the grid is drawn only over days that were measured. A
  // padded-out calendar would render "before you started" identically to
  // "spent nothing", which are not the same claim.
  const span = first && last ? ` Covering ${first} to ${last} — only measured days are drawn.` : '';

  return card(
    'When the spend happens',
    'Click a day to open its detail. A row of dark Tuesdays is a different problem from a dark month end.' +
      span,
    calendarHeatmap({
      days: series.days,
      values: series.totals,
      onSelect: (day) => setState({ view: 'day', from: day, to: day, range: 'custom' }),
    }),
  );
}

function topDaysCard(series, anomalies) {
  const flagged = new Map((anomalies?.anomalies ?? []).map((entry) => [entry.date, entry]));

  const rows = series.days
    .map((day, index) => ({
      day,
      credits: series.totals[index],
      requests: series.requestCounts[index],
      flagged: flagged.has(day),
    }))
    .sort((a, b) => b.credits - a.credits)
    .slice(0, 12);

  if (rows.length === 0) return card('Most expensive days', null, empty('No days in range.'));

  return card(
    'Most expensive days',
    'Click a row to open that day.',
    el(
      'div',
      { className: 'tl-table-scroll' },
      table(
        [
          {
            key: 'day',
            label: 'Day',
            render: (row) =>
              el('span', { className: row.flagged ? 'tl-anomaly' : '' }, [
                row.day,
                row.flagged ? ' ⚠' : '',
              ]),
          },
          { key: 'credits', label: 'Credits', numeric: true, render: (row) => fmt(row.credits) },
          { key: 'requests', label: 'Requests', numeric: true },
          {
            key: 'perRequest',
            label: 'Per request',
            numeric: true,
            render: (row) => fmt(row.credits / Math.max(1, row.requests)),
          },
        ],
        rows,
        {
          sortKey: 'credits',
          onRowClick: (row) =>
            setState({ view: 'day', from: row.day, to: row.day, range: 'custom' }),
        },
      ),
    ),
  );
}
