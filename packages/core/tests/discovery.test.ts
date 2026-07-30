import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  candidateWorkspaceStorageRoots,
  discoverChatSessionDirs,
} from '../src/ingest/discovery.js';

describe('candidateWorkspaceStorageRoots', () => {
  it('builds Windows paths under %APPDATA%', () => {
    const roots = candidateWorkspaceStorageRoots({
      platform: 'win32',
      homedir: 'C:\\Users\\dev',
      env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
    });
    expect(roots).toContain(
      join('C:\\Users\\dev\\AppData\\Roaming', 'Code', 'User', 'workspaceStorage'),
    );
    expect(roots).toContain(
      join('C:\\Users\\dev\\AppData\\Roaming', 'Code - Insiders', 'User', 'workspaceStorage'),
    );
  });

  it('falls back to a default AppData path on Windows when APPDATA is unset', () => {
    const roots = candidateWorkspaceStorageRoots({
      platform: 'win32',
      homedir: 'C:\\Users\\dev',
      env: {},
    });
    expect(roots[0]).toBe(
      join('C:\\Users\\dev', 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
    );
  });

  it('builds macOS paths under Library/Application Support', () => {
    const roots = candidateWorkspaceStorageRoots({
      platform: 'darwin',
      homedir: '/Users/dev',
      env: {},
    });
    expect(roots).toContain(
      join('/Users/dev', 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
    );
  });

  it('builds Linux paths per the XDG base directory spec', () => {
    const roots = candidateWorkspaceStorageRoots({
      platform: 'linux',
      homedir: '/home/dev',
      env: { XDG_CONFIG_HOME: '/home/dev/.config' },
    });
    expect(roots).toContain(join('/home/dev/.config', 'Code', 'User', 'workspaceStorage'));
  });

  it('always returns both Stable and Insiders candidates', () => {
    const roots = candidateWorkspaceStorageRoots({
      platform: 'linux',
      homedir: '/home/dev',
      env: {},
    });
    expect(roots).toHaveLength(2);
  });
});

describe('discoverChatSessionDirs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tokenlens-discovery-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds workspaces that have a chatSessions folder and skips ones that do not', async () => {
    await mkdir(join(dir, 'ws-with-sessions', 'chatSessions'), { recursive: true });
    await mkdir(join(dir, 'ws-without-sessions'), { recursive: true });

    const found = await discoverChatSessionDirs([dir]);

    expect(found).toEqual([
      {
        workspaceId: 'ws-with-sessions',
        chatSessionsDir: join(dir, 'ws-with-sessions', 'chatSessions'),
      },
    ]);
  });

  it('returns an empty array for a root that does not exist, without throwing', async () => {
    const found = await discoverChatSessionDirs([join(dir, 'does-not-exist')]);
    expect(found).toEqual([]);
  });

  it('scans multiple roots', async () => {
    const rootA = join(dir, 'a');
    const rootB = join(dir, 'b');
    await mkdir(join(rootA, 'ws1', 'chatSessions'), { recursive: true });
    await mkdir(join(rootB, 'ws2', 'chatSessions'), { recursive: true });

    const found = await discoverChatSessionDirs([rootA, rootB]);
    expect(found.map((w) => w.workspaceId).sort()).toEqual(['ws1', 'ws2']);
  });
});
