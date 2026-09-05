import { api } from '../lib/api.js';
import { card, el, table } from '../lib/dom.js';
import { gaugeArc } from '../lib/charts.js';
import { fmt, provenanceChip, taggedChip } from '../lib/format.js';
import { toQuery } from '../lib/state.js';

export const meta = { id: 'budget', label: 'Budget', icon: '◔' };

const SOURCE_TEXT = {
  flag: 'set on the command line',
  env: 'set by TOKENLENS_MONTHLY_ALLOWANCE',
  config: 'set in .tokenlens/config.json',
  'plan-default':
    'the published figure for this plan — not a reading of your organisation’s settings',
};

export async function render(state) {
  const query = toQuery(state);
  const [budget, compare] = await Promise.all([
    api.budget(query),
    api.compare(query).catch(() => null),
  ]);

  return [
    allowanceCard(budget),
    forecastCard(budget),
    compare ? comparisonCard(compare) : null,
  ].filter(Boolean);
}

function allowanceCard(budget) {
  const allowanceText =
    budget.monthlyAllowance === null
      ? 'unlimited — no monthly limit set'
      : `${fmt(budget.monthlyAllowance, 0)} credits`;

  return card('Allowance', SOURCE_TEXT[budget.allowanceSource] ?? budget.allowanceSource, [
    el('div', { className: 'tl-budget-grid' }, [
      item('Plan', budget.plan),
      item('Monthly allowance', allowanceText),
      item('Month-to-date', [
        fmt(budget.monthToDateCredits.value),
        ' ',
        provenanceChip(budget.monthToDateCredits),
      ]),
      item('Projected month-end', [
        fmt(budget.projectedMonthEndCredits.value),
        ' ',
        taggedChip(budget.projectedMonthEndCredits),
      ]),
    ]),
    budget.allowanceSource === 'plan-default'
      ? el(
          'p',
          { className: 'tl-warning' },
          'TokenLens makes no network calls, so it cannot read your organisation’s actual limit. ' +
            'Set it with --allowance, TOKENLENS_MONTHLY_ALLOWANCE, or "monthlyAllowance" in .tokenlens/config.json.',
        )
      : null,
  ]);
}

function item(label, value) {
  return el('div', { className: 'tl-budget-item' }, [
    el('div', { className: 'tl-budget-label' }, label),
    el('div', { className: 'tl-budget-value' }, [value].flat()),
  ]);
}

function forecastCard(budget) {
  if (budget.unlimited) {
    return card(
      'Forecast',
      'No monthly limit is enforced, so there is nothing to exceed and no exhaustion date to project.',
      el(
        'p',
        {},
        `Day ${String(budget.daysElapsedInMonth)} of ${String(budget.daysInMonth)} — spend and projection are still measured, only the ceiling is absent.`,
      ),
    );
  }

  return card(
    'Forecast',
    'Linear extrapolation of the month-to-date daily rate — not a forecast of behaviour change.',
    [
      // The gauge shows spend against the allowance, and the projection is
      // stated beside it rather than drawn: an extrapolation rendered as the
      // same kind of mark as a measurement reads as one.
      gaugeArc({
        value: budget.monthToDateCredits.value,
        max: budget.monthlyAllowance,
        label: `of ${fmt(budget.monthlyAllowance, 0)} credits used`,
      }),
      budget.onTrackToExceedAllowance
        ? el(
            'p',
            { className: 'tl-warning' },
            `Projected to exceed the allowance by ${fmt(budget.projectedOverage.value)} credits.`,
          )
        : el('p', {}, 'On track to stay within the included allowance.'),
      budget.hardBlockDate
        ? el(
            'p',
            { className: 'tl-subtle' },
            `Projected exhaustion date: ${budget.hardBlockDate.value}`,
          )
        : null,
    ],
  );
}

/**
 * Range comparison against the **preceding window of equal length**, never
 * "everything before" — comparing a week to a year and calling the
 * difference a trend is how a chart lies without a single wrong number.
 */
function comparisonCard(compare) {
  if (compare.previous.credits === undefined || compare.deltaPercent === null) {
    return card(
      'Comparison',
      null,
      el(
        'p',
        { className: 'tl-subtle' },
        'Pick a custom or bounded range to compare it against the preceding window.',
      ),
    );
  }

  const up = compare.deltaCredits > 0;

  return card(
    'Versus the preceding window',
    'Equal length, immediately before the selected range.',
    [
      table(
        [
          { key: 'window', label: 'Window' },
          { key: 'from', label: 'From' },
          { key: 'to', label: 'To' },
          { key: 'credits', label: 'Credits', numeric: true, render: (row) => fmt(row.credits) },
          { key: 'requests', label: 'Requests', numeric: true },
          {
            key: 'measuredShare',
            label: 'Measured',
            numeric: true,
            render: (row) => `${((row.measuredCredits / (row.credits || 1)) * 100).toFixed(0)}%`,
          },
        ],
        [
          { window: 'Selected', ...compare.current },
          { window: 'Preceding', ...compare.previous },
        ],
        { sortable: false },
      ),
      el('p', {}, [
        'Change: ',
        el(
          'span',
          { className: up ? 'tl-delta-up' : 'tl-delta-down' },
          `${up ? '+' : ''}${fmt(compare.deltaCredits)} credits (${compare.deltaPercent.toFixed(1)}%)`,
        ),
      ]),
    ],
  );
}
