import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SupportedPlatform = 'win32' | 'darwin' | 'linux' | (string & {});

export interface DiscoveryEnv {
  readonly platform: SupportedPlatform;
  readonly homedir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function defaultDiscoveryEnv(): DiscoveryEnv {
  return { platform: process.platform, homedir: homedir(), env: process.env };
}

/**
 * Candidate roots for VS Code's `workspaceStorage`, across editions
 * (Stable and Insiders) and OSes. Pure and injectable (see
 * {@link DiscoveryEnv}) so every platform's path shape is unit-testable
 * regardless of which OS the test actually runs on.
 */
export function candidateWorkspaceStorageRoots(
  discoveryEnv: DiscoveryEnv = defaultDiscoveryEnv(),
): string[] {
  const { platform, homedir: home, env } = discoveryEnv;

  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return [
      join(appData, 'Code', 'User', 'workspaceStorage'),
      join(appData, 'Code - Insiders', 'User', 'workspaceStorage'),
    ];
  }

  if (platform === 'darwin') {
    const appSupport = join(home, 'Library', 'Application Support');
    return [
      join(appSupport, 'Code', 'User', 'workspaceStorage'),
      join(appSupport, 'Code - Insiders', 'User', 'workspaceStorage'),
    ];
  }

  // Linux and other POSIX platforms: XDG Base Directory spec.
  const configHome = env.XDG_CONFIG_HOME ?? join(home, '.config');
  return [
    join(configHome, 'Code', 'User', 'workspaceStorage'),
    join(configHome, 'Code - Insiders', 'User', 'workspaceStorage'),
  ];
}

export interface DiscoveredWorkspace {
  /** The workspace-storage folder name — an opaque VS Code-assigned hash. */
  readonly workspaceId: string;
  readonly chatSessionsDir: string;
}

/**
 * Scans every candidate root for `<workspaceId>/chatSessions/` directories
 * that actually exist. Missing roots (e.g. Insiders not installed) are
 * skipped silently — that is the expected, common case, not an error.
 */
export async function discoverChatSessionDirs(
  roots: readonly string[] = candidateWorkspaceStorageRoots(),
): Promise<DiscoveredWorkspace[]> {
  const discovered: DiscoveredWorkspace[] = [];

  for (const root of roots) {
    let workspaceIds: string[];
    try {
      workspaceIds = await readdir(root);
    } catch {
      continue; // root does not exist on this machine — expected, not an error
    }

    for (const workspaceId of workspaceIds) {
      const chatSessionsDir = join(root, workspaceId, 'chatSessions');
      try {
        await readdir(chatSessionsDir);
        discovered.push({ workspaceId, chatSessionsDir });
      } catch {
        // no chatSessions subfolder for this workspace — normal, skip
      }
    }
  }

  return discovered;
}
