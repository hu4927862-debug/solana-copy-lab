# Public distribution decisions

## 2026-10-06 — Publish a separate, clean-history source distribution

Keep the existing private archival repository and its complete evidence backup
private. Publish this independently initialized public source repository.

Retain source semantics. Improve the offline entry point, documentation,
license, reproducible public tests and CI. Do not modify the original working
directory or its journals, authorization history, policies or liability state.

Default `pnpm start` runs the offline demo. Live operational launch scripts and
private sealed dependencies are not part of the public quickstart. No API key,
wallet or provider subscription is required to evaluate the offline core.

Public distribution is not deployment, resealing, financial authorization or
reopening a previously closed research program.

## 2026-10-06 — Make the public offline workflow usable end to end

Reuse the existing classifier, risk policy, paper state and read-only report
interfaces in a synthetic example. Each invocation creates a new isolated
output directory; no real operational database or provider is loaded. Keep
rejected, duplicate and unavailable cases visible and distinguish paper ledger
arithmetic from actual costs, execution qualification and live returns.

Provide a minimal classifier integration example, evidence-linked capability
matrix and installation guidance. CI runs the public checks on Linux and
macOS with Node 24. Product source, dependencies, original risk policies and
private historical state remain unchanged. No collection or funds authority
is introduced by version 0.2.0.
