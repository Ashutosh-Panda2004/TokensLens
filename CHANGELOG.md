# Changelog

Notable changes to TokenLens are recorded here. The format follows Keep a Changelog, and releases
use semantic versioning once the public API reaches 1.0.

## [Unreleased]

### Added

- Selectable daily, weekly, and monthly credit and token consumption charts in the VS Code sidebar.
- Package-local extension tests and reproducible VSIX tooling.
- Open-source contribution, security, support, conduct, enterprise-boundary, and release policies.
- CodeQL, Dependabot, structured issue forms, release checksums, SBOMs, and provenance attestations.
- Marketplace and activity-bar artwork, plus automated release-metadata validation.
- Explicit workspace-trust and virtual-workspace restrictions for the VS Code extension.
- Production dependency audit and pull-request dependency-review gates.

### Changed

- The MIT-licensed core is now a publishable `@tokenslens/core` package that installs the
  `tokenlens` command.
- Package and marketplace metadata now link to the canonical repository and issue tracker.
- Fastify and its URI parser dependencies were updated to versions with zero known production
  advisories at validation time.
- Hook CPU-budget checks now run in an isolated worker instead of competing with behavioral test
  workers or coverage instrumentation.
- npm and VSIX publication lifecycles now build without recursive npm hooks; the packed core
  retains the `tokenlens` executable and verifies its Node shebang before release.
- Public npm tarballs exclude source maps while local development builds retain them.
- Standard Windows npm shims now run through their Node target so a timed-out HUD refresh cannot
  leave the CLI process behind.
- Extension test files are now included in the enforced TypeScript check.

## [0.1.0] - 2026-09-03

### Added

- Initial preview of the local credit ledger, dashboard, waste attribution, simulation, policy,
  runtime guard, holdout, organisation, outcome, and VS Code HUD capabilities.

[Unreleased]: https://github.com/Ashutosh-Panda2004/TokensLens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Ashutosh-Panda2004/TokensLens/releases/tag/v0.1.0
