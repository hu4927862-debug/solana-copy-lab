# Fixed transaction fixtures

All public fixture tests run offline. The collections below have different
provenance and must not be described as interchangeable full RPC captures.

## Synthetic cases

`MAINNET_FIXTURES` is built by `swapFixture` in
[mainnet-fixtures.ts](mainnet-fixtures.ts). Despite the historical constant name,
these cases are synthetic. They cover BUY/SELL, v0 lookup-key and CPI shapes,
Jupiter routes, Raydium, Pump.fun/PumpSwap, partial/full sells and exact amounts.
`NEGATIVE_FIXTURES` includes native/SPL transfers, ATA creation and liquidity.
The five-case `pnpm demo` and full paper workflow use synthetic inputs.

## Minimized historical observations

`REAL_MAINNET_FIXTURES` contains **eight** records associated with mainnet-beta
signatures, slots and chain times. The existing
[capture manifest](mainnet-capture-manifest.json) records a capture timestamp of
2026-08-21T13:53:00Z and signature/slot pairs. It does **not** include original
full-response hashes or complete RPC bodies.

These eight records are reconstructed by `capturedSwap`: it builds a reduced
account list, placeholder token-account addresses, selected balances, generic
instruction bytes and a parsed instruction/log description around recorded
values. They are regression representations, not byte-for-byte archived
transactions. Passing their classifier test checks the representation; it does
not independently re-establish original instruction bytes, all owners/flows or
historical transaction truth from a complete source chain.

The eight-record regression assertions compare declared candidate wallet, side,
DEX, mint and exact token/quote raw quantities against fixed literals. That is
stronger than merely asserting acceptance, but it does not supply the missing
original capture proof or demonstrate payer/owner equivalence in general.

## Provider-neutral v5 JSON snapshots

Four existing JSON files retain larger provider-neutral transaction inputs:

- [v5-native-sol-with-rent.json](v5-native-sol-with-rent.json)
- [v5-jupiter-buy-with-refund.json](v5-jupiter-buy-with-refund.json)
- [v5-jupiter-sell-with-output-fee.json](v5-jupiter-sell-with-output-fee.json)
- [v5-jupiter-full-sell-with-output-fee.json](v5-jupiter-full-sell-with-output-fee.json)

They include signatures, slots, chain timestamps, message/lookup keys, token
owners, exact decimal-string balances, instruction bytes and logs used by
existing principal tests. They satisfy the project's `RawTransaction` format;
they are not unmodified complete JSON-RPC envelopes. Their original capture
receipt, full-response digest and transformation chain are not published.
Hashing a checked-in JSON proves the replay input identity, not a complete
capture provenance chain or current chain observation.

`pnpm demo:replay` reads these exact files and labels the receipt time as a local
**replay** clock. It does not restamp history as a fresh signal, fetch any missing
evidence, write to an operational Store or qualify a follower trade. The supplied
candidate wallet is an explicit fixed fixture identity, checked against
token-owner/transfer evidence; it is not inferred from fee payer. These records
do not establish a general rule that payer or signer equals asset owner.

The snapshots are useful for repeatable principal/refund/rent regression tests.
They are insufficient for full deployment/program attestation, market coverage,
complete multi-intent historical validation or realized follower PnL.
