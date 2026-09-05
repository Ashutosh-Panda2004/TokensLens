import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import {
  availablePeriods,
  buildMonthlyReport,
  renderMonthlyReportMarkdown,
} from '../../report/monthly.js';
import { parsePlan, resolveAllowance } from '../../ledger/budget.js';
import { readMergedConfig } from '../../shared/config.js';
import { addScopeOptions, scopeFromOptions, type ScopeCommandOptions } from '../scope-options.js';
import { describeScope } from '../../scope/index.js';
import type { PrivacyContext } from '../../privacy/scope.js';
import { printHeading, printLine } from '../output.js';
import { logger } from '../../shared/logger.js';

interface ReportCommandOptions extends ScopeCommandOptions {
  readonly month?: string;
  readonly out?: string;
  readonly list?: boolean;
  readonly plan?: string;
  readonly allowance?: string;
  readonly self?: boolean;
}

interface ReportConfig {
  readonly plan?: string;
  readonly monthlyAllowance?: string | number;
}

export function registerReportCommand(program: Command): void {
  const command = program
    .command('report')
    .description('Write a month of spend as Markdown, ready to hand to an AI assistant.')
    .option('--month <YYYY-MM>', 'the month to report on (default: the most recent with activity)')
    .option('--out <file>', 'write to this file instead of standard output')
    .option('--list', 'list the months that have recorded activity, and exit')
    .option('--plan <plan>', 'override the configured Copilot plan')
    .option('--allowance <credits>', 'override the configured monthly allowance')
    .option(
      '--self',
      'this report is for your own eyes only — keeps per-session detail. Without it, the ' +
        'report is treated as shareable and that detail is withheld.',
    );

  addScopeOptions(command).action(async (options: ReportCommandOptions) => {
    const db = await openLedgerForReading();
    try {
      const scope = await scopeFromOptions(options);
      const periods = availablePeriods(db, scope);

      if (options.list === true) {
        printHeading('Months with recorded activity');
        if (periods.length === 0) printLine('none in this scope.');
        for (const period of periods) printLine(`  ${period}`);
        printLine();
        printLine(describeScope(scope));
        return;
      }

      const period = options.month ?? periods[0];
      if (period === undefined) {
        printLine('No recorded activity in this scope, so there is nothing to report.');
        printLine(describeScope(scope));
        return;
      }

      const config = await readMergedConfig<ReportConfig>({});
      const plan =
        options.plan !== undefined
          ? parsePlan(options.plan, '--plan')
          : config.merged.plan !== undefined
            ? parsePlan(config.merged.plan, 'config.json')
            : 'enterprise';

      const allowance = resolveAllowance({
        plan,
        flag: options.allowance,
        env: process.env.TOKENLENS_MONTHLY_ALLOWANCE,
        config: config.project.monthlyAllowance,
        userConfig: config.user.monthlyAllowance,
      });

      // A report exists to be sent somewhere, so the safe scope is the
      // default and the permissive one has to be asked for — the same rule
      // the JSON and HTML exporters follow.
      const privacy: PrivacyContext = {
        scope: options.self === true ? 'self' : 'shared',
        subjectCount: 1,
      };

      const report = buildMonthlyReport(db, {
        period,
        allowance,
        scope,
        scopeLabel: describeScope(scope),
        privacy,
      });

      const markdown = renderMonthlyReportMarkdown(report, db);

      if (options.out === undefined) {
        process.stdout.write(`${markdown}\n`);
        return;
      }

      await writeFile(options.out, markdown, 'utf8');
      logger.success(`Wrote ${options.out}`);
      if (privacy.scope === 'shared') {
        logger.info(
          'Per-session detail was withheld so this file is safe to share. Use --self to keep it.',
        );
      }
    } finally {
      db.close();
    }
  });
}
