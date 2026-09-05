import { api } from '../lib/api.js';
import { bar, card, el, empty, table } from '../lib/dom.js';
import { barsH, colourFor } from '../lib/charts.js';
import { day, fmt, fmtInt, pct } from '../lib/format.js';

export const meta = { id: 'projects', label: 'Projects', icon: '▤' };

export async function render() {
  const [projects, scope] = await Promise.all([api.projects(), api.scope({})]);

  if (projects.length === 0) {
    return [card('Projects', null, empty('No workspace has recorded any Copilot activity yet.'))];
  }

  return [rankCard(projects), projectsCard(projects), anatomyCard(scope), unattributedCard(scope)];
}

function rankCard(projects) {
  const top = projects.slice(0, 12);
  const total = projects.reduce((sum, project) => sum + project.credits, 0);

  return card(
    'Where the credits went',
    `Top ${String(top.length)} of ${String(projects.length)} workspaces, by credits.`,
    barsH({
      rows: top.map((project, index) => ({
        label: project.label ?? '(unplaced)',
        value: project.credits,
        colour: colourFor(index),
        detail: `${((project.credits / (total || 1)) * 100).toFixed(1)}% of all spend · ${String(project.requestCount)} requests`,
      })),
    }),
  );
}

function projectsCard(projects) {
  const max = Math.max(...projects.map((project) => project.credits), 1);
  const filter = el('input', {
    type: 'search',
    className: 'tl-filter',
    placeholder: 'Filter projects…',
    'aria-label': 'Filter projects',
  });

  const rows = projects.map((project) => ({
    ...project,
    project: project.label ?? '(unplaced)',
    measuredShare: project.credits > 0 ? (project.measuredCredits / project.credits) * 100 : 0,
  }));

  const container = el('div');
  const paint = (visible) => {
    container.replaceChildren(
      table(
        [
          {
            key: 'project',
            label: 'Project',
            render: (row) => el('span', { title: row.displayPath ?? row.workspaceId }, row.project),
          },
          { key: 'credits', label: 'Credits', numeric: true, render: (row) => fmt(row.credits) },
          { key: 'requestCount', label: 'Requests', numeric: true },
          { key: 'share', label: 'Share', numeric: true, render: (row) => pct(row.share) },
          {
            key: 'measuredShare',
            label: 'Measured',
            numeric: true,
            render: (row) => pct(row.measuredShare, 0),
          },
          { key: 'firstTs', label: 'First', render: (row) => day(row.firstTs) },
          { key: 'lastTs', label: 'Last', render: (row) => day(row.lastTs) },
          { key: 'topModel', label: 'Top model' },
          {
            key: 'weight',
            label: '',
            sortable: false,
            render: (row) => bar(row.credits / max),
          },
        ],
        visible,
        { sortKey: 'credits' },
      ),
    );
  };

  filter.addEventListener('input', () => {
    const needle = filter.value.trim().toLowerCase();
    paint(needle === '' ? rows : rows.filter((row) => row.project.toLowerCase().includes(needle)));
  });

  paint(rows);

  return card(
    'Every project on this machine',
    'The ledger is machine-wide. This is the whole of it, split by the folder each workspace belongs to.',
    [filter, container],
  );
}

/**
 * The anatomy tree.
 *
 * Own and subtree credits are shown side by side at every node. A parent
 * that reported only its rolled-up total would answer "what did this tree
 * cost" while losing "what did this folder itself cost" — the same
 * conflation the unscoped ledger made, one level down.
 */
function anatomyCard(scope) {
  if (!scope.tree || scope.tree.length === 0) {
    return card('Anatomy', null, empty('No folder could be resolved for any workspace.'));
  }

  const renderNode = (node) =>
    el('li', {}, [
      el('div', { className: 'tl-tree-row' }, [
        el('span', { className: 'tl-tree-label', title: node.displayPath }, node.label),
        el('span', {}, `${fmt(node.subtreeCredits)} cr`),
        node.children.length > 0
          ? el(
              'span',
              { className: 'tl-tree-own' },
              `(${fmt(node.ownCredits)} cr in this folder itself · ${fmtInt(node.subtreeRequestCount)} req in subtree)`,
            )
          : el('span', { className: 'tl-tree-own' }, `${fmtInt(node.ownRequestCount)} req`),
      ]),
      node.children.length > 0 ? el('ul', {}, node.children.map(renderNode)) : null,
    ]);

  return card(
    'Project anatomy',
    'Own credits and subtree credits are reported separately — a nested folder is never silently folded into its parent.',
    el('ul', { className: 'tl-tree' }, scope.tree.map(renderNode)),
  );
}

function unattributedCard(scope) {
  const bucket = scope.unattributed;
  if (!bucket || bucket.workspaceCount === 0) {
    return card(
      'Unattributed',
      null,
      empty('Every workspace with chat history maps to a folder. Nothing is unattributed.'),
    );
  }

  return card(
    'Could not be placed',
    'These credits are still counted in every total above. Dropping what cannot be classified would understate the very figure this page exists to make trustworthy.',
    [
      el(
        'p',
        {},
        `${fmt(bucket.credits)} credits across ${fmtInt(bucket.requestCount)} request(s) in ${fmtInt(bucket.workspaceCount)} workspace(s).`,
      ),
      table(
        [
          { key: 'text', label: 'Reason' },
          { key: 'workspaceCount', label: 'Workspaces', numeric: true },
          { key: 'credits', label: 'Credits', numeric: true, render: (row) => fmt(row.credits) },
        ],
        bucket.byReason,
        { sortKey: 'credits' },
      ),
    ],
  );
}
