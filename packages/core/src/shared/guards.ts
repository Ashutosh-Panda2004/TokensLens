/**
 * Minimal runtime type guards for narrowing `unknown` values read from
 * external, untrusted, undocumented data (the journal — PLAN.md §10.2).
 * Deliberately tiny and dependency-free rather than a full schema
 * validation library: every call site that matters is paired with an
 * explicit decision about what happens when the guard fails (default,
 * skip, or `SchemaDriftError`) — see `ingest/normalise.ts`.
 */

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
