import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  allScope,
  buildProjectTree,
  isAtOrBeneath,
  readWorkspaceMap,
  resolveScope,
  sourceFileInScope,
  workspaceIdOfSourceFile,
  decodeFolderUri,
  describeScope,
  isEmptyScope,
  type WorkspaceLocation,
} from '../src/scope/index.js';

const tempDirectories: string[] = [];

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeStorage(
  entries: readonly { id: string; folder?: string; workspace?: string; raw?: string }[],
): Promise<string> {
  const root = await tempDirectory('tokenlens-scope-');
  for (const entry of entries) {
    const dir = join(root, entry.id);
    await mkdir(join(dir, 'chatSessions'), { recursive: true });
    if (entry.raw !== undefined) {
      await writeFile(join(dir, 'workspace.json'), entry.raw, 'utf8');
    } else if (entry.folder !== undefined) {
      await writeFile(
        join(dir, 'workspace.json'),
        JSON.stringify({ folder: pathToFileURL(entry.folder).href }),
        'utf8',
      );
    } else if (entry.workspace !== undefined) {
      await writeFile(
        join(dir, 'workspace.json'),
        JSON.stringify({ workspace: entry.workspace }),
        'utf8',
      );
    }
  }
  return root;
}

describe('workspaceIdOfSourceFile', () => {
  it('reads the workspace id off a stored journal path', () => {
    expect(workspaceIdOfSourceFile('abc123/chatSessions/s.jsonl')).toBe('abc123');
  });

  it('refuses to invent one from a path that escaped redaction', () => {
    // `C:/Users/...` is not a workspace id, and treating it as one would
    // conjure a project that does not exist.
    expect(workspaceIdOfSourceFile('C:/Users/me/thing.jsonl')).toBeUndefined();
    expect(workspaceIdOfSourceFile('nofolder.jsonl')).toBeUndefined();
  });
});

describe('isAtOrBeneath', () => {
  it('respects segment boundaries so a sibling is not folded in', () => {
    expect(isAtOrBeneath('/a/project', '/a/project')).toBe(true);
    expect(isAtOrBeneath('/a/project/sub', '/a/project')).toBe(true);
    // The defect a bare `startsWith` would introduce: an unrelated sibling
    // silently counted into the parent's total.
    expect(isAtOrBeneath('/a/project2', '/a/project')).toBe(false);
  });
});

describe('sourceFileInScope', () => {
  it('treats an absent id set as "everything", not as "nothing"', () => {
    expect(sourceFileInScope('w1/chatSessions/a.jsonl', allScope(3))).toBe(true);
    expect(sourceFileInScope('w1/chatSessions/a.jsonl', undefined)).toBe(true);
  });

  it('excludes a workspace outside the selection', () => {
    const scope = {
      mode: 'folder' as const,
      workspaceIds: new Set(['w1']),
      totalWorkspaceCount: 2,
      matchedWorkspaceCount: 1,
    };
    expect(sourceFileInScope('w1/chatSessions/a.jsonl', scope)).toBe(true);
    expect(sourceFileInScope('w2/chatSessions/a.jsonl', scope)).toBe(false);
  });
});

describe('decodeFolderUri', () => {
  it('decodes the shapes VS Code actually writes', () => {
    expect(decodeFolderUri('file:///c%3A/Users/me/proj')).toBe('c:/Users/me/proj');
    expect(decodeFolderUri('file:///home/me/proj/')).toBe('/home/me/proj');
  });
});

describe('readWorkspaceMap + resolveScope', () => {
  it('maps a workspace to its folder and matches the folder and its children', async () => {
    const parent = await tempDirectory('tokenlens-proj-');
    const child = join(parent, 'child');
    await mkdir(child, { recursive: true });

    const roots = [
      await makeStorage([
        { id: 'w-parent', folder: parent },
        { id: 'w-child', folder: child },
      ]),
    ];
    const locations = await readWorkspaceMap(roots);
    expect(locations).toHaveLength(2);

    const folderScope = await resolveScope({ mode: 'folder', at: parent, locations });
    expect(folderScope.matchedWorkspaceCount).toBe(2);

    // `workspace` mode is the exact match only — a nested folder is a
    // different workspace and answering "what did *this* one cost" must not
    // roll its children in.
    const exact = await resolveScope({ mode: 'workspace', at: parent, locations });
    expect(exact.matchedWorkspaceCount).toBe(1);
  });

  it('matches regardless of how the same folder is spelled', async () => {
    const dir = await tempDirectory('tokenlens-case-');
    const roots = [await makeStorage([{ id: 'w1', folder: dir }])];
    const locations = await readWorkspaceMap(roots);

    // The D12 silent-join defect, avoided: separators and case must not fork
    // the key, or a project full of data reports zero.
    for (const spelling of [dir, dir.replace(/\\/g, '/'), dir.toUpperCase()]) {
      const scope = await resolveScope({ mode: 'folder', at: spelling, locations });
      expect(scope.matchedWorkspaceCount).toBe(1);
    }
  });

  it('resolves an unopened folder to zero workspaces and says so', async () => {
    const dir = await tempDirectory('tokenlens-empty-');
    const other = await tempDirectory('tokenlens-other-');
    const roots = [await makeStorage([{ id: 'w1', folder: other }])];
    const locations = await readWorkspaceMap(roots);

    const scope = await resolveScope({ mode: 'folder', at: dir, locations });
    expect(scope.matchedWorkspaceCount).toBe(0);
    // Empty is distinct from "everything" — conflating them is exactly how
    // an empty folder ended up reporting the whole machine.
    expect(isEmptyScope(scope)).toBe(true);
    expect(isEmptyScope(allScope(5))).toBe(false);
    expect(describeScope(scope)).toContain('0 of 1');
  });

  it('classifies what it cannot place, rather than dropping it', async () => {
    const roots = [
      await makeStorage([
        { id: 'w-none' },
        { id: 'w-bad', raw: '{not json' },
        { id: 'w-multi', workspace: 'file:///c%3A/x/team.code-workspace' },
      ]),
    ];
    const locations = await readWorkspaceMap(roots);
    const reasons = locations.map((location) => location.unattributedReason).sort();
    expect(reasons).toEqual([
      'malformed-workspace-json',
      'multi-root-workspace',
      'no-workspace-json',
    ]);
  });
});

describe('buildProjectTree', () => {
  const parent: WorkspaceLocation = {
    workspaceId: 'p',
    canonicalPath: '/a/proj',
    displayPath: '/a/proj',
    label: 'proj',
  };
  const child: WorkspaceLocation = {
    workspaceId: 'c',
    canonicalPath: '/a/proj/sub',
    displayPath: '/a/proj/sub',
    label: 'sub',
  };
  const orphan: WorkspaceLocation = {
    workspaceId: 'o',
    unattributedReason: 'no-workspace-json',
  };

  const stats = [
    { workspaceId: 'p', credits: 100, measuredCredits: 50, requestCount: 10 },
    { workspaceId: 'c', credits: 40, measuredCredits: 0, requestCount: 4 },
    { workspaceId: 'o', credits: 7, measuredCredits: 0, requestCount: 1 },
  ];

  it('reports own and subtree credits separately at every node', () => {
    const tree = buildProjectTree([parent, child, orphan], stats);
    const root = tree.roots[0];

    expect(root?.label).toBe('proj');
    expect(root?.ownCredits).toBe(100);
    expect(root?.subtreeCredits).toBe(140);
    expect(root?.children[0]?.ownCredits).toBe(40);
    expect(root?.children[0]?.subtreeCredits).toBe(40);
  });

  it('keeps unplaceable credits in the total instead of discarding them', () => {
    const tree = buildProjectTree([parent, child, orphan], stats);

    expect(tree.unattributed.credits).toBe(7);
    expect(tree.unattributed.workspaceCount).toBe(1);
    // The reconciliation that makes the whole thing trustworthy: what is
    // shown plus what could not be placed equals what was actually spent.
    expect((tree.roots[0]?.subtreeCredits ?? 0) + tree.unattributed.credits).toBe(
      tree.totalCredits,
    );
  });
});
