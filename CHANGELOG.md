# Changelog

## 0.3.0

- Add an offline replay of four existing provider-neutral transaction snapshots
  with file hashes, explicit owner provenance, exact amounts, principal evidence
  and separate chain/replay clocks. Original RPC capture provenance is not
  invented when it is unavailable.
- Strengthen the eight minimized snapshot tests with literal owner, direction,
  mint and raw-amount expectations.
- Add synthetic-message checks through the existing independent transaction
  reviewer. The shape control remains blocked on missing CPI evidence; this is
  guard coverage, not complete transaction or execution qualification.
- Document DEX recognition, quote-route retention and historical execution
  source separately, including unsupported formats and direct Orca parsing.
- Preserve all product source, dependencies, fixture originals, policies and
  private state. No RPC, quote request, collector, signer or trading authority
  is introduced.

## 0.2.0

- Add a complete synthetic offline example through the existing classifier,
  paper risk, SQLite accounting and deterministic evidence report.
- Add a minimal classifier usage example and an evidence-linked capability
  matrix with explicit unsupported and unverified behavior.
- Improve English/Chinese onboarding and installation troubleshooting.
- Run the supported offline checks on Linux and macOS with Node 24.
- Preserve product source, dependencies and risk/authority semantics. This is
  an offline tooling release, not a collector launch, execution deployment,
  strategy validation or funds authorization.

## 0.1.0

- Publish the research core and historical experimental source under Apache
  2.0 with clean public history and private operational evidence excluded.
- Add the five-case synthetic classifier demo, public offline tests and CI.
