# Contributing to TokenLens

Thank you for improving TokenLens. Contributions to code, tests, documentation, detectors, and
privacy controls are welcome.

## Before opening an issue

- Search existing issues and discussions first.
- Never attach a real VS Code journal, prompt, completion, file path, session identifier, access
  token, or organisation export.
- Use a minimal synthetic fixture when a bug depends on ledger data.
- Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development setup

TokenLens runtime development requires Node.js 20 or newer and npm 10 or newer. Use Node.js 22 when
packaging the VS Code extension; the current Marketplace tooling resolves development-only Azure SDK
packages that require it.

```powershell
git clone https://github.com/Ashutosh-Panda2004/TokensLens.git
cd TokensLens
npm ci
npm run build
npm test
```

Useful focused commands:

```powershell
npm run test -w @tokenslens/core -- hud.test.ts
npm run test:performance -w @tokenslens/core
npm run test -w tokenlens-vscode
npm run typecheck
npm run lint
npm run format:check
npm run verify:release
```

## Engineering requirements

1. Keep the core deterministic: no network calls, model calls, or telemetry egress.
2. Preserve provenance. A measured value and an estimate must remain distinguishable in types and
   presentation.
3. Minimise retained data. Do not add prompt text, response text, raw paths, tool arguments, or raw
   session identifiers to the normalised model.
4. Fail open in runtime hooks and fail loud in reporting. A guard must not break the developer's
   agent, while a missing measurement must never become a silent zero.
5. Keep the VS Code extension thin. Aggregation and policy decisions belong in the core snapshot;
   the extension formats and renders them.
6. Add focused tests for changed behavior and keep unrelated refactors out of the pull request.
7. Maintain Node.js 20 compatibility even when developing on a newer runtime.

## Pull requests

Open a pull request against `main`. Explain the user-visible behavior, privacy impact, validation
performed, and any compatibility or migration concern. Screenshots are useful for UI changes, but
must contain synthetic data.

By submitting a contribution, you agree that it is licensed under the repository's MIT license and
that you have the right to submit it.
