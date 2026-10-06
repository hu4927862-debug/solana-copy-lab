# Security

This is an experimental research codebase, not an audited trading product.
The supported quickstart is offline. It creates no wallet, signs no transaction
and makes no provider request. Historical signer and executor source exists;
its presence must not be read as approval to run it.

Do not use a funded wallet to reproduce a bug. Do not upload credentials,
mnemonics, private keys, signed transaction bytes, live authorization files or
private state. Share the smallest synthetic counterexample instead.

For a vulnerability that could expose secrets or bypass an authority boundary,
use the repository's private vulnerability reporting channel if available.
Do not publish an exploit or sensitive evidence in a public issue. Ordinary
non-sensitive bugs can use the issue template.

Public test success establishes only the tested offline behavior. It does not
establish a current program attestation, executable route, live qualification,
positive expectancy or funds authority. Network, signing, submission and
recovery responsibilities must remain distinct from research classification.

## Trust boundaries

| Boundary | Supported offline behavior | Remaining limitation |
| --- | --- | --- |
| Transaction input | Exact amounts and supported swap evidence are inspected; ambiguous and unsupported cases can be rejected. | Classification is not universal asset-owner proof, token safety or permission to buy. |
| Paper quote | A fixed fixture can exercise the existing amount, freshness, route and impact checks. | No live route, liquidity, landing, MEV protection or actual fill is verified. |
| Paper ledger | The example uses a new synthetic SQLite database; duplicate application and paper position accounting are observable. | It is not a production Journal or real position/recovery truth. |
| Evidence report | Missing labels and costs remain explicit; output cannot establish live expectancy. | Synthetic results do not validate a strategy or future execution. |
| Experimental execution source | Original scope and authority guards remain in the source. | Private dependencies and attestation assets are absent; execution is not qualified by this release. |

The examples need no provider URL, private key or funded wallet. Dependency
installation still downloads software and may run explicitly allowed native
build scripts. Review lockfile and build-permission changes separately from
offline application behavior. Do not bypass missing private evidence or turn
on a signer to reproduce an example.
