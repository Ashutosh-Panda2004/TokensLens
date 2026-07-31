import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashPath } from '../ingest/redact.js';
import { hashIdentifier } from '../privacy/identifiers.js';

const run = promisify(execFile);

/**
 * Reading outcomes out of a git repository, without ever holding a name,
 * an e-mail address, or a file path.
 *
 * ## Why git and not the forge API
 *
 * A pull-request API gives richer data — reviewer identity, comment counts,
 * approval timestamps — and requires a token, a network call, and a
 * per-forge integration. Git gives less, needs none of those, and is
 * present in every enterprise regardless of whether it uses GitHub,
 * Azure DevOps or Bitbucket.
 *
 * So this reads git, and is explicit about what git cannot answer. Review
 * *latency* is recoverable from a merge commit; reviewer *effort* is not,
 * and is declared unavailable rather than approximated by latency. Those
 * are different quantities and treating them as one would put an
 * unsupportable number at the centre of the whole phase.
 *
 * ## The join
 *
 * File paths are hashed with `hashPath` and the **same per-install salt**
 * the credit ledger already uses for tool-call targets. That is what makes
 * `outcomes` joinable to `waste` and `ledger` at all: the same file has the
 * same hash on both sides, and neither side ever stores the path.
 */
export interface FileChange {
  /** Salted hash — the join key to `tool_call.target_file_hash`. */
  readonly pathHash: string;
  /** Extension, kept in the clear. It is a language, not an identifier. */
  readonly extension: string;
  readonly added: number;
  readonly deleted: number;
}

export interface CommitRecord {
  readonly sha: string;
  /**
   * Salted hash of the author's e-mail. Hashed here and the raw value
   * discarded, exactly as session ids are — this is the field that would
   * turn the phase into a surveillance tool if it survived.
   */
  readonly authorId: string;
  readonly ts: number;
  readonly parents: readonly string[];
  readonly isMerge: boolean;
  /** Pull-request number, when the merge subject reveals one. */
  readonly pullRequest?: number;
  /** SHA this commit reverts, when it is a revert. */
  readonly revertsSha?: string;
  readonly files: readonly FileChange[];
}

export interface GitLogOptions {
  readonly cwd: string;
  /** Only commits after this instant. Defaults to the whole history. */
  readonly since?: Date;
  readonly maxCommits?: number;
}

/**
 * Field separator. `\x1f` (ASCII unit separator) cannot appear in a commit
 * subject, so parsing needs no escaping rules and no quoting bugs.
 */
const FIELD = '\u001f';
const RECORD = '\u001e';

const FORMAT = ['%H', '%P', '%ae', '%at', '%s'].join(FIELD);

/** `Revert "..."` bodies carry `This reverts commit <sha>.` */
const REVERT_PATTERN = /This reverts commit ([0-9a-f]{7,40})/i;
/** GitHub, GitLab and Azure DevOps merge subjects all carry the number this way. */
const PR_PATTERNS = [
  /Merge pull request #(\d+)/i,
  /Merged PR (\d+)/i,
  /\(#(\d+)\)\s*$/,
  /See merge request \S+!(\d+)/i,
];

export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

const defaultRunner: GitRunner = async (args, cwd) => {
  const { stdout } = await run('git', [...args], {
    cwd,
    // Histories are large and the buffer default is not.
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  return stdout;
};

/**
 * Reads the repository's commit history into privacy-safe records.
 *
 * `--numstat` gives per-file added/deleted counts; `-m` would expand merge
 * commits into per-parent diffs, which double-counts, so merges are read
 * without their diff and the work is attributed to the commits they bring
 * in. A merge is a *boundary*, not a change.
 */
export async function readGitHistory(
  options: GitLogOptions,
  salt: string,
  runner: GitRunner = defaultRunner,
): Promise<CommitRecord[]> {
  const args = [
    'log',
    `--pretty=format:${RECORD}${FORMAT}`,
    '--numstat',
    '--no-renames',
    '--date-order',
  ];
  if (options.since) args.push(`--since=${options.since.toISOString()}`);
  if (options.maxCommits !== undefined) args.push(`-n${String(options.maxCommits)}`);

  const stdout = await runner(args, options.cwd);
  const bodies = await readRevertBodies(options, runner);

  return parseGitLog(stdout, salt, bodies);
}

/**
 * Revert targets live in the commit *body*, which the main format omits to
 * keep the output small. Only revert commits need it, so they are fetched
 * separately with a grep rather than by widening every record.
 */
async function readRevertBodies(
  options: GitLogOptions,
  runner: GitRunner,
): Promise<Map<string, string>> {
  const args = [
    'log',
    `--pretty=format:${RECORD}%H${FIELD}%b`,
    '--grep=This reverts commit',
    '--extended-regexp',
  ];
  if (options.since) args.push(`--since=${options.since.toISOString()}`);

  const bodies = new Map<string, string>();
  try {
    const stdout = await runner(args, options.cwd);
    for (const record of stdout.split(RECORD)) {
      if (!record.trim()) continue;
      const [sha, body] = record.split(FIELD);
      if (sha !== undefined && body !== undefined) bodies.set(sha.trim(), body);
    }
  } catch {
    // A repository with no reverts, or a git that dislikes the grep, is not
    // an error — it means no revert evidence, which the report will say.
  }
  return bodies;
}

export function parseGitLog(
  stdout: string,
  salt: string,
  revertBodies: ReadonlyMap<string, string> = new Map(),
): CommitRecord[] {
  const commits: CommitRecord[] = [];

  for (const record of stdout.split(RECORD)) {
    if (!record.trim()) continue;

    const newline = record.indexOf('\n');
    const headerLine = newline === -1 ? record : record.slice(0, newline);
    const rest = newline === -1 ? '' : record.slice(newline + 1);

    const [sha, parentList, email, epoch, subject] = headerLine.split(FIELD);
    if (sha === undefined || email === undefined || epoch === undefined) continue;

    const parents = (parentList ?? '').trim() === '' ? [] : (parentList ?? '').trim().split(' ');
    const files = parseNumstat(rest, salt);
    const body = revertBodies.get(sha) ?? '';
    const revertsSha = REVERT_PATTERN.exec(`${subject ?? ''}\n${body}`)?.[1];
    const pullRequest = matchPullRequest(subject ?? '');

    commits.push({
      sha,
      authorId: hashIdentifier(email.trim().toLowerCase(), salt),
      ts: Number.parseInt(epoch, 10) * 1000,
      parents,
      isMerge: parents.length > 1,
      files,
      ...(pullRequest !== undefined ? { pullRequest } : {}),
      ...(revertsSha !== undefined ? { revertsSha } : {}),
    });
  }

  return commits;
}

function matchPullRequest(subject: string): number | undefined {
  for (const pattern of PR_PATTERNS) {
    const match = pattern.exec(subject);
    if (match?.[1] === undefined) continue;
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * `--numstat` lines are `added<TAB>deleted<TAB>path`. Binary files report
 * `-` for both counts; they are kept, with zero line counts, because a
 * binary asset is still a touched file for rework purposes even though its
 * size tells us nothing.
 */
function parseNumstat(block: string, salt: string): FileChange[] {
  const files: FileChange[] = [];

  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [addedRaw, deletedRaw, path] = parts;
    if (path === undefined) continue;

    files.push({
      pathHash: hashPath(path, salt),
      extension: extensionOf(path),
      added: addedRaw === '-' ? 0 : Number.parseInt(addedRaw ?? '0', 10) || 0,
      deleted: deletedRaw === '-' ? 0 : Number.parseInt(deletedRaw ?? '0', 10) || 0,
    });
  }

  return files;
}

/**
 * A file extension is a statement about language, not about a person, and
 * it is what lets a change be classified as source, test or configuration.
 * Everything before the final dot is dropped.
 */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** True when this looks like a git working tree. */
export async function isGitRepository(
  cwd: string,
  runner: GitRunner = defaultRunner,
): Promise<boolean> {
  try {
    const stdout = await runner(['rev-parse', '--is-inside-work-tree'], cwd);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
