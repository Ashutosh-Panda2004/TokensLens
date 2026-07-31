import { hashPath } from './redact.js';

/**
 * Extracts the file a tool call targeted, as a *salted hash*, from the
 * call's raw `arguments` JSON.
 *
 * This is the enabling signal for W2 (the same file read repeatedly in one
 * session) and W11 (files referenced but never opened). Without it, two
 * `read_file` calls are indistinguishable from each other and duplicate
 * retrieval is undetectable.
 *
 * **Redaction contract.** The raw `arguments` string is parsed, one path is
 * read out of it, that path is immediately hashed, and the parsed object is
 * discarded. Nothing else — not the query text, not the file content, not
 * the command line — is ever returned, stored, or logged. The raw path never
 * leaves this function. This preserves PLAN.md P1 while still letting later
 * phases answer "was this the same file?".
 *
 * The key names below are not guesses: they are the path-bearing argument
 * keys observed across ~10,000 real tool calls (`filePath` on read/write/
 * search tools, `path` on directory and memory tools, `file_path` as a
 * snake_case variant). Unknown tools simply yield no hash, which is the
 * correct degradation — a detector that cannot identify a file must not
 * pretend it can.
 */
const PATH_KEYS = ['filePath', 'file_path', 'path', 'absolutePath', 'uri'] as const;

export interface ToolCallTarget {
  readonly fileHash: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

function firstFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parses `rawArguments` and returns the hashed target file plus, when the
 * call was range-scoped, the line range. The range matters: re-reading lines
 * 1–50 and then 400–450 of the same file is not duplicate retrieval, and a
 * detector that ignored the range would report a false positive on exactly
 * the disciplined behaviour we want to encourage.
 */
export function extractToolCallTarget(
  rawArguments: string | undefined,
  salt: string,
): ToolCallTarget | undefined {
  if (!rawArguments) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    // Malformed argument JSON is not worth a warning: the model produces
    // these occasionally and the round already records a retry count.
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const args = parsed as Record<string, unknown>;

  let rawPath: string | undefined;
  for (const key of PATH_KEYS) {
    const candidate = args[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      rawPath = candidate;
      break;
    }
  }
  if (rawPath === undefined) return undefined;

  const startLine = firstFiniteNumber(args.startLine);
  const endLine = firstFiniteNumber(args.endLine);

  return {
    fileHash: hashPath(rawPath, salt),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  };
}
