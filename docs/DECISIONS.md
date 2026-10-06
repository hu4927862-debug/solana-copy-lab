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
