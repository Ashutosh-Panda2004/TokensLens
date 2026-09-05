import { el } from './dom.js';

/**
 * Number formatting.
 *
 * The locale is **explicit and always**. D3 found `toLocaleString()` with no
 * locale rendering `1,54,09,029.333` on the machine this was built on — a
 * report that groups digits differently depending on who opens it is not a
 * report anybody can quote back.
 */
const LOCALE = 'en-US';

export function fmt(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString(LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtInt(value) {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString(LOCALE, { maximumFractionDigits: 0 });
}

export function pct(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(decimals)}%`;
}

export function day(ts) {
  if (ts === null || ts === undefined) return '—';
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * The provenance chip.
 *
 * Rendered next to every aggregate figure. An aggregate over many requests
 * is routinely part measured and part estimated, and collapsing that to
 * either pole would be a lie in one direction or the other — so `blended`
 * carries the exact measured share rather than rounding to a verdict.
 */
export function provenanceChip(view) {
  if (!view || typeof view !== 'object') return null;

  if (view.kind === 'measured') {
    return el(
      'span',
      { className: 'tl-chip tl-chip-measured', title: 'Read from a recorded credits value.' },
      'measured',
    );
  }
  if (view.kind === 'modelled') {
    return el(
      'span',
      {
        className: 'tl-chip tl-chip-modelled',
        title: 'Estimated from the derived rate card, not measured.',
      },
      'modelled',
    );
  }
  return el(
    'span',
    {
      className: 'tl-chip tl-chip-blended',
      title: `${fmt(view.measured)} of ${fmt(view.value)} credits are measured; the rest is a rate-card estimate.`,
    },
    `~${String(view.measuredPercent)}% measured`,
  );
}

/** A `Measured<T>`/`Modelled<T>` tagged value, which is binary rather than blended. */
export function taggedChip(value) {
  if (!value?.provenance) return null;
  const kind = value.provenance.kind;
  const title =
    kind === 'measured'
      ? `Source: ${value.provenance.source ?? 'recorded value'}`
      : [value.provenance.basis, ...(value.provenance.assumptions ?? [])]
          .filter(Boolean)
          .join(' — ');
  return el('span', { className: `tl-chip tl-chip-${kind}`, title }, kind);
}
