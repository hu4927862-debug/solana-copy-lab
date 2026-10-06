# Contributing

Start with the offline path. Node.js 24+ and pnpm 11.22.0 are required.

```sh
pnpm install --frozen-lockfile
pnpm demo
pnpm check
```

The tests use fixed inputs, mocks and temporary SQLite databases. Some test
servers bind loopback ports. No production provider or wallet is required.

Small, useful contributions include reproducible decoder counterexamples,
exact-integer edge cases, evidence completeness and documentation improvements.
Provide a sanitized fixture and a failing focused test before changing behavior.
Unknown, rejected and failed observations must stay visible in denominators.

Do not include API keys, provider URLs containing credentials, wallet secrets,
real authorization documents, private journals or raw operational databases.
A public address alone does not prove ownership. A quote is not a realized fill.

`src/live` and `src/autonomous` contain historical experimental safety/execution
source. They are not runnable deployments: private sealed dependencies and
third-party deployment captures are omitted. Changes there need independent
review; never weaken a guard to make a missing artifact pass. No contribution,
CI result, license or merged patch grants financial authority.

Run the focused test for a change, then `pnpm check`. Commit lockfile changes
only when a dependency change is intentional. Preserve Apache-2.0 attribution.
