# Fixed transaction fixtures

The suite includes provider-neutral snapshots captured from Solana mainnet-beta on 2026-08-21. `REAL_MAINNET_FIXTURES` retains the real signature, slot, block time, signer, mint, raw pre/post balance deltas, fee, version, program ID, and observed swap instruction. Account layout is minimized to the fields required by the normalizer; complete raw transactions are intentionally not stored. Additional canonical fixtures exercise edge cases with fixed owners and sizes. Every test is offline and deterministic.

Coverage: Jupiter BUY/SELL and v0 multi-hop, Raydium BUY/SELL, Pump.fun BUY, PumpSwap SELL, native SOL transfer, SPL transfer, ATA creation, liquidity operation, partial sell, full sell, and duplicate replay.
