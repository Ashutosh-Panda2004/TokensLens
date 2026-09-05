import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import {
  auditContribution,
  buildContribution,
  CONTRIBUTION_MANIFEST,
  type MonthlyContribution,
} from '../../contribute/contribution.js';
import {
  consentFilePath,
  consentState,
  CONSENT_STATE_TEXT,
  grantConsent,
  readConsent,
  revokeConsent,
} from '../../contribute/consent.js';
import {
  alreadyContributed,
  listOutbox,
  outboxDir,
  writeContribution,
} from '../../contribute/outbox.js';
import { printHeading, printJson, printLine } from '../output.js';

interface ContributeOptions {
  readonly month?: string;
  readonly preview?: boolean;
  readonly json?: boolean;
  readonly force?: boolean;
}

/** A preview must not require consent — you cannot agree to something you cannot see. */
async function previewContribution(month: string | undefined): Promise<MonthlyContribution> {
  const db = await openLedgerForReading();
  try {
    return buildContribution(db, { contributorId: 'preview-not-yet-assigned', period: month });
  } finally {
    db.close();
  }
}

export function registerContributeCommand(program: Command): void {
  const contribute = program
    .command('contribute')
    .description(
      'Opt in to sharing anonymous monthly aggregates, and see exactly what that means.',
    );

  contribute
    .command('status', { isDefault: true })
    .description('Whether sharing is on, and what has been produced.')
    .action(async () => {
      const state = consentState(await readConsent());
      printHeading('TokenLens — anonymous contribution');

      if (state.active) {
        printLine('Sharing: ON');
        printLine(`agreed on:      ${state.record.consentedAt}`);
        printLine(`contributor id: ${state.record.contributorId}  (random; identifies nothing)`);
      } else {
        printLine('Sharing: OFF');
        printLine(CONSENT_STATE_TEXT[state.reason] ?? state.reason);
      }

      const produced = await listOutbox();
      printLine();
      printLine(`outbox: ${outboxDir()}`);
      printLine(
        produced.length === 0
          ? 'nothing has been produced yet.'
          : `${String(produced.length)} file(s): ${produced.join(', ')}`,
      );
      printLine();
      printLine('TokenLens never uploads. Files stay here until you send them yourself.');
      printLine('  See what would be shared:  tokenlens contribute preview');
      printLine('  Turn it on:                tokenlens contribute on');
    });

  contribute
    .command('preview')
    .description(
      'Print the exact payload that would be shared. Requires no consent, sends nothing.',
    )
    .option('--month <YYYY-MM>', 'the month to build (default: the current one)')
    .option('--json', 'print the payload as JSON only')
    .action(async (options: ContributeOptions) => {
      const contribution = await previewContribution(options.month);

      if (options.json) {
        printJson(contribution);
        return;
      }

      printHeading('What would be shared');
      for (const entry of CONTRIBUTION_MANIFEST) {
        printLine(entry.field);
        printLine(`  ${entry.why}`);
      }
      printLine();
      printLine('Nothing else. No prompts, completions, file paths, file contents, tool');
      printLine('arguments, session ids, repository names, or timestamps finer than a day.');
      printLine();
      printHeading(`The payload for ${contribution.period}`);
      printJson(contribution);
    });

  contribute
    .command('on')
    .description('Agree to share anonymous monthly aggregates.')
    .action(async () => {
      const record = await grantConsent();
      printLine('Sharing is ON.');
      printLine(`recorded in: ${consentFilePath()}`);
      printLine(`contributor id: ${record.contributorId}`);
      printLine();
      printLine('Nothing has been sent. Produce this month with: tokenlens contribute run');
      printLine('Turn it off at any time with: tokenlens contribute off');
    });

  contribute
    .command('off')
    .description('Withdraw consent. Nothing further is produced.')
    .action(async () => {
      const record = await revokeConsent();
      printLine(
        record === undefined
          ? 'Sharing was already off — there was no consent on record.'
          : 'Sharing is OFF. Nothing further will be produced.',
      );
      printLine(`Files already in ${outboxDir()} are yours; delete them if you do not want them.`);
    });

  contribute
    .command('run')
    .description('Build this month’s contribution into the local outbox. Uploads nothing.')
    .option('--month <YYYY-MM>', 'the month to build (default: the current one)')
    .option('--force', 'rebuild even if this month has already been produced')
    .action(async (options: ContributeOptions) => {
      const state = consentState(await readConsent());
      if (!state.active) {
        // Fails closed, and says which of the three "no" states applies —
        // a version change is a very different problem from never opting in.
        printLine('Sharing is off, so nothing was produced.');
        printLine(CONSENT_STATE_TEXT[state.reason] ?? state.reason);
        printLine('  Review the payload:  tokenlens contribute preview');
        process.exitCode = 1;
        return;
      }

      const db = await openLedgerForReading();
      try {
        const contribution = buildContribution(db, {
          contributorId: state.record.contributorId,
          period: options.month,
        });

        const audit = auditContribution(contribution);
        if (!audit.safe) {
          printLine(
            'Refusing to write: the payload contains fields its manifest does not declare.',
          );
          printLine(audit.detail);
          process.exitCode = 1;
          return;
        }

        if (!options.force && (await alreadyContributed(contribution.period))) {
          printLine(`${contribution.period} has already been produced. Use --force to rebuild.`);
          return;
        }

        const path = await writeContribution(contribution);
        printLine(`Wrote ${path}`);
        printLine(audit.detail);
        printLine();
        printLine('Nothing has been uploaded. Read the file, then send it if you still want to.');
      } finally {
        db.close();
      }
    });
}
