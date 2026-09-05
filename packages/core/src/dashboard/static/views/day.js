import { api } from '../lib/api.js';
import { card, empty, table } from '../lib/dom.js';
import { fmt, fmtInt, pct } from '../lib/format.js';
import { colourFor, legend, stackedBar } from '../lib/charts.js';

export const meta = { id: 'day', label: 'Day detail', icon: '◷', hidden: true };

export async function render(state) {
  const date = state.from || state.to;
  if (!date) {
    return [card('Day detail', null, empty('Pick a day from the Overview burn-down.'))];
  }

  const detail = await api.day(date);

  if (detail.requestCount === 0) {
    return [card(`${date}`, null, empty('Nothing was recorded on this day.'))];
  }

  const segments = detail.byModel.map((model, index) => ({
    label: model.model,
    value: model.credits,
    colour: colourFor(index),
  }));

  return [
    card(
      date,
      `${fmt(detail.totalCredits)} credits across ${fmtInt(detail.requestCount)} request(s).`,
      [
        stackedBar(segments, { height: 28 }),
        legend(segments.map((segment) => ({ label: segment.label, colour: segment.colour }))),
      ],
    ),

    card(
      'Models that day',
      null,
      table(
        [
          { key: 'model', label: 'Model' },
          { key: 'credits', label: 'Credits', numeric: true, render: (row) => fmt(row.credits) },
          { key: 'requestCount', label: 'Requests', numeric: true },
        ],
        detail.byModel,
        { sortKey: 'credits' },
      ),
    ),

    card(
      'Cost centres that day',
      null,
      table(
        [
          { key: 'label', label: 'Cost centre' },
          { key: 'tokens', label: 'Tokens', numeric: true, render: (row) => fmtInt(row.tokens) },
          { key: 'credits', label: 'Credits', numeric: true, render: (row) => fmt(row.credits) },
        ],
        detail.byCostCentre,
        { sortKey: 'tokens' },
      ),
    ),

    card(
      'Sessions that day',
      'Session ids are salted hashes.',
      table(
        [
          { key: 'sessionId', label: 'Session', render: (row) => row.sessionId.slice(0, 8) },
          { key: 'credits', label: 'Credits', numeric: true, render: (row) => fmt(row.credits) },
          { key: 'requestCount', label: 'Requests', numeric: true },
          {
            key: 'share',
            label: 'Share',
            numeric: true,
            render: (row) => pct((row.credits / (detail.totalCredits || 1)) * 100),
          },
        ],
        detail.sessions,
        { sortKey: 'credits' },
      ),
    ),
  ];
}
