/**
 * Scope: which workspace's spend a figure is actually about.
 *
 * This file is deliberately **pure** — no filesystem, no imports beyond
 * types — because `src/ledger` and `src/waste` consume the resolved
 * selection and neither is allowed to reach the disk (`arch.test.ts`).
 * Everything that reads `workspace.json` lives in `workspace-map.ts`.
 */

export type ScopeMode = 'folder' | 'workspace' | 'path' | 'all';

/**
 * Why a workspace could not be attributed to a folder a human would
 * recognise. Never collapsed into a single "unknown" — the report tells
 * the reader which of these it hit, because each has a different fix.
 */
export type UnattributedReason =
  | 'no-workspace-json'
  | 'malformed-workspace-json'
  | 'multi-root-workspace'
  | 'empty-window'
  | 'folder-no-longer-present';

export interface WorkspaceLocation {
  /** The opaque directory name VS Code assigned under `workspaceStorage`. */
  readonly workspaceId: string;
  /**
   * Canonical form used for matching only — lower-cased, POSIX
   * separators, scheme and percent-encoding removed. Never displayed and
   * never stored.
   */
  readonly canonicalPath?: string;
  /** Human-readable absolute path, case preserved. Display only, never persisted. */
  readonly displayPath?: string;
  /** Trailing folder name — what a person calls the project. */
  readonly label?: string;
  /** Set when the workspace could not be placed; drives the unattributed bucket. */
  readonly unattributedReason?: UnattributedReason;
}

export interface ScopeSelection {
  readonly mode: ScopeMode;
  /** Canonical root the scope is anchored at. `undefined` for `all`. */
  readonly rootCanonicalPath?: string;
  readonly rootDisplayPath?: string;
  /**
   * Every anchor, when the scope covers more than one folder — a multi-root
   * VS Code workspace. `rootDisplayPath` stays the first of them so existing
   * readers keep working, but reporting only that one would silently drop
   * the rest of the workspace's spend.
   */
  readonly rootDisplayPaths?: readonly string[];
  /**
   * The workspace ids in scope. `undefined` means *every* workspace —
   * distinct from an empty set, which means "we looked and nothing here
   * matched". Conflating the two is how an empty folder ends up reporting
   * the whole machine.
   */
  readonly workspaceIds?: ReadonlySet<string>;
  /** Every workspace known on this machine, in scope or not. */
  readonly totalWorkspaceCount: number;
  /** How many of them this scope selected. */
  readonly matchedWorkspaceCount: number;
}

/**
 * The workspace id a stored `source_file` belongs to.
 *
 * `request.source_file` is written by `toJournalRelativePath()` as
 * `<workspaceId>/chatSessions/<session>.jsonl`, always with POSIX
 * separators. A row whose path never met that marker is returned as
 * `undefined` rather than guessed at.
 */
export function workspaceIdOfSourceFile(sourceFile: string): string | undefined {
  const normalised = sourceFile.replace(/\\/g, '/');
  const slash = normalised.indexOf('/');
  if (slash <= 0) return undefined;
  const candidate = normalised.slice(0, slash);
  // An absolute path that escaped redaction (`C:` or an empty segment) is
  // not a workspace id, and treating it as one would invent a project.
  if (candidate.endsWith(':')) return undefined;
  return candidate;
}

/** Does a stored `source_file` fall inside `scope`? */
export function sourceFileInScope(sourceFile: string, scope: ScopeSelection | undefined): boolean {
  if (!scope?.workspaceIds) return true;
  const workspaceId = workspaceIdOfSourceFile(sourceFile);
  if (workspaceId === undefined) return false;
  return scope.workspaceIds.has(workspaceId);
}

/** A scope that selects everything — the explicit `--all` opt-in. */
export function allScope(totalWorkspaceCount = 0): ScopeSelection {
  return { mode: 'all', totalWorkspaceCount, matchedWorkspaceCount: totalWorkspaceCount };
}

/**
 * Is `candidate` at or beneath `root`? Both must already be canonical.
 *
 * The segment-boundary check is what stops `/a/project2` matching a root
 * of `/a/project` — a prefix comparison alone would silently fold an
 * unrelated sibling into the total.
 */
export function isAtOrBeneath(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return candidate.startsWith(prefix);
}
