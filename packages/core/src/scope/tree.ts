import { isAtOrBeneath, type UnattributedReason, type WorkspaceLocation } from './types.js';

/** Per-workspace totals, computed by the caller from the ledger. */
export interface WorkspaceStats {
  readonly workspaceId: string;
  readonly credits: number;
  readonly measuredCredits: number;
  readonly requestCount: number;
  readonly firstTs?: number;
  readonly lastTs?: number;
  readonly topModel?: string;
}

export interface ProjectNode {
  readonly label: string;
  readonly displayPath: string;
  readonly workspaceIds: readonly string[];
  /** Credits recorded against **this** folder, opened directly. */
  readonly ownCredits: number;
  readonly ownRequestCount: number;
  /** This folder plus everything beneath it. */
  readonly subtreeCredits: number;
  readonly subtreeRequestCount: number;
  readonly children: readonly ProjectNode[];
}

export interface UnattributedBucket {
  readonly credits: number;
  readonly requestCount: number;
  readonly workspaceCount: number;
  readonly byReason: readonly {
    reason: UnattributedReason;
    workspaceCount: number;
    credits: number;
  }[];
}

export interface ProjectTree {
  readonly roots: readonly ProjectNode[];
  readonly unattributed: UnattributedBucket;
  readonly totalCredits: number;
}

const REASON_ORDER: readonly UnattributedReason[] = [
  'no-workspace-json',
  'malformed-workspace-json',
  'multi-root-workspace',
  'empty-window',
  'folder-no-longer-present',
];

export const UNATTRIBUTED_REASON_TEXT: Readonly<Record<UnattributedReason, string>> = {
  'no-workspace-json': 'no workspace.json beside the journal',
  'malformed-workspace-json': 'workspace.json could not be parsed',
  'multi-root-workspace': 'a multi-root .code-workspace naming several folders',
  'empty-window': 'an editor window opened without a folder',
  'folder-no-longer-present': 'names a folder that no longer exists',
};

/**
 * Builds the folder anatomy: what each directory spent on its own, and
 * what it spent including everything beneath it.
 *
 * The two are reported **separately at every node** and never merged.
 * Opening `TokenLens/packages/core` directly creates a workspace distinct
 * from `TokenLens`; rolling the child silently into the parent gives the
 * right total and the wrong answer to "what did this workspace cost", which
 * is the same class of error as the unscoped ledger itself.
 *
 * Anything that could not be placed goes to the unattributed bucket rather
 * than being dropped, so `tree + bucket` still reconciles against the
 * machine total. A scoping control that quietly discards what it cannot
 * classify would understate the very figure it exists to make trustworthy.
 */
export function buildProjectTree(
  locations: readonly WorkspaceLocation[],
  stats: readonly WorkspaceStats[],
): ProjectTree {
  const statsById = new Map(stats.map((entry) => [entry.workspaceId, entry]));
  const statFor = (workspaceId: string): WorkspaceStats =>
    statsById.get(workspaceId) ?? {
      workspaceId,
      credits: 0,
      measuredCredits: 0,
      requestCount: 0,
    };

  const placed = locations.filter(
    (location): location is WorkspaceLocation & { canonicalPath: string; displayPath: string } =>
      location.unattributedReason === undefined &&
      location.canonicalPath !== undefined &&
      location.displayPath !== undefined,
  );

  // Several workspace ids can point at one folder — the same project opened
  // after a VS Code storage reset, for instance. They are one node.
  const byFolder = new Map<
    string,
    { displayPath: string; workspaceIds: string[]; credits: number; requestCount: number }
  >();
  for (const location of placed) {
    const existing = byFolder.get(location.canonicalPath);
    const stat = statFor(location.workspaceId);
    if (existing) {
      existing.workspaceIds.push(location.workspaceId);
      existing.credits += stat.credits;
      existing.requestCount += stat.requestCount;
    } else {
      byFolder.set(location.canonicalPath, {
        displayPath: location.displayPath,
        workspaceIds: [location.workspaceId],
        credits: stat.credits,
        requestCount: stat.requestCount,
      });
    }
  }

  const paths = [...byFolder.keys()].sort((a, b) => a.length - b.length);
  const nodes = new Map<string, ProjectNode & { childList: ProjectNode[] }>();
  const roots: (ProjectNode & { childList: ProjectNode[] })[] = [];

  for (const path of paths) {
    const folder = byFolder.get(path);
    if (!folder) continue;

    const node = {
      label: folder.displayPath.split('/').filter(Boolean).pop() ?? folder.displayPath,
      displayPath: folder.displayPath,
      workspaceIds: folder.workspaceIds,
      ownCredits: folder.credits,
      ownRequestCount: folder.requestCount,
      subtreeCredits: folder.credits,
      subtreeRequestCount: folder.requestCount,
      children: [] as ProjectNode[],
      childList: [] as ProjectNode[],
    };

    // Deepest existing ancestor wins, so `a/b/c` attaches to `a/b` when both
    // are present rather than jumping straight to `a`.
    let parentPath: string | undefined;
    for (const candidate of paths) {
      if (candidate === path) continue;
      if (!isAtOrBeneath(path, candidate)) continue;
      if (parentPath === undefined || candidate.length > parentPath.length) parentPath = candidate;
    }

    nodes.set(path, node);
    const parent = parentPath === undefined ? undefined : nodes.get(parentPath);
    if (parent) parent.childList.push(node);
    else roots.push(node);
  }

  // Depth-last so a child's subtree is complete before its parent reads it.
  const deepestFirst = [...paths].sort((a, b) => b.length - a.length);
  for (const path of deepestFirst) {
    const node = nodes.get(path);
    if (!node) continue;
    const rolled = node.childList.reduce(
      (accumulator, child) => ({
        credits: accumulator.credits + child.subtreeCredits,
        requests: accumulator.requests + child.subtreeRequestCount,
      }),
      { credits: 0, requests: 0 },
    );
    Object.assign(node, {
      children: node.childList,
      subtreeCredits: node.ownCredits + rolled.credits,
      subtreeRequestCount: node.ownRequestCount + rolled.requests,
    });
  }

  const unplaced = locations.filter((location) => location.unattributedReason !== undefined);
  const byReason = REASON_ORDER.map((reason) => {
    const entries = unplaced.filter((location) => location.unattributedReason === reason);
    return {
      reason,
      workspaceCount: entries.length,
      credits: entries.reduce((sum, entry) => sum + statFor(entry.workspaceId).credits, 0),
    };
  }).filter((entry) => entry.workspaceCount > 0);

  const unattributed: UnattributedBucket = {
    credits: unplaced.reduce((sum, entry) => sum + statFor(entry.workspaceId).credits, 0),
    requestCount: unplaced.reduce((sum, entry) => sum + statFor(entry.workspaceId).requestCount, 0),
    workspaceCount: unplaced.length,
    byReason,
  };

  const sortByCredits = (list: readonly ProjectNode[]): ProjectNode[] =>
    [...list]
      .sort((a, b) => b.subtreeCredits - a.subtreeCredits)
      .map((node) => ({ ...node, children: sortByCredits(node.children) }));

  return {
    roots: sortByCredits(roots),
    unattributed,
    totalCredits: stats.reduce((sum, entry) => sum + entry.credits, 0),
  };
}
