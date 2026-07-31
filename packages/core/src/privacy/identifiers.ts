import { createHash } from 'node:crypto';

/**
 * Turning identifiers into things that are safe to store and show.
 *
 * Two identifiers need two genuinely different treatments, because they
 * carry different information:
 *
 * - A **session id** is an opaque UUID whose only job is to group requests
 *   together. Nothing downstream needs the original value, so it is hashed
 *   at ingest and the original is never stored at all.
 *
 * - A **journal path** must stay resolvable, because `tokenlens verify`
 *   exists to let a developer open the exact file a figure came from
 *   (PLAN.md P2). Hashing it would destroy that. But the absolute path
 *   contains the OS user's home directory \u2014 on the machine this was built
 *   on, literally `C:\Users\<username>\...` \u2014 which is a direct personal
 *   identifier. So it is stored **relative to the journal root**: the
 *   username-bearing prefix is dropped, and what remains is
 *   `<workspace-id>/chatSessions/<session>.jsonl`, whose components are
 *   already opaque machine-generated ids.
 *
 * That keeps P2 (traceability) and the privacy rule both intact, rather
 * than trading one off against the other.
 */

const HASH_LENGTH_HEX_CHARS = 16;

/** The path segment every VS Code journal lives under, on every platform. */
const JOURNAL_ROOT_SEGMENT = 'workspaceStorage';

/**
 * Salted, truncated SHA-256. Same construction as `ingest/redact.ts` uses
 * for file paths \u2014 per-install salt, so the same id is stable on one
 * machine (needed to avoid double-counting) but uncorrelatable across
 * machines (so an org rollup can never join two developers' data).
 */
export function hashIdentifier(raw: string, salt: string): string {
  return createHash('sha256')
    .update(salt, 'utf8')
    .update(raw, 'utf8')
    .digest('hex')
    .slice(0, HASH_LENGTH_HEX_CHARS);
}

/**
 * Strips the user-identifying prefix from a journal path, keeping only the
 * portion below `workspaceStorage`.
 *
 * Returns the input unchanged if the marker is absent \u2014 callers get a path
 * that is no *worse* than what they passed in, and {@link isPathRedacted}
 * lets the guard detect that case rather than assuming success.
 */
export function toJournalRelativePath(absolutePath: string): string {
  const normalised = absolutePath.replace(/\\/g, '/');
  const marker = `/${JOURNAL_ROOT_SEGMENT}/`;
  const index = normalised.indexOf(marker);
  if (index === -1) return absolutePath;
  return normalised.slice(index + marker.length);
}

/**
 * Does this path still look like it contains a home directory or drive
 * root? Used by the privacy guard to fail loudly if an un-redacted path
 * ever reaches a report, rather than trusting that ingest did its job.
 */
export function isPathRedacted(path: string): boolean {
  const normalised = path.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalised)) return false; // C:/...
  if (normalised.startsWith('/')) return false; // POSIX absolute
  if (normalised.includes('/Users/') || normalised.includes('/home/')) return false;
  if (normalised.includes(JOURNAL_ROOT_SEGMENT)) return false;
  return true;
}

/**
 * A short, human-readable form of a hashed id for display.
 *
 * Deliberately still a hash, just shorter. Truncation is for reading
 * convenience in a table; it is not the privacy mechanism, which is the
 * salted hash itself.
 */
export function shortId(hashedId: string): string {
  return hashedId.slice(0, 8);
}
