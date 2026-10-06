# Offline usage and troubleshooting

The supported public workflow uses synthetic inputs, local computation and a
new disposable SQLite database. It does not read provider keys, connect to RPC,
build a live transaction, simulate on chain, sign or send. Installation still
downloads npm dependencies; offline execution begins after installation.

## Install the pinned toolchain

Use Node **24** and pnpm **11.22.0** for the tested setup. The package engine
allows newer Node versions, but that is not a claim that every version has been
verified. Check what your shell actually resolves:

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
```

The package-manager pin lives in `package.json`. Corepack is optional and is not
bundled with every Node installation. If you already use Corepack, its pnpm
command reads the pin; otherwise use your normal package-manager installation
method to select pnpm 11.22.0. Do not regenerate the lockfile just to resolve an
environment mismatch.

Public CI declares Node 24 checks on Linux and macOS; check the [actual workflow
results](https://github.com/hu4927862-debug/solana-copy-lab/actions/workflows/ci.yml)
for a particular commit. Local installation and execution have also been checked
on an Apple Silicon Mac with Node 24.21.0 and pnpm 11.22.0. This is not a Windows
compatibility claim or a live operational qualification.

## Choose a local entry point

```sh
# Five classification cases, stdout JSON only; no SQLite
pnpm demo

# Small TypeScript example using the same classifier
pnpm example:classify

# Classification → paper risk → persisted fills → evidence report
pnpm demo:workflow

# Four saved provider-neutral JSON inputs; separate chain and replay clocks
pnpm demo:replay

# Synthetic bytes through the actual reviewer; missing CPI evidence must block
pnpm demo:review

# Optional: write workflow artifacts to an explicitly NEW directory
pnpm demo:workflow --output ./offline-example

# Evaluate that closed snapshot through its generated request
pnpm evaluate:strategies ./offline-example/EVALUATION-REQUEST.json

# Type checking, source build, fixed tests and the supported examples
pnpm check
```

The workflow prints its actual output location. The default is a fresh temporary
directory; an explicit output directory must not already exist. This prevents a
demo from overwriting previous results or using a supplied operational database.
`pnpm start` remains the five-case classification demo.

## Saved-input replay and byte-review demonstration

`pnpm demo:replay` reads the four `v5-*.json` files listed in
[fixture provenance](../test/fixtures/README.md). It prints source-file identity,
chain time, a distinct local replay clock, exact amounts and principal evidence.
It neither fetches a transaction nor writes an observation into an operational
Store. The replay clock is not the time the historical follower first knew the
transaction. File hashes bind this replay input, not an omitted original RPC
capture or an independently complete ownership audit.

The stdout contract is `OFFLINE_SNAPSHOT_REPLAY_V1`. For each snapshot inspect
`sourceSha256`, `signature`/`slot`, `chainTimeMs`, `replayedAtMs`,
`replayReceiptKind`, `fixtureOwner`/`ownerBasis`, payer/signers and
`walletNativeDeltaRaw`. Accepted rows additionally contain `tokenRaw`, `quoteRaw`
and principal `evidence`; native wallet delta is not automatically swap principal.
`originalRpcReceipt` and `historicalFirstObservedAt` remain `UNKNOWN`. Negative
controls mutate proof/caller inputs and remain labeled synthetic controls.

The checked-in inputs currently yield these exact classifier amounts; this is
replay of the published representation, not fresh independent chain verification:

| Snapshot                               | Side | Token raw        | Quote input / proceeds raw (lamports) |
| -------------------------------------- | ---- | ---------------- | ------------------------------------- |
| `v5-native-sol-with-rent`              | BUY  | `418484406419`   | `5000000`                             |
| `v5-jupiter-buy-with-refund`           | BUY  | `52614039669334` | `997037`                              |
| `v5-jupiter-sell-with-output-fee`      | SELL | `21178399997852` | `7816843`                             |
| `v5-jupiter-full-sell-with-output-fee` | SELL | `944791432947`   | `1230294`                             |

`pnpm demo:review` passes **synthetic unsigned bytes** to the existing
`reviewTransaction` / `decodeWire` checks and exercises signature-message
rejection boundaries. The reference shape reaches `CPI_EVIDENCE_REQUIRED`:
this is an `EXPECTED_BLOCK`, not a successful transaction review. It does not
download attestation binaries, create independent CPI evidence, perform chain
simulation or invoke a signer. Expiry, Journal responsibility, real authorization
and live signer/POST qualification are not established by this demo.

Its stdout schema is `PUBLIC_OFFLINE_REVIEW_GUARDS_V1`; all nine cases report
`EXPECTED_BLOCK`, and `completeTransactionReview` remains
`NOT_PASSED_MISSING_CPI_EVIDENCE`. Expected errors include missing CPI evidence,
wrong wallet/program/account/amount/slippage, exceeded network-fee budget, changed message at signature intake
and absent signature. No real signature is generated or accepted.

These two stdout examples complement the paper workflow. They do not make all
protocols supported; see [DEX boundaries](DEX-SUPPORT.md). Complete historical
runtime closure and funded operation remain excluded.

## Read the workflow output

| Artifact                         | What to inspect                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SUMMARY.json`                   | Case results, risk rejection reasons, quote-provider call count and paper position state.                            |
| `SYNTHETIC-INPUTS.json`          | Fixed synthetic input provenance; these are not new chain observations.                                              |
| `SYNTHETIC-QUOTES.json`          | In-memory mock quote inputs and outputs, with exact decimal-string amounts. No provider request occurs.              |
| `paper.sqlite`                   | Disposable paper state created by this run using the existing migrations and Store.                                  |
| `EVALUATION-REQUEST.json`        | When Git `HEAD` resolves: `OFFLINE_EVALUATION_REQUEST_V1`, closed snapshot SHA256, evidence kind and report context. |
| `report/evidence-report-v1.json` | Machine-readable evidence report and explicit insufficiency.                                                         |
| `report/evidence-report-v1.md`   | Human-readable report from the same read-only reporting owner.                                                       |
| `MANIFEST.json`                  | Artifact identity and file hashes for checking what was produced.                                                    |

The cases include a BUY, duplicate replay, excessive impact, missing impact,
stale intent, ordinary transfer and FULL SELL. A paper position can close in the
model while the strategy report remains `INSUFFICIENT_EVIDENCE`. Missing real
network fees, tip, landing and fill evidence must not become a claim of realized
net profit. Read the JSON and report before treating a green command as evidence
for a particular capability.

The demo uses the existing **paper** policy example. Its separately defined
BUY/SELL caps are not the historical Money Lane authorization. This command
does not change either policy or confer permission to trade.

## Evaluate a saved snapshot

`pnpm evaluate:strategies ./offline-example/EVALUATION-REQUEST.json` verifies
the generated snapshot hash and evaluates its own temporary copy. Relative
paths resolve from the request directory. The output location must be new;
the default generated request uses `re-evaluated` within the example directory.
Stdout lists the actual report paths and all requested evaluation buckets,
including missing evidence and cost limitations.

The new evaluation directory contains `evidence-report-v1.json`,
`evidence-report-v1.md`, `SUMMARY.json` and `MANIFEST.json`. The summary includes
request/snapshot/entry-point identities and unknown live costs. The manifest
binds output files. A Git checkout with a resolvable `HEAD` generates the reusable
request. Archives without a source revision still run the synthetic workflow,
but report `SOURCE_REVISION_UNAVAILABLE` and do not supply a reusable request.

For an existing dataset, start with
[`config/strategy-evaluation.example.json`](../config/strategy-evaluation.example.json).
Only a closed, complete independent snapshot is suitable; an active database
with uncheckpointed WAL is not. The CLI rejects nonempty WAL/journal sidecars
and mismatched snapshot bytes rather than changing the input. The evidence-kind
and source-commit fields are declarations; a hash binds bytes but does not
authenticate their capture history or prove a sealed runtime closure.

Read [EVIDENCE-EVALUATION.md](EVIDENCE-EVALUATION.md) before interpreting a
verdict. This entry point reviews fixed paper evidence and retains the existing
policy. It does not fit a signal, test alpha or turn `POSITIVE_CANDIDATE` into
execution qualification. Paper cost completeness does not establish real fill,
network/tip or failed-execution costs. Keep operational databases and financial
approvals private; a real dataset is not supplied with this example.

## Reuse classification in TypeScript

Read the complete runnable [example](../examples/classify-transaction.ts). Its
essential call uses the existing classes:

```ts
const result = new SwapClassifier().classify(
  new TransactionNormalizer(clock).normalize(envelope),
  observedWallet,
);

if (!result.accepted) {
  // Keep the original rejection code and details in your research denominator.
  console.log(result.code, result.details);
} else {
  // Exact raw quantities are bigint. Do not convert them to Number.
  console.log(result.event.side, result.event.token.raw.toString());
}
```

Here `envelope.payload` must satisfy the project's
[`RawTransaction` schema](../src/decoder/raw-transaction.ts). It is not arbitrary
JSON-RPC or an explorer response. The example constructs the envelope explicitly
and uses a fixed clock with labeled synthetic receipt times. For an input you
already possess, retain its source identity and the time/provenance actually
available to your observer. Do not stamp an old transaction as a fresh signal.

The classifier takes a wallet supplied by the caller and checks signer and
owner-scoped evidence within its supported scope. Passing the fee payer as that
wallet does not establish it as asset owner. Accepted classification is not
FOLLOW, a safe token, execution support or funding approval. Imports here are
source-level examples, not a promised stable published npm API.

## Troubleshooting

| Symptom                                                      | Smallest useful check / action                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unsupported Node engine or syntax                            | Check `node --version` and your PATH. Use the tested Node 24 toolchain; avoid changing source or loosening engines to mask it.                                                                                                                                                                                           |
| pnpm version mismatch or lockfile rejection                  | Check `pnpm --version`; use the pinned 11.22.0. Keep `--frozen-lockfile` and the checked-in lockfile.                                                                                                                                                                                                                    |
| `ERR_PNPM_IGNORED_BUILDS`                                    | Keep `pnpm-workspace.yaml`: required `better-sqlite3` and `esbuild` builds are explicitly allowed; optional accelerators are explicitly denied. Do not enable every dependency build script.                                                                                                                             |
| Cannot load `better_sqlite3.node` / ABI mismatch             | Confirm dependency installation used the same Node major and architecture as execution. After correcting that, reinstall from the lockfile; if the original build was interrupted, `pnpm rebuild better-sqlite3` uses the checked-in allowlist. Do not copy a native binary from another machine.                        |
| SQLite native source build fails                             | Save the first actual build error. If there is no usable prebuilt artifact for the environment, the native build needs Python, a C/C++ compiler and the platform build tools. On macOS this commonly means Command Line Tools; on Linux the corresponding toolchain. No global scanner or new runtime service is needed. |
| Network or metadata error during installation                | This is dependency acquisition, not a failed offline demonstration. Keep the pinned versions and fix the package-manager/environment issue; do not disable integrity controls or introduce a substitute provider.                                                                                                        |
| Workflow refuses an output path                              | Use a new directory or omit `--output`. It deliberately refuses reuse rather than changing an existing database.                                                                                                                                                                                                         |
| Evaluator rejects a snapshot or request                      | Verify `OFFLINE_EVALUATION_REQUEST_V1`, the exact SHA256 and persisted context. Use a closed, checkpointed independent snapshot and a new output directory; do not delete live WAL or alter evidence to bypass the check.                                                                                                |
| Experimental autonomous startup reports missing sealed files | Expected for a fresh public clone. See [public snapshot limits](OPEN_SOURCE.md); do not bypass hashes, substitute fixtures or invent authority.                                                                                                                                                                          |

If reporting an issue, include OS/architecture, Node/pnpm versions, the exact
supported command and a redacted error. Do not attach `.env`, credentials,
private databases, signing material or financial approvals. See the
[capability map](CAPABILITIES.md) and [security policy](../SECURITY.md).
