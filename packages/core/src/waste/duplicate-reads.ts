import { groupBy } from './scoring.js';
import type { DetectContext } from './types.js';
import type { ToolCallRow } from '../store/database.js';

/** Tools whose results are file content and therefore re-readable. */
const READ_TOOLS = new Set(['read_file', 'get_errors']);

export interface DuplicateRead {
  readonly requestId: string;
  readonly sessionId: string;
  readonly fileHash: string;
  /** Measured character length of the redundant result. */
  readonly chars: number;
}

export interface DuplicateReadScan {
  readonly duplicates: readonly DuplicateRead[];
  readonly readCalls: number;
  /**
   * Re-reads that overlapped an earlier range but happened **after** the
   * file was edited in that session. These are not duplicates — the content
   * genuinely changed — and they are excluded from {@link duplicates}
   * rather than charged.
   */
  readonly refreshedAfterEdit: number;
}

/**
 * Finds reads that re-fetched content already sitting in the conversation.
 *
 * ## The edit exemption, and why it is not a refinement
 *
 * A first cut counts any read whose range overlaps an earlier read in the
 * same session. On this machine's real corpus that flagged 1,769 reads —
 * and **1,396 of them followed an edit to the same file**. Those are not
 * duplicates in any sense: the agent changed the file and read it back,
 * which is the correct thing to do and the only way to see what it had just
 * written.
 *
 * Charging them would have overstated this waste class roughly fivefold,
 * and — worse — the corresponding policy would deny the agent sight of its
 * own edits. The simulation phase is what surfaced it: a detector can
 * overstate a number quietly, but a *policy* built on the same logic has to
 * describe what it would actually block, and that description did not
 * survive being read.
 *
 * So an edit invalidates everything previously read from that file. Only
 * reads overlapping a range fetched *since* the last edit count.
 *
 * Edit times are the timestamp of the request the edit belongs to, which is
 * the finest resolution the journal records.
 */
export function scanDuplicateReads(ctx: DetectContext): DuplicateReadScan {
  const readCalls = ctx.toolCalls.filter(
    (call) => READ_TOOLS.has(call.name) && call.targetFileHash !== null,
  );

  const editTimes = editTimesBySessionFile(ctx);
  const duplicates: DuplicateRead[] = [];
  let refreshedAfterEdit = 0;

  for (const [sessionId, calls] of groupBy(readCalls, (call) => call.sessionId)) {
    const seen = new Map<string, { range: Range; ts: number }[]>();

    for (const call of calls) {
      const fileHash = call.targetFileHash;
      if (fileHash === null) continue;

      const range = rangeOf(call);
      const prior = seen.get(fileHash) ?? [];
      const overlapping = prior.filter((earlier) => overlaps(earlier.range, range));

      if (overlapping.length > 0) {
        const lastEdit = latestEditBefore(editTimes.get(`${sessionId}:${fileHash}`), call.ts);
        // Still redundant only if some overlapping copy was fetched after
        // the most recent edit — otherwise every copy in context is stale.
        if (overlapping.some((earlier) => earlier.ts >= lastEdit)) {
          duplicates.push({
            requestId: call.requestId,
            sessionId,
            fileHash,
            chars: call.resultChars ?? 0,
          });
        } else {
          refreshedAfterEdit += 1;
        }
      }

      prior.push({ range, ts: call.ts });
      seen.set(fileHash, prior);
    }
  }

  return { duplicates, readCalls: readCalls.length, refreshedAfterEdit };
}

function editTimesBySessionFile(ctx: DetectContext): Map<string, number[]> {
  const requestById = new Map(ctx.requests.map((request) => [request.requestId, request]));
  const times = new Map<string, number[]>();

  for (const edit of ctx.edits) {
    const request = requestById.get(edit.requestId);
    if (!request) continue;
    const key = `${request.sessionId}:${edit.fileHash}`;
    const bucket = times.get(key) ?? [];
    bucket.push(request.ts);
    times.set(key, bucket);
  }

  for (const bucket of times.values()) bucket.sort((a, b) => a - b);
  return times;
}

/** Most recent edit at or before `ts`, or `-Infinity` when the file was never edited. */
function latestEditBefore(times: readonly number[] | undefined, ts: number): number {
  if (!times) return -Infinity;
  let latest = -Infinity;
  for (const time of times) {
    if (time > ts) break;
    latest = time;
  }
  return latest;
}

interface Range {
  readonly start: number;
  readonly end: number;
}

/** A read with no explicit range covers the whole file. */
function rangeOf(call: ToolCallRow): Range {
  return { start: call.targetStartLine ?? 0, end: call.targetEndLine ?? Number.MAX_SAFE_INTEGER };
}

function overlaps(a: Range, b: Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}
