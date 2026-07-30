import { readFile } from 'node:fs/promises';
import { logger } from '../shared/logger.js';
import { asArray, asRecord } from '../shared/guards.js';
import { applyEnvelope, parseEnvelope, type PathSegment } from './journal-envelope.js';

const NEWLINE_BYTE = 0x0a;
const CARRIAGE_RETURN_BYTE = 0x0d;

export interface RawLine {
  readonly text: string;
  /** Byte offset (not character offset) of this line's first byte in the file. */
  readonly offset: number;
}

/**
 * Splits a buffer into newline-delimited lines, tracking the **byte**
 * offset of each line — required for `tokenlens verify` to point at an
 * exact, reproducible location regardless of multi-byte UTF-8 content.
 * Tolerates a trailing line with no final newline (a file written by a
 * process that was killed mid-append) by yielding it like any other line;
 * whether it's valid JSON is the parser's problem, not the splitter's.
 */
export function splitBufferIntoLines(buffer: Buffer): RawLine[] {
  const lines: RawLine[] = [];
  let lineStart = 0;

  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === NEWLINE_BYTE) {
      let lineEnd = i;
      if (lineEnd > lineStart && buffer[lineEnd - 1] === CARRIAGE_RETURN_BYTE) {
        lineEnd -= 1; // strip a trailing \r (CRLF)
      }
      if (lineEnd > lineStart) {
        lines.push({
          text: buffer.subarray(lineStart, lineEnd).toString('utf8'),
          offset: lineStart,
        });
      }
      lineStart = i + 1;
    }
  }

  if (lineStart < buffer.length) {
    lines.push({ text: buffer.subarray(lineStart).toString('utf8'), offset: lineStart });
  }

  return lines;
}

export interface JournalStats {
  readonly totalLines: number;
  readonly malformedLines: number;
  readonly unrecognisedEnvelopes: number;
}

export interface ParsedJournal {
  readonly sourceFile: string;
  readonly doc: unknown;
  /** Request array index -> byte offset of the last envelope that touched it. */
  readonly requestOffsets: ReadonlyMap<number, number>;
  readonly stats: JournalStats;
}

function requestIndexTouchedBy(k: readonly PathSegment[]): number | undefined {
  if (k.length >= 2 && k[0] === 'requests' && typeof k[1] === 'number') {
    return k[1];
  }
  return undefined;
}

/**
 * Parses an already-read journal buffer into a replayed document plus
 * per-request offset attribution. Pure (no filesystem access) so it is
 * fully unit-testable against in-memory fixtures — see
 * `readJournalFile` for the thin I/O wrapper used in production.
 */
export function parseJournalBuffer(buffer: Buffer, sourceFile: string): ParsedJournal {
  const lines = splitBufferIntoLines(buffer);

  let doc: unknown;
  let malformedLines = 0;
  let unrecognisedEnvelopes = 0;
  const requestOffsets = new Map<number, number>();

  for (const line of lines) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(line.text);
    } catch {
      malformedLines += 1;
      logger.debug(
        `Skipping malformed journal line at byte offset ${String(line.offset)} in ${sourceFile}`,
      );
      continue;
    }

    if (typeof candidate !== 'object' || candidate === null || !('kind' in candidate)) {
      unrecognisedEnvelopes += 1;
      continue;
    }

    const envelope = parseEnvelope(candidate);
    if (!envelope) {
      unrecognisedEnvelopes += 1;
      continue;
    }

    const beforeLength =
      envelope.kind === 2 && envelope.k.length === 1 && envelope.k[0] === 'requests'
        ? asArray(asRecord(doc)?.requests)?.length
        : undefined;

    ({ doc } = applyEnvelope(doc, envelope));

    if (envelope.kind === 1 || envelope.kind === 2) {
      const touchedIndex = requestIndexTouchedBy(envelope.k);
      if (touchedIndex !== undefined) {
        requestOffsets.set(touchedIndex, line.offset);
      } else if (beforeLength !== undefined && envelope.kind === 2) {
        // A bare append to `requests` (a brand-new request object) — the
        // newly created indices are [beforeLength, beforeLength + n).
        const appendedCount = envelope.v.length;
        for (let i = 0; i < appendedCount; i++) {
          requestOffsets.set(beforeLength + i, line.offset);
        }
      }
    }
  }

  return {
    sourceFile,
    doc,
    requestOffsets,
    stats: { totalLines: lines.length, malformedLines, unrecognisedEnvelopes },
  };
}

/** Reads and parses a journal file from disk. See {@link parseJournalBuffer} for the pure core. */
export async function readJournalFile(filePath: string): Promise<ParsedJournal> {
  const buffer = await readFile(filePath);
  return parseJournalBuffer(buffer, filePath);
}
