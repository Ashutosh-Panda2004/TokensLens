/**
 * Measures how much *text* a recorded tool result carried.
 *
 * VS Code stores a tool result in `result.metadata.toolCallResults[callId]`
 * in one of two shapes, both seen on real journals:
 *
 * 1. A plain string payload — `{ content: [{ value: "..." }] }`. Terminal
 *    output, subagent reports and web fetches look like this.
 * 2. A serialised *prompt-element tree* — `{ content: [{ value: { node:
 *    { children: [...] } } }] }`. `read_file`, `grep_search` and the other
 *    structured tools look like this, and their text lives in string
 *    leaves scattered throughout the tree.
 *
 * A naive `String(value).length` sees ~2 characters for a 15,000-token file
 * read, because the payload is an object. Walking for string leaves is what
 * makes the second shape measurable at all.
 *
 * **What this returns is a character count, not a token count.** The count
 * is exact and therefore `Measured`; converting it to tokens is an
 * approximation and belongs to the caller, tagged `Modelled` — see
 * {@link CHARS_PER_TOKEN_ESTIMATE}. Keeping the honest measurement and the
 * estimate in separate places is PLAN.md P3 applied to ingest.
 *
 * No payload text is ever retained — only its length. This is what lets
 * Phase D3 price an oversized tool result without storing a byte of it.
 */

/** Depth cap. Real trees nest ~10 deep; this is a cycle/pathology guard, not a limit. */
const MAX_DEPTH = 64;

/**
 * Structural keys in the prompt-element tree that carry no prompt text.
 * `ctorName` in particular is a minified class name (e.g. `YLe`) present on
 * every node — counting it would inflate a deep tree's size by thousands of
 * characters that were never billed.
 */
const STRUCTURAL_KEYS = new Set(['$mid', 'type', 'ctor', 'ctorName', 'priority', 'flexGrow']);

/**
 * Rough characters-per-token used to turn a measured character count into a
 * token estimate. Deliberately a single named constant: every figure derived
 * from it is `Modelled`, and this is the assumption to state when saying so.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Sums the length of every string leaf reachable from `value`, skipping
 * structural bookkeeping keys. Returns 0 for `undefined`/`null` rather than
 * throwing — a missing result is a legitimate state (the tool errored, or
 * the journal was truncated mid-write), not a malformed one.
 */
export function measureResultChars(value: unknown, depth = 0): number {
  if (depth > MAX_DEPTH) return 0;
  if (typeof value === 'string') return value.length;
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number' || typeof value === 'boolean') return 0;

  if (Array.isArray(value)) {
    let sum = 0;
    for (const item of value) sum += measureResultChars(item, depth + 1);
    return sum;
  }

  if (typeof value === 'object') {
    let sum = 0;
    for (const [key, child] of Object.entries(value)) {
      if (STRUCTURAL_KEYS.has(key)) continue;
      sum += measureResultChars(child, depth + 1);
    }
    return sum;
  }

  return 0;
}

/** Converts a measured character count into an estimated token count. Always `Modelled`. */
export function estimateTokensFromChars(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN_ESTIMATE);
}
