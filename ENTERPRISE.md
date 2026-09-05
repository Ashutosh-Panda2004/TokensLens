# Open Source and Enterprise Use

TokenLens uses one MIT-licensed codebase for individual, team, and enterprise deployments. The
enterprise path is an operating model, not a less transparent binary.

## Capability model

| Capability                       | Local use                                 | Fleet use                                         |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| Credit and token ledger          | Per workspace or machine                  | Aggregate-only organisation bundles               |
| Waste attribution and simulation | Local deterministic analysis              | Policy fit and drift across cohorts               |
| Controls                         | Workspace configuration and runtime hooks | MDM artefacts, staged rollout, holdouts, rollback |
| Reporting                        | Dashboard, JSON, Markdown, offline HTML   | Suppressed small groups and auditable manifests   |
| Data movement                    | None by default                           | Explicit export controlled by the operator        |

All capabilities above are in this repository. TokenLens has no license-key check, hidden telemetry,
or mandatory service dependency.

## Enterprise deployment checklist

1. Pin a released version and verify the published SHA-256 checksums.
2. Review [SECURITY.md](SECURITY.md) and the local-data threat model in the root README.
3. Package the core binary and extension through the organisation's approved registry.
4. Keep workspace trust enabled only for approved repositories, and manage `tokenlens.binaryPath`
	through an approved configuration layer.
5. Configure allowance, scope, retention, and managed policy channels centrally.
6. Pilot with a pre-registered holdout before fleet-wide policy enforcement.
7. Keep aggregate exports inside an approved boundary and retain their field manifests.
8. Monitor guard overrides, outcome regressions, and policy drift; preserve the generated rollback.

## Commercial boundary

Organisations may build, modify, self-host, redistribute, and support the MIT-licensed code. Paid
support, implementation, training, managed deployment, or a future hosted service may be offered
separately. Such an offering must not retroactively relicense this repository. Any future component
under different terms must live in a clearly separate package or repository, carry its own license,
and communicate with the open core through a documented interface.

This boundary keeps procurement straightforward: the software here remains inspectable and usable
without a commercial agreement, while organisations can purchase operational accountability when
they need it.
