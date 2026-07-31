import type Database from 'better-sqlite3';
import { buildDetectContext } from './context.js';
import { DETECTORS, UNAVAILABLE_CLASSES } from './registry.js';
import type { UnavailableClass, WasteFinding } from './types.js';

export interface WasteReport {
  /** Findings ranked by attributed credits, descending. */
  readonly findings: readonly WasteFinding[];
  /** Classes that could not be assessed, with the reason. Never silently dropped. */
  readonly unavailable: readonly UnavailableClass[];
  readonly totalLedgerCredits: number;
  /**
   * Sum of attributed credits across findings. **This deliberately may
   * exceed the ledger total**, and the report says so rather than clamping
   * it — see {@link WasteReport.overlapWarning}.
   */
  readonly attributedCredits: number;
  /** `attributedCredits / totalLedgerCredits`. */
  readonly attributedShare: number;
  /**
   * Set when attribution exceeds the ledger total. Causes genuinely
   * overlap: a request can be both on an over-powered model *and* inside a
   * stale session, and both detectors will rightly claim it. Presenting the
   * sum as a total saving would be double-counting, so the report flags it
   * instead of hiding it. Phase D4 resolves overlap properly, by combining
   * levers multiplicatively rather than additively.
   */
  readonly overlapWarning: string | undefined;
}

/**
 * Runs every available detector and ranks the results.
 *
 * Detector failures are contained: one detector throwing must not lose the
 * other six findings, so each runs independently and a thrown error becomes
 * a visible omission rather than a crashed report.
 */
export function buildWasteReport(db: Database.Database): WasteReport {
  const ctx = buildDetectContext(db);

  const findings: WasteFinding[] = [];
  const failed: UnavailableClass[] = [];

  for (const detector of DETECTORS) {
    try {
      findings.push(...detector.detect(ctx));
    } catch (error) {
      failed.push({
        class: detector.class,
        name: detector.name,
        reason: `The detector failed to run: ${error instanceof Error ? error.message : String(error)}`,
        unblockedBy: 'A fix to the detector. This is a defect, not a data limitation.',
      });
    }
  }

  findings.sort((a, b) => b.credits.value - a.credits.value);

  const attributedCredits = findings.reduce((sum, finding) => sum + finding.credits.value, 0);
  const totalLedgerCredits = ctx.ledger.totalCredits;
  const attributedShare = totalLedgerCredits > 0 ? attributedCredits / totalLedgerCredits : 0;

  return {
    findings,
    unavailable: [...UNAVAILABLE_CLASSES, ...failed],
    totalLedgerCredits,
    attributedCredits,
    attributedShare,
    overlapWarning:
      attributedCredits > totalLedgerCredits
        ? 'Attributed credits exceed the ledger total because causes overlap — one request can be ' +
          'counted by more than one detector. These figures are per-cause, not a sum. ' +
          'Combining levers into a single saving requires the simulation engine.'
        : undefined,
  };
}

export interface McpServerRoi {
  /** Server or extension prefix inferred from the tool name, or the bare tool name. */
  readonly server: string;
  readonly toolCount: number;
  readonly invocations: number;
  /** Share of all tool invocations in the corpus. */
  readonly invocationShare: number;
  readonly verdict: 'active' | 'marginal' | 'unused-in-window';
}

/**
 * Per-server invocation summary — the input to the MCP ROI question
 * *"is this integration earning the tokens it costs?"*
 *
 * ## What this can and cannot tell you
 *
 * It reports what was **invoked**. It cannot report what was **installed**,
 * because the journal only records tools that were actually called. A
 * server installed and never once used contributes nothing here and is
 * therefore invisible — and those are exactly the most wasteful ones.
 *
 * `unused-in-window` therefore means *"not invoked during the measured
 * period"*, not *"never used"*. The distinction is stated in the command
 * output rather than left for the reader to assume.
 */
export function buildMcpRoi(db: Database.Database): McpServerRoi[] {
  const ctx = buildDetectContext(db);
  const totalInvocations = ctx.toolCalls.length;

  const byServer = new Map<string, { tools: Set<string>; invocations: number }>();
  for (const call of ctx.toolCalls) {
    const server = serverOf(call.name);
    const bucket = byServer.get(server) ?? { tools: new Set<string>(), invocations: 0 };
    bucket.tools.add(call.name);
    bucket.invocations += 1;
    byServer.set(server, bucket);
  }

  const requestCount = Math.max(1, ctx.requests.length);

  return [...byServer.entries()]
    .map(([server, bucket]): McpServerRoi => {
      const perRequest = bucket.invocations / requestCount;
      return {
        server,
        toolCount: bucket.tools.size,
        invocations: bucket.invocations,
        invocationShare: totalInvocations > 0 ? bucket.invocations / totalInvocations : 0,
        verdict:
          perRequest >= 0.25 ? 'active' : perRequest >= 0.05 ? 'marginal' : 'unused-in-window',
      };
    })
    .sort((a, b) => b.invocations - a.invocations);
}

/**
 * MCP tools are conventionally namespaced (`server_tool`, `server/tool`,
 * `mcp_server_tool`). Built-in editor tools have no separator and are
 * grouped under a single bucket so they do not masquerade as servers.
 */
function serverOf(toolName: string): string {
  if (toolName.startsWith('mcp_')) {
    const rest = toolName.slice(4);
    return `mcp:${rest.split('_')[0] ?? rest}`;
  }
  if (toolName.includes('/')) return toolName.split('/')[0] ?? toolName;
  return 'built-in';
}
