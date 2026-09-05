import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathExists } from '../shared/io.js';
import { canonicalisePath } from '../ingest/redact.js';
import { candidateWorkspaceStorageRoots, discoverChatSessionDirs } from '../ingest/discovery.js';
import { logger } from '../shared/logger.js';
import type { WorkspaceLocation } from './types.js';

/**
 * The half of the mapping the database does not hold.
 *
 * `request.source_file` already carries the workspace id on every row, so
 * the ledger has always known *which* workspace a request came from. What
 * it has never known is which **folder** that id refers to. VS Code writes
 * that next to the journal, in `workspaceStorage/<id>/workspace.json`:
 *
 * ```json
 * { "folder": "file:///c%3A/Users/me/Documents/project" }
 * ```
 *
 * ## Why this is read live and never stored
 *
 * An absolute project path begins `C:\Users\<name>`, so it names a person.
 * Migration v3 exists precisely to purge that class of value from the
 * database, and persisting it here would re-import what that migration
 * removed. So the map is rebuilt per run from files already on disk — S4
 * permits read-only access to `workspaceStorage` — and discarded when the
 * process exits. The cost is a few hundred small reads against an ingest
 * that already stats every journal file.
 *
 * It also means a renamed or moved project is picked up on the next run
 * rather than being stale until someone notices.
 */

interface WorkspaceJson {
  readonly folder?: unknown;
  readonly workspace?: unknown;
}

/**
 * Turns the `file:///c%3A/...` URI VS Code writes into a path a person
 * recognises: scheme dropped, percent-decoding applied, separators
 * normalised. **Case is preserved** — this is the display form. Matching
 * uses {@link canonicalisePath} instead, which lower-cases.
 */
export function decodeFolderUri(raw: string): string {
  let path = raw.trim();

  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(path);
  if (scheme) path = path.slice(scheme[0].length);

  if (path.includes('%')) {
    try {
      path = decodeURIComponent(path);
    } catch {
      // A literal `%` that is not an escape. The raw form still reads fine.
    }
  }

  path = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  path = path.replace(/^\/(?=[a-z]:)/i, '');
  // A trailing separator would make the leaf name empty.
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  return path;
}

/** The trailing segment — what a person calls the project. */
export function labelOf(displayPath: string): string {
  const segments = displayPath.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? displayPath;
}

async function locationFor(workspaceId: string, workspaceDir: string): Promise<WorkspaceLocation> {
  const jsonPath = join(workspaceDir, 'workspace.json');

  let raw: string;
  try {
    raw = await readFile(jsonPath, 'utf8');
  } catch {
    return { workspaceId, unattributedReason: 'no-workspace-json' };
  }

  let parsed: WorkspaceJson;
  try {
    parsed = JSON.parse(raw) as WorkspaceJson;
  } catch {
    return { workspaceId, unattributedReason: 'malformed-workspace-json' };
  }

  // A multi-root `.code-workspace` names a *file* listing several folders.
  // Attributing its spend to one of them would be a guess, and splitting it
  // between them would be an invented apportionment, so it is reported as
  // unattributed by name rather than half-counted.
  if (typeof parsed.workspace === 'string') {
    return { workspaceId, unattributedReason: 'multi-root-workspace' };
  }

  if (typeof parsed.folder !== 'string' || parsed.folder.trim() === '') {
    return { workspaceId, unattributedReason: 'empty-window' };
  }

  const displayPath = decodeFolderUri(parsed.folder);
  const base = {
    workspaceId,
    canonicalPath: canonicalisePath(parsed.folder),
    displayPath,
    label: labelOf(displayPath),
  };

  // A folder that no longer exists still holds real, already-spent credits.
  // It is kept and flagged, never dropped — deleting a project does not
  // refund it.
  return (await pathExists(displayPath))
    ? base
    : { ...base, unattributedReason: 'folder-no-longer-present' };
}

/**
 * Every workspace on this machine that has chat history, with the folder
 * it belongs to where that can be determined.
 *
 * `roots` is injectable for the same reason `ingestAllDiscovered` takes it:
 * without an override a test would scan the real `workspaceStorage`.
 */
export async function readWorkspaceMap(
  roots: readonly string[] = candidateWorkspaceStorageRoots(),
): Promise<WorkspaceLocation[]> {
  const discovered = await discoverChatSessionDirs(roots);

  const locations = await Promise.all(
    // `chatSessionsDir` is `<root>/<workspaceId>/chatSessions`; the
    // workspace directory is its parent.
    discovered.map(async ({ workspaceId, chatSessionsDir }) =>
      locationFor(workspaceId, dirname(chatSessionsDir)),
    ),
  );

  logger.debug(
    `scope: ${String(locations.length)} workspace(s) discovered, ` +
      `${String(locations.filter((l) => l.unattributedReason === undefined).length)} placed`,
  );

  return locations;
}
