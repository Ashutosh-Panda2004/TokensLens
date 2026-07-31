import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import { printHeading, printJson, printLine, printTable } from '../output.js';
import { assertContained } from '../../shared/safe.js';
import { runHook, writeDecision } from '../../hooks/run.js';
import { generateHookConfig, type HookScope } from '../../hooks/config.js';
import { GUARDS, UNAVAILABLE_GUARDS } from '../../hooks/guards.js';
import {
  guardStatePath,
  openGuardState,
  allRuleHealth,
  readDecisionLog,
  disableRule,
  enableRule,
} from '../../hooks/state.js';
import { runMcpServer } from '../../mcp/server.js';

interface HookOptions {
  readonly event?: string;
}

interface InstallOptions {
  readonly scope: string;
  readonly out?: string;
  readonly command: string;
}

/**
 * A guard's reason is written to be read by an agent, so it is several
 * sentences long: what was refused, why, and what to do instead. In the
 * audit log only the first of those is the point, and a hard character
 * truncation cut it mid-word — which reads like a corrupted record rather
 * than a summary. Take the leading sentence, and only clip if that alone is
 * unreasonably long.
 */
function firstSentence(evidence: string): string {
  const collapsed = evidence.replace(/\s+/g, ' ').trim();
  const stop = collapsed.search(/\.\s/);
  const sentence = stop === -1 ? collapsed : collapsed.slice(0, stop + 1);
  return sentence.length <= 160 ? sentence : `${sentence.slice(0, 159).trimEnd()}…`;
}

/**
 * The hook subcommand is the only place in the CLI that writes to **stdout
 * as a protocol** rather than as a report. Everything it prints is consumed
 * by the agent, which is why the logger has been stderr-only since D0.
 */
export function registerHookCommand(program: Command): void {
  const hook = program
    .command('hook')
    .description('Runtime guard entry point, invoked by the Copilot agent per tool call.')
    .option('--event <event>', 'hook event name, e.g. PreToolUse')
    .action(async (options: HookOptions) => {
      // No try/catch here on purpose: `runHook` cannot throw. If it somehow
      // did, cli/index.ts would still exit non-zero and break the agent —
      // which is why the guarantee lives inside the function rather than
      // being reconstructed at each call site.
      const decision = await runHook({
        ...(options.event !== undefined ? { event: options.event } : {}),
      });
      writeDecision(decision);
    });

  hook
    .command('install')
    .description('Generate the configuration that makes the agent call these guards.')
    .option('--scope <scope>', 'workspace or user', 'workspace')
    .option('--out <dir>', 'write here instead of printing')
    .option('--command <command>', 'how the agent should invoke TokenLens', 'tokenlens')
    .action(async (options: InstallOptions) => {
      const scope: HookScope = options.scope === 'user' ? 'user' : 'workspace';
      const artefacts = generateHookConfig({ scope, command: options.command });

      if (options.out === undefined) {
        for (const artefact of artefacts) {
          printHeading(artefact.path);
          printLine(artefact.contents);
        }
        printLine(
          'Nothing was written. Re-run with --out <dir> to produce the files, then move them into place ' +
            'through review — a hook config is a deployment, and committing one enables these guards for ' +
            'everyone who opens the repository.',
        );
        return;
      }

      const outDir = resolve(options.out);
      for (const artefact of artefacts) {
        const target = assertContained(outDir, artefact.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, artefact.contents, 'utf8');
        printLine(`· ${artefact.path} — ${artefact.description}`);
      }
      printLine();
      printLine(`Written to ${outDir}. Nothing on this machine was changed.`);
    });

  hook
    .command('status')
    .description('What the guards did, what was reversed, and what stood itself down.')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action((options: { json?: boolean }) => {
      const db = openGuardState(guardStatePath());
      try {
        const health = allRuleHealth(db);
        const log = readDecisionLog(db, 20);

        if (options.json) {
          printJson({ health, recent: log, unavailable: UNAVAILABLE_GUARDS });
          return;
        }

        printHeading('TokenLens — runtime guards');
        printTable(
          GUARDS.map((guard) => {
            const entry = health.find((row) => row.rule === guard.id);
            const interventions = entry?.interventions ?? 0;
            const reversals = entry?.reversals ?? 0;
            return {
              guard: guard.id,
              automation: guard.automation,
              attacks: guard.attacks,
              interventions,
              reversed: reversals,
              state: entry?.disabledAt === null || entry === undefined ? 'active' : 'stood down',
            };
          }),
        );

        const disabled = health.filter((row) => row.disabledAt !== null);
        if (disabled.length > 0) {
          printLine();
          printHeading('Stood down');
          for (const row of disabled) printLine(`· ${row.rule} — ${row.disabledReason ?? ''}`);
        }

        if (log.length > 0) {
          printLine();
          printHeading('Recent interventions');
          for (const entry of log.slice(0, 10)) {
            printLine(
              `${new Date(entry.ts).toISOString().slice(0, 19)}  ${entry.decision.padEnd(7)} ${entry.rule}` +
                (entry.toolName === undefined ? '' : `  (${entry.toolName})`),
            );
            if (entry.evidence) printLine(`    ${firstSentence(entry.evidence)}`);
          }
        } else {
          printLine();
          printLine(
            'No guard has intervened yet. Run `tokenlens hook install` if that is unexpected.',
          );
        }

        if (UNAVAILABLE_GUARDS.length > 0) {
          printLine();
          printLine(`${String(UNAVAILABLE_GUARDS.length)} automation(s) specified but not built:`);
          for (const entry of UNAVAILABLE_GUARDS) {
            printLine(`  ${entry.automation} ${entry.name} — ${entry.reason}`);
            printLine(`    unblocked by: ${entry.unblockedBy}`);
          }
        }
      } finally {
        db.close();
      }
    });

  hook
    .command('disable <guard>')
    .description('Stand a guard down without disabling the others.')
    .action((guard: string) => {
      const db = openGuardState(guardStatePath());
      try {
        disableRule(db, guard, 'Disabled by hand.', Date.now());
        printLine(`${guard} is stood down. The other guards are unaffected.`);
      } finally {
        db.close();
      }
    });

  hook
    .command('enable <guard>')
    .description('Bring a guard back, clearing its reversal count.')
    .action((guard: string) => {
      const db = openGuardState(guardStatePath());
      try {
        enableRule(db, guard);
        printLine(`${guard} is active again, with its reversal count reset.`);
      } finally {
        db.close();
      }
    });
}

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run the budget-guard MCP server over stdio.')
    .option('--plan <plan>', 'business or enterprise', 'enterprise')
    .action(async (options: { plan: string }) => {
      await runMcpServer({ plan: options.plan === 'business' ? 'business' : 'enterprise' });
    });
}
