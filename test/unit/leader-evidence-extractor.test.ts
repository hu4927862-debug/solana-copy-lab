import { describe, expect, it } from "vitest";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import {
  LeaderEvidenceExtractor,
  LEADER_EVIDENCE_SCHEMA_VERSION,
} from "../../src/research/leader-evidence.js";
import { MAINNET_FIXTURES, LEADER_A } from "../fixtures/mainnet-fixtures.js";
import { envelope } from "../helpers/envelope.js";
import { TestClock } from "../helpers/test-clock.js";

describe("LeaderEvidenceExtractor", () => {
  it("creates deterministic, precision-preserving evidence with unavailable ordering", () => {
    const clock = new TestClock();
    const normalized = new TransactionNormalizer(clock).normalize(
      envelope(MAINNET_FIXTURES.jupiterBuy),
    );
    const classification = new SwapClassifier().classify(normalized, LEADER_A);
    const extractor = new LeaderEvidenceExtractor();
    const first = extractor.extract(
      normalized,
      LEADER_A,
      classification,
      "primary",
    );
    const second = extractor.extract(
      normalized,
      LEADER_A,
      classification,
      "primary",
    );

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(LEADER_EVIDENCE_SCHEMA_VERSION);
    expect(first.evidenceId).toMatch(/^leader_evidence_[0-9a-f]{64}$/);
    expect(first.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const otherEnvelope = envelope(MAINNET_FIXTURES.jupiterBuy);
    const otherNormalized = new TransactionNormalizer(
      new TestClock(),
    ).normalize({
      ...otherEnvelope,
      streamReceivedTimestampMs: otherEnvelope.streamReceivedTimestampMs + 999,
      streamReceivedMonotonicNs: otherEnvelope.streamReceivedMonotonicNs + 999n,
    });
    const otherClassification = new SwapClassifier().classify(
      otherNormalized,
      LEADER_A,
    );
    expect(
      extractor.extract(
        otherNormalized,
        LEADER_A,
        otherClassification,
        "secondary",
      ).sourceFingerprint,
    ).toBe(first.sourceFingerprint);
    expect(first.transactionIndex).toBeNull();
    expect(first.transactionIndexStatus).toBe("UNAVAILABLE");
    expect(first.eventOrdinalStatus).toBe("UNAVAILABLE");
    expect(first.inputAmountRaw).toBe("1000000000");
    expect(first.outputAmountRaw).toBe("2000000");
    const tokenBalance = first.accountBalances.find(
      (balance) => balance.mint === "DezXAZ8z7PnrnRJjz3wXBoRgixCa6LKH5mRk5kMZQ",
    );
    expect(tokenBalance?.preRaw).toBe("0");
    expect(tokenBalance?.postRaw).toBe("2000000");
    expect(tokenBalance?.ownerStatus).toBe("AVAILABLE");
    expect(first.feeRaw).toBe("5000");
    expect(first.feeAttributionStatus).toBe("LEADER_FEE_PAYER");
    expect(first.coverageStatus).toBe("PARTIAL");
  });

  it("keeps native SOL and WSOL as distinct source assets", () => {
    const raw = structuredClone(MAINNET_FIXTURES.jupiterBuy);
    raw.preTokenBalances.push({
      accountIndex: 4,
      mint: "So11111111111111111111111111111111111111112",
      owner: LEADER_A,
      rawAmount: "9000000000",
      decimals: 9,
      tokenProgram: "TOKEN",
      unsupportedExtension: false,
    });
    raw.postTokenBalances.push({
      accountIndex: 4,
      mint: "So11111111111111111111111111111111111111112",
      owner: LEADER_A,
      rawAmount: "8000000000",
      decimals: 9,
      tokenProgram: "TOKEN",
      unsupportedExtension: false,
    });
    const baseNormalized = new TransactionNormalizer(new TestClock()).normalize(
      envelope(MAINNET_FIXTURES.jupiterBuy),
    );
    const classification = new SwapClassifier().classify(
      baseNormalized,
      LEADER_A,
    );
    const normalized = new TransactionNormalizer(new TestClock()).normalize(
      envelope(raw),
    );
    const evidence = new LeaderEvidenceExtractor().extract(
      normalized,
      LEADER_A,
      classification,
      "primary",
    );
    expect(
      evidence.accountBalances.some(
        (balance) =>
          balance.mint === "So11111111111111111111111111111111111111112",
      ),
    ).toBe(true);
    expect(evidence.canonicalQuoteMint).toBe("SOL_NATIVE");
  });

  it("captures partial sells and repeated lifecycle observations without joining them", () => {
    const clock = new TestClock();
    const extractor = new LeaderEvidenceExtractor();
    const normalizer = new TransactionNormalizer(clock);
    const classifier = new SwapClassifier();
    const buyTx = normalizer.normalize(envelope(MAINNET_FIXTURES.jupiterBuy));
    const sellTx = normalizer.normalize(
      envelope({
        ...MAINNET_FIXTURES.jupiterSell,
        signature: `${MAINNET_FIXTURES.jupiterSell.signature}x`,
        slot: "289000002",
        preTokenBalances: MAINNET_FIXTURES.jupiterSell.preTokenBalances.map(
          (balance) => ({ ...balance, rawAmount: "5000000" }),
        ),
        postTokenBalances: MAINNET_FIXTURES.jupiterSell.postTokenBalances.map(
          (balance) => ({ ...balance, rawAmount: "3000000" }),
        ),
      }),
    );
    const buy = extractor.extract(
      buyTx,
      LEADER_A,
      classifier.classify(buyTx, LEADER_A),
      "primary",
    );
    const sell = extractor.extract(
      sellTx,
      LEADER_A,
      classifier.classify(sellTx, LEADER_A),
      "primary",
    );
    expect(buy.inputAmountRaw).not.toBeNull();
    expect(sell.outputAmountRaw).not.toBeNull();
    expect(buy.evidenceId).not.toBe(sell.evidenceId);
    expect(buy.transactionIndexStatus).toBe("UNAVAILABLE");
    expect(sell.transactionIndexStatus).toBe("UNAVAILABLE");
  });

  it("records unsupported multi-direction evidence without authorizing trading", () => {
    const raw = structuredClone(MAINNET_FIXTURES.jupiterBuy);
    raw.postTokenBalances.push({
      accountIndex: 5,
      mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
      owner: LEADER_A,
      rawAmount: "1",
      decimals: 6,
      tokenProgram: "TOKEN",
      unsupportedExtension: false,
    });
    const normalized = new TransactionNormalizer(new TestClock()).normalize(
      envelope(raw),
    );
    const classification = new SwapClassifier().classify(normalized, LEADER_A);
    expect(classification.accepted).toBe(false);
    const evidence = new LeaderEvidenceExtractor().extract(
      normalized,
      LEADER_A,
      classification,
      "primary",
    );
    expect(evidence.tradingAuthorization).toBe("NOT_AUTHORIZED");
    expect(evidence.inputAmountRaw).toBeNull();
    expect(evidence.outputAmountRaw).toBeNull();
  });
});
