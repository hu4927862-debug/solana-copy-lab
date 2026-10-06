# What this public snapshot contains

The source originates from the existing private project; this repository has
fresh Git history. The private archive is retained separately and is not made
public by deleting files in a later commit.

## Included

- TypeScript/ESM transaction readers, normalization, strict classification,
  paper copy mechanics, risk, persistence, recovery and research projections.
- Historical `src/live` and `src/autonomous` source, for inspection.
- Offline unit, integration, recovery and decoder fixtures; SQL migrations.
- Examples, pinned package lockfile, local demo and build/test configuration.

## Excluded

- Provider/signer credentials, approvals, funds authorizations and real state.
- Private reports, run evidence, wallet watchlists, journals and SQLite files.
- Captured third-party deployment binaries and private sealed owner closures.
- Historical operational launch scripts, candidate patches, media, caches,
  editor clippings, archives and unrelated video work.
- Historical live/autonomous fixture suites that require those private assets.

## Supported checks and important limits

`pnpm test` checks only the public `test/` tree. It does not claim to run every
historical private test. Classification support is not execution support, and
its evidence model is not a universal transaction/ownership decoder.

`pnpm build` compiles TypeScript. It does not package native `.mjs` files or
supply omitted attestation data. In particular, `research-owner.mjs` still
requires its original hash-pinned closure: absence fails closed. The public
copy never substitutes a fixture, removes a guard or invents authority there.

`src/live` and `src/autonomous` are experimental source, not a working funded
quickstart. Their pinned observations are historical, not a current program
verification. Public CI does not qualify those paths or validate profitability.

The public test adaptation replaces a historical canary's wallet/config input
with a temporary synthetic input and makes one timeout test use a controlled
clock. Product source remains unchanged. Changes to package scripts and docs
apply only to this independent public distribution.
