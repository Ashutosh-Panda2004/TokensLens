import { api } from '../lib/api.js';
import { bar, card, el, empty, table } from '../lib/dom.js';
import { fmt, fmtInt, pct } from '../lib/format.js';

export const meta = { id: 'tools', label: 'Tools', icon: '⚒' };

export async function render() {
  const roi = await api.mcpRoi();

  if (roi.length === 0) {
    return [card('Tool ROI', null, empty('No tool invocations recorded.'))];
  }

  const max = Math.max(...roi.map((entry) => entry.invocations), 1);

  return [
    card(
      'Tool and MCP server ROI',
      'Only tools that were actually invoked can appear here. A server installed and never called leaves no trace in the journal — and that is the most wasteful case of all.',
      table(
        [
          { key: 'server', label: 'Server / group' },
          { key: 'toolCount', label: 'Tools', numeric: true },
          {
            key: 'invocations',
            label: 'Invocations',
            numeric: true,
            render: (r) => fmtInt(r.invocations),
          },
          {
            key: 'invocationShare',
            label: 'Share',
            numeric: true,
            render: (row) => pct(row.invocationShare * 100),
          },
          {
            key: 'verdict',
            label: 'Verdict',
            render: (row) =>
              el('span', { className: `tl-verdict tl-verdict-${row.verdict}` }, row.verdict),
          },
          {
            key: 'weight',
            label: '',
            sortable: false,
            render: (row) => bar(row.invocations / max),
          },
        ],
        roi,
        { sortKey: 'invocations' },
      ),
    ),
  ];
}

export { fmt };
