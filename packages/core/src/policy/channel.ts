import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { PolicyChannelError } from '../shared/errors.js';

const run = promisify(execFile);

/**
 * The three channels through which Copilot Managed Settings are delivered
 * (PLAN.md §18.1), in **precedence order, highest first**.
 *
 * Precedence is winner-take-all, not merged (enforced from VS Code 1.128).
 * If the org delivers *any* setting by native MDM, a `managed-settings.json`
 * written to disk is silently ignored — no error, no warning, nothing
 * happens. That is the single most likely way for this whole product to
 * fail: the payload is correct, the deployment succeeds, and the numbers do
 * not move.
 */
export const CHANNEL_PRECEDENCE = ['native-mdm', 'server-managed', 'file-based'] as const;

export type ManagedChannel = (typeof CHANNEL_PRECEDENCE)[number];

export type ChannelStatus =
  | 'present'
  /** Checked, and definitively not in use. */
  | 'absent'
  /** Cannot be determined from this machine. Not the same as absent. */
  | 'unobservable';

/**
 * What was at a target path before, and how confidently we know it.
 *
 * The `unreadable` case is load-bearing rather than defensive. A settings
 * file that exists but does not parse is emphatically **not** absent: if
 * that distinction were lost, the generated rollback would say "delete the
 * file", destroying a hand-written configuration whose only crime was a
 * comment. Emission is refused for that surface instead.
 */
export type PriorDocument =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly document: Record<string, unknown> }
  | { readonly state: 'unreadable'; readonly reason: string };

export interface ChannelEvidence {
  readonly channel: ManagedChannel;
  readonly status: ChannelStatus;
  /** The exact location that was checked, so the answer is verifiable. */
  readonly where: string;
  readonly detail: string;
  /** Settings found there, when the channel is both present and readable. */
  readonly values?: Readonly<Record<string, unknown>>;
  /**
   * For the file-based channel, the document exactly as it was found — the
   * input to both the diff and the rollback, read once so the two cannot
   * disagree about what was there.
   */
  readonly prior?: PriorDocument;
}

export interface ChannelDetection {
  readonly platform: NodeJS.Platform;
  readonly evidence: readonly ChannelEvidence[];
  /** The highest-precedence channel observed to be present. */
  readonly active: ManagedChannel | undefined;
  /**
   * True when a channel that would outrank `active` could not be ruled out.
   * A verdict of "file-based wins" is always conditional on this, because
   * server-managed settings leave no local artefact.
   */
  readonly uncertain: boolean;
  readonly caveat: string;
}

/**
 * The probes detection depends on, isolated so the precedence logic can be
 * tested on every platform from any platform. Shelling out to `reg` on a
 * Linux CI box is not a test of anything.
 */
export interface ChannelProbe {
  readNativeMdm(platform: NodeJS.Platform): Promise<Record<string, string> | undefined>;
  readFileBased(path: string): Promise<PriorDocument>;
}

/** Where the file-based channel lives on each platform (PLAN.md §18.1). */
export function fileBasedPath(platform: NodeJS.Platform, env = process.env): string {
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
    return `${programFiles}\\GitHubCopilot\\managed-settings.json`;
  }
  if (platform === 'darwin') {
    return '/Library/Application Support/GitHubCopilot/managed-settings.json';
  }
  return '/etc/github-copilot/managed-settings.json';
}

const WINDOWS_POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\GitHubCopilot';
const MACOS_POLICY_DOMAIN = 'com.github.copilot';
const PROBE_TIMEOUT_MS = 5_000;

export const defaultChannelProbe: ChannelProbe = {
  async readNativeMdm(platform) {
    try {
      if (platform === 'win32') {
        // execFile with an argv array, never a shell string: the arguments
        // here are constants today, and a shell would make that a property
        // of this call site rather than of the API.
        const { stdout } = await run('reg', ['query', WINDOWS_POLICY_KEY, '/s'], {
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
        });
        return parseRegQuery(stdout);
      }
      if (platform === 'darwin') {
        const { stdout } = await run('defaults', ['read', MACOS_POLICY_DOMAIN], {
          timeout: PROBE_TIMEOUT_MS,
        });
        return parseDefaultsRead(stdout);
      }
      return undefined;
    } catch {
      // A non-zero exit means the key or domain does not exist, which is
      // the answer rather than a failure.
      return undefined;
    }
  },

  async readFileBased(path) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return { state: 'absent' };
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? { state: 'present', document: parsed as Record<string, unknown> }
        : { state: 'unreadable', reason: 'the file is valid JSON but not an object.' };
    } catch (error) {
      return {
        state: 'unreadable',
        reason:
          `it exists but is not strict JSON (${error instanceof Error ? error.message : String(error)}). ` +
          'VS Code accepts comments and trailing commas in settings files; this tool will not guess at rewriting them.',
      };
    }
  },
};

export interface DetectChannelOptions {
  readonly platform?: NodeJS.Platform;
  readonly probe?: ChannelProbe;
  readonly env?: NodeJS.ProcessEnv;
}

export async function detectChannel(options: DetectChannelOptions = {}): Promise<ChannelDetection> {
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? defaultChannelProbe;

  const mdmValues = await probe.readNativeMdm(platform);
  const filePath = fileBasedPath(platform, options.env ?? process.env);
  const filePrior = await probe.readFileBased(filePath);

  const evidence: ChannelEvidence[] = [
    {
      channel: 'native-mdm',
      status: mdmValues === undefined ? 'absent' : 'present',
      where:
        platform === 'win32'
          ? WINDOWS_POLICY_KEY
          : platform === 'darwin'
            ? `defaults domain ${MACOS_POLICY_DOMAIN}`
            : 'not applicable on this platform',
      detail:
        platform === 'win32' || platform === 'darwin'
          ? mdmValues === undefined
            ? 'No Copilot policy is delivered by MDM on this machine.'
            : `${String(Object.keys(mdmValues).length)} policy value(s) delivered by MDM.`
          : 'Native MDM delivery of Copilot policy is a Windows and macOS mechanism.',
      ...(mdmValues !== undefined ? { values: mdmValues } : {}),
    },
    {
      channel: 'server-managed',
      // The load-bearing admission of this whole command.
      status: 'unobservable',
      where: 'resolved by VS Code from the signed-in GitHub account',
      detail:
        'Server-managed settings are delivered to the client at run time and leave no artefact on disk, ' +
        'so no local check can confirm or rule them out. Run `Developer: Policy Diagnostics` in VS Code ' +
        'to see what is actually in effect, or deploy and then run `tokenlens policy verify`.',
    },
    {
      channel: 'file-based',
      // A file that exists but does not parse still means the channel is in
      // use; it is the *values* that are unknown, not the channel.
      status: filePrior.state === 'absent' ? 'absent' : 'present',
      where: filePath,
      detail:
        filePrior.state === 'absent'
          ? 'No managed-settings.json at the platform path.'
          : filePrior.state === 'unreadable'
            ? `A managed-settings.json is present but could not be read: ${filePrior.reason}`
            : `${String(Object.keys(filePrior.document).length)} setting(s) present.`,
      prior: filePrior,
      ...(filePrior.state === 'present' ? { values: filePrior.document } : {}),
    },
  ];

  const active = CHANNEL_PRECEDENCE.find(
    (channel) => evidence.find((item) => item.channel === channel)?.status === 'present',
  );

  // Anything that would outrank the observed winner and could not be checked
  // makes the verdict conditional.
  const uncertain = evidence.some(
    (item) =>
      item.status === 'unobservable' && (active === undefined || rank(item.channel) < rank(active)),
  );

  return {
    platform,
    evidence,
    active,
    uncertain,
    caveat: uncertain
      ? 'Server-managed settings outrank the file-based channel and cannot be observed locally. ' +
        'If your organisation delivers Copilot policy through the GitHub account, anything written to ' +
        'disk here is silently ignored — confirm with `Developer: Policy Diagnostics` before deploying.'
      : 'The active channel was determined directly; no higher-precedence channel is unaccounted for.',
  };
}

/**
 * Refuses to emit to a channel that a higher-precedence one would override.
 *
 * Throwing is the point. Writing a correct payload to a losing channel
 * produces a deployment that appears to succeed and changes nothing, and
 * that failure is indistinguishable from "the analysis was wrong" — which
 * is how a tool like this loses an organisation's trust permanently.
 */
export function assertChannelWritable(detection: ChannelDetection, target: ManagedChannel): void {
  if (detection.active === undefined) return;
  if (rank(detection.active) >= rank(target)) return;

  throw new PolicyChannelError(
    `Refusing to emit to the ${target} channel: ${detection.active} is active on this machine and ` +
      'takes precedence. Managed Settings precedence is winner-take-all, not merged, so the payload ' +
      `would be written successfully and then silently ignored. Emit to ${detection.active} instead.`,
    { targetChannel: target, activeChannel: detection.active },
  );
}

function rank(channel: ManagedChannel): number {
  return CHANNEL_PRECEDENCE.indexOf(channel);
}

/**
 * Parses `reg query <key> /s` output. Value lines are indented and
 * separated by runs of whitespace: `    Name    REG_SZ    data`.
 */
export function parseRegQuery(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s{4,}(\S.*?)\s{4,}REG_\w+\s{4,}(.*)$/.exec(line);
    if (match?.[1] !== undefined) values[match[1]] = match[2] ?? '';
  }
  return values;
}

/**
 * Parses `defaults read <domain>` output, which is an old-style plist
 * dictionary rather than JSON. Only scalar values matter here — a Copilot
 * policy value is a string, a number or a boolean — so nested structures
 * are recorded as present without being decomposed.
 */
export function parseDefaultsRead(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s*=\s*(.*?);?\s*$/.exec(line);
    if (match?.[1] === undefined) continue;
    const raw = match[2] ?? '';
    values[match[1]] = raw.replace(/^"(.*)"$/, '$1');
  }
  return values;
}
