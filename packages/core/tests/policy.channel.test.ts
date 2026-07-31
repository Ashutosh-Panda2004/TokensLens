import { describe, it, expect } from 'vitest';
import {
  CHANNEL_PRECEDENCE,
  assertChannelWritable,
  detectChannel,
  fileBasedPath,
  parseDefaultsRead,
  parseRegQuery,
  type ChannelProbe,
} from '../src/policy/channel.js';
import { PolicyChannelError } from '../src/shared/errors.js';

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

/**
 * PLAN.md §18.1 calls this "the single most likely cause of a 'we deployed
 * it and nothing happened' failure", and it is: precedence is winner-take-all,
 * so a correct payload written to a losing channel deploys cleanly, reports
 * success and changes nothing. There is no error anywhere in that sequence.
 */
describe('managed-settings channel precedence', () => {
  it('orders the channels highest-precedence first', () => {
    expect(CHANNEL_PRECEDENCE).toEqual(['native-mdm', 'server-managed', 'file-based']);
  });

  it('picks the highest-precedence channel that is present', async () => {
    const detection = await detectChannel({
      platform: 'win32',
      probe: probe({ mdm: { ChatDefaultModel: 'haiku' }, file: { ChatMCP: 'none' } }),
    });

    expect(detection.active).toBe('native-mdm');
  });

  it('refuses to emit to a channel a higher one would override', async () => {
    const detection = await detectChannel({
      platform: 'win32',
      probe: probe({ mdm: { ChatDefaultModel: 'haiku' } }),
    });

    let thrown: unknown;
    try {
      assertChannelWritable(detection, 'file-based');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PolicyChannelError);
    const error = thrown as PolicyChannelError;
    expect(error.code).toBe('POLICY_CHANNEL');
    expect(error.context).toEqual({ targetChannel: 'file-based', activeChannel: 'native-mdm' });
    expect(error.message).toMatch(/silently ignored/);
  });

  it('allows emitting to the active channel, and to one that outranks it', async () => {
    const detection = await detectChannel({
      platform: 'win32',
      probe: probe({ file: { ChatMCP: 'none' } }),
    });

    expect(detection.active).toBe('file-based');
    expect(() => {
      assertChannelWritable(detection, 'file-based');
    }).not.toThrow();
    expect(() => {
      assertChannelWritable(detection, 'native-mdm');
    }).not.toThrow();
  });

  it('allows any channel when nothing is active', async () => {
    const detection = await detectChannel({ platform: 'linux', probe: probe({}) });

    expect(detection.active).toBeUndefined();
    for (const channel of CHANNEL_PRECEDENCE) {
      expect(() => {
        assertChannelWritable(detection, channel);
      }).not.toThrow();
    }
  });

  /**
   * The load-bearing admission. Server-managed settings are resolved by
   * VS Code from the signed-in account and leave nothing on disk, so a
   * verdict of "file-based wins" is always conditional. Reporting it as
   * `absent` would be a confident wrong answer.
   */
  it('reports server-managed as unobservable, never as absent', async () => {
    const detection = await detectChannel({ platform: 'win32', probe: probe({}) });
    const server = detection.evidence.find((item) => item.channel === 'server-managed');

    expect(server?.status).toBe('unobservable');
    expect(detection.uncertain).toBe(true);
    expect(detection.caveat).toMatch(/silently ignored/);
    expect(server?.detail).toMatch(/Policy Diagnostics/);
  });

  it('stops calling the verdict uncertain once a channel outranks the unobservable one', async () => {
    const detection = await detectChannel({
      platform: 'darwin',
      probe: probe({ mdm: { ChatDefaultModel: 'haiku' } }),
    });

    expect(detection.active).toBe('native-mdm');
    expect(detection.uncertain).toBe(false);
  });

  it('knows where the file-based channel lives on each platform', () => {
    expect(fileBasedPath('win32', { ProgramFiles: 'C:\\Program Files' })).toBe(
      'C:\\Program Files\\GitHubCopilot\\managed-settings.json',
    );
    expect(fileBasedPath('darwin', {})).toMatch(/^\/Library\/Application Support\//);
    expect(fileBasedPath('linux', {})).toMatch(/^\/etc\//);
  });

  it('surfaces the values it found, so the diff can use them', async () => {
    const detection = await detectChannel({
      platform: 'win32',
      probe: probe({ mdm: { ChatDefaultModel: 'haiku', ChatMCP: 'registry' } }),
    });

    expect(detection.evidence.find((item) => item.channel === 'native-mdm')?.values).toEqual({
      ChatDefaultModel: 'haiku',
      ChatMCP: 'registry',
    });
  });
});

describe('probe output parsing', () => {
  it('reads values out of `reg query /s` output', () => {
    const stdout = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\GitHubCopilot',
      '    ChatDefaultModel    REG_SZ    gpt-4.1-mini',
      '    ChatAgentExtensionTools    REG_DWORD    0x0',
      '',
    ].join('\r\n');

    expect(parseRegQuery(stdout)).toEqual({
      ChatDefaultModel: 'gpt-4.1-mini',
      ChatAgentExtensionTools: '0x0',
    });
  });

  it('ignores the key header line, which is not a value', () => {
    expect(parseRegQuery('HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\GitHubCopilot\r\n')).toEqual({});
  });

  it('reads scalars out of `defaults read` plist output', () => {
    const stdout = [
      '{',
      '    ChatDefaultModel = "gpt-4.1-mini";',
      '    ChatMCP = registry;',
      '}',
    ].join('\n');

    expect(parseDefaultsRead(stdout)).toMatchObject({
      ChatDefaultModel: 'gpt-4.1-mini',
      ChatMCP: 'registry',
    });
  });
});
