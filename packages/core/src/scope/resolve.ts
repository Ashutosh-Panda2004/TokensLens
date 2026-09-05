import { canonicalisePath } from '../ingest/redact.js';
import { readWorkspaceMap } from './workspace-map.js';
import {
  isAtOrBeneath,
  type ScopeMode,
  type ScopeSelection,
  type WorkspaceLocation,
} from './types.js';

export interface ResolveScopeOptions {
  readonly mode?: ScopeMode;
  /**
   * The directory (or directories) to anchor at. Defaults to the process
   * working directory. Several are accepted because a VS Code workspace can
   * hold several folders, and scoping to only the first understates it.
   */
  readonly at?: string | readonly string[];
  /** Injected for tests; otherwise read from the real `workspaceStorage`. */
  readonly locations?: readonly WorkspaceLocation[];
  readonly roots?: readonly string[];
}

/**
 * Resolves which workspaces a command is talking about.
 *
 * The default is `folder` — the directory you are standing in **and
 * everything beneath it** — rather than an exact match, because standing
 * in a parent directory holding three projects should total those three
 * rather than report nothing on the grounds that the parent was never
 * itself opened as a workspace.
 *
 * `all` returns a selection with no id set at all, which is what widens
 * every downstream filter back to the whole machine.
 */
export async function resolveScope(options: ResolveScopeOptions = {}): Promise<ScopeSelection> {
  const mode: ScopeMode = options.mode ?? 'folder';
  const locations = options.locations ?? (await readWorkspaceMap(options.roots));
  const totalWorkspaceCount = locations.length;

  if (mode === 'all') {
    return { mode, totalWorkspaceCount, matchedWorkspaceCount: totalWorkspaceCount };
  }

  const anchors = toAnchors(options.at);
  const canonicalAnchors = anchors.map((anchor) => canonicalisePath(anchor));

  const matched = locations.filter((location) => {
    const path = location.canonicalPath;
    if (path === undefined) return false;
    return canonicalAnchors.some((anchor) =>
      mode === 'workspace' ? path === anchor : isAtOrBeneath(path, anchor),
    );
  });

  return {
    mode,
    rootCanonicalPath: canonicalAnchors[0],
    rootDisplayPath: anchors[0],
    ...(anchors.length > 1 ? { rootDisplayPaths: anchors } : {}),
    workspaceIds: new Set(matched.map((location) => location.workspaceId)),
    totalWorkspaceCount,
    matchedWorkspaceCount: matched.length,
  };
}

function toAnchors(at: string | readonly string[] | undefined): string[] {
  if (at === undefined) return [process.cwd()];
  const list = (typeof at === 'string' ? [at] : at).filter((entry) => entry.trim() !== '');
  return list.length > 0 ? list : [process.cwd()];
}

/**
 * One line stating what the figures below cover.
 *
 * Printed on **every** scoped artefact. The defect that created this whole
 * phase was not a wrong total — it was a correct total that never said
 * whose it was, which let a reader in an empty folder attribute the entire
 * machine's spend to it.
 */
export function describeScope(scope: ScopeSelection): string {
  if (scope.mode === 'all') {
    return `scope: all ${String(scope.totalWorkspaceCount)} workspace(s) on this machine`;
  }

  const suffix = scope.mode === 'workspace' ? ' (this workspace only)' : ' and below';
  const where =
    scope.rootDisplayPaths !== undefined && scope.rootDisplayPaths.length > 1
      ? `${String(scope.rootDisplayPaths.length)} folders`
      : (scope.rootDisplayPath ?? '(current folder)');

  return (
    `scope: ${where}${suffix} — ` +
    `${String(scope.matchedWorkspaceCount)} of ${String(scope.totalWorkspaceCount)} workspace(s)`
  );
}

/** True when the scope selected nothing — the case that must never render as a blank table. */
export function isEmptyScope(scope: ScopeSelection): boolean {
  return scope.workspaceIds?.size === 0;
}
