import { ProvenanceError } from '../shared/errors.js';

/**
 * Where a value came from — the type-level enforcement of PLAN.md §13's
 * metric policy: "never publish an estimate as a measurement."
 *
 * - `measured`  — read directly from a field GitHub/VS Code wrote to disk.
 *   `source` is a file path (or logical dataset name) and `offset` is a
 *   byte offset when the value traces to one exact location — together
 *   these are exactly what `tokenlens verify` prints.
 * - `modelled`  — derived: extrapolated, simulated, or estimated. `basis`
 *   names the method; `assumptions` lists what would have to be true for
 *   the number to hold.
 */
export type Provenance =
  | { readonly kind: 'measured'; readonly source: string; readonly offset?: number }
  | { readonly kind: 'modelled'; readonly basis: string; readonly assumptions: readonly string[] };

export interface Value<T> {
  readonly value: T;
  readonly provenance: Provenance;
}

export type Measured<T> = Value<T> & { readonly provenance: { readonly kind: 'measured' } };
export type Modelled<T> = Value<T> & { readonly provenance: { readonly kind: 'modelled' } };

/** Constructs a {@link Measured} value. `offset` is a byte offset when known. */
export function measured<T>(value: T, source: string, offset?: number): Measured<T> {
  return {
    value,
    provenance:
      offset === undefined ? { kind: 'measured', source } : { kind: 'measured', source, offset },
  };
}

/** Constructs a {@link Modelled} value. `assumptions` should be falsifiable, not vague. */
export function modelled<T>(
  value: T,
  basis: string,
  assumptions: readonly string[] = [],
): Modelled<T> {
  return { value, provenance: { kind: 'modelled', basis, assumptions } };
}

export function isMeasured<T>(v: Value<T>): v is Measured<T> {
  return v.provenance.kind === 'measured';
}

export function isModelled<T>(v: Value<T>): v is Modelled<T> {
  return v.provenance.kind === 'modelled';
}

export interface RenderOptions {
  /** Custom numeric formatter (currency, percentage, ...). Defaults to `String()`. */
  format?: (value: number) => string;
  /**
   * Omit the bracketed provenance footnote. **Forbidden for `Modelled`
   * values** — see PLAN.md §13. Defaults to `true` (footnote shown).
   */
  footnote?: boolean;
}

/**
 * The one sanctioned way to turn a {@link Value} into display text. Always
 * includes the provenance footnote unless the caller opts out — and that
 * opt-out is refused outright for `modelled` values, so a screen, a log
 * line, or a report can never present an estimate as if it were measured.
 */
export function render(value: Value<number>, options: RenderOptions = {}): string {
  const format = options.format ?? ((n: number): string => String(n));
  const footnote = options.footnote ?? true;
  const formatted = format(value.value);

  if (!footnote) {
    if (value.provenance.kind === 'modelled') {
      throw new ProvenanceError(
        'Modelled values must never be rendered without their provenance footnote ' +
          '(basis + assumptions) — see PLAN.md §13 metric policy.',
        { kind: 'modelled' },
      );
    }
    return formatted;
  }

  if (value.provenance.kind === 'measured') {
    const offsetSuffix =
      value.provenance.offset !== undefined ? `#${String(value.provenance.offset)}` : '';
    return `${formatted} [measured — ${value.provenance.source}${offsetSuffix}]`;
  }

  const assumptionsSuffix =
    value.provenance.assumptions.length > 0
      ? `; assumes: ${value.provenance.assumptions.join('; ')}`
      : '';
  return `${formatted} [modelled — ${value.provenance.basis}${assumptionsSuffix}]`;
}
