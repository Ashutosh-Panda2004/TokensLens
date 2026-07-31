import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import { buildMcpRoi, buildWasteReport } from '../../waste/report.js';
import { printHeading, printJson, printLine, printTable } from '../output.js';
import { isMeasured, isModelled } from '../../model/provenance.js';
import type { WasteClass, WasteFinding } from '../../waste/types.js';

interface WasteCommandOptions {
  readonly json?: boolean;
  readonly explain?: string;
}

/** Renders a finding's credits with its provenance, never as a bare number. */
function creditsLabel(finding: WasteFinding): string {
  const tag = isMeasured(finding.credits) ? 'measured' : 'modelled';
  return `${finding.credits.value.toFixed(1)} cr [${tag}]`;
}

function printExplanation(finding: WasteFinding): void {
  printHeading(`${finding.class} · ${finding.title}`);
  printLine(`credits:     ${creditsLabel(finding)}`);
  printLine(`confidence:  ${(finding.confidence * 100).toFixed(0)}%`);
  printLine(`fix (tier ${finding.remediation.tier}): ${finding.remediation.summary}`);
  printLine(`             ${finding.remediation.action}`);

  if (isModelled(finding.credits)) {
    printLine();
    printLine('basis:');
    printLine(`  ${finding.credits.provenance.basis}`);
    printLine('assumptions:');
    for (const assumption of finding.credits.provenance.assumptions) {
      printLine(`  · ${assumption}`);
    }
  }

  printLine();
  printLine('evidence:');
  for (const item of finding.evidence) {
    const credits = item.credits === undefined ? '' : ` (${item.credits.toFixed(1)} cr)`;
    printLine(`  [${item.kind}] ${item.ref}${credits}`);
    printLine(`      ${item.detail}`);
  }
}

export function registerWasteCommand(program: Command): void {
  program
    .command('waste')
    .description('Rank measured waste by cause, with named remediation for each.')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .option('--explain <class>', 'print the full evidence chain for one class, e.g. W1')
    .action(async (options: WasteCommandOptions) => {
      const db = await openLedgerForReading();
      const report = buildWasteReport(db);

      if (options.json) {
        printJson(report);
        return;
      }

      if (options.explain) {
        const wanted = options.explain.toUpperCase() as WasteClass;
        const finding = report.findings.find((f) => f.class === wanted);
        if (!finding) {
          const unavailable = report.unavailable.find((u) => u.class === wanted);
          if (unavailable) {
            printHeading(`${unavailable.class} · ${unavailable.name}`);
            printLine('This class could not be assessed from the available data.');
            printLine(`reason:       ${unavailable.reason}`);
            printLine(`unblocked by: ${unavailable.unblockedBy}`);
            return;
          }
          printLine(`No finding for ${wanted}. Run \`tokenlens waste\` to see what was detected.`);
          return;
        }
        printExplanation(finding);
        return;
      }

      printHeading('TokenLens — waste attribution');

      if (report.findings.length === 0) {
        printLine('No waste detected in the ingested data.');
      } else {
        printTable(
          report.findings.map((finding) => ({
            class: finding.class,
            cause: finding.title,
            credits: finding.credits.value.toFixed(1),
            provenance: isMeasured(finding.credits) ? 'measured' : 'modelled',
            confidence: `${(finding.confidence * 100).toFixed(0)}%`,
            tier: finding.remediation.tier,
          })),
        );

        printLine();
        printLine(
          `attributed: ${report.attributedCredits.toFixed(1)} of ${report.totalLedgerCredits.toFixed(1)} ledger credits ` +
            `(${(report.attributedShare * 100).toFixed(1)}%)`,
        );
        if (report.overlapWarning) {
          printLine(`⚠ ${report.overlapWarning}`);
        }
      }

      if (report.unavailable.length > 0) {
        printLine();
        printLine(
          `${String(report.unavailable.length)} class(es) could not be assessed from the available data:`,
        );
        for (const item of report.unavailable) {
          printLine(`  ${item.class} ${item.name} — ${item.reason}`);
        }
        printLine();
        printLine(
          'These are reported rather than omitted: "we cannot look" is not the same as "there is nothing there".',
        );
      }

      printLine();
      printLine('Run `tokenlens waste --explain W1` for the full evidence chain behind any class.');
    });
}

export function registerMcpRoiCommand(program: Command): void {
  program
    .command('mcp-roi')
    .description('Per tool group: invocations, share of tool use, and whether it earned its place.')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: { readonly json?: boolean }) => {
      const db = await openLedgerForReading();
      const roi = buildMcpRoi(db);

      if (options.json) {
        printJson(roi);
        return;
      }

      printHeading('TokenLens — tool / MCP server return on investment');

      if (roi.length === 0) {
        printLine('No tool invocations found in the ingested data.');
        return;
      }

      printTable(
        roi.map((row) => ({
          server: row.server,
          tools: row.toolCount,
          invocations: row.invocations,
          share: `${(row.invocationShare * 100).toFixed(1)}%`,
          verdict: row.verdict,
        })),
      );

      printLine();
      printLine(
        'Note: this lists tools that were *invoked*. A server installed but never called once ' +
          'leaves no trace in the journal and cannot appear here — yet it is billed on every ' +
          'request. "unused-in-window" means "not invoked during the measured period", not "never used".',
      );
    });
}
