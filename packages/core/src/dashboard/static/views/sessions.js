import { api } from '../lib/api.js';
import { card, el, empty, table } from '../lib/dom.js';
import { fmt, fmtInt, pct, provenanceChip } from '../lib/format.js';
import { toQuery } from '../lib/state.js';

export const meta = { id: 'sessions', label: 'Sessions', icon: '❐' };

export async function render(state) {
  const ledger = await api.ledger(toQuery(state));

  if (ledger.bySession.length === 0) {
    return [card('Sessions', null, empty('No sessions in this scope and range.'))];
  }

  const total = ledger.totalCredits.value || 1;
  const topFive = ledger.bySession.slice(0, 5).reduce((sum, s) => sum + s.credits.value, 0);

  return [
    card(
      'Session concentration',
      'Spend concentrating in a few long sessions is the signal behind session-hygiene advice.',
      [
        el('div', { className: 'tl-totals' }, [
          el('div', { className: 'tl-total-figure' }, [
            el('div', { className: 'tl-total-value' }, pct((topFive / total) * 100)),
            el('div', { className: 'tl-total-label' }, 'Top 5 share'),
          ]),
          el('div', { className: 'tl-total-figure' }, [
            el('div', { className: 'tl-total-value' }, fmtInt(ledger.bySession.length)),
            el('div', { className: 'tl-total-label' }, 'Sessions'),
          ]),
        ]),
        el(
          'p',
          { className: 'tl-subtle' },
          'Session ids are salted hashes — the raw value was discarded at ingest and never stored.',
        ),
        table(
          [
            { key: 'sessionId', label: 'Session', render: (row) => row.sessionId.slice(0, 8) },
            {
              key: 'credits',
              label: 'Credits',
              numeric: true,
              render: (row) =>
                el('span', {}, [fmt(row.credits), ' ', provenanceChip(row.provenance)]),
            },
            { key: 'requestCount', label: 'Requests', numeric: true },
            {
              key: 'share',
              label: 'Share',
              numeric: true,
              render: (row) => pct(row.share),
            },
            {
              key: 'firstTs',
              label: 'Started',
              render: (row) => new Date(row.firstTs).toISOString().slice(0, 16).replace('T', ' '),
            },
          ],
          ledger.bySession.map((session) => ({
            ...session,
            credits: session.credits.value,
            provenance: session.credits,
            share: (session.credits.value / total) * 100,
          })),
          { sortKey: 'credits' },
        ),
      ],
    ),
    card('Provenance', null, [
      el('p', {}, [
        'Total for this scope: ',
        el('strong', {}, fmt(ledger.totalCredits.value)),
        ' ',
        provenanceChip(ledger.totalCredits),
      ]),
    ]),
  ];
}
