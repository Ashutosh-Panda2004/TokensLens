import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import { buildWorkspaceStats } from '../../ledger/ledger.js';
import {
  buildProjectTree,
  readWorkspaceMap,
  UNATTRIBUTED_REASON_TEXT,
  type ProjectNode,
} from '../../scope/index.js';
import { printHeading, printJson, printLine, printTable } from '../output.js';

interface ProjectsCommandOptions {
  readonly tree?: boolean;
  readonly unattributed?: boolean;
  readonly json?: boolean;
}

function formatDay(ts: number | undefined): string {
  return ts === undefined ? '—' : new Date(ts).toISOString().slice(0, 10);
}

/**
 * Renders the anatomy tree.
 *
 * Own and subtree credits are printed side by side at every node. A parent
 * that only showed its rolled-up figure would answer "what did this tree
 * cost" while silently losing "what did this folder itself cost" — the same
 * conflation, one level down, that the unscoped ledger made.
 */
function printTree(nodes: readonly ProjectNode[], prefix = ''): void {
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    const own = node.ownCredits.toFixed(1);
    const subtree = node.subtreeCredits.toFixed(1);
    const detail =
      node.children.length > 0
        ? `${subtree} cr subtree · ${own} cr own · ${String(node.subtreeRequestCount)} req`
        : `${own} cr · ${String(node.ownRequestCount)} req`;

    printLine(`${prefix}${last ? '└─ ' : '├─ '}${node.label}  —  ${detail}`);
    printTree(node.children, `${prefix}${last ? '   ' : '│  '}`);
  });
}

export function registerProjectsCommand(program: Command): void {
  program
    .command('projects')
    .description('Every VS Code workspace on this machine, and what each one has cost.')
    .option('--tree', 'show the folder anatomy: own vs subtree credits at every level')
    .option('--unattributed', 'itemise the workspaces that could not be placed, and why')
    .option('--json', 'print machine-readable JSON instead of tables')
    .action(async (options: ProjectsCommandOptions) => {
      const db = await openLedgerForReading();
      const [stats, locations] = await Promise.all([
        Promise.resolve(buildWorkspaceStats(db)),
        readWorkspaceMap(),
      ]);
      const tree = buildProjectTree(locations, stats);

      const byId = new Map(locations.map((location) => [location.workspaceId, location]));
      const rows = stats.map((stat) => {
        const location = byId.get(stat.workspaceId);
        return {
          project: location?.label ?? '(unplaced)',
          credits: stat.credits,
          requests: stat.requestCount,
          share: tree.totalCredits > 0 ? (stat.credits / tree.totalCredits) * 100 : 0,
          firstSeen: formatDay(stat.firstTs),
          lastSeen: formatDay(stat.lastTs),
          topModel: stat.topModel ?? '—',
          unplacedReason: location?.unattributedReason,
        };
      });

      if (options.json) {
        printJson({ projects: rows, tree });
        return;
      }

      if (options.unattributed) {
        printHeading('TokenLens — workspaces that could not be placed');
        if (tree.unattributed.workspaceCount === 0) {
          printLine('Every workspace with chat history maps to a folder. Nothing is unattributed.');
          return;
        }
        printLine(
          `${tree.unattributed.credits.toFixed(1)} credits across ` +
            `${String(tree.unattributed.requestCount)} request(s) in ` +
            `${String(tree.unattributed.workspaceCount)} workspace(s)`,
        );
        printLine();
        printTable(
          tree.unattributed.byReason.map((entry) => ({
            reason: UNATTRIBUTED_REASON_TEXT[entry.reason],
            workspaces: entry.workspaceCount,
            credits: entry.credits.toFixed(1),
          })),
        );
        return;
      }

      if (options.tree) {
        printHeading('TokenLens — project anatomy');
        printTree(tree.roots);
        printLine();
        printLine(
          `Unattributed: ${tree.unattributed.credits.toFixed(1)} cr across ` +
            `${String(tree.unattributed.workspaceCount)} workspace(s) — ` +
            'run `tokenlens projects --unattributed` for the reasons',
        );
        return;
      }

      printHeading('TokenLens — projects');
      printLine(
        `${String(rows.length)} workspace(s) with chat history · ` +
          `${tree.totalCredits.toFixed(1)} credits total`,
      );
      printLine();
      printTable(
        rows.map((row) => ({
          project: row.project,
          credits: row.credits.toFixed(1),
          requests: row.requests,
          'share%': row.share.toFixed(1),
          first: row.firstSeen,
          last: row.lastSeen,
          'top model': row.topModel,
        })),
      );

      if (tree.unattributed.workspaceCount > 0) {
        printLine();
        printLine(
          `${String(tree.unattributed.workspaceCount)} workspace(s) could not be placed against a ` +
            `folder (${tree.unattributed.credits.toFixed(1)} cr). Their credits are still counted ` +
            'in the total above — run `tokenlens projects --unattributed` for the reasons.',
        );
      }
    });
}
