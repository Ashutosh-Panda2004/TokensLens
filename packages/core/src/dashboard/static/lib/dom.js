/**
 * DOM helpers.
 *
 * Everything here builds nodes with `createElement`/`textContent` and never
 * assigns `innerHTML` on data. Model ids, tool names, session hashes and —
 * new in D13 — workspace labels taken from `workspace.json` all originate
 * outside this file, so treating any of them as markup would be an XSS
 * hole in a page that holds a bearer token.
 */

export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else node.setAttribute(key, String(value));
  }

  for (const child of [children].flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

export function svg(tag, attributes = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    node.setAttribute(key, String(value));
  }
  for (const child of [children].flat(Infinity)) {
    if (child) node.append(child);
  }
  return node;
}

export function card(title, note, children) {
  return el('section', { className: 'tl-card' }, [
    el('header', { className: 'tl-card-head' }, [
      el('h2', {}, title),
      note ? el('p', { className: 'tl-card-note' }, note) : null,
    ]),
    el('div', { className: 'tl-card-body' }, [children].flat()),
  ]);
}

/**
 * A sortable, optionally clickable table.
 *
 * `columns` are `{ key, label, numeric?, render? }`. Sorting is client-side
 * over the already-fetched rows — the data sets here are hundreds of rows,
 * not millions, and a round trip per column click would be slower than the
 * sort.
 */
export function table(columns, rows, options = {}) {
  let sortKey = options.sortKey ?? null;
  let sortDir = options.sortDir ?? 'desc';

  const tbody = el('tbody');
  const head = el(
    'tr',
    {},
    columns.map((column) =>
      el(
        'th',
        {
          className: column.sortable === false ? '' : 'tl-sortable',
          scope: 'col',
          'aria-sort':
            sortKey === column.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none',
          tabindex: column.sortable === false ? undefined : '0',
          onclick:
            column.sortable === false
              ? undefined
              : () => {
                  sortDir = sortKey === column.key && sortDir === 'desc' ? 'asc' : 'desc';
                  sortKey = column.key;
                  paint();
                },
          onkeydown:
            column.sortable === false
              ? undefined
              : (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  sortDir = sortKey === column.key && sortDir === 'desc' ? 'asc' : 'desc';
                  sortKey = column.key;
                  paint();
                },
        },
        column.label,
      ),
    ),
  );

  const element = el('table', { className: 'tl-table' }, [el('thead', {}, head), tbody]);

  function paint() {
    const sorted = sortKey === null ? [...rows] : [...rows].sort(compareBy(sortKey, sortDir));

    tbody.replaceChildren(
      ...sorted.map((row) =>
        el(
          'tr',
          {
            className: options.onRowClick ? 'tl-clickable' : '',
            tabindex: options.onRowClick ? '0' : undefined,
            onclick: options.onRowClick ? () => options.onRowClick(row) : undefined,
            onkeydown: options.onRowClick
              ? (event) => {
                  if (event.key === 'Enter') options.onRowClick(row);
                }
              : undefined,
          },
          columns.map((column) =>
            el(
              'td',
              { className: column.numeric ? 'tl-num' : '' },
              column.render ? column.render(row) : (row[column.key] ?? '—'),
            ),
          ),
        ),
      ),
    );

    for (const [index, th] of [...head.children].entries()) {
      const column = columns[index];
      th.setAttribute(
        'aria-sort',
        sortKey === column.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none',
      );
    }
  }

  paint();
  return element;
}

function compareBy(key, direction) {
  const sign = direction === 'asc' ? 1 : -1;
  return (a, b) => {
    const left = a[key];
    const right = b[key];
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * sign;
    return String(left ?? '').localeCompare(String(right ?? '')) * sign;
  };
}

export function bar(fraction) {
  return el('div', { className: 'tl-bar-track' }, [
    el('div', {
      className: 'tl-bar-fill',
      style: { width: `${Math.max(0, Math.min(1, fraction)) * 100}%` },
    }),
  ]);
}

export function skeleton(lines = 3) {
  return el(
    'div',
    { className: 'tl-card tl-skeleton-card' },
    el(
      'div',
      { className: 'tl-card-body' },
      Array.from({ length: lines }, (_, index) =>
        el('div', {
          className: 'tl-skeleton',
          style: { width: `${90 - index * 15}%`, marginBottom: '10px' },
        }),
      ),
    ),
  );
}

export function empty(message) {
  return el('p', { className: 'tl-empty' }, message);
}
