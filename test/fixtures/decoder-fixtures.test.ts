import { describe, expect, it } from "vitest";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import { NATIVE_SOL } from "../../src/domain/assets.js";
import { envelope } from "../helpers/envelope.js";
import { TestClock } from "../helpers/test-clock.js";
import {
  LEADER_A,
  MAINNET_FIXTURES,
  NEGATIVE_FIXTURES,
  REAL_MAINNET_FIXTURES,
} from "./mainnet-fixtures.js";

describe("fixed decoder fixtures", () => {
  const normalizer = new TransactionNormalizer(new TestClock());
  const classifier = new SwapClassifier();

  for (const [name, fixture] of Object.entries(MAINNET_FIXTURES)) {
    it(`accepts ${name}`, () => {
      const result = classifier.classify(
        normalizer.normalize(envelope(fixture)),
        LEADER_A,
      );
      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.event.token.raw).toBeGreaterThan(0n);
        expect(result.event.quote.raw).toBeGreaterThan(0n);
      }
    });
  }

  for (const [name, fixture] of Object.entries(REAL_MAINNET_FIXTURES)) {
    it(`replays captured mainnet ${name}`, () => {
      const result = classifier.classify(
        normalizer.normalize(envelope(fixture)),
        fixture.feePayer,
      );
      expect(result.accepted).toBe(true);
    });
  }

  it("classifies BUY and SELL from owner net deltas", () => {
    const buy = classifier.classify(
      normalizer.normalize(envelope(MAINNET_FIXTURES.jupiterBuy)),
      LEADER_A,
    );
    const sell = classifier.classify(
      normalizer.normalize(envelope(MAINNET_FIXTURES.jupiterSell)),
      LEADER_A,
    );
    expect(buy.accepted && buy.event.side).toBe("BUY");
    expect(sell.accepted && sell.event.side).toBe("SELL");
  });

  it("canonicalizes a WSOL quote to native SOL in the domain event", () => {
    const result = classifier.classify(
      normalizer.normalize(envelope(MAINNET_FIXTURES.wsolBuy)),
      LEADER_A,
    );

    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.event.quote.mint).toBe(NATIVE_SOL);
  });

  it.each([
    ["SOL transfer", NEGATIVE_FIXTURES.solTransfer],
    ["SPL transfer", NEGATIVE_FIXTURES.splTransfer],
    ["ATA create", NEGATIVE_FIXTURES.ataCreate],
    ["liquidity operation", NEGATIVE_FIXTURES.liquidityOperation],
  ])("rejects %s", (_name, fixture) => {
    const result = classifier.classify(
      normalizer.normalize(envelope(fixture)),
      LEADER_A,
    );
    expect(result.accepted).toBe(false);
  });

  it("supports raw amounts above Number.MAX_SAFE_INTEGER without precision loss", () => {
    const huge = structuredClone(MAINNET_FIXTURES.jupiterBuy);
    huge.postTokenBalances[0]!.rawAmount = "900719925474099312345";
    const normalized = normalizer.normalize(envelope(huge));
    expect(normalized.postTokenBalances[0]!.rawAmount).toBe(
      900719925474099312345n,
    );
  });

  it("supports legacy, v0 lookup addresses, outer instructions, and CPI", () => {
    const legacy = normalizer.normalize(envelope(MAINNET_FIXTURES.raydiumBuy));
    const versioned = normalizer.normalize(
      envelope(MAINNET_FIXTURES.multiHopJupiter),
    );
    expect(legacy.version).toBe("legacy");
    expect(legacy.outerInstructions.length).toBeGreaterThan(0);
    expect(versioned.version).toBe(0);
    expect(
      versioned.accountKeys.some((key) => key.source === "LOOKUP_WRITABLE"),
    ).toBe(true);
    expect(versioned.innerInstructions.length).toBeGreaterThan(0);
  });
});
