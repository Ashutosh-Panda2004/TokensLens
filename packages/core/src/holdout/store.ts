import { join } from 'node:path';
import { tokenLensDir } from '../shared/config.js';
import { pathExists, writeJsonFileAtomic } from '../shared/io.js';
import { readFile } from 'node:fs/promises';
import { ConfigError } from '../shared/errors.js';
import type { HoldoutDesign } from './assignment.js';
import type { PreregistrationDocument } from './preregistration.js';
import { hashPreregistration } from './preregistration.js';

/**
 * Where the experiment lives on disk.
 *
 * A single file, committed to the repository, deliberately. The commitment
 * device in `preregistration.ts` only works if the registration is
 * somewhere a reviewer can find it and a diff would show it changing; a
 * design held in someone's spreadsheet has all the same fields and none of
 * the same force.
 */
export const HOLDOUT_FILE_NAME = 'holdout.json';

export interface HoldoutRecord {
  readonly version: 1;
  readonly design: HoldoutDesign;
  readonly preregistration: PreregistrationDocument;
  /** When the policy was first pushed. Undefined until it is. */
  readonly deployedAt?: string;
}

export function holdoutPath(cwd: string = process.cwd()): string {
  return join(tokenLensDir(cwd), HOLDOUT_FILE_NAME);
}

export async function readHoldout(cwd: string = process.cwd()): Promise<HoldoutRecord | undefined> {
  const path = holdoutPath(cwd);
  if (!(await pathExists(path))) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    // Loud, per S5. A corrupt experiment file must not silently become "no
    // experiment", because "no experiment" is indistinguishable from a
    // clean slate and would invite a fresh randomisation.
    throw new ConfigError(
      `The holdout design at ${path} is not valid JSON.`,
      { reason: 'experiment-integrity', filePath: path },
      { cause: error },
    );
  }

  // Validated structurally rather than trusted: the file is on disk, has
  // been through a merge or two, and may predate the current shape.
  const record = parsed as Partial<HoldoutRecord>;
  if (record.version !== 1 || !record.design || !record.preregistration) {
    throw new ConfigError(`The holdout design at ${path} is missing required fields.`, {
      reason: 'experiment-integrity',
      filePath: path,
    });
  }
  return record as HoldoutRecord;
}

/**
 * Refuses to overwrite an existing design.
 *
 * This is the single most important line in the file. Re-randomising after
 * seeing early results is the most effective way to manufacture whichever
 * conclusion is wanted, and it never looks like misconduct from the inside
 * — it looks like fixing an unlucky draw. Amending the design has to be an
 * explicit, visible act.
 */
export async function writeHoldout(
  record: HoldoutRecord,
  cwd: string = process.cwd(),
  options: { readonly force?: boolean } = {},
): Promise<string> {
  const path = holdoutPath(cwd);
  if (options.force !== true && (await pathExists(path))) {
    throw new ConfigError(
      `A holdout design already exists at ${path}. Re-randomising after the experiment has started ` +
        'discards the pre-registration, so this is refused by default. Pass --force if the experiment ' +
        'is genuinely being restarted, and expect to explain the new hash.',
      { reason: 'experiment-integrity', filePath: path },
    );
  }
  await writeJsonFileAtomic(path, record);
  return path;
}

export interface RecordIntegrity {
  readonly intact: boolean;
  readonly detail: string;
}

/**
 * Has the registration been edited since it was written?
 *
 * Checked on every read rather than only on demand, because an integrity
 * check nobody runs is decoration.
 */
export function checkIntegrity(record: HoldoutRecord): RecordIntegrity {
  const actual = hashPreregistration(record.preregistration.registration);
  return actual === record.preregistration.hash
    ? { intact: true, detail: `Registration hash ${actual.slice(0, 12)}… matches its contents.` }
    : {
        intact: false,
        detail:
          `Registration hash mismatch: the file records ${record.preregistration.hash.slice(0, 12)}… ` +
          `but its contents hash to ${actual.slice(0, 12)}…. The registration has been edited since it ` +
          'was written and no longer evidences anything. Every result from this experiment is exploratory.',
      };
}
