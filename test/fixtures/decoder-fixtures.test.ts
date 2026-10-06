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

// Literal expectations for the published minimized snapshot contract. These
// do not independently authenticate the unavailable original RPC captures.
const capturedExpectations = {
  jupiterBuy: {
    owner: "FrhLfj81LRpMR3EwSSCGPzHmxsnoq8h628ne68vK5oMN",
    side: "BUY",
    dex: "JUPITER",
    tokenRaw: 250305289n,
    quoteRaw: 181434765n,
    mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  },
  jupiterSell: {
    owner: "CBFB4dhq5wLvbYFoemedBNnxqV8pxarANtTMWr8Zb7Cu",
    side: "SELL",
    dex: "JUPITER",
    tokenRaw: 220167659n,
    quoteRaw: 220214400n,
    mint: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
  },
  raydiumBuy: {
    owner: "EsM56zsTpZN54WjuFNDVRckz5KDLM7QqDKScZY15M3eZ",
    side: "BUY",
    dex: "RAYDIUM",
    tokenRaw: 7959454631778n,
    quoteRaw: 1173033927n,
    mint: "FhBfSgb1Nxu53kDR9sgHoHYRMoV1dvyL4rd1wn8cpump",
  },
  raydiumSell: {
    owner: "14gdEtVDvNFeSm6BqDaKRAW4q9SHSkbPBGP77ntXMyRJ",
    side: "SELL",
    dex: "RAYDIUM",
    tokenRaw: 17014758807709n,
    quoteRaw: 488309715n,
    mint: "7XdvsEuhzejEADSHqz2CY6HuATyGs4Ed6R4Uz6e5pump",
  },
  pumpFunBuy: {
    owner: "FoZXh8qZBa7zUY5Uoms3hH1K2BbJEtRPZv6QBPbGfbmn",
    side: "BUY",
    dex: "PUMP_FUN",
    tokenRaw: 1852732340316n,
    quoteRaw: 181580594n,
    mint: "3FXtVr8DmtubnsEK5kUXxDSV6hALQwhC9HMBa542pump",
  },
  pumpFunSell: {
    owner: "nya666pQkP3PzWxi7JngU3rRMHuc7zbLK8c8wxQ4qpT",
    side: "SELL",
    dex: "PUMP_FUN",
    tokenRaw: 2181354901433n,
    quoteRaw: 104403945n,
    mint: "GhhysRSkGAK89VZHuXdRYJGQr7SZBe2Bab3h2rFnpump",
  },
  pumpSwapBuy: {
    owner: "6CWmPQD8tDLatj2s8BVEiZTMycn73qmJney796dEGf7V",
    side: "BUY",
    dex: "PUMP_SWAP",
    tokenRaw: 7252254009n,
    quoteRaw: 303100000n,
    mint: "8du34ohgGj2ikZVTGZNwHbNbqX8b8AHGFANf6qmopump",
  },
  pumpSwapSell: {
    owner: "CkUZV387xnoGpF7wC2moMa6mPmAgCvTT4pWgzq4M9fCD",
    side: "SELL",
    dex: "PUMP_SWAP",
    tokenRaw: 1341756557461n,
    quoteRaw: 152676306n,
    mint: "At8fKxJjiK9GV7KNQocTjmpNBtXLZpX5jTA6dWakpump",
  },
} as const;

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

  for (const name of Object.keys(REAL_MAINNET_FIXTURES) as Array<
    keyof typeof REAL_MAINNET_FIXTURES
  >) {
    const fixture = REAL_MAINNET_FIXTURES[name];
    const expected = capturedExpectations[name];
    it(`replays the exact minimized snapshot amounts for ${name}`, () => {
      const result = classifier.classify(
        normalizer.normalize(envelope(fixture)),
        expected.owner,
      );
      expect(result.accepted).toBe(true);
      if (!result.accepted) throw new Error(result.code);
      expect(result.event).toMatchObject({
        signature: fixture.signature,
        slot: BigInt(fixture.slot),
        leaderWallet: expected.owner,
        side: expected.side,
        dex: expected.dex,
        token: { mint: expected.mint, raw: expected.tokenRaw },
        quote: { raw: expected.quoteRaw },
      });
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
