/**
 * Replay engine for the VS Code `chatSessions` journal's envelope format.
 *
 * Empirically, each JSONL line is one of exactly three envelope shapes
 * (verified against real journals on 2026-07-30 — DEVELOPMENT-PLAN.md
 * Phase D1):
 *
 *   `{ kind: 0, v }`          — a full document **snapshot**. Always the
 *                               first line; replaces the working document
 *                               outright.
 *   `{ kind: 1, k, v }`       — **set**: write `v` at path `k`.
 *   `{ kind: 2, k, v: [...] }` — **append**: push every element of `v`
 *                               onto the array found at path `k`.
 *
 * This is an event-sourced log: the current state of a session is only
 * knowable by replaying every envelope, in file order, onto an initially
 * empty document. There is no guarantee only these three kinds exist —
 * the format is undocumented (PLAN.md §10.2) — so unrecognised kinds are
 * skipped rather than treated as fatal; `applyEnvelope` reports whether it
 * recognised the envelope so callers can track a drift/coverage signal.
 */

export type PathSegment = string | number;

export interface SnapshotEnvelope {
  readonly kind: 0;
  readonly v: unknown;
}

export interface SetEnvelope {
  readonly kind: 1;
  readonly k: readonly PathSegment[];
  readonly v: unknown;
}

export interface AppendEnvelope {
  readonly kind: 2;
  readonly k: readonly PathSegment[];
  readonly v: readonly unknown[];
}

export type JournalEnvelope = SnapshotEnvelope | SetEnvelope | AppendEnvelope;

export interface ApplyResult {
  readonly doc: unknown;
  /** False when `envelope.kind` was not one of the three recognised kinds. */
  readonly recognised: boolean;
}

/** Structural check — does `value` look like a plausible journal envelope at all? */
export function isEnvelopeShaped(
  value: unknown,
): value is { kind: unknown; k?: unknown; v?: unknown } {
  return typeof value === 'object' && value !== null && 'kind' in value;
}

function isPathSegmentArray(value: unknown): value is PathSegment[] {
  return (
    Array.isArray(value) && value.every((seg) => typeof seg === 'string' || typeof seg === 'number')
  );
}

/**
 * Narrows a shape-checked envelope candidate to a well-formed
 * {@link JournalEnvelope}, or returns `undefined` if it doesn't match any
 * recognised shape (e.g. an unknown `kind`, or `k`/`v` of the wrong type).
 */
export function parseEnvelope(candidate: {
  kind: unknown;
  k?: unknown;
  v?: unknown;
}): JournalEnvelope | undefined {
  if (candidate.kind === 0) {
    return { kind: 0, v: candidate.v };
  }
  if (candidate.kind === 1 && isPathSegmentArray(candidate.k)) {
    return { kind: 1, k: candidate.k, v: candidate.v };
  }
  if (candidate.kind === 2 && isPathSegmentArray(candidate.k) && Array.isArray(candidate.v)) {
    return { kind: 2, k: candidate.k, v: candidate.v };
  }
  return undefined;
}

/**
 * Applies one envelope to `doc`, returning the (possibly new) document.
 *
 * `doc` is mutated in place for `kind: 1`/`kind: 2` (the common case); a
 * `kind: 0` envelope replaces it outright, which is why the result must be
 * reassigned by the caller — see the module doc comment's replay loop.
 */
export function applyEnvelope(doc: unknown, envelope: JournalEnvelope): ApplyResult {
  switch (envelope.kind) {
    case 0:
      return { doc: envelope.v, recognised: true };
    case 1:
      setAtPath(doc, envelope.k, envelope.v);
      return { doc, recognised: true };
    case 2:
      appendAtPath(doc, envelope.k, envelope.v);
      return { doc, recognised: true };
  }
}

/**
 * Replays a full sequence of envelopes onto an initially empty document.
 * Envelopes that fail to parse (unrecognised `kind`, malformed `k`/`v`)
 * are skipped and counted in `unrecognisedCount` rather than aborting the
 * replay — see the module doc comment.
 */
export function replayEnvelopes(
  candidates: Iterable<{ kind: unknown; k?: unknown; v?: unknown }>,
): { doc: unknown; unrecognisedCount: number } {
  let doc: unknown;
  let unrecognisedCount = 0;

  for (const candidate of candidates) {
    const envelope = parseEnvelope(candidate);
    if (!envelope) {
      unrecognisedCount += 1;
      continue;
    }
    ({ doc } = applyEnvelope(doc, envelope));
  }

  return { doc, unrecognisedCount };
}

interface ParentRef {
  readonly parent: Record<PropertyKey, unknown> | unknown[];
  readonly key: PathSegment;
}

/**
 * Walks `path` against `doc`, auto-vivifying missing intermediate
 * containers (an array if the *next* segment is numeric, an object
 * otherwise) so a `set`/`append` at a path that hasn't been touched yet
 * still succeeds. Returns the immediate parent + final key, or `undefined`
 * if `path` is empty or `doc` is not an object/array to begin with.
 */
function navigateToParent(doc: unknown, path: readonly PathSegment[]): ParentRef | undefined {
  if (path.length === 0) return undefined;
  if (typeof doc !== 'object' || doc === null) return undefined;

  let current: Record<PropertyKey, unknown> = doc as Record<PropertyKey, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    const nextSegment = path[i + 1];
    if (segment === undefined || nextSegment === undefined) return undefined;

    current[segment] ??= typeof nextSegment === 'number' ? [] : {};

    const next = current[segment];
    if (typeof next !== 'object' || next === null) return undefined;
    current = next as Record<PropertyKey, unknown>;
  }

  const key = path[path.length - 1];
  if (key === undefined) return undefined;
  return { parent: current, key };
}

function setAtPath(doc: unknown, path: readonly PathSegment[], value: unknown): void {
  const ref = navigateToParent(doc, path);
  if (!ref) return;
  (ref.parent as Record<PropertyKey, unknown>)[ref.key] = value;
}

function appendAtPath(
  doc: unknown,
  path: readonly PathSegment[],
  values: readonly unknown[],
): void {
  const ref = navigateToParent(doc, path);
  if (!ref) return;
  const record = ref.parent as Record<PropertyKey, unknown>;
  if (!Array.isArray(record[ref.key])) {
    record[ref.key] = [];
  }
  (record[ref.key] as unknown[]).push(...values);
}
