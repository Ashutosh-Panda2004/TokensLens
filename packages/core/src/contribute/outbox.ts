import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { userTokenLensDir } from '../shared/config.js';
import { pathExists, writeJsonFileAtomic } from '../shared/io.js';
import type { MonthlyContribution } from './contribution.js';

/**
 * **Where a contribution goes, and why it does not go further.**
 *
 * TokenLens makes no network calls. That is not a convenience: the binary
 * reads developers' conversations, and the case for trusting it rests on
 * there being no outbound path to review. Adding an uploader here would
 * trade the project's central claim for the saving of one manual step, and
 * it would be the *sharing* feature that did it — the one place where the
 * claim matters most.
 *
 * So a contribution is written to a local outbox and stops. Transport is a
 * separate, explicit act: the user sends the file, or a script they can read
 * does. The file is plain JSON precisely so that reviewing it before it
 * leaves is possible without any tooling.
 */
export function outboxDir(): string {
  return join(userTokenLensDir(), 'outbox');
}

export function outboxPathFor(period: string): string {
  return join(outboxDir(), `contribution-${period}.json`);
}

export async function alreadyContributed(period: string): Promise<boolean> {
  return pathExists(outboxPathFor(period));
}

export async function writeContribution(contribution: MonthlyContribution): Promise<string> {
  const path = outboxPathFor(contribution.period);
  await writeJsonFileAtomic(path, contribution);
  return path;
}

export async function listOutbox(): Promise<readonly string[]> {
  if (!(await pathExists(outboxDir()))) return [];
  const entries = await readdir(outboxDir());
  return entries.filter((name) => name.endsWith('.json')).sort();
}
