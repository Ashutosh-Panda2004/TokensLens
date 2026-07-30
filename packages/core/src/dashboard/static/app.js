// TokenLens dashboard — vanilla JS, no build step, no framework and no
// charting library (see DEVELOPMENT-PLAN.md §1: "ship speed and zero
// build complexity matter more"). Proportional visuals (the cost-centre
// treemap, model/session bars) are plain CSS widths, not a real treemap
// layout algorithm — that gets the same "here's the share" story across
// without a dependency.

const TREEMAP_COLORS = ['#1f6feb', '#8250df', '#cf222e', '#9a6700', '#1a7f37', '#57606a'];

const token = new URLSearchParams(window.location.search).get('token') ?? '';

/** Minimal DOM builder — avoids innerHTML for anything containing real data (XSS hygiene). */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') node.className = value;
    else if (key === 'title') node.title = value;
    else if (key === 'style') Object.assign(node.style, value);
    else node.setAttribute(key, value);
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path) {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`${path} responded ${String(response.status)}`);
  }
  return response.json();
}

function fmt(n, digits = 1) {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Renders a `ProvenanceView` (measured/modelled/blended) as a hoverable chip. */
function provenanceChip(view) {
  const label =
    view.kind === 'measured'
      ? 'measured'
      : view.kind === 'modelled'
        ? 'modelled'
        : `~${String(view.measuredPercent)}% measured`;
  return el(
    'span',
    {
      className: `tl-chip tl-chip-${view.kind}`,
      title: `${fmt(view.measured)} measured + ${fmt(view.modelled)} modelled = ${fmt(view.value)} credits`,
    },
    label,
  );
}

/**
 * Renders a tagged `Value` — a single figure that is measured *or*
 * modelled, never a mix (budget projections, model rates) — as a
 * hoverable chip showing its source or its stated assumptions.
 */
function taggedChip(taggedValue) {
  const p = taggedValue.provenance;
  const assumptions = p.kind === 'modelled' ? p.assumptions.join('; ') : '';
  return el(
    'span',
    {
      className: `tl-chip tl-chip-${p.kind}`,
      title:
        p.kind === 'measured'
          ? p.source
          : `${p.basis}${assumptions ? ` — assumes: ${assumptions}` : ''}`,
    },
    p.kind,
  );
}

function bar(share) {
  return el('div', { className: 'tl-bar-track' }, [
    el('div', {
      className: 'tl-bar-fill',
      style: { width: `${String(Math.max(0, Math.min(100, share)))}%` },
    }),
  ]);
}

function card(title, note, ...children) {
  const head = note
    ? [el('h2', {}, title), el('p', { className: 'tl-card-note' }, note)]
    : [el('h2', {}, title)];
  return el('section', { className: 'tl-card' }, [...head, ...children]);
}

function renderTotals(ledger) {
  return card(
    'Total spend',
    null,
    el('div', { className: 'tl-totals' }, [
      el('div', { className: 'tl-total-figure' }, [
        el('div', { className: 'tl-total-value' }, [
          `${fmt(ledger.totalCredits.value)} `,
          provenanceChip(ledger.totalCredits),
        ]),
        el('div', { className: 'tl-total-label' }, 'credits'),
      ]),
      el('div', { className: 'tl-total-figure' }, [
        el('div', { className: 'tl-total-value' }, String(ledger.requestCount)),
        el('div', { className: 'tl-total-label' }, 'requests'),
      ]),
    ]),
  );
}

function renderBurnDown(ledger, budget) {
  const maxDayCredits = Math.max(1, ...ledger.byDay.map((d) => d.credits.value));

  const budgetGrid = el('div', { className: 'tl-budget-grid' }, [
    budgetItem('Plan', budget.plan),
    budgetItem('Monthly allowance', `${fmt(budget.monthlyAllowance, 0)} credits`),
    budgetItem('Month-to-date', [
      `${fmt(budget.monthToDateCredits.value)} `,
      provenanceChip(budget.monthToDateCredits),
    ]),
    budgetItem('Projected month-end', [
      `${fmt(budget.projectedMonthEndCredits.value)} `,
      taggedChip(budget.projectedMonthEndCredits),
    ]),
  ]);

  const warning = budget.onTrackToExceedAllowance
    ? el('p', { className: 'tl-warning' }, [
        `⚠ Projected to exceed the allowance by ${fmt(budget.projectedOverage.value)} credits`,
        ' ',
        taggedChip(budget.projectedOverage),
        budget.hardBlockDate ? ` — projected exhaustion date: ${budget.hardBlockDate.value}` : '',
      ])
    : null;

  const table = el('table', { className: 'tl-table' }, [
    el(
      'thead',
      {},
      el('tr', {}, [
        el('th', {}, 'Day'),
        el('th', {}, 'Credits'),
        el('th', {}, 'Requests'),
        el('th', {}, ''),
      ]),
    ),
    el(
      'tbody',
      {},
      ledger.byDay.map((day) =>
        el('tr', {}, [
          el('td', {}, day.day),
          el('td', { className: 'tl-num' }, [
            `${fmt(day.credits.value)} `,
            provenanceChip(day.credits),
          ]),
          el('td', { className: 'tl-num' }, String(day.requestCount)),
          el('td', {}, bar((day.credits.value / maxDayCredits) * 100)),
        ]),
      ),
    ),
  ]);

  return card(
    'Burn-down',
    'Credits per day, month-to-date, and the projected month-end forecast',
    budgetGrid,
    warning,
    table,
  );
}

function budgetItem(label, value) {
  return el('div', { className: 'tl-budget-item' }, [
    el('div', { className: 'tl-budget-label' }, label),
    el('div', { className: 'tl-budget-value' }, value),
  ]);
}

function renderCostCentres(ledger) {
  const segments = ledger.byCostCentre.map((centre, i) =>
    el(
      'div',
      {
        className: 'tl-treemap-segment',
        style: {
          width: `${String(centre.tokenShare)}%`,
          background: TREEMAP_COLORS[i % TREEMAP_COLORS.length],
        },
        title: `${centre.label}: ${String(centre.tokenShare)}% of tokens (${fmt(centre.tokens, 0)} tokens)`,
      },
      centre.tokenShare >= 6 ? `${centre.label} ${String(centre.tokenShare)}%` : '',
    ),
  );

  const table = el('table', { className: 'tl-table' }, [
    el(
      'thead',
      {},
      el('tr', {}, [
        el('th', {}, 'Cost centre'),
        el('th', {}, 'Tokens'),
        el('th', {}, 'Share'),
        el('th', {}, 'Credits'),
      ]),
    ),
    el(
      'tbody',
      {},
      ledger.byCostCentre.map((centre) =>
        el('tr', {}, [
          el('td', {}, centre.label),
          el('td', { className: 'tl-num' }, fmt(centre.tokens, 0)),
          el('td', { className: 'tl-num' }, `${String(centre.tokenShare)}%`),
          el('td', { className: 'tl-num' }, [
            `${fmt(centre.credits.value)} `,
            provenanceChip(centre.credits),
          ]),
        ]),
      ),
    ),
  ]);

  return card(
    'Cost-centre breakdown',
    'The five-way split of every prompt — the Tool Definitions share is the headline finding (F3)',
    el('div', { className: 'tl-treemap' }, segments),
    table,
  );
}

function renderModelMix(ledger) {
  const maxCredits = Math.max(1, ...ledger.byModel.map((m) => m.credits.value));

  const table = el('table', { className: 'tl-table' }, [
    el(
      'thead',
      {},
      el('tr', {}, [
        el('th', {}, 'Model'),
        el('th', {}, 'Credits'),
        el('th', {}, 'Requests'),
        el('th', {}, 'cr / 1k'),
        el('th', {}, ''),
      ]),
    ),
    el(
      'tbody',
      {},
      ledger.byModel.map((model) =>
        el('tr', {}, [
          el('td', {}, model.model),
          el('td', { className: 'tl-num' }, [
            `${fmt(model.credits.value)} `,
            provenanceChip(model.credits),
          ]),
          el('td', { className: 'tl-num' }, String(model.requestCount)),
          el('td', { className: 'tl-num' }, [
            `${fmt(model.rate.value, 3)} `,
            taggedChip(model.rate),
          ]),
          el('td', {}, bar((model.credits.value / maxCredits) * 100)),
        ]),
      ),
    ),
  ]);

  return card(
    'Model mix',
    'Requests and credits by model — note the price spread between them',
    table,
  );
}

function renderSessions(ledger) {
  const top = ledger.bySession.slice(0, 10);
  const maxCredits = Math.max(1, ...top.map((s) => s.credits.value));

  const table = el('table', { className: 'tl-table' }, [
    el(
      'thead',
      {},
      el('tr', {}, [
        el('th', {}, '#'),
        el('th', {}, 'Session'),
        el('th', {}, 'Credits'),
        el('th', {}, 'Requests'),
        el('th', {}, ''),
      ]),
    ),
    el(
      'tbody',
      {},
      top.map((session, index) =>
        el('tr', {}, [
          el('td', {}, String(index + 1)),
          el('td', {}, session.sessionId),
          el('td', { className: 'tl-num' }, [
            `${fmt(session.credits.value)} `,
            provenanceChip(session.credits),
          ]),
          el('td', { className: 'tl-num' }, String(session.requestCount)),
          el('td', {}, bar((session.credits.value / maxCredits) * 100)),
        ]),
      ),
    ),
  ]);

  const share =
    ledger.totalCredits.value > 0
      ? (top.reduce((sum, s) => sum + s.credits.value, 0) / ledger.totalCredits.value) * 100
      : 0;

  return card(
    'Session leaderboard',
    `Top ${String(top.length)} of ${String(ledger.bySession.length)} sessions carry ${fmt(share)}% of all credits`,
    table,
  );
}

async function main() {
  const app = document.getElementById('app');
  try {
    const [ledger, budget] = await Promise.all([api('/api/ledger'), api('/api/budget')]);
    app.replaceChildren(
      renderTotals(ledger),
      renderBurnDown(ledger, budget),
      renderCostCentres(ledger),
      renderModelMix(ledger),
      renderSessions(ledger),
    );
  } catch (error) {
    app.replaceChildren(
      el(
        'p',
        { className: 'tl-error' },
        `Failed to load dashboard data: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

main();
