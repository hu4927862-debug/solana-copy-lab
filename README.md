# Solana Copy Lab

[![Offline checks](https://github.com/hu4927862-debug/solana-copy-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/hu4927862-debug/solana-copy-lab/actions/workflows/ci.yml) [![Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE) [![Node 24+](https://img.shields.io/badge/node-24%2B-43853d)](package.json)

**Understand a wallet trade before you copy it.**

An offline-first research toolkit for Solana wallet activity: conservative swap classification, exact integer amounts, paper accounting, durable risk gates, and reproducible evidence reports.

[简体中文](README.zh-CN.md) · [Quick start](#quick-start) · [Code map](#code-map) · [Contribute](#contributing)

![Solana Copy Lab architecture: transaction inputs pass through normalization and conservative classification, then into paper risk, accounting and evidence reports. The offline demo stops at classification.](docs/assets/overview.svg)

## Why this exists

A token balance change can come from a swap, a transfer, rent, a fee, or a liquidity operation. Copying the change without understanding its cause produces misleading signals. A quote used as a paper fill also leaves real execution costs and landing outcomes unresolved.

Solana Copy Lab makes those distinctions inspectable. It is useful for building transaction analysis tools, reproducing decoder bugs, checking paper position accounting, and reviewing whether a research conclusion has enough evidence behind it.

## Quick start

Use **Node.js 24 or newer** and **pnpm 11.22.0**, the version pinned in `package.json`. If your Node installation provides Corepack, `corepack pnpm` uses that pin; otherwise install the pinned pnpm version with your usual package manager.

```sh
git clone https://github.com/hu4927862-debug/solana-copy-lab.git
cd solana-copy-lab
pnpm install --frozen-lockfile
pnpm demo
pnpm test
pnpm typecheck
pnpm build
```

Installation downloads dependencies. The demo and default tests then run locally without RPC credentials or a wallet. Tests use fixed fixtures, temporary SQLite databases and, where needed, local mock servers. `better-sqlite3` is a native dependency; keep `pnpm-workspace.yaml`, which permits its build.

### What the demo shows

`pnpm demo` runs the existing normalizer and classifier against five **synthetic** transactions. It prints JSON containing:

| Case                                      | Output                                          |
| ----------------------------------------- | ----------------------------------------------- |
| Swap spending SOL and receiving a token   | `ACCEPT`, `BUY`                                 |
| Swap spending a token and receiving SOL   | `ACCEPT`, `SELL`                                |
| BUY above JavaScript's safe integer limit | Exact token raw amount `"9007199254740993"`     |
| Ordinary token transfer                   | `REJECT`, `ORDINARY_TRANSFER`, readable reason  |
| Failed transaction                        | `REJECT`, `TRANSACTION_FAILED`, readable reason |

Raw amounts stay `bigint` inside the decoder and become decimal strings in JSON. The demo opens no database and imports no network, signer, collector or sealed Research owner. Its accepted BUY is a decoded observation, not an instruction to trade.

## What you can use

| Capability                                          | Where to start                                                       | Meaning and limit                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Normalize transactions and classify swaps           | [`src/decoder`](src/decoder), [`test/fixtures`](test/fixtures)       | Uses signer, asset deltas and allow-listed swap evidence; rejects unsupported or ambiguous cases. |
| Inspect sizing and paper risk decisions             | [`src/copy`](src/copy), [`src/risk`](src/risk)                       | Deterministic copy policy, exposure limits, freshness and provider health gates.                  |
| Track paper positions and recover from interruption | [`src/persistence`](src/persistence), [`src/recovery`](src/recovery) | SQLite persistence, reservations, fill application and restart tests.                             |
| Review research evidence                            | [`src/strategy-evaluation`](src/strategy-evaluation)                 | Cost completeness, round trips, comparability, missing evidence and deterministic reports.        |
| Investigate provider behavior                       | [`src/network`](src/network), [`src/stream`](src/stream)             | Transport, pacing and stream recovery code; live use needs separate configuration.                |

The fixed fixture collection includes both synthetic cases and minimized historical snapshots. See [fixture provenance](test/fixtures/README.md). The demo uses only the synthetic cases.

## Evidence boundaries

- Decoder acceptance means the supported transaction evidence satisfies the classifier. It does not establish a qualified FOLLOW event or a safe follower trade.
- Paper fills use a declared model. A quote is not a landed fill, and paper accounting is not realized live profit.
- Missing costs and outcomes remain explicit. A verdict can be `INSUFFICIENT_EVIDENCE`; unknown values should not become zero.
- This public snapshot establishes no alpha, profitability, turnkey autonomous operation or permission to trade. The publication does not restart a collector or launch live execution.

### Experimental execution sources

`src/live` and `src/autonomous` preserve experimental transaction review, execution, signing-policy and responsibility code for inspection. They are outside the default public test suite. Private operational evidence, the pinned sealed Research dependency closure, signer credentials and program-attestation binary artifacts are **not included**.

A fresh clone cannot complete the autonomous runtime checks or execute that historical deployment. A successful TypeScript build checks source compilation; it does not supply the missing closure, copy all runtime assets, qualify execution, or confer funds authority. Review these modules as experimental source, not a ready-to-launch bot.

## More local commands

```sh
# Individual parts of the default offline suite
pnpm test:fixtures
pnpm test:unit
pnpm test:integration
pnpm test:recovery

# Decoder processing time on one fixed synthetic fixture
pnpm benchmark:latency

# Verify read-only SQLite reporting and deterministic output
pnpm exec vitest run test/integration/deterministic-evidence-report-workflow.test.ts
```

The benchmark measures local decode/classification time; it is not network or trade execution latency. The reporting test checks that the input database remains unchanged, repeated outputs are byte-identical, and missing evidence yields an insufficient-evidence verdict.

For your own immutable paper SQLite snapshot, [`scripts/evaluate-strategies.ts`](scripts/evaluate-strategies.ts) emits JSON and Markdown reports. [`config/strategy-evaluation.example.json`](config/strategy-evaluation.example.json) is a request template: replace its database, time window, identities and policy bindings before using it. A populated research database is not bundled.

## Code map

```text
src/decoder/              transaction normalization and classification
src/domain/               exact amounts, events and shared contracts
src/copy/ + src/risk/      paper decisions and admission limits
src/persistence/          SQLite state and migrations
src/recovery/             replay, interruption and exit recovery
src/strategy-evaluation/  evidence read models, metrics and reports
src/live/ + autonomous/   experimental execution sources; see limits above
test/                     offline unit, integration, recovery and fixtures
scripts/demo-offline.ts   five synthetic cases; stdout only
```

## Contributing

Useful contributions make the existing toolkit easier to understand and reproduce:

- Add minimized decoder fixtures with source provenance and an expected rejection or classification.
- Improve accounting and recovery cases around duplicate events, precision, fees and interrupted state transitions.
- Make missing evidence and unsupported cases clearer in reports and documentation.
- Improve portable installation, readable examples and CI reproducibility.

Open an issue with the input shape, expected behavior, actual output, and Node/pnpm versions. Omit credentials, signer material and private operational records. Keep changes focused and run `pnpm test`, `pnpm typecheck` and `pnpm build`. Changes to algorithms, execution scope or funds permissions require a separate design discussion.

## License

[Apache 2.0](LICENSE).
