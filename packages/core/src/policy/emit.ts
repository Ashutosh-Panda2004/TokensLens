import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { buildDetectContext } from '../waste/context.js';
import { buildSimulation } from '../simulate/report.js';
import { formatCredits } from '../waste/format.js';
import {
  assertChannelWritable,
  detectChannel,
  type ChannelDetection,
  type ManagedChannel,
  type PriorDocument,
} from './channel.js';
import { resolveSettings, type DeferredKey, type ResolvedSetting } from './keys.js';
import { emitAgents, deriveAgents, type DeriveAgentsResult } from './agents.js';
import {
  emitManagedJson,
  emitMacosProfile,
  emitWindowsRegistry,
  emitWorkspaceSettings,
  type Artefact,
} from './artefacts.js';
import type { Policy } from '../simulate/policy.js';
import type { SavingBand } from '../simulate/replay.js';
import type { LeverId } from '../simulate/levers.js';

/**
 * One emitted policy line, next to what it replaces and what it is worth.
 *
 * The credit figure is the whole point of `--dry-run`: a settings payload
 * with no numbers beside it is a change request, and a platform team is
 * right to deprioritise it. With the numbers it is a business case.
 */
export interface PolicyLine {
  readonly settingId: string;
  readonly managedName: string | undefined;
  readonly surface: ResolvedSetting['key']['surface'];
  readonly automation: string;
  readonly attacks: string;
  readonly from: string;
  readonly desired: string;
  /** What is in effect now, where that is readable. `undefined` means unset. */
  readonly current: string | undefined;
  readonly changes: boolean;
  /**
   * Credits this line delivers, from the D4 replay. `undefined` means the
   * lever behind it could not be priced — reported as such, never as zero.
   */
  readonly credits: SavingBand | undefined;
  readonly unpricedReason?: string;
}

/** A lever the simulation priced whose saving no *setting* delivers. */
export interface CarriedElsewhere {
  readonly lever: LeverId;
  readonly credits: SavingBand;
  readonly carriedBy: string;
}

export interface PolicyEmission {
  readonly channel: ManagedChannel;
  readonly detection: ChannelDetection;
  readonly lines: readonly PolicyLine[];
  /** Policy lines no setting can express, with the phase that does enforce them. */
  readonly deferred: readonly DeferredKey[];
  readonly agents: DeriveAgentsResult;
  readonly artefacts: readonly Artefact[];
  readonly carriedElsewhere: readonly CarriedElsewhere[];
  /** Surfaces skipped because their existing file could not be parsed. */
  readonly skipped: readonly string[];
  readonly totalCredits: SavingBand;
}

export interface EmitPolicyOptions {
  /** Overrides channel detection. Still refused if a higher channel is active. */
  readonly channel?: ManagedChannel;
  readonly detection?: ChannelDetection;
  readonly cwd?: string;
  /** Injected so generated profiles are byte-identical across runs. */
  readonly uuid?: () => string;
  readonly now?: Date;
}

/**
 * Compiles a policy into the exact artefacts a platform team deploys
 * (DEVELOPMENT-PLAN.md D5).
 *
 * ## Why nothing here writes to the machine
 *
 * Every artefact is returned, never applied. A tool that silently changed a
 * developer's settings — or an organisation's MDM — would be doing the one
 * thing this project says it does not do (risk A9). The caller writes them
 * to an output directory and a human deploys them, which also means the
 * rollback exists on disk *before* the change does.
 */
export async function emitPolicy(
  db: Database.Database,
  policy: Policy,
  options: EmitPolicyOptions = {},
): Promise<PolicyEmission> {
  const detection = options.detection ?? (await detectChannel());
  const channel = options.channel ?? detection.active ?? 'file-based';
  assertChannelWritable(detection, channel);

  const { settings, deferred } = resolveSettings(policy);
  const ctx = buildDetectContext(db);
  const simulation = buildSimulation(db, policy, {
    privacy: { scope: 'self', subjectCount: 1 },
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const byLever = new Map(simulation.levers.map((lever) => [lever.id, lever]));

  const cwd = options.cwd ?? process.cwd();
  // Reused from detection rather than read a second time: two reads of the
  // same file can disagree, and the one that fed the verdict is the one the
  // diff and the rollback must both be built from.
  const managedPrior: PriorDocument =
    channel === 'file-based'
      ? (detection.evidence.find((item) => item.channel === 'file-based')?.prior ?? {
          state: 'absent',
        })
      : { state: 'absent' };
  const workspacePrior = await readPriorDocument(join(cwd, '.vscode', 'settings.json'));

  const effective = effectiveValues(detection, channel, workspacePrior);

  const lines: PolicyLine[] = settings.map((setting): PolicyLine => {
    const desired = renderValue(setting.value);
    const current = effective.get(currentKeyFor(setting));
    const lever = setting.key.lever === undefined ? undefined : byLever.get(setting.key.lever);

    return {
      settingId: setting.key.settingId ?? setting.key.managedName ?? setting.key.id,
      managedName: setting.key.managedName,
      surface: setting.key.surface,
      automation: setting.key.auto,
      attacks: setting.key.attacks,
      from: setting.from,
      desired,
      current,
      changes: current !== desired,
      credits: lever?.credits,
      ...(lever === undefined
        ? {
            unpricedReason:
              setting.key.lever === undefined
                ? 'No simulable lever measures this setting — see `tokenlens simulate` for what was and was not priced.'
                : 'The policy does not configure the lever this setting delivers, so there is nothing to price.',
          }
        : {}),
    };
  });

  const agents = deriveAgents(ctx, policy);

  const carriedElsewhere: CarriedElsewhere[] = simulation.levers
    .filter((lever) => !settings.some((setting) => setting.key.lever === lever.id))
    .map((lever) => ({
      lever: lever.id,
      credits: lever.credits,
      carriedBy:
        deferred.find((entry) => entry.at.startsWith(leverPrefix(lever.id)))?.enforcedBy ??
        'the generated agent files, or a later phase — see the deferred list.',
    }));

  const skipped: string[] = [];
  if (workspacePrior.state === 'unreadable') {
    skipped.push(
      `.vscode/settings.json — ${workspacePrior.reason} Emission refused rather than risk a rollback that deletes it.`,
    );
  }
  if (managedPrior.state === 'unreadable') {
    skipped.push(`managed-settings.json — ${managedPrior.reason} Emission refused.`);
  }

  const artefacts: Artefact[] = [
    ...(channel === 'native-mdm' && detection.platform === 'darwin'
      ? emitMacosProfile(settings, options.uuid === undefined ? {} : { uuid: options.uuid })
      : []),
    ...(channel === 'native-mdm' && detection.platform !== 'darwin'
      ? emitWindowsRegistry(settings, priorRegistryValues(detection))
      : []),
    ...(channel === 'file-based' ? emitManagedJson(settings, managedPrior) : []),
    ...emitWorkspaceSettings(settings, workspacePrior),
    ...emitAgents(agents),
  ];

  artefacts.push({
    path: 'README.md',
    contents: renderReadme({ channel, detection, lines, deferred, agents, skipped }),
    description: 'What this directory contains, what it changes, and how to undo it',
    role: 'apply',
  });

  return {
    channel,
    detection,
    lines,
    deferred,
    agents,
    artefacts: artefacts.sort((a, b) => a.path.localeCompare(b.path)),
    carriedElsewhere,
    skipped,
    totalCredits: simulation.combined,
  };
}

/**
 * The values in effect right now, for the diff.
 *
 * Only the *active* managed channel is consulted: values sitting in a losing
 * channel are not in effect, and showing them as the current state would
 * describe a machine that does not exist.
 */
function effectiveValues(
  detection: ChannelDetection,
  channel: ManagedChannel,
  workspacePrior: PriorDocument,
): Map<string, string> {
  const effective = new Map<string, string>();

  const active = detection.evidence.find((item) => item.channel === (detection.active ?? channel));
  for (const [name, value] of Object.entries(active?.values ?? {})) {
    effective.set(`managed:${name}`, renderValue(value as never));
  }

  if (workspacePrior.state === 'present') {
    for (const [id, value] of Object.entries(workspacePrior.document)) {
      effective.set(`workspace:${id}`, renderValue(value as never));
    }
  }

  return effective;
}

function currentKeyFor(setting: ResolvedSetting): string {
  return setting.key.surface === 'managed'
    ? `managed:${setting.key.managedName ?? ''}`
    : `workspace:${setting.key.settingId ?? ''}`;
}

function priorRegistryValues(detection: ChannelDetection): Record<string, string | undefined> {
  const values = detection.evidence.find((item) => item.channel === 'native-mdm')?.values ?? {};
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, renderValue(value as never)]),
  );
}

async function readPriorDocument(path: string): Promise<PriorDocument> {
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
        'VS Code accepts comments and trailing commas here; this tool will not guess at rewriting them.',
    };
  }
}

function renderValue(value: string | number | boolean | Record<string, boolean>): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function leverPrefix(lever: LeverId): string {
  const prefixes: Record<LeverId, string> = {
    'model-routing': 'model.route',
    'tool-trim': 'tools.deny',
    'payload-cap': 'payload.max_result_tokens',
    'loop-cap': 'session.max_rounds',
    'session-hygiene': 'session.nudge_after_turns',
    'dedupe-reads': 'retrieval.dedupe_reads',
  };
  return prefixes[lever];
}

interface ReadmeInput {
  readonly channel: ManagedChannel;
  readonly detection: ChannelDetection;
  readonly lines: readonly PolicyLine[];
  readonly deferred: readonly DeferredKey[];
  readonly agents: DeriveAgentsResult;
  readonly skipped: readonly string[];
}

/**
 * The artefact directory explains itself. Whoever opens the pull request
 * that contains it is a platform engineer who did not run the analysis, and
 * a payload with no accompanying reasoning is one they are right to refuse.
 */
function renderReadme(input: ReadmeInput): string {
  const changing = input.lines.filter((line) => line.changes);

  const rows = changing.map((line) => {
    const credits =
      line.credits === undefined
        ? 'not priced'
        : `${formatCredits(line.credits.low)}–${formatCredits(line.credits.high)}`;
    return `| \`${line.settingId}\` | ${line.current ?? '*unset*'} | ${line.desired} | ${credits} | ${line.automation} · ${line.attacks} |`;
  });

  return `# Copilot cost policy — generated by TokenLens

Target channel: **${input.channel}**${input.detection.active === undefined ? ' (nothing is currently active)' : ''}

${input.detection.caveat}

## What changes

| Setting | Now | After | Credits saved | Automation |
|---|---|---|---|---|
${rows.length > 0 ? rows.join('\n') : '| *nothing* | | | | |'}

Credit figures are the range from \`tokenlens simulate\`: a band rather than a point, because how
much of a setting actually lands depends on who has to cooperate with it. Lines marked *not priced*
are still worth deploying — the saving was not measurable from this corpus, which is not the same
as it being zero.

## How to undo it

Every applied artefact has a \`rollback\` counterpart in the same directory, generated from the state
this machine was in **before** the change. A value that was unset is removed rather than reset to a
guessed default.

## What this does not do
${input.deferred.length === 0 ? '\nNothing was deferred.\n' : ''}
${input.deferred
  .map((entry) => `- \`${entry.at}\` — ${entry.reason}\n  - Enforced by: ${entry.enforcedBy}`)
  .join('\n')}

## Generated agents

${
  input.agents.agents.length === 0
    ? 'None.'
    : input.agents.agents
        .map(
          (agent) => `- \`${agent.name}\` — ${String(agent.tools.length)} tool(s). ${agent.basis}`,
        )
        .join('\n')
}

${input.agents.caveats.map((caveat) => `> ${caveat}`).join('\n>\n')}
${
  input.skipped.length > 0
    ? `\n## Surfaces skipped\n\n${input.skipped.map((entry) => `- ${entry}`).join('\n')}\n`
    : ''
}`;
}
