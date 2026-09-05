# Changelog

## 0.1.0

- Added live allowance, spend, projection, session, and model indicators.
- Added selectable daily, weekly, and monthly credit/token consumption charts.
- Added keyboard-accessible point inspection and reduced-motion support.
- Added one-click dashboard and fresh-chat actions.
- Added Marketplace and activity-bar artwork plus package-local release metadata.
- Disabled activation in untrusted and virtual workspaces because the extension starts a local
	binary and reads local journal metadata.
- Standard Windows npm shims run through their Node target so timed-out refreshes do not leave the
	CLI process behind.
- Extension test files are included in the package typecheck.
