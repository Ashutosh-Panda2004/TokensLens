import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSimulationCorpus } from './fixtures/simulate-corpus.js';
import { parsePolicy } from '../src/simulate/policy.js';
import { resolveSettings } from '../src/policy/keys.js';
import { detectChannel, type ChannelProbe } from '../src/policy/channel.js';
import { emitPolicy } from '../src/policy/emit.js';
import { verifyPolicy } from '../src/policy/verify.js';
import type { ChannelDetection } from '../src/policy/channel.js';

const NOW = new Date('2026-07-15T12:00:00Z');

const FULL_POLICY = `
version: 1
model:
  default: model-cheap
  utility: model-cheap
  route:
    - when: { complexity: low }
      to: model-cheap
tools:
  allow_mcp: [aws]
  deny: [legacy_tool]
  extension_tools: false
  virtual_tools_threshold: 48
payload:
  max_result_tokens: 4000
  compress_terminal_output: true
session:
  max_rounds: 20
  nudge_after_turns: 8
retrieval:
  dedupe_reads: true
  exclude: ["**/dist/**"]
`;

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

async function detection(
  platform: NodeJS.Platform,
  options: { mdm?: Record<string, string>; file?: Record<string, unknown> } = {},
): Promise<ChannelDetection> {
  return detectChannel({ platform, probe: probe(options) });
}

async function emptyWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tokenlens-policy-'));
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

describe('policy key mapping', () => {
  it('routes every DSL line either to a setting or to a stated enforcement mechanism', () => {
    const { settings, deferred } = resolveSettings(parsePolicy(FULL_POLICY).policy);

    expect(settings.map((setting) => setting.key.settingId).sort()).toEqual([
      'chat.agent.maxRequests',
      'chat.defaultModel',
      'chat.extensionTools.enabled',
      'chat.mcp.access',
      'chat.tools.compressOutput.enabled',
      'chat.utilityModel',
      'github.copilot.chat.virtualTools.threshold',
      'search.exclude',
    ]);

    // Nothing the user wrote may vanish between the simulation and the artefact.
    expect(deferred.map((entry) => entry.at).sort()).toEqual([
      'model.route',
      'payload.max_result_tokens',
      'retrieval.dedupe_reads',
      'session.nudge_after_turns',
      'tools.deny',
    ]);
    for (const entry of deferred) expect(entry.enforcedBy).toBeTruthy();
  });

  /**
   * `chat.tools.compressOutput.enabled` is adjacent to a payload cap but is
   * a different mechanism with a different effect. Emitting it as though it
   * were the cap would attribute the cap's measured saving to a control that
   * does not deliver it.
   */
  it('does not substitute output compression for the payload cap', () => {
    const { settings, deferred } = resolveSettings(
      parsePolicy('version: 1\npayload:\n  max_result_tokens: 4000\n').policy,
    );

    expect(settings).toEqual([]);
    expect(deferred[0]?.at).toBe('payload.max_result_tokens');
    expect(deferred[0]?.enforcedBy).toMatch(/D6/);
  });

  it('turns an exclude list into the glob→boolean map the setting actually takes', () => {
    const { settings } = resolveSettings(
      parsePolicy('version: 1\nretrieval:\n  exclude: ["**/dist/**", "**/*.lock"]\n').policy,
    );

    expect(settings[0]?.value).toEqual({ '**/dist/**': true, '**/*.lock': true });
  });

  it('is stable in output order regardless of the order the DSL was written in', () => {
    const a = resolveSettings(
      parsePolicy('version: 1\nsession:\n  max_rounds: 20\nmodel:\n  default: x\n').policy,
    );
    const b = resolveSettings(
      parsePolicy('version: 1\nmodel:\n  default: x\nsession:\n  max_rounds: 20\n').policy,
    );

    expect(a.settings.map((s) => s.key.id)).toEqual(b.settings.map((s) => s.key.id));
  });
});

describe('policy emission', () => {
  it('emits a registry payload with the measured values in it', async () => {
    const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(FULL_POLICY).policy, {
      detection: await detection('win32', { mdm: { ChatDefaultModel: 'model-premium' } }),
      cwd: await emptyWorkspace(),
      now: NOW,
    });

    const reg = contentsOf(emission.artefacts, 'windows/GitHubCopilot.reg');
    expect(reg.startsWith('Windows Registry Editor Version 5.00')).toBe(true);
    expect(reg).toContain('[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\GitHubCopilot]');
    expect(reg).toContain('"ChatDefaultModel"="model-cheap"');
    expect(reg).toContain('"ChatMCP"="registry"');
    // Booleans are REG_DWORD, not the string "false".
    expect(reg).toContain('"ChatAgentExtensionTools"=dword:00000000');
    // The honest limit travels with the payload.
    expect(reg).toMatch(/does not restrict the model menu/);
  });

  /**
   * `reg import` reads a UTF-8 file without a BOM as ANSI, so the
   * typographic characters this project uses in prose arrive mangled — in a
   * file whose entire purpose is to be pasted into a production MDM policy.
   */
  it('keeps the registry payload pure ASCII', async () => {
    const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(FULL_POLICY).policy, {
      detection: await detection('win32', { mdm: {} }),
      cwd: await emptyWorkspace(),
      now: NOW,
    });

    for (const path of ['windows/GitHubCopilot.reg', 'windows/GitHubCopilot.rollback.reg']) {
      const contents = contentsOf(emission.artefacts, path);
      // eslint-disable-next-line no-control-regex
      expect(contents).not.toMatch(/[^\x00-\x7f]/);
      expect(contents).toContain('\r\n');
      // Every comment line is its own line: transliterating before splitting
      // would strip the newline and weld two of them together.
      for (const line of contents.split('\r\n')) expect(line.length).toBeLessThan(400);
    }
  });

  it('escapes registry values rather than trusting the policy file', async () => {
    const emission = await emitPolicy(
      buildSimulationCorpus(),
      parsePolicy("version: 1\nmodel:\n  default: 'a\"b\\c'\n").policy,
      {
        detection: await detection('win32', { mdm: {} }),
        cwd: await emptyWorkspace(),
        now: NOW,
      },
    );

    expect(contentsOf(emission.artefacts, 'windows/GitHubCopilot.reg')).toContain(
      '"ChatDefaultModel"="a\\"b\\\\c"',
    );
  });

  it('emits a macOS profile that is byte-identical across runs', async () => {
    const stable = (): string => '00000000-0000-4000-8000-000000000000';
    const emit = async (): Promise<string> => {
      const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(FULL_POLICY).policy, {
        detection: await detection('darwin', { mdm: {} }),
        cwd: await emptyWorkspace(),
        uuid: stable,
        now: NOW,
      });
      return contentsOf(emission.artefacts, 'macos/GitHubCopilot.mobileconfig');
    };

    const first = await emit();
    expect(first).toBe(await emit());
    expect(first).toContain('<key>ChatDefaultModel</key>');
    expect(first).toContain('<string>model-cheap</string>');
    expect(first).toContain('<key>ChatAgentExtensionTools</key>');
    expect(first).toContain('<false/>');
  });

  it('emits identical artefacts when run twice on unchanged input', async () => {
    const cwd = await emptyWorkspace();
    const run = async (): Promise<string> => {
      const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(FULL_POLICY).policy, {
        detection: await detection('win32', { mdm: {} }),
        cwd,
        uuid: () => '00000000-0000-4000-8000-000000000000',
        now: NOW,
      });
      return JSON.stringify(emission.artefacts);
    };

    expect(await run()).toBe(await run());
  });

  it('reports a policy already in effect as changing nothing', async () => {
    const emission = await emitPolicy(
      buildSimulationCorpus(),
      parsePolicy('version: 1\nmodel:\n  default: model-cheap\n').policy,
      {
        detection: await detection('win32', { mdm: { ChatDefaultModel: 'model-cheap' } }),
        cwd: await emptyWorkspace(),
        now: NOW,
      },
    );

    expect(emission.lines).toHaveLength(1);
    expect(emission.lines[0]?.current).toBe('model-cheap');
    expect(emission.lines[0]?.changes).toBe(false);
  });

  it('attaches the simulated credit band to the lines a lever delivers', async () => {
    const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(FULL_POLICY).policy, {
      detection: await detection('win32', { mdm: {} }),
      cwd: await emptyWorkspace(),
      now: NOW,
    });

    const routed = emission.lines.find((line) => line.settingId === 'chat.defaultModel');
    expect(routed?.credits?.low).toBeGreaterThan(0);
    expect(routed?.credits?.high).toBeGreaterThan(routed?.credits?.low ?? 0);

    // A setting no lever measures says so, and never reports zero.
    const compress = emission.lines.find(
      (line) => line.settingId === 'chat.tools.compressOutput.enabled',
    );
    expect(compress?.credits).toBeUndefined();
    expect(compress?.unpricedReason).toMatch(/No simulable lever/);
  });

  it('says where a measured saving goes when no setting can carry it', async () => {
    const emission = await emitPolicy(
      buildSimulationCorpus(),
      parsePolicy('version: 1\nretrieval:\n  dedupe_reads: true\n').policy,
      {
        detection: await detection('win32', { mdm: {} }),
        cwd: await emptyWorkspace(),
        now: NOW,
      },
    );

    const carried = emission.carriedElsewhere.find((entry) => entry.lever === 'dedupe-reads');
    expect(carried?.credits.low).toBeGreaterThan(0);
    expect(carried?.carriedBy).toMatch(/D6/);
  });
});

describe('rollback', () => {
  it('gives every applied surface an inverse', async () => {
    const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(FULL_POLICY).policy, {
      detection: await detection('win32', { mdm: {} }),
      cwd: await emptyWorkspace(),
      now: NOW,
    });

    expect(emission.artefacts.some((a) => a.path === 'windows/GitHubCopilot.rollback.reg')).toBe(
      true,
    );
    expect(emission.artefacts.some((a) => a.path === 'workspace/rollback.md')).toBe(true);
    expect(emission.artefacts.filter((a) => a.role === 'rollback').length).toBeGreaterThan(0);
  });

  /**
   * A value that was never set is removed on rollback, not written back as
   * a guessed default — that would leave the machine in a state it was
   * never in.
   */
  it('removes a value that was unset, and restores one that was set', async () => {
    const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(FULL_POLICY).policy, {
      detection: await detection('win32', { mdm: { ChatDefaultModel: 'model-premium' } }),
      cwd: await emptyWorkspace(),
      now: NOW,
    });

    const rollback = contentsOf(emission.artefacts, 'windows/GitHubCopilot.rollback.reg');
    expect(rollback).toContain('"ChatDefaultModel"="model-premium"  ; restored');
    expect(rollback).toContain('"ChatMCP"=-  ; was not set before');
  });

  it('preserves the exact prior document rather than reconstructing it', async () => {
    const cwd = await emptyWorkspace();
    await mkdir(join(cwd, '.vscode'), { recursive: true });
    await writeFile(
      join(cwd, '.vscode', 'settings.json'),
      JSON.stringify({ 'editor.fontSize': 13, 'search.exclude': { '**/vendor/**': true } }),
    );

    const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(FULL_POLICY).policy, {
      detection: await detection('win32', { mdm: {} }),
      cwd,
      now: NOW,
    });

    const rollback = JSON.parse(
      contentsOf(emission.artefacts, 'workspace/settings.rollback.json'),
    ) as Record<string, unknown>;
    expect(rollback).toEqual({ 'editor.fontSize': 13, 'search.exclude': { '**/vendor/**': true } });

    // And the applied version merges rather than clobbering.
    const applied = JSON.parse(contentsOf(emission.artefacts, 'workspace/settings.json')) as Record<
      string,
      unknown
    >;
    expect(applied['editor.fontSize']).toBe(13);
    expect(applied['search.exclude']).toEqual({ '**/vendor/**': true, '**/dist/**': true });
  });

  /**
   * VS Code settings files are JSON *with comments*, which `JSON.parse`
   * rejects. Treating that as "absent" would generate a rollback saying
   * "delete the file" — destroying a hand-written configuration whose only
   * crime was containing a comment.
   */
  it('refuses a surface whose existing file cannot be parsed, rather than assuming it is absent', async () => {
    const cwd = await emptyWorkspace();
    await mkdir(join(cwd, '.vscode'), { recursive: true });
    await writeFile(
      join(cwd, '.vscode', 'settings.json'),
      '{\n  // a comment, which VS Code allows\n  "editor.fontSize": 13\n}',
    );

    const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(FULL_POLICY).policy, {
      detection: await detection('win32', { mdm: {} }),
      cwd,
      now: NOW,
    });

    expect(emission.artefacts.some((a) => a.path.startsWith('workspace/'))).toBe(false);
    expect(emission.skipped.join(' ')).toMatch(/settings\.json/);
    expect(emission.skipped.join(' ')).toMatch(/comments/);
  });
});

describe('generated agents', () => {
  it('derives agents from observed clusters and pins the routed model', async () => {
    const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(FULL_POLICY).policy, {
      detection: await detection('win32', { mdm: {} }),
      cwd: await emptyWorkspace(),
      now: NOW,
    });

    expect(emission.agents.agents.length).toBeGreaterThan(0);
    for (const agent of emission.agents.agents) {
      expect(agent.tools.length).toBeGreaterThan(0);
      expect(agent.basis).toBeTruthy();
    }

    const retrieval = emission.agents.agents.find((agent) => agent.name === 'retrieval');
    expect(retrieval?.model).toBe('model-cheap');

    const file = contentsOf(emission.artefacts, 'agents/retrieval.agent.md');
    expect(file.startsWith('---\n')).toBe(true);
    expect(file).toContain('model: model-cheap');
    // The file states its own epistemic status.
    expect(file).toMatch(/describes what happened, not what should happen/);
  });

  it('declines to invent handoffs, and says why', async () => {
    const emission = await emitPolicy(buildSimulationCorpus(), parsePolicy(FULL_POLICY).policy, {
      detection: await detection('win32', { mdm: {} }),
      cwd: await emptyWorkspace(),
      now: NOW,
    });

    expect(emission.agents.caveats.join(' ')).toMatch(/handoffs/);
    expect(emission.agents.caveats.join(' ')).toMatch(/invention/);
  });
});

describe('policy verification', () => {
  it('confirms a setting that is in effect', async () => {
    const verification = await verifyPolicy(
      parsePolicy('version: 1\nmodel:\n  default: model-cheap\n').policy,
      { detection: await detection('win32', { mdm: { ChatDefaultModel: 'model-cheap' } }) },
    );

    expect(verification.ok).toBe(true);
    expect(verification.lines[0]?.status).toBe('applied');
  });

  it('reports a value that deployed to a channel but did not take', async () => {
    const verification = await verifyPolicy(
      parsePolicy('version: 1\nmodel:\n  default: model-cheap\n').policy,
      { detection: await detection('win32', { mdm: { ChatDefaultModel: 'model-premium' } }) },
    );

    expect(verification.ok).toBe(false);
    expect(verification.lines[0]?.status).toBe('differs');
    expect(verification.lines[0]?.detail).toMatch(/model-premium/);
  });

  /**
   * On a machine governed by server-managed settings this command can
   * honestly confirm almost nothing, and `unverifiable` must never be
   * folded into a pass. A green tick meaning "found no evidence either way"
   * is worse than no command at all.
   */
  it('never counts an unverifiable line as a pass', async () => {
    const verification = await verifyPolicy(
      parsePolicy('version: 1\nmodel:\n  default: model-cheap\n').policy,
      { detection: await detection('win32', {}) },
    );

    expect(verification.lines[0]?.status).toBe('unverifiable');
    expect(verification.unverifiable).toBe(1);
    expect(verification.ok).toBe(false);
  });
});
