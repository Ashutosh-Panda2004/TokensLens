import { el, svg } from './dom.js';
import { fmt } from './format.js';

/**
 * Charts, hand-rolled in SVG.
 *
 * No charting dependency and no bundler, deliberately. This binary reads
 * developers' conversations; every package added to it is supply-chain
 * surface on something that already holds sensitive data, and a CDN import
 * would break both the offline guarantee and the "no outbound network"
 * property the whole tool rests on. Axes, scales, hover and tooltips are a
 * few hundred lines — cheaper than the review a dependency would need.
 *
 * Everything renders into a `viewBox` of fixed logical width and is sized to
 * 100% by CSS, so charts are responsive without a resize observer.
 */

const W = 1000;
const PALETTE = [
  '#4c8dff',
  '#a371f7',
  '#3fb950',
  '#d29922',
  '#f85149',
  '#2dd4bf',
  '#f778ba',
  '#a5d6ff',
  '#7ee787',
  '#ffa657',
];

export function colourFor(index) {
  return PALETTE[index % PALETTE.length];
}

// --- scales and ticks -------------------------------------------------

/**
 * Axis ticks a human would have chosen: 1, 2, 2.5 or 5 times a power of ten.
 * A raw `max / count` produces labels like 3,847 and makes a reader do
 * arithmetic to compare two bars.
 */
function niceTicks(max, count = 5) {
  if (!Number.isFinite(max) || max <= 0) return { ticks: [0, 1], top: 1 };

  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude * 10;

  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(value);
  return { ticks, top };
}

function shortNumber(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1000) return `${(value / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (abs >= 10) return value.toFixed(0);
  return value.toFixed(abs === 0 ? 0 : 1);
}

// --- tooltip ----------------------------------------------------------

let tooltipNode = null;

function tooltip() {
  tooltipNode ??= document.body.appendChild(el('div', { className: 'tl-tooltip', hidden: true }));
  return tooltipNode;
}

function showTooltip(event, nodes) {
  const node = tooltip();
  node.replaceChildren(...nodes);
  node.hidden = false;

  // Flip before the pointer once the box would run past the viewport, so a
  // tooltip on the last data point is not clipped off the screen.
  const box = node.getBoundingClientRect();
  const x =
    event.clientX + 14 + box.width > window.innerWidth
      ? event.clientX - box.width - 14
      : event.clientX + 14;
  node.style.left = `${String(Math.max(8, x))}px`;
  node.style.top = `${String(Math.max(8, event.clientY - box.height - 12))}px`;
}

function hideTooltip() {
  if (tooltipNode) tooltipNode.hidden = true;
}

function swatch(colour) {
  return el('span', { className: 'tl-legend-swatch', style: { background: colour } });
}

// --- line / area ------------------------------------------------------

/**
 * A line (or area) chart over a categorical x axis of days.
 *
 * `series` is `[{ key, colour, values: number[] }]`, every array the same
 * length as `labels`. A hover anywhere on the plot snaps to the nearest
 * column and reports every series at once, which is what makes two lines
 * comparable at a glance.
 */
export function lineChart({ labels, series, height = 280, area = false, yFormat = shortNumber }) {
  if (labels.length === 0) return el('p', { className: 'tl-empty' }, 'Nothing to plot.');

  const margin = { top: 16, right: 16, bottom: 34, left: 56 };
  const plotW = W - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const max = Math.max(...series.flatMap((s) => s.values), 0);
  const { ticks, top } = niceTicks(max);

  const x = (index) =>
    margin.left + (labels.length === 1 ? plotW / 2 : (index / (labels.length - 1)) * plotW);
  const y = (value) => margin.top + plotH - (value / top) * plotH;

  const gridlines = ticks.map((tick) =>
    svg('g', {}, [
      svg('line', {
        x1: margin.left,
        x2: W - margin.right,
        y1: y(tick),
        y2: y(tick),
        class: 'tl-grid',
      }),
      svg('text', { x: margin.left - 8, y: y(tick) + 4, class: 'tl-axis tl-axis-y' }, [
        document.createTextNode(yFormat(tick)),
      ]),
    ]),
  );

  // Roughly six x labels however many days there are, so a 90-day range does
  // not overprint itself into a grey smear.
  const stride = Math.max(1, Math.ceil(labels.length / 6));
  const xLabels = labels
    .map((label, index) => ({ label, index }))
    .filter(({ index }) => index % stride === 0 || index === labels.length - 1)
    .map(({ label, index }) =>
      svg('text', { x: x(index), y: height - 10, class: 'tl-axis tl-axis-x' }, [
        document.createTextNode(label.slice(5)),
      ]),
    );

  const paths = series.flatMap((s) => {
    const line = s.values.map((value, index) => `${x(index)},${y(value)}`).join(' ');
    const nodes = [];

    if (area) {
      nodes.push(
        svg('polygon', {
          points: `${margin.left},${y(0)} ${line} ${x(labels.length - 1)},${y(0)}`,
          fill: s.colour,
          'fill-opacity': '0.14',
        }),
      );
    }

    nodes.push(
      svg('polyline', {
        points: line,
        fill: 'none',
        stroke: s.colour,
        'stroke-width': '2',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    );

    return nodes;
  });

  const cursor = svg('line', {
    y1: margin.top,
    y2: margin.top + plotH,
    class: 'tl-cursor',
    opacity: '0',
  });

  const markers = series.map((s) =>
    svg('circle', {
      r: 4,
      fill: s.colour,
      stroke: 'var(--tl-surface)',
      'stroke-width': 2,
      opacity: '0',
    }),
  );

  const surface = svg('rect', {
    x: margin.left,
    y: margin.top,
    width: plotW,
    height: plotH,
    fill: 'transparent',
  });

  const root = svg(
    'svg',
    {
      viewBox: `0 0 ${W} ${height}`,
      class: 'tl-chart',
      role: 'img',
      'aria-label': `Line chart over ${String(labels.length)} days, peak ${fmt(max)}`,
    },
    [...gridlines, ...xLabels, ...paths, cursor, ...markers, surface],
  );

  surface.addEventListener('mousemove', (event) => {
    const bounds = root.getBoundingClientRect();
    const ratio = ((event.clientX - bounds.left) / bounds.width) * W;
    const index = Math.round(((ratio - margin.left) / plotW) * (labels.length - 1 || 1));
    const clamped = Math.max(0, Math.min(labels.length - 1, index));

    cursor.setAttribute('x1', String(x(clamped)));
    cursor.setAttribute('x2', String(x(clamped)));
    cursor.setAttribute('opacity', '1');

    markers.forEach((marker, position) => {
      marker.setAttribute('cx', String(x(clamped)));
      marker.setAttribute('cy', String(y(series[position].values[clamped])));
      marker.setAttribute('opacity', '1');
    });

    showTooltip(event, [
      el('strong', {}, labels[clamped]),
      ...series.map((s) => el('div', {}, [swatch(s.colour), `${s.key}: `, fmt(s.values[clamped])])),
    ]);
  });

  surface.addEventListener('mouseleave', () => {
    cursor.setAttribute('opacity', '0');
    for (const marker of markers) marker.setAttribute('opacity', '0');
    hideTooltip();
  });

  return root;
}

/**
 * Stacked areas — the shape that answers "is the premium share growing?",
 * which a table of daily totals cannot.
 */
export function stackedAreaChart({ labels, series, height = 300, yFormat = shortNumber }) {
  if (labels.length === 0 || series.length === 0) {
    return el('p', { className: 'tl-empty' }, 'Nothing to plot.');
  }

  const margin = { top: 16, right: 16, bottom: 34, left: 56 };
  const plotW = W - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const totals = labels.map((_, index) => series.reduce((sum, s) => sum + s.values[index], 0));
  const { ticks, top } = niceTicks(Math.max(...totals, 0));

  const x = (index) =>
    margin.left + (labels.length === 1 ? plotW / 2 : (index / (labels.length - 1)) * plotW);
  const y = (value) => margin.top + plotH - (value / top) * plotH;

  const running = labels.map(() => 0);
  const bands = series.map((s) => {
    const lower = [...running];
    const upper = s.values.map((value, index) => (running[index] += value));
    const forward = upper.map((value, index) => `${x(index)},${y(value)}`).join(' ');
    const back = [...lower]
      .map((value, index) => ({ value, index }))
      .reverse()
      .map(({ value, index }) => `${x(index)},${y(value)}`)
      .join(' ');

    return svg('polygon', {
      points: `${forward} ${back}`,
      fill: s.colour,
      'fill-opacity': '0.85',
      stroke: s.colour,
      'stroke-width': '0.5',
    });
  });

  const gridlines = ticks.map((tick) =>
    svg('g', {}, [
      svg('line', {
        x1: margin.left,
        x2: W - margin.right,
        y1: y(tick),
        y2: y(tick),
        class: 'tl-grid',
      }),
      svg('text', { x: margin.left - 8, y: y(tick) + 4, class: 'tl-axis tl-axis-y' }, [
        document.createTextNode(yFormat(tick)),
      ]),
    ]),
  );

  const stride = Math.max(1, Math.ceil(labels.length / 6));
  const xLabels = labels
    .map((label, index) => ({ label, index }))
    .filter(({ index }) => index % stride === 0 || index === labels.length - 1)
    .map(({ label, index }) =>
      svg('text', { x: x(index), y: height - 10, class: 'tl-axis tl-axis-x' }, [
        document.createTextNode(label.slice(5)),
      ]),
    );

  const cursor = svg('line', {
    y1: margin.top,
    y2: margin.top + plotH,
    class: 'tl-cursor',
    opacity: '0',
  });

  const surface = svg('rect', {
    x: margin.left,
    y: margin.top,
    width: plotW,
    height: plotH,
    fill: 'transparent',
  });

  const root = svg(
    'svg',
    {
      viewBox: `0 0 ${W} ${height}`,
      class: 'tl-chart',
      role: 'img',
      'aria-label': `Stacked area chart of ${String(series.length)} series over ${String(labels.length)} days`,
    },
    [...gridlines, ...bands, ...xLabels, cursor, surface],
  );

  surface.addEventListener('mousemove', (event) => {
    const bounds = root.getBoundingClientRect();
    const ratio = ((event.clientX - bounds.left) / bounds.width) * W;
    const index = Math.max(
      0,
      Math.min(
        labels.length - 1,
        Math.round(((ratio - margin.left) / plotW) * (labels.length - 1 || 1)),
      ),
    );

    cursor.setAttribute('x1', String(x(index)));
    cursor.setAttribute('x2', String(x(index)));
    cursor.setAttribute('opacity', '1');

    // Only the series actually present that day, biggest first — a legend of
    // twelve models with ten zeroes is noise, not information.
    const present = series
      .map((s) => ({ key: s.key, colour: s.colour, value: s.values[index] }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    showTooltip(event, [
      el('strong', {}, labels[index]),
      el('div', { className: 'tl-tooltip-total' }, `${fmt(totals[index])} credits`),
      ...present.map((entry) =>
        el('div', {}, [swatch(entry.colour), `${entry.key}: `, fmt(entry.value)]),
      ),
    ]);
  });

  surface.addEventListener('mouseleave', () => {
    cursor.setAttribute('opacity', '0');
    hideTooltip();
  });

  return root;
}

// --- donut ------------------------------------------------------------

export function donutChart({ segments, height = 240, centreLabel = '', centreValue = '' }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return el('p', { className: 'tl-empty' }, 'Nothing to plot.');

  const size = height;
  const radius = size / 2 - 6;
  const inner = radius * 0.62;
  const centre = size / 2;

  let angle = -Math.PI / 2;
  const arcs = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => {
      const sweep = (segment.value / total) * Math.PI * 2;
      const end = angle + sweep;
      const large = sweep > Math.PI ? 1 : 0;

      const path = [
        `M ${centre + radius * Math.cos(angle)} ${centre + radius * Math.sin(angle)}`,
        `A ${radius} ${radius} 0 ${large} 1 ${centre + radius * Math.cos(end)} ${centre + radius * Math.sin(end)}`,
        `L ${centre + inner * Math.cos(end)} ${centre + inner * Math.sin(end)}`,
        `A ${inner} ${inner} 0 ${large} 0 ${centre + inner * Math.cos(angle)} ${centre + inner * Math.sin(angle)}`,
        'Z',
      ].join(' ');

      const share = (segment.value / total) * 100;
      const node = svg('path', { d: path, fill: segment.colour, class: 'tl-arc' });

      node.addEventListener('mousemove', (event) => {
        showTooltip(event, [
          el('strong', {}, segment.label),
          el('div', {}, `${fmt(segment.value)} credits`),
          el('div', { className: 'tl-tooltip-total' }, `${share.toFixed(1)}% of total`),
        ]);
      });
      node.addEventListener('mouseleave', hideTooltip);

      angle = end;
      return node;
    });

  return svg(
    'svg',
    {
      viewBox: `0 0 ${size} ${size}`,
      class: 'tl-donut',
      role: 'img',
      'aria-label': `Donut chart of ${String(segments.length)} segments`,
    },
    [
      ...arcs,
      svg('text', { x: centre, y: centre - 2, class: 'tl-donut-value' }, [
        document.createTextNode(centreValue),
      ]),
      svg('text', { x: centre, y: centre + 18, class: 'tl-donut-label' }, [
        document.createTextNode(centreLabel),
      ]),
    ],
  );
}

// --- horizontal bars --------------------------------------------------

export function barsH({ rows, height, format = fmt, onSelect }) {
  if (rows.length === 0) return el('p', { className: 'tl-empty' }, 'Nothing to plot.');

  const rowH = 28;
  const total = height ?? rows.length * rowH + 12;
  const max = Math.max(...rows.map((row) => row.value), 0) || 1;
  const labelW = 260;
  const barW = W - labelW - 130;

  const bars = rows.map((row, index) => {
    const y = index * rowH + 6;
    const width = (row.value / max) * barW;

    const group = svg('g', { class: onSelect ? 'tl-bar-row tl-bar-clickable' : 'tl-bar-row' }, [
      svg('text', { x: labelW - 10, y: y + 15, class: 'tl-bar-label' }, [
        document.createTextNode(row.label),
      ]),
      svg('rect', {
        x: labelW,
        y: y + 3,
        width: barW,
        height: rowH - 12,
        rx: 3,
        class: 'tl-bar-track-svg',
      }),
      svg('rect', {
        x: labelW,
        y: y + 3,
        width: Math.max(2, width),
        height: rowH - 12,
        rx: 3,
        fill: row.colour ?? 'var(--tl-accent)',
      }),
      svg('text', { x: labelW + barW + 10, y: y + 15, class: 'tl-bar-value' }, [
        document.createTextNode(format(row.value)),
      ]),
    ]);

    group.addEventListener('mousemove', (event) => {
      showTooltip(
        event,
        [
          el('strong', {}, row.label),
          el('div', {}, `${format(row.value)}`),
          row.detail ? el('div', { className: 'tl-tooltip-total' }, row.detail) : null,
        ].filter(Boolean),
      );
    });
    group.addEventListener('mouseleave', hideTooltip);
    if (onSelect) group.addEventListener('click', () => onSelect(row));

    return group;
  });

  return svg(
    'svg',
    { viewBox: `0 0 ${W} ${total}`, class: 'tl-chart', role: 'img', 'aria-label': 'Ranked bars' },
    bars,
  );
}

// --- calendar heatmap -------------------------------------------------

/**
 * A GitHub-style contribution grid over the day axis.
 *
 * Answers a question none of the other charts do: *when* does the spend
 * happen. A row of dark Tuesdays is a different problem from a dark last
 * week of the month.
 */
export function calendarHeatmap({ days, values, onSelect }) {
  if (days.length === 0) return el('p', { className: 'tl-empty' }, 'Nothing to plot.');

  const cell = 15;
  const gap = 3;
  const left = 30;
  const topPad = 18;

  const first = new Date(`${days[0]}T00:00:00Z`);
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());

  const byDay = new Map(days.map((day, index) => [day, values[index]]));
  const last = new Date(`${days[days.length - 1]}T00:00:00Z`);
  const weeks = Math.ceil((last.getTime() - start.getTime()) / (7 * 86_400_000)) + 1;
  const max = Math.max(...values, 0) || 1;

  const cells = [];
  const monthLabels = [];
  let lastMonth = -1;

  for (let week = 0; week < weeks; week += 1) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + week * 7 + weekday);
      const key = date.toISOString().slice(0, 10);
      const value = byDay.get(key);

      if (week === 0 || (weekday === 0 && date.getUTCMonth() !== lastMonth)) {
        if (date.getUTCMonth() !== lastMonth) {
          lastMonth = date.getUTCMonth();
          monthLabels.push(
            svg('text', { x: left + week * (cell + gap), y: 12, class: 'tl-axis' }, [
              document.createTextNode(
                date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
              ),
            ]),
          );
        }
      }

      // Fourth root, not linear: one enormous day would otherwise flatten
      // every other day to the same near-empty shade.
      const intensity = value === undefined ? 0 : Math.max(0.12, (value / max) ** 0.25);

      const rect = svg('rect', {
        x: left + week * (cell + gap),
        y: topPad + weekday * (cell + gap),
        width: cell,
        height: cell,
        rx: 3,
        fill: value === undefined ? 'var(--tl-bar-track)' : 'var(--tl-accent)',
        'fill-opacity': value === undefined ? '0.45' : String(intensity),
        class: value === undefined ? '' : 'tl-heat-cell',
      });

      if (value !== undefined) {
        rect.addEventListener('mousemove', (event) => {
          showTooltip(event, [el('strong', {}, key), el('div', {}, `${fmt(value)} credits`)]);
        });
        rect.addEventListener('mouseleave', hideTooltip);
        if (onSelect) rect.addEventListener('click', () => onSelect(key));
      }

      cells.push(rect);
    }
  }

  const weekdayLabels = ['Mon', 'Wed', 'Fri'].map((label, index) =>
    svg('text', { x: 0, y: topPad + (index * 2 + 1) * (cell + gap) + 11, class: 'tl-axis' }, [
      document.createTextNode(label),
    ]),
  );

  const width = left + weeks * (cell + gap) + 10;
  const height = topPad + 7 * (cell + gap);

  return svg(
    'svg',
    {
      viewBox: `0 0 ${width} ${height}`,
      // Unlike every other chart here, this one is drawn at a fixed cell
      // size: a calendar is only readable when a day is day-sized. Without
      // explicit dimensions the viewBox stretches to the card width, and a
      // fortnight of data renders as a handful of enormous blocks.
      width,
      height,
      class: 'tl-heatmap',
      role: 'img',
      'aria-label': 'Daily spend calendar',
    },
    [...monthLabels, ...weekdayLabels, ...cells],
  );
}

// --- gauge ------------------------------------------------------------

export function gaugeArc({ value, max, label, height = 190 }) {
  const size = height;
  const centre = size / 2;
  const radius = size / 2 - 16;
  const fraction = max > 0 ? Math.min(1.35, value / max) : 0;

  const arc = (from, to, colour, width) => {
    const start = Math.PI * (0.75 + from * 1.5);
    const end = Math.PI * (0.75 + to * 1.5);
    const large = end - start > Math.PI ? 1 : 0;
    return svg('path', {
      d:
        `M ${centre + radius * Math.cos(start)} ${centre + radius * Math.sin(start)} ` +
        `A ${radius} ${radius} 0 ${large} 1 ${centre + radius * Math.cos(end)} ${centre + radius * Math.sin(end)}`,
      fill: 'none',
      stroke: colour,
      'stroke-width': width,
      'stroke-linecap': 'round',
    });
  };

  const over = fraction > 1;

  return svg(
    'svg',
    {
      viewBox: `0 0 ${size} ${size}`,
      class: 'tl-gauge',
      role: 'img',
      'aria-label': `${label}: ${fmt(value)} of ${fmt(max)}`,
    },
    [
      arc(0, 1, 'var(--tl-bar-track)', 14),
      arc(0, Math.min(1, fraction), over ? 'var(--tl-danger)' : 'var(--tl-accent)', 14),
      svg('text', { x: centre, y: centre + 2, class: 'tl-donut-value' }, [
        document.createTextNode(`${Math.round(fraction * 100).toString()}%`),
      ]),
      svg('text', { x: centre, y: centre + 22, class: 'tl-donut-label' }, [
        document.createTextNode(label),
      ]),
    ],
  );
}

// --- legend -----------------------------------------------------------

export function legend(entries) {
  return el(
    'div',
    { className: 'tl-chart-legend' },
    entries.map((entry) =>
      el('span', { className: 'tl-legend-item', title: entry.title ?? entry.label }, [
        swatch(entry.colour),
        entry.label,
      ]),
    ),
  );
}

/** Kept for the compact in-table visuals, which are not worth an SVG. */
export function stackedBar(segments, { height = 14 } = {}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return el('div', { className: 'tl-bar-track', style: { height: `${height}px` } });

  return el(
    'div',
    {
      className: 'tl-stack',
      style: { height: `${height}px`, borderRadius: '4px', overflow: 'hidden' },
    },
    segments
      .filter((segment) => segment.value > 0)
      .map((segment) =>
        el('div', {
          className: 'tl-stack-seg',
          style: { width: `${(segment.value / total) * 100}%`, background: segment.colour },
          title: `${segment.label}: ${fmt(segment.value)} (${((segment.value / total) * 100).toFixed(1)}%)`,
        }),
      ),
  );
}

export function sparkline(values, { width = 160, height = 32, colour = 'var(--tl-accent)' } = {}) {
  if (values.length === 0) return el('span', { className: 'tl-subtle' }, '—');

  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;

  return svg(
    'svg',
    {
      class: 'tl-sparkline',
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': `Trend, peak ${fmt(max)}`,
    },
    [
      svg('polyline', {
        points: values
          .map((value, index) => `${index * step},${height - ((value - min) / span) * height}`)
          .join(' '),
        fill: 'none',
        stroke: colour,
        'stroke-width': '1.5',
      }),
    ],
  );
}

export { shortNumber };
