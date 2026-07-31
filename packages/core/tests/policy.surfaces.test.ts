import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSimulationCorpus, record } from './fixtures/simulate-corpus.js';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { buildDetectContext } from '../src/waste/context.js';
import { parsePolicy } from '../src/simulate/policy.js';
import { detectChannel, defaultChannelProbe, type ChannelProbe } from '../src/policy/channel.js';
import { emitPolicy } from '../src/policy/emit.js';
import { verifyPolicy } from '../src/policy/verify.js';
import { deriveAgents } from '../src/policy/agents.js';

const NOW = new Date('2026-07-15T12:00:00Z');

function probe(options: {
  mdm?: Record<string, string>;
  file?: Record<string, unknown>;
}): ChannelProbe {
  return {
    readNativeMdm: () => Promise.resolve(options.mdm),
    readFileBased: () =>
      Promise.resolve(
        options.file === undefined
          ? ({ state: 'absent' } as const)
          : ({ state: 'present', document: options.file } as const),
      ),
  };
}

async function workspace(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-surfaces-'));
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(dir, relative);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents);
  }
  return dir;
}

function contentsOf(
  artefacts: readonly { path: string; contents: string }[],
  path: string,
): string {
  const found = artefacts.find((artefact) => artefact.path === path);
  if (!found)
    throw new Error(`no artefact at ${path} — got ${artefacts.map((a) => a.path).join(', ')}`);
  return found.contents;
}

const MANAGED_POLICY =
  'version: 1\nmodel:\n  default: model-cheap\ntools:\n  extension_tools: false\n';

describe('file-based channel emission', () => {
  it('merges over the document already at the platform path, and keeps the original as rollback', async () => {
    const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(MANAGED_POLICY).policy, {
      detection: await detectChannel({
        platform: 'linux',
        probe: probe({ file: { ChatMCP: 'none', ChatDefaultModel: 'model-premium' } }),
      }),
      cwd: await workspace(),
      now: NOW,
    });

    expect(emission.channel).toBe('file-based');

    const applied = JSON.parse(
      contentsOf(emission.artefacts, 'file-based/managed-settings.json'),
    ) as Record<string, unknown>;
    // The setting we own is replaced; one we do not own is left alone.
    expect(applied.ChatDefaultModel).toBe('model-cheap');
    expect(applied.ChatMCP).toBe('none');

    const rollback = JSON.parse(
      contentsOf(emission.artefacts, 'file-based/managed-settings.rollback.json'),
    ) as Record<string, unknown>;
    expect(rollback).toEqual({ ChatMCP: 'none', ChatDefaultModel: 'model-premium' });
  });

  it('says to delete the file when there was none, rather than writing an empty one back', async () => {
    const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(MANAGED_POLICY).policy, {
      detection: await detectChannel({ platform: 'linux', probe: probe({}) }),
      channel: 'file-based',
      cwd: await workspace(),
      now: NOW,
    });

    expect(contentsOf(emission.artefacts, 'file-based/rollback.md')).toMatch(/delete the file/);
  });

  it('does not emit a registry payload for a channel it was not asked for', async () => {
    const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(MANAGED_POLICY).policy, {
      detection: await detectChannel({ platform: 'linux', probe: probe({}) }),
      channel: 'file-based',
      cwd: await workspace(),
      now: NOW,
    });

    expect(emission.artefacts.some((a) => a.path.startsWith('windows/'))).toBe(false);
    expect(emission.artefacts.some((a) => a.path.startsWith('macos/'))).toBe(false);
  });
});

describe('workspace-surface verification', () => {
  const policy = 'version: 1\nsession:\n  max_rounds: 25\n';

  it('confirms a workspace setting that is in effect', async () => {
    const cwd = await workspace({
      '.vscode/settings.json': JSON.stringify({ 'chat.agent.maxRequests': 25 }),
    });

    const verification = await verifyPolicy(parsePolicy(policy).policy, {
      detection: await detectChannel({ platform: 'linux', probe: probe({}) }),
      cwd,
    });

    expect(verification.lines[0]?.status).toBe('applied');
    expect(verification.ok).toBe(true);
  });

  it('reports a workspace setting that holds a different value', async () => {
    const cwd = await workspace({
      '.vscode/settings.json': JSON.stringify({ 'chat.agent.maxRequests': 100 }),
    });

    const verification = await verifyPolicy(parsePolicy(policy).policy, {
      detection: await detectChannel({ platform: 'linux', probe: probe({}) }),
      cwd,
    });

    expect(verification.lines[0]?.status).toBe('differs');
    expect(verification.lines[0]?.detail).toMatch(/100/);
  });

  it('reports a workspace setting that is simply absent', async () => {
    const cwd = await workspace({
      '.vscode/settings.json': JSON.stringify({ 'editor.fontSize': 13 }),
    });

    const verification = await verifyPolicy(parsePolicy(policy).policy, {
      detection: await detectChannel({ platform: 'linux', probe: probe({}) }),
      cwd,
    });

    expect(verification.lines[0]?.status).toBe('missing');
  });

  it('reports a policy with nothing deployable as having nothing to verify', async () => {
    const verification = await verifyPolicy(
      parsePolicy('version: 1\nretrieval:\n  dedupe_reads: true\n').policy,
      {
        detection: await detectChannel({ platform: 'linux', probe: probe({}) }),
        cwd: await workspace(),
      },
    );

    expect(verification.lines).toEqual([]);
    // Zero checks passing is not a pass.
    expect(verification.ok).toBe(false);
  });
});

describe('agent derivation limits', () => {
  it('declines to generate a retrieval agent when no model has a measured rate', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(
      db,
      Array.from({ length: 15 }, (_, i) =>
        record({
          requestId: `r${String(i)}`,
          ts: i,
          sessionId: `s${String(i)}`,
          rounds: [
            {
              id: `round${String(i)}`,
              ts: i,
              retries: 0,
              toolCalls: [{ id: `c${String(i)}`, name: 'read_file', resultChars: 100 }],
            },
          ],
        }),
      ),
    );

    const result = deriveAgents(buildDetectContext(db), { version: 1 });

    expect(result.agents.some((agent) => agent.name === 'retrieval')).toBe(false);
    expect(result.caveats.join(' ')).toMatch(/no model in this corpus has a measured rate/);
  });

  it('declines to cluster below the sample floor, and says why', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({
        requestId: 'lonely',
        ts: 1,
        credits: 5,
        rounds: [
          {
            id: 'r',
            ts: 1,
            retries: 0,
            toolCalls: [{ id: 'c', name: 'read_file', resultChars: 10 }],
          },
        ],
      }),
    ]);

    const result = deriveAgents(buildDetectContext(db), { version: 1 });

    expect(result.agents.filter((agent) => agent.name.endsWith('-tasks'))).toEqual([]);
    expect(result.coverage).toBe(0);
    expect(result.caveats.join(' ')).toMatch(/coincidence rather than a workflow/);
  });
});

describe('default channel probe', () => {
  it('reads a managed-settings.json that is really on disk', async () => {
    const dir = await workspace({
      'managed-settings.json': JSON.stringify({ ChatMCP: 'registry' }),
    });

    expect(await defaultChannelProbe.readFileBased(join(dir, 'managed-settings.json'))).toEqual({
      state: 'present',
      document: { ChatMCP: 'registry' },
    });
  });

  /**
   * A file that exists but does not parse is emphatically not absent. If
   * the two were folded together, the generated rollback would say "delete
   * the file" for a configuration that was merely unparseable.
   */
  it('distinguishes a missing file from one it could not read', async () => {
    const dir = await workspace({ 'broken.json': '{ not json' });

    expect(await defaultChannelProbe.readFileBased(join(dir, 'nope.json'))).toEqual({
      state: 'absent',
    });

    const broken = await defaultChannelProbe.readFileBased(join(dir, 'broken.json'));
    expect(broken.state).toBe('unreadable');
    expect(broken.state === 'unreadable' && broken.reason).toMatch(/comments/);
  });

  it('has no native-MDM channel to read on Linux', async () => {
    expect(await defaultChannelProbe.readNativeMdm('linux')).toBeUndefined();
  });

  /**
   * Exercises the real `reg`/`defaults` path on whichever platform CI runs.
   * A non-zero exit means the key does not exist, which is an answer rather
   * than a failure — the assertion is that it never escapes as one.
   */
  it('never throws when probing the current platform', async () => {
    await expect(defaultChannelProbe.readNativeMdm(process.platform)).resolves.not.toThrow();
  });
});
