import { describe, expect, it } from "vitest";
import { LiveEvaluator } from "../../src/validation/evaluator.js";
import { ValidationStore } from "../../src/validation/validation-store.js";
import { LEADER_A } from "../fixtures/mainnet-fixtures.js";
import { testStore } from "../helpers/database.js";
import { TestClock } from "../helpers/test-clock.js";

describe("LiveEvaluator", () => {
  it("marks provider comparison unavailable in Single Provider Mode", () => {
    const { database } = testStore("evaluator-single-provider-");
    const evaluator = new LiveEvaluator(database, {
      providerComparisonAvailable: false,
    });
    expect(evaluator.providerLatency()).toEqual(
      expect.objectContaining({ status: "NOT_AVAILABLE_SINGLE_PROVIDER" }),
    );
    database.close();
  });

  it("reports human-reviewed false positives and categorized false negatives", async () => {
    const { database } = testStore("evaluator-");
    const clock = new TestClock();
    const store = new ValidationStore(database, clock, { primary: "primary" });
    const base = {
      eventIndex: 0,
      slot: 1n,
      leader: LEADER_A,
      primaryProvider: "primary",
      programIds: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
      dex: "JUPITER" as const,
      tokenMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6LKH5mRk5kMZQ",
      quoteMint: "So11111111111111111111111111111111111111112",
      balanceDeltas: [],
      classifierEvidence: ["JUPITER:instruction:swap"],
      capturePath: "/tmp/evidence.json.gz",
      isDuplicate: false,
    };
    await store.saveValidation({
      ...base,
      id: "false-positive",
      signature: "false-positive-signature-1111111111111111111111111111111",
      systemClassification: "BUY",
      groundTruth: {
        classification: "BUY",
        source: "AUTO_RULE",
        reviewReason: "SWAP_LABEL_REQUIRES_HUMAN_REVIEW",
      },
      createdAtMs: clock.now().wallMs,
    });
    await store.review(
      "false-positive",
      "TRANSFER",
      "manual transaction trace review",
    );
    await store.saveValidation({
      ...base,
      id: "false-negative",
      signature: "false-negative-signature-1111111111111111111111111111111",
      systemClassification: "UNKNOWN",
      groundTruth: {
        classification: "UNKNOWN",
        source: "AUTO_RULE",
        reviewReason: "UNKNOWN",
      },
      skipReason: "UNKNOWN_SWAP_PROGRAM",
      createdAtMs: clock.now().wallMs,
    });
    await store.review(
      "false-negative",
      "SELL",
      "manual supported swap trace review",
    );
    const evaluator = new LiveEvaluator(database);
    expect(evaluator.accuracy().overall.falsePositive).toBe(1);
    expect(evaluator.accuracy().overall.falseNegative).toBe(1);
    expect(evaluator.falsePositives()).toHaveLength(1);
    expect(evaluator.falseNegatives()).toEqual([
      expect.objectContaining({ category: "unsupported program" }),
    ]);
    database.close();
  });
});
