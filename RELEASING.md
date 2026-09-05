# Releasing TokenLens

Releases are built from annotated version tags by `.github/workflows/release.yml`.
Maintainer packaging uses Node.js 22 or newer; runtime CI continues to cover Node.js 20, 22, and 24.

The TokenLens runtime supports Node.js 20 and newer. Maintainer packaging uses Node.js 22 because
the current VS Code Marketplace publishing toolchain resolves Azure SDK dependencies that require
Node.js 22; those packages are development-only and are not included in the core tarball or VSIX.

## Prepare

1. Move relevant entries from `Unreleased` in [CHANGELOG.md](CHANGELOG.md) into the new version.
2. Set the same semantic version in the root, core, and VS Code package manifests.
3. With Node.js 22, run `npm ci`, `npm run format:check`, `npm run lint`, `npm run typecheck`,
   `npm run audit:production`, `npm run build`, `npm run verify:release -- X.Y.Z`, and `npm test`
   on a clean checkout.
4. Inspect `npm pack --dry-run -w @tokenslens/core` and a locally packaged VSIX.
5. Commit the release changes and create an annotated `vX.Y.Z` tag.

## Automated artifacts

Pushing the tag runs the full release gate and creates a GitHub release containing:

- the npm tarball for the MIT core/CLI;
- the VS Code extension VSIX;
- a CycloneDX software bill of materials;
- SHA-256 checksums for every artifact;
- GitHub build-provenance attestations for the complete artifact set.

The workflow intentionally does not publish to npm or the VS Code Marketplace. Registry ownership,
trusted publishing, signing policy, and marketplace publisher verification must be configured by a
maintainer before those irreversible steps are enabled. Until then, the GitHub release artifacts
are the canonical distribution.

The public package is `@tokenslens/core`; the installed executable remains `tokenlens`. The npm
scope must be created or transferred to the maintainers before registry publication.
