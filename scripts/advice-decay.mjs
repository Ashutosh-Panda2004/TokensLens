#!/usr/bin/env node
/**
 * D11 §6.2 — the catalogue decay check.
 *
 * ## What this is allowed to do
 *
 * Read four objective fields per entry from the GitHub API — default-branch last
 * commit date, latest release date, SPDX licence, `archived` flag — compare them
 * against what the dataset records, and write a Markdown report. The workflow
 * then opens an issue.
 *
 * ## What this is not allowed to do, ever
 *
 * Edit `catalogue.data.ts`. Open a pull request. Add an entry. Promote one to
 * `recommended`. Change an owner, a repository URL, a licence or an install
 * command.
 *
 * That boundary is not squeamishness. While this feature was being designed,
 * agent-collected repository metadata produced three plausible-looking errors —
 * a wrong owner, an implausible star count, a second wrong owner — none of which
 * a schema check, a type or a lint rule would have caught, and one of which
 * would have sent a developer to the wrong repository. That is the worst failure
 * mode a recommendation engine has: it turns a helpful suggestion into a
 * supply-chain hazard. So automation reports, and a human decides.
 *
 * It also lives here rather than in `packages/core`, so the shipped binary
 * contains no code capable of fetching anything. `arch.test.ts` enforces that
 * half of the rule; this file's location enforces the other.
 *
 * Exits 0 whether or not anything decayed. Decay is a curation task, not a
 * broken build.
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import {
  CATALOGUE,
  MAX_MONTHS_SINCE_COMMIT,
  MAX_MONTHS_SINCE_RELEASE,
  MAX_MONTHS_SINCE_VERIFICATION,
} from '../packages/core/dist/index.js';

const API = 'https://api.github.com';
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

function monthsBetween(from, to) {
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  return to.getUTCDate() < from.getUTCDate() ? months - 1 : months;
}

function repoPath(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

async function api(path) {
  const response = await fetch(`${API}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'tokenlens-advice-decay',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${path} → ${String(response.status)}`);
  return response.json();
}

/** Every observation is reported next to what the dataset claims. Nothing is silently accepted. */
async function observe(entry) {
  const path = repoPath(entry.repository);
  if (path === undefined) {
    return {
      entry,
      problems: [`repository URL is not a canonical GitHub URL: ${entry.repository}`],
    };
  }

  const now = new Date();
  const problems = [];

  const repo = await api(`/repos/${path}`);
  if (repo === undefined) {
    return { entry, problems: ['repository returned 404 — moved, renamed or deleted'] };
  }
  if (repo.archived === true) problems.push('upstream has archived the repository');

  const recordedLicence = entry.licence;
  const observedLicence = repo.license?.spdx_id;
  if (observedLicence && observedLicence !== recordedLicence) {
    problems.push(`licence is now ${observedLicence}; the dataset records ${recordedLicence}`);
  }

  if (repo.pushed_at) {
    const months = monthsBetween(new Date(repo.pushed_at), now);
    if (months > MAX_MONTHS_SINCE_COMMIT) {
      problems.push(
        `last push was ${String(months)} months ago, over the ${String(MAX_MONTHS_SINCE_COMMIT)}-month limit`,
      );
    }
  }

  const releases = await api(`/repos/${path}/releases/latest`);
  if (releases?.published_at) {
    const months = monthsBetween(new Date(releases.published_at), now);
    if (months > MAX_MONTHS_SINCE_RELEASE) {
      problems.push(
        `latest release ${releases.tag_name ?? ''} was ${String(months)} months ago, over the ${String(MAX_MONTHS_SINCE_RELEASE)}-month limit`,
      );
    }
  } else if (entry.status !== 'deprecated') {
    problems.push('upstream publishes no releases');
  }

  const verified = monthsBetween(new Date(`${entry.verification.checkedOn}T00:00:00Z`), now);
  if (verified > MAX_MONTHS_SINCE_VERIFICATION) {
    problems.push(
      `last human verification was ${String(verified)} months ago, over the ${String(MAX_MONTHS_SINCE_VERIFICATION)}-month limit`,
    );
  }

  return { entry, problems };
}

const results = [];
for (const entry of CATALOGUE) {
  // Deprecated entries are still checked: an archived project coming back to
  // life is exactly the sort of thing a human should be told about.
  try {
    results.push(await observe(entry));
  } catch (error) {
    results.push({ entry, problems: [`check failed: ${error.message}`] });
  }
}

const stale = results.filter((result) => result.problems.length > 0);

const report = [
  '## Advice catalogue decay report',
  '',
  `Checked ${String(CATALOGUE.length)} entr${CATALOGUE.length === 1 ? 'y' : 'ies'} on ${new Date().toISOString().slice(0, 10)}.`,
  '',
  '**This issue is a prompt for a human, not a change.** Nothing has been edited.',
  'Per D11 §6.2, automation may notice decay and may not act on it: identity fields',
  'are security-relevant and automated collection has already been shown to get them',
  'wrong in a plausible-looking way.',
  '',
  ...(stale.length === 0
    ? ['No entry breached a freshness rule.']
    : stale.flatMap(({ entry, problems }) => [
        `### ${entry.id} — ${entry.repository}`,
        `status \`${entry.status}\` · verified ${entry.verification.checkedOn} by ${entry.verification.checkedBy}`,
        '',
        ...problems.map((problem) => `- ${problem}`),
        '',
      ])),
  '',
  '### What to do',
  '',
  '1. Confirm each fact against the repository yourself.',
  '2. Update `packages/core/src/advice/catalogue.data.ts` in a pull request.',
  '3. Rule-2 breach → `caution`. Unresolved next cycle → `deprecated`, with the reason recorded.',
  '4. Removal only on a licence change away from OSI, or on upstream archival.',
].join('\n');

writeFileSync('decay-report.md', `${report}\n`, 'utf8');

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `stale=${stale.length > 0 ? 'true' : 'false'}\ncount=${String(stale.length)}\n`,
    'utf8',
  );
}

console.log(report);
