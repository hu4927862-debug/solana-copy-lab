# Offline usage and troubleshooting

The supported public workflow uses synthetic inputs, local computation and a
new disposable SQLite database. It does not read provider keys, connect to RPC,
build a Solana transaction, simulate on chain, sign or send. Installation still
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

# Optional: write workflow artifacts to an explicitly NEW directory
pnpm demo:workflow --output ./offline-example

# Type checking, source build, fixed tests and the supported examples
pnpm check
```

The workflow prints its actual output location. The default is a fresh temporary
directory; an explicit output directory must not already exist. This prevents a
demo from overwriting previous results or using a supplied operational database.
`pnpm start` remains the five-case classification demo.

## Read the workflow output

| Artifact                         | What to inspect                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SUMMARY.json`                   | Case results, risk rejection reasons, quote-provider call count and paper position state.               |
| `SYNTHETIC-INPUTS.json`          | Fixed synthetic input provenance; these are not new chain observations.                                 |
| `SYNTHETIC-QUOTES.json`          | In-memory mock quote inputs and outputs, with exact decimal-string amounts. No provider request occurs. |
| `paper.sqlite`                   | Disposable paper state created by this run using the existing migrations and Store.                     |
| `report/evidence-report-v1.json` | Machine-readable evidence report and explicit insufficiency.                                            |
| `report/evidence-report-v1.md`   | Human-readable report from the same read-only reporting owner.                                          |
| `MANIFEST.json`                  | Artifact identity and file hashes for checking what was produced.                                       |

The cases include a BUY, duplicate replay, excessive impact, missing impact,
stale intent, ordinary transfer and FULL SELL. A paper position can close in the
model while the strategy report remains `INSUFFICIENT_EVIDENCE`. Missing real
network fees, tip, landing and fill evidence must not become a claim of realized
net profit. Read the JSON and report before treating a green command as evidence
for a particular capability.

The demo uses the existing **paper** policy example. Its separately defined
BUY/SELL caps are not the historical Money Lane authorization. This command
does not change either policy or confer permission to trade.

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
| Experimental autonomous startup reports missing sealed files | Expected for a fresh public clone. See [public snapshot limits](OPEN_SOURCE.md); do not bypass hashes, substitute fixtures or invent authority.                                                                                                                                                                          |

If reporting an issue, include OS/architecture, Node/pnpm versions, the exact
supported command and a redacted error. Do not attach `.env`, credentials,
private databases, signing material or financial approvals. See the
[capability map](CAPABILITIES.md) and [security policy](../SECURITY.md).
