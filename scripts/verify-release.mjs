import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = process.argv[2];

function readJson(relative) {
  return JSON.parse(readFileSync(join(root, relative), 'utf8'));
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function requireFile(relative) {
  requireValue(existsSync(join(root, relative)), `Missing release file: ${relative}`);
}

const workspace = readJson('package.json');
const core = readJson('packages/core/package.json');
const extension = readJson('packages/vscode/package.json');
const lock = readJson('package-lock.json');
const releaseWorkflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

requireValue(core.name === '@tokenslens/core', `Unexpected core package name: ${core.name}`);
requireValue(extension.name === 'tokenlens-vscode', `Unexpected extension name: ${extension.name}`);
requireValue(core.private !== true, 'The core package must be publishable.');
requireValue(core.publishConfig?.access === 'public', 'The core package must publish publicly.');
requireValue(core.publishConfig?.provenance === true, 'npm provenance must remain enabled.');
requireValue(workspace.engines?.npm === '>=10', 'Maintainer npm requirement drifted.');
requireValue(core.files?.includes('!dist/**/*.map'), 'Published core must exclude source maps.');
requireValue(
  core.bin?.tokenlens === 'dist/cli/index.js',
  'The tokenlens executable mapping drifted.',
);
requireValue(
  extension.devDependencies?.['@tokenslens/core'] === '*',
  'Extension/core link drifted.',
);
requireValue(
  extension.extensionKind?.includes('workspace'),
  'Extension must run with workspace trust.',
);
requireValue(
  extension.capabilities?.virtualWorkspaces?.supported === false,
  'Virtual workspaces must remain disabled.',
);
requireValue(
  extension.capabilities?.untrustedWorkspaces?.supported === false,
  'Untrusted workspaces must remain disabled.',
);
requireValue(
  core.scripts?.test?.includes('--exclude tests/hooks.performance.test.ts'),
  'Behavioral tests must exclude the isolated performance file.',
);
requireValue(
  core.scripts?.['test:performance']?.includes('--maxWorkers 1'),
  'Performance tests must run in an isolated worker.',
);
requireValue(
  workspace.scripts?.test?.includes('test:performance'),
  'Root tests must include the performance gate.',
);
requireValue(
  workspace.scripts?.['audit:production']?.includes('--omit=dev'),
  'Production dependency audit gate drifted.',
);
const qualityGate =
  releaseWorkflow.match(/- name: Quality gate\s+run: \|\s+([\s\S]*?)(?=\n\s+- name:)/)?.[1] ?? '';
requireValue(
  qualityGate.includes('VERSION="${GITHUB_REF_NAME#v}"') &&
    qualityGate.includes('npm run verify:release -- "$VERSION"'),
  'Release quality gate must derive the tag version in its own step.',
);
requireValue(
  extension.scripts?.typecheck?.includes('tests/tsconfig.json'),
  'Extension tests must remain part of the typecheck.',
);
requireValue(
  extension.scripts?.package?.startsWith('npm run build && vsce package'),
  'VSIX packaging must build explicitly without nested prepublish hooks.',
);

const versions = new Set([workspace.version, core.version, extension.version]);
requireValue(versions.size === 1, 'Workspace, core, and extension versions must match.');
if (expectedVersion !== undefined) {
  requireValue(
    core.version === expectedVersion,
    `Package version ${core.version} != ${expectedVersion}.`,
  );
}

requireValue(
  lock.packages?.['packages/core']?.name === '@tokenslens/core',
  'Core lock entry drifted.',
);
requireValue(
  lock.packages?.['packages/core']?.bin?.tokenlens === 'dist/cli/index.js',
  'Core lockfile executable mapping drifted.',
);
requireValue(
  lock.packages?.['packages/vscode']?.devDependencies?.['@tokenslens/core'] === '*',
  'Extension lock entry drifted.',
);

for (const relative of [
  'LICENSE',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'ENTERPRISE.md',
  'RELEASING.md',
  'SECURITY.md',
  'SUPPORT.md',
  'packages/core/LICENSE',
  'packages/core/README.md',
  'packages/vscode/LICENSE',
  'packages/vscode/README.md',
  'packages/vscode/CHANGELOG.md',
  'packages/vscode/SUPPORT.md',
  'packages/vscode/media/activity.svg',
  'packages/vscode/media/icon.png',
]) {
  requireFile(relative);
}

const cliSource = readFileSync(join(root, 'packages/core/src/cli/index.ts'), 'utf8');
requireValue(
  cliSource.startsWith('#!/usr/bin/env node\n'),
  'CLI source must start with a Node shebang.',
);

requireValue(extension.icon === 'media/icon.png', 'Marketplace icon path drifted.');
const activityIcon = extension.contributes?.viewsContainers?.activitybar?.[0]?.icon;
requireValue(activityIcon === 'media/activity.svg', 'Activity-bar icon path drifted.');

const png = readFileSync(join(root, 'packages/vscode', extension.icon));
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
requireValue(png.subarray(0, 8).equals(pngSignature), 'Marketplace icon is not a PNG.');
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
requireValue(
  width === height && width >= 128,
  `Marketplace icon must be square and >=128px, got ${width}x${height}.`,
);

const activity = readFileSync(join(root, 'packages/vscode', activityIcon), 'utf8');
requireValue(/viewBox=["']0 0 24 24["']/.test(activity), 'Activity icon must use a 24px viewBox.');
const passiveActivity = activity.replace(/xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/i, '');
requireValue(
  !/<script|<foreignObject|\bhref=|https?:|data:/i.test(passiveActivity),
  'Activity icon contains active or external content.',
);
const colours = new Set(activity.match(/#[0-9a-f]{6}/gi) ?? []);
requireValue(colours.size === 1, 'Activity icon must use exactly one colour.');

console.log(`Release metadata verified for TokenLens ${core.version}.`);
