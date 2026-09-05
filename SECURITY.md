# Security Policy

TokenLens reads local developer-tool telemetry and produces policy artefacts, so data minimisation,
path safety, authentication, and output integrity are security boundaries.

## Supported versions

Security fixes target the latest published release and the current `main` branch. Before version
1.0, fixes may require upgrading to the newest minor release.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/Ashutosh-Panda2004/TokensLens/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

Include:

- affected version and operating system;
- the smallest synthetic reproduction you can provide;
- expected and observed impact;
- whether the issue exposes data, crosses a scope boundary, bypasses dashboard authentication, or
  changes an emitted policy;
- any mitigation already tested.

Do not include real prompts, completions, journals, repository paths, bearer tokens, session IDs,
organisation bundles, or other private material. Maintainers may ask for a synthetic fixture that
has the same shape.

## What happens next

Maintainers will acknowledge the report, reproduce it privately, assess affected releases, and
coordinate a fix and disclosure. No response-time SLA is promised by this community project;
enterprise support arrangements may define one separately.

Good-faith research that avoids privacy violations, service disruption, and access to other
people's data is welcome. Please allow a reasonable remediation window before disclosure.
