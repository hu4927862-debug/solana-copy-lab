# Evaluate saved paper evidence

The public evaluator reviews a declared, closed SQLite paper snapshot with the
existing evidence-report owners. It does not discover profitable wallets,
predict future returns, fetch quotes, or authorize a trade. This makes the
current research core usable without adding a second scoring or trading system.

## Run a complete local example

```sh
# Choose a directory that does not already exist
pnpm demo:workflow --output ./offline-example

# Re-evaluate the snapshot using its generated identity-bound request
pnpm evaluate:strategies ./offline-example/EVALUATION-REQUEST.json
```

The workflow creates labeled synthetic transactions and in-memory quotes, closes
its disposable database, and records its bytes in `EVALUATION-REQUEST.json` and
`MANIFEST.json`. The second command uses the same report owner on a temporary
copy and writes reports to a new `re-evaluated` directory within the example
directory. Its stdout identifies the actual report paths and includes every
requested wallet/leader/quote-mint bucket; it does not select the first or best
bucket as the whole result.

The new evaluation directory contains `evidence-report-v1.json`,
`evidence-report-v1.md`, `SUMMARY.json` and `MANIFEST.json`. The summary binds the
request, snapshot and entry-point file identities, exposes the bucket results
and identifies unknown live costs. The manifest binds the produced files; it
does not turn declared evidence into independently authenticated observations.

The example remains `SYNTHETIC` and `INSUFFICIENT_EVIDENCE`. Its paper position
can be closed with a positive modeled result while costs and research evidence
remain incomplete. No real provider request, transaction, signer, or wallet is
used. This example is a reproducibility check, not a strategy backtest.

Use a Git checkout with a resolvable `HEAD` for the two-command example: it
generates the reusable evaluation request. Archives lacking a source revision
still run the synthetic workflow, but the reusable request is unavailable;
`SOURCE_REVISION_UNAVAILABLE` is reported instead of an invented commit.

Git must be available on `PATH` to resolve the source identity. Ordinary and
packed references, detached checkouts and linked worktrees are supported. The
workflow resolves its own checkout rather than using a parent repository or
inherited `GIT_DIR`/`GIT_WORK_TREE` overrides.

## Bring an existing offline snapshot

Use [the request template](../config/strategy-evaluation.example.json), replacing
the paths, snapshot hash, identities, window and policy bindings with the values
of evidence you already possess. The required request schema is
`OFFLINE_EVALUATION_REQUEST_V1`; the supported evidence labels are `SYNTHETIC`,
`PAPER_SNAPSHOT`, and `SHADOW_PAPER_SNAPSHOT`. These are declarations about the
input, not authentication of its origin or independent evidence qualification.

| Binding                                           | Meaning                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `databasePath` and `databaseSha256`               | Exact bytes of one closed, independent SQLite snapshot.                            |
| `outputDirectory`                                 | A new output location; existing results are not overwritten.                       |
| `evidenceKind`                                    | Declared synthetic, paper, or shadow-paper input; never real finalized PnL.        |
| `repositoryCommit`                                | Declared source revision for the report; not proof of a sealed dependency closure. |
| Window, source, mode, policy versions and buckets | Explicit context to compare with the persisted evidence; not an inferred cohort.   |
| `shadowPaperEvidenceBinding`, when required       | The existing shadow-paper evidence contract and provenance checks.                 |

Relative database and output paths resolve from the request file's directory.
The verdict policy still comes from the checked-in repository policy, rather
than accepting a policy that the request substitutes. The CLI verifies the
snapshot hash before evaluation, refuses nonempty SQLite WAL/journal sidecars,
and evaluates its own temporary copy. A mismatched identity, context or missing
required evidence must remain a rejection or an explicit unavailable result.

Stop the process that owns a source database and create a complete, checkpointed
snapshot using its existing lifecycle/export procedure. Copying only an active
`.sqlite` file is not a valid snapshot: pending WAL data may be omitted. The CLI
does not stop a process, reconcile a real journal, or create an operational
backup. Keep real databases, wallet panels, credentials and financial approvals
out of issues and public commits; share only an intentionally sanitized example.

A failed invocation may leave partial report files in its newly claimed output
directory. Only a completed `MANIFEST.json` with matching file hashes identifies
a finished export; do not treat partial JSON/Markdown as a successful evaluation
or reuse that directory for another attempt.

## Read the verdict in its actual scope

Inspect the JSON and Markdown reports as well as the CLI summary. All requested
buckets, unavailable metrics, rejected/unfilled opportunities, censored
lifecycles and cost limitations matter. Completed-cycle metrics have their own
conditional denominator; they do not represent every observed opportunity or a
one-position portfolio.

The existing policy uses fixed paper-evidence requirements, including its
completed-cycle minimum. That historical policy is retained unchanged. Neither
its minimum nor a request's `minimumCompletedCycles` is a general statistical
sample-size rule or public strategy-promotion gate.

- `INSUFFICIENT_EVIDENCE` preserves missing evidence rather than replacing it
  with zero or a normal loss.
- `NEGATIVE_EXPECTANCY` applies to the evaluated paper contract and evidence.
  It does not prove that every form of Solana wallet following is negative-EV.
- `POSITIVE_CANDIDATE` is a bounded paper-review result. It establishes no
  predictive alpha, execution qualification, deployment approval or funds
  authority, including for an input labeled synthetic.

`COST_COMPLETE` is defined by the report's paper cost contract. It does not mean
that all real network fees, tips, execution failures, fill deviations and
recoverable rent have been observed. A quote-as-fill model is distinct from
finalized follower wallet accounting. Do not subtract impact, protocol fees or
immediate roundtrip friction again when the quoted amounts already include their
economic effect; record unknown costs as `UNKNOWN`, or present explicitly
labeled assumptions separately.

## What would be needed for an alpha claim

The current validity, freshness, route and risk gates are not an empirically
validated return predictor. A new predictive claim would first need one frozen
signal and universe, the actual time each input became available, and a later
unseen time block. Compare with a baseline that does not use the signal while
holding observation delay, size, quote/outcome construction and costs constant.
Keep failures, missing outcomes, tails and shared wallet/mint/time-block
dependence visible. Multiple horizons of one event are repeated measurements.

That experiment is not implemented or run by this command. No universal
buy-the-top rule, fixed slippage range, or absolute MEV immunity follows from
these fixtures. Research permission, execution scope, qualification and funds
authorization remain separate. The previously closed collection workstream is
not restarted by evaluating saved evidence.
