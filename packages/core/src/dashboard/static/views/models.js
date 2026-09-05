import { api } from '../lib/api.js';
import { card, el, empty, table } from '../lib/dom.js';
import { fmt, fmtInt, pct, provenanceChip, taggedChip } from '../lib/format.js';
import { barsH, colourFor, donutChart, legend, stackedAreaChart } from '../lib/charts.js';
import { toQuery } from '../lib/state.js';

export const meta = { id: 'models', label: 'Models', icon: '◇' };

export async function render(state) {
  const query = toQuery(state);
  const [ledger, series] = await Promise.all([api.ledger(query), api.timeseries(query)]);

  if (ledger.byModel.length === 0) {
    return [card('Models', null, empty('No requests in this scope and range.'))];
  }

  const total = ledger.totalCredits.value || 1;
  const byRate = [...ledger.byModel].sort((a, b) => a.rate.value - b.rate.value);
  const cheapest = byRate[0];
  const dearest = byRate[byRate.length - 1];
  const spread = cheapest.rate.value > 0 ? dearest.rate.value / cheapest.rate.value : null;

  const segments = ledger.byModel.map((model, index) => ({
    label: model.model,
    value: model.credits.value,
    colour: colourFor(index),
  }));

  const bands = series.byModel.slice(0, 8).map((band, index) => ({
    key: band.key,
    colour: colourFor(index),
    values: band.values,
  }));

  return [
    el('div', { className: 'tl-grid-3' }, [
      kpi('Models in use', fmtInt(ledger.byModel.length)),
      kpi('Cheapest rate', cheapest.rate.value.toFixed(3), `${cheapest.model} · credits / 1k`),
      kpi('Dearest rate', dearest.rate.value.toFixed(3), `${dearest.model} · credits / 1k`),
      kpi('Spread', spread ? `${spread.toFixed(1)}×` : '—', 'the largest single lever available'),
    ]),

    el('div', { className: 'tl-grid-2' }, [
      card(
        'Share of credits',
        'Not share of requests — a cheap model can dominate one and barely register in the other.',
        [
          donutChart({
            segments,
            centreValue: fmt(total, 0),
            centreLabel: 'credits',
            height: 220,
          }),
          legend(segments.slice(0, 8).map((s) => ({ label: s.label, colour: s.colour }))),
        ],
      ),
      card(
        'Credits by model',
        null,
        barsH({
          rows: ledger.byModel.slice(0, 10).map((model, index) => ({
            label: model.model,
            value: model.credits.value,
            colour: colourFor(index),
            detail: `${String(model.requestCount)} requests · ${model.rate.value.toFixed(3)} cr/1k`,
          })),
        }),
      ),
    ]),

    card('Model mix over time', 'Whether the expensive share is growing, not just how big it is.', [
      stackedAreaChart({ labels: series.days, series: bands, height: 260 }),
      legend(bands.map((band) => ({ label: band.key, colour: band.colour }))),
    ]),

    card(
      'By model',
      'A rate carries its own provenance: one derived from this model’s measured requests and one that fell back to the blended average are different claims.',
      table(
        [
          { key: 'model', label: 'Model' },
          {
            key: 'creditsValue',
            label: 'Credits',
            numeric: true,
            render: (row) =>
              el('span', {}, [fmt(row.credits.value), ' ', provenanceChip(row.credits)]),
          },
          { key: 'requestCount', label: 'Requests', numeric: true },
          { key: 'share', label: 'Share', numeric: true, render: (row) => pct(row.share) },
          {
            key: 'rateValue',
            label: 'cr / 1k',
            numeric: true,
            render: (row) => el('span', {}, [row.rate.value.toFixed(3), ' ', taggedChip(row.rate)]),
          },
          {
            key: 'rateSampleSize',
            label: 'Rate samples',
            numeric: true,
            render: (row) =>
              row.rateSampleSize === 0 ? 'blended fallback' : fmtInt(row.rateSampleSize),
          },
        ],
        ledger.byModel.map((model) => ({
          ...model,
          creditsValue: model.credits.value,
          rateValue: model.rate.value,
          share: (model.credits.value / total) * 100,
        })),
        { sortKey: 'creditsValue' },
      ),
    ),
  ];
}

function kpi(label, value, sub) {
  return el('div', { className: 'tl-kpi' }, [
    el('div', { className: 'tl-kpi-label' }, label),
    el('div', { className: 'tl-kpi-value' }, value),
    sub ? el('div', { className: 'tl-kpi-sub' }, sub) : null,
  ]);
}
