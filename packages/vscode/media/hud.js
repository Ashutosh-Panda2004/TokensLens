/*
 * The panel is deliberately dumb: it receives formatted strings and writes
 * them into fixed elements. Nothing here decides what a figure means, and
 * nothing here is built from a template string — every value goes in via
 * `textContent`, so a model id or a workspace path cannot be parsed as
 * markup no matter what it contains.
 */
// eslint-disable-next-line no-undef
const vscode = acquireVsCodeApi();

const el = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const PERIODS = ['daily', 'weekly', 'monthly'];
const METRICS = ['credits', 'tokens'];

const savedState = vscode.getState() ?? {};
let selectedPeriod = PERIODS.includes(savedState.period) ? savedState.period : 'daily';
let selectedMetric = METRICS.includes(savedState.metric) ? savedState.metric : 'credits';
let currentHistory;

const root = el('root');
const nodes = {
  message: el('message'),
  freshness: el('freshness'),
  heroValue: el('hero-value'),
  heroLabel: el('hero-label'),
  heroSub: el('hero-sub'),
  meter: el('meter'),
  meterFill: el('meter-fill'),
  meterLabel: el('meter-label'),
  tiles: el('tiles'),
  historyCard: el('history-card'),
  historySummary: el('history-summary'),
  historyPlot: el('history-plot'),
  historyChart: el('history-chart'),
  historyTooltip: el('history-tooltip'),
  session: el('session'),
  sessionNext: el('session-next'),
  sessionMultiple: el('session-multiple'),
  sessionDetail: el('session-detail'),
  modelsCard: el('models-card'),
  models: el('models'),
  saving: el('saving'),
  savingValue: el('saving-value'),
  savingDetail: el('saving-detail'),
  notes: el('notes'),
  scope: el('scope'),
};

function div(className, text) {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function renderTiles(tiles) {
  nodes.tiles.replaceChildren(
    ...tiles.map((tile) => {
      const card = div('tile');
      card.append(div('tile-label', tile.label), div('tile-value', tile.value));
      if (tile.sub) card.append(div('tile-sub', tile.sub));
      return card;
    }),
  );
}

function renderModels(models) {
  nodes.modelsCard.hidden = models.length === 0;
  nodes.models.replaceChildren(
    ...models.map((model) => {
      const row = div('model');
      const head = div('model-head');
      head.append(div('model-name', model.name), div('model-value', model.value));

      const track = div('model-track');
      const fill = div('model-fill');
      // A style property, not markup: the share is a number from the host.
      fill.style.width = `${Math.max(2, Math.round(model.share * 100))}%`;
      track.append(fill);

      row.append(head, track);
      return row;
    }),
  );
}

function rememberChartSelection() {
  vscode.setState({ ...(vscode.getState() ?? {}), period: selectedPeriod, metric: selectedMetric });
}

function paintChartControls() {
  for (const button of document.querySelectorAll('[data-period]')) {
    const active = button.dataset.period === selectedPeriod;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }

  for (const button of document.querySelectorAll('[data-metric]')) {
    button.setAttribute('aria-pressed', String(button.dataset.metric === selectedMetric));
  }
}

function showHistoryTooltip(point, x, y, width, height) {
  const primary = selectedMetric === 'credits' ? point.creditsText : point.tokensText;
  const secondary = selectedMetric === 'credits' ? point.tokensText : point.creditsText;

  nodes.historyTooltip.replaceChildren(
    div('history-tooltip-range', point.range),
    div('history-tooltip-value', primary),
    div('history-tooltip-detail', secondary),
    div('history-tooltip-detail', point.requestsText),
  );
  nodes.historyTooltip.hidden = false;
  nodes.historyTooltip.classList.toggle('align-right', x > width * 0.68);
  nodes.historyTooltip.style.left = `${Math.max(4, Math.min(96, (x / width) * 100))}%`;
  nodes.historyTooltip.style.top = `${Math.max(2, Math.min(82, (y / height) * 100))}%`;
}

function hideHistoryTooltip() {
  nodes.historyTooltip.hidden = true;
}

function renderHistoryChart() {
  if (!currentHistory) return;

  const series = currentHistory[selectedPeriod];
  const values = series.points.map((point) =>
    Math.max(0, Number(selectedMetric === 'credits' ? point.credits : point.tokens) || 0),
  );
  const max = Math.max(...values, 1);
  const width = 300;
  const height = 158;
  const margin = { top: 14, right: 10, bottom: 28, left: 10 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const baseline = margin.top + plotHeight;
  const x = (index) =>
    margin.left +
    (series.points.length <= 1 ? plotWidth / 2 : (index / (series.points.length - 1)) * plotWidth);
  const y = (value) => margin.top + plotHeight - (value / max) * plotHeight;

  const chart = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'group',
    'aria-roledescription': 'consumption chart',
    'aria-label': `${series.label} ${selectedMetric} consumption. ${selectedMetric === 'credits' ? series.creditsSummary : series.tokensSummary}`,
    class: `history-svg metric-${selectedMetric}`,
  });

  for (const fraction of [0, 0.5, 1]) {
    const lineY = margin.top + plotHeight * (1 - fraction);
    chart.append(
      svg('line', {
        x1: margin.left,
        x2: width - margin.right,
        y1: lineY,
        y2: lineY,
        class: 'history-grid',
      }),
    );
  }

  const topLabel = svg('text', { x: margin.left, y: 9, class: 'history-axis history-axis-top' });
  const peakIndex = values.indexOf(Math.max(...values));
  const peak = series.points[peakIndex];
  topLabel.textContent =
    selectedMetric === 'credits' ? (peak?.creditsText ?? '') : (peak?.tokensText ?? '');
  chart.append(topLabel);

  const coordinates = values.map((value, index) => `${x(index)},${y(value)}`);
  if (coordinates.length > 0) {
    const area = svg('path', {
      d: `M ${x(0)} ${baseline} L ${coordinates.join(' L ')} L ${x(values.length - 1)} ${baseline} Z`,
      class: 'history-area',
    });
    const line = svg('path', {
      d: `M ${coordinates.join(' L ')}`,
      class: 'history-line',
    });
    chart.append(area, line);
  }

  const labelIndexes = new Set([0, Math.floor((series.points.length - 1) / 2), values.length - 1]);
  for (const index of labelIndexes) {
    const point = series.points[index];
    if (!point) continue;
    const label = svg('text', {
      x: x(index),
      y: height - 7,
      class: 'history-axis history-axis-x',
      'text-anchor': index === 0 ? 'start' : index === values.length - 1 ? 'end' : 'middle',
    });
    label.textContent = point.label;
    chart.append(label);
  }

  const pointGroups = [];
  series.points.forEach((point, index) => {
    const pointX = x(index);
    const pointY = y(values[index]);
    const group = svg('g', {
      class: 'history-point',
      role: 'img',
      tabindex: '0',
      'aria-label': `${point.range}. ${point.creditsText}. ${point.tokensText}. ${point.requestsText}.`,
    });
    group.append(
      svg('line', {
        x1: pointX,
        x2: pointX,
        y1: pointY,
        y2: baseline,
        class: 'history-stem',
      }),
      svg('circle', { cx: pointX, cy: pointY, r: 3.2, class: 'history-dot' }),
      svg('rect', {
        x: pointX - Math.max(8, plotWidth / Math.max(1, values.length) / 2),
        y: margin.top,
        width: Math.max(16, plotWidth / Math.max(1, values.length)),
        height: plotHeight,
        class: 'history-hit',
      }),
    );

    const show = () => showHistoryTooltip(point, pointX, pointY, width, height);
    group.addEventListener('mouseenter', show);
    group.addEventListener('focus', show);
    group.addEventListener('mouseleave', hideHistoryTooltip);
    group.addEventListener('blur', hideHistoryTooltip);
    group.addEventListener('click', () => group.focus());
    group.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const next = Math.max(0, Math.min(pointGroups.length - 1, index + direction));
      pointGroups[next]?.focus();
    });
    pointGroups.push(group);
    chart.append(group);
  });

  nodes.historySummary.textContent =
    selectedMetric === 'credits' ? series.creditsSummary : series.tokensSummary;
  nodes.historyPlot.className = `history-plot metric-${selectedMetric}`;
  nodes.historyChart.replaceChildren(chart);
  hideHistoryTooltip();
}

function renderHistory(history) {
  currentHistory = history;
  nodes.historyCard.hidden = !history;
  if (!history) return;
  paintChartControls();
  renderHistoryChart();
}

function render(view) {
  root.classList.remove('loading');

  nodes.freshness.textContent = `live · updated ${view.freshness}`;
  nodes.heroValue.textContent = view.hero.value;
  nodes.heroLabel.textContent = view.hero.label;
  nodes.heroSub.textContent = view.hero.sub;

  if (view.meter) {
    nodes.meter.hidden = false;
    nodes.meter.className = `meter ${view.meter.state}`;
    nodes.meterFill.style.width = `${Math.round(view.meter.fill * 100)}%`;
    nodes.meterLabel.textContent = view.meter.label;
  } else {
    nodes.meter.hidden = true;
  }

  renderTiles(view.tiles);
  renderHistory(view.history);

  if (view.session) {
    nodes.session.hidden = false;
    nodes.session.className = view.session.warn ? 'card session warn' : 'card session';
    nodes.sessionNext.textContent = view.session.next;
    nodes.sessionMultiple.textContent = view.session.multiple;
    nodes.sessionDetail.textContent = view.session.detail;
  } else {
    nodes.session.hidden = true;
  }

  renderModels(view.models);

  if (view.saving) {
    nodes.saving.hidden = false;
    nodes.savingValue.textContent = view.saving.value;
    nodes.savingDetail.textContent = view.saving.detail;
  } else {
    nodes.saving.hidden = true;
  }

  nodes.notes.textContent = view.notes.join(' · ');
  nodes.scope.textContent = view.scope;
}

function showMessage(text) {
  root.classList.add('loading');
  nodes.message.textContent = text;
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.view) render(data.view);
  else if (data && data.message) showMessage(data.message);
});

el('open-dashboard').addEventListener('click', () => {
  vscode.postMessage({ command: 'tokenlens.openDashboard' });
});

el('fresh-chat').addEventListener('click', () => {
  vscode.postMessage({ command: 'tokenlens.newChat' });
});

for (const button of document.querySelectorAll('[data-period]')) {
  button.addEventListener('click', () => {
    if (!PERIODS.includes(button.dataset.period)) return;
    selectedPeriod = button.dataset.period;
    rememberChartSelection();
    paintChartControls();
    renderHistoryChart();
  });

  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    const index = PERIODS.indexOf(selectedPeriod);
    selectedPeriod = PERIODS[(index + direction + PERIODS.length) % PERIODS.length];
    rememberChartSelection();
    paintChartControls();
    renderHistoryChart();
    document.querySelector(`[data-period="${selectedPeriod}"]`)?.focus();
  });
}

for (const button of document.querySelectorAll('[data-metric]')) {
  button.addEventListener('click', () => {
    if (!METRICS.includes(button.dataset.metric)) return;
    selectedMetric = button.dataset.metric;
    rememberChartSelection();
    paintChartControls();
    renderHistoryChart();
  });
}
