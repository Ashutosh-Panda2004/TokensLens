/**
 * Number formatting for report output.
 *
 * `toLocaleString()` with no explicit locale follows the host machine's
 * settings, which produced `1,54,09,029.333` on a machine set to an Indian
 * locale — correct for that locale, but a report that renders differently
 * depending on who runs it is not a report anybody can quote. Every figure
 * that reaches a user goes through here.
 */
const LOCALE = 'en-US';

/** Whole-number count with thousands separators. Rounds — token counts are never fractional. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString(LOCALE);
}

/** Credits, to one decimal place. */
export function formatCredits(value: number): string {
  return value.toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** A 0..1 ratio as a percentage string. */
export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}
