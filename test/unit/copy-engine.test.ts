import { describe, expect, it } from "vitest";
import { CopyEngine } from "../../src/copy/copy-engine.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import type { Position } from "../../src/domain/positions.js";
import { envelope } from "../helpers/envelope.js";
import { TestClock } from "../helpers/test-clock.js";
import {
  FOLLOWER,
  LEADER_A,
  MAINNET_FIXTURES,
  TOKEN_MINT,
} from "../fixtures/mainnet-fixtures.js";

function eventFor(
  fixture: (typeof MAINNET_FIXTURES)[keyof typeof MAINNET_FIXTURES],
) {
  const result = new SwapClassifier().classify(
    new TransactionNormalizer(new TestClock()).normalize(envelope(fixture)),
    LEADER_A,
  );
  if (!result.accepted) throw new Error(result.code);
  return result.event;
}

const policy = {
  followerWallet: FOLLOWER,
  copyRatioBps: 1000,
  mode: "SHADOW" as const,
};

describe("CopyEngine", () => {
  it("preserves the authoritative chain timestamp instead of decode time", () => {
    const event = eventFor(MAINNET_FIXTURES.jupiterBuy);
    const intent = new CopyEngine().decide(
      {
        ...event,
        timestamps: {
          ...event.timestamps,
          sourceTimestampMs: 1_000,
          sourceTimestampPrecision: "SECOND",
          decodedTimestampMs: 99_000,
        },
      },
      policy,
    );

    expect(intent).toMatchObject({
      authoritativeSourceTimestamp: {
        valueMs: 1_000,
        provenance: "CHAIN_BLOCK_TIME",
        precision: "SECOND",
      },
      createdAtMs: 99_000,
    });
  });

  it("does not authorize a timestamp without chain-derived provenance", () => {
    const event = eventFor(MAINNET_FIXTURES.jupiterBuy);
    const intent = new CopyEngine().decide(
      {
        ...event,
        timestamps: {
          ...event.timestamps,
          sourceTimestampMs: 99_000,
          sourceTimestampPrecision: "MILLISECOND",
          sourceTimestampProvenance: "UNKNOWN",
        },
      } as never,
      policy,
    );

    expect(intent.authoritativeSourceTimestamp).toBeUndefined();
  });

  it("is deterministic and sizes BUY by leader quote spent times copy ratio", () => {
    const engine = new CopyEngine();
    const event = eventFor(MAINNET_FIXTURES.jupiterBuy);
    const first = engine.decide(event, policy);
    const second = engine.decide(event, policy);
    expect(first).toEqual(second);
    expect(first.executionKey).toBe(second.executionKey);
    expect(first.theoreticalQuoteRaw).toBe(event.quote.raw / 10n);
    expect(first.theoreticalTokenRaw).toBe(event.token.raw / 10n);
  });

  it("uses leader sold/pre-balance ratio for partial sell", () => {
    const position: Position = {
      followerWallet: FOLLOWER,
      leaderWallet: LEADER_A,
      tokenMint: TOKEN_MINT,
      quoteMint: eventFor(MAINNET_FIXTURES.partialSell).quote.mint,
      rawAmount: 4_000_000n,
      reservedRawAmount: 0n,
      accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
      version: 1,
      state: "OPEN",
    };
    const intent = new CopyEngine().decide(
      eventFor(MAINNET_FIXTURES.partialSell),
      policy,
      position,
    );
    expect(intent.sellRatio).toEqual({
      numerator: 2_500_000n,
      denominator: 10_000_000n,
    });
    expect(intent.theoreticalTokenRaw).toBe(1_000_000n);
  });

  it("fails closed when a SELL has no mapped follower position", () => {
    const intent = new CopyEngine().decide(
      eventFor(MAINNET_FIXTURES.partialSell),
      policy,
    );

    expect(intent.skipReason).toBe("NO_MAPPED_POSITION");
    expect(intent.diagnosticCode).toBe("MAPPING_ABSENT_OR_UNRESOLVED");
    expect(intent.theoreticalTokenRaw).toBe(0n);
    expect(intent.theoreticalQuoteRaw).toBe(0n);
  });

  it("diagnoses a mapped position that is already closed without changing the skip", () => {
    const event = eventFor(MAINNET_FIXTURES.partialSell);
    const intent = new CopyEngine().decide(event, policy, {
      followerWallet: FOLLOWER,
      leaderWallet: LEADER_A,
      tokenMint: TOKEN_MINT,
      quoteMint: event.quote.mint,
      rawAmount: 0n,
      reservedRawAmount: 0n,
      accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
      version: 2,
      state: "CLOSED",
    });
    expect(intent.skipReason).toBe("NO_MAPPED_POSITION");
    expect(intent.diagnosticCode).toBe("OBSERVED_POSITION_STATE_CLOSED");
  });

  it("copies a full sell as the entire mapped position", () => {
    const position: Position = {
      followerWallet: FOLLOWER,
      leaderWallet: LEADER_A,
      tokenMint: TOKEN_MINT,
      quoteMint: eventFor(MAINNET_FIXTURES.fullSell).quote.mint,
      rawAmount: 4_000_001n,
      reservedRawAmount: 0n,
      accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
      version: 1,
      state: "OPEN",
    };
    const intent = new CopyEngine().decide(
      eventFor(MAINNET_FIXTURES.fullSell),
      policy,
      position,
    );
    expect(intent.theoreticalTokenRaw).toBe(4_000_001n);
  });

  it("fails closed when leader sold amount exceeds the pre-sell balance", () => {
    const position: Position = {
      followerWallet: FOLLOWER,
      leaderWallet: LEADER_A,
      tokenMint: TOKEN_MINT,
      quoteMint: eventFor(MAINNET_FIXTURES.partialSell).quote.mint,
      rawAmount: 4_000_000n,
      reservedRawAmount: 0n,
      accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
      version: 1,
      state: "OPEN",
    };
    const event = eventFor(MAINNET_FIXTURES.partialSell);
    const intent = new CopyEngine().decide(
      {
        ...event,
        token: { ...event.token, raw: event.leaderPreTokenRaw + 1n },
      },
      policy,
      position,
    );

    expect(intent.skipReason).toBe("LEADER_SELL_EXCEEDS_PRE_BALANCE");
    expect(intent.theoreticalTokenRaw).toBe(0n);
    expect(intent.theoreticalQuoteRaw).toBe(0n);
  });

  it("isolates a positive legacy position without verified fill cost basis", () => {
    const legacyPosition: Position = {
      followerWallet: FOLLOWER,
      leaderWallet: LEADER_A,
      tokenMint: TOKEN_MINT,
      rawAmount: 4_000_000n,
      reservedRawAmount: 0n,
      version: 1,
      state: "OPEN",
    };

    const intent = new CopyEngine().decide(
      eventFor(MAINNET_FIXTURES.partialSell),
      policy,
      legacyPosition,
    );

    expect(intent.skipReason).toBe("LEGACY_POSITION_COST_BASIS_UNAVAILABLE");
    expect(intent.theoreticalTokenRaw).toBe(0n);
    expect(intent.theoreticalQuoteRaw).toBe(0n);
  });

  it("rounds a non-divisible follower SELL amount down", () => {
    const event = eventFor(MAINNET_FIXTURES.partialSell);
    const position: Position = {
      followerWallet: FOLLOWER,
      leaderWallet: LEADER_A,
      tokenMint: TOKEN_MINT,
      quoteMint: event.quote.mint,
      rawAmount: 10n,
      reservedRawAmount: 0n,
      accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
      version: 1,
      state: "OPEN",
    };

    const intent = new CopyEngine().decide(
      {
        ...event,
        token: { ...event.token, raw: 1n },
        leaderPreTokenRaw: 3n,
      },
      policy,
      position,
    );

    expect(intent.theoreticalTokenRaw).toBe(3n);
    expect(intent.sellRatio).toEqual({ numerator: 1n, denominator: 3n });
  });

  it("skips a zero-sized leader SELL", () => {
    const event = eventFor(MAINNET_FIXTURES.partialSell);
    const position: Position = {
      followerWallet: FOLLOWER,
      leaderWallet: LEADER_A,
      tokenMint: TOKEN_MINT,
      quoteMint: event.quote.mint,
      rawAmount: 10n,
      reservedRawAmount: 0n,
      accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
      version: 1,
      state: "OPEN",
    };

    const intent = new CopyEngine().decide(
      {
        ...event,
        token: { ...event.token, raw: 0n },
        leaderPreTokenRaw: 3n,
      },
      policy,
      position,
    );

    expect(intent.skipReason).toBe("SIZE_ROUNDED_TO_ZERO");
    expect(intent.theoreticalTokenRaw).toBe(0n);
    expect(intent.theoreticalQuoteRaw).toBe(0n);
  });
});
