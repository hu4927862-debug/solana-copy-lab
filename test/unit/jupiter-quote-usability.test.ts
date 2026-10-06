import { describe, expect, it } from "vitest";
import type { FollowerScopedJupiterSuccessRateResult } from "../../src/strategy-evaluation/execution-quality.js";
import {
  calculateJupiterQuoteUsability,
  type CopyabilityBucket,
  type CopyabilityEvaluationContext,
} from "../../src/strategy-evaluation/copyability.js";

const bucket: CopyabilityBucket = {
  followerWallet: "follower-a",
  leaderWallet: "leader-a",
  quoteMint: "USDC",
};

const context: CopyabilityEvaluationContext = {
  window: { fromMs: 1_000, toMs: 2_000 },
  source: "fixture",
  mode: "SHADOW",
  copyRatioBps: 1_000,
  riskPolicyVersion: "RISK_V1",
  fillPolicyVersion: "FILL_V1",
  accountingPolicyVersion: "ACCOUNTING_V1",
  copyabilityDefinitionVersion: "JUPITER_QUOTE_USABILITY_V1",
};

function result(
  overrides: Partial<FollowerScopedJupiterSuccessRateResult> = {},
): FollowerScopedJupiterSuccessRateResult {
  return {
    ...bucket,
    attemptCount: 10,
    successCount: 7,
    successRate: "0.7",
    status: "AVAILABLE",
    ...overrides,
  };
}

describe("calculateJupiterQuoteUsability", () => {
  it("composes the existing Jupiter success analytical result", () => {
    expect(calculateJupiterQuoteUsability(bucket, result(), context)).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
      jupiterQuoteOpportunityCount: 10,
      usableJupiterQuoteCount: 7,
      jupiterQuoteUsabilityRate: "0.7",
      status: "AVAILABLE",
      definitionVersion: "JUPITER_QUOTE_USABILITY_V1",
    });
  });

  it("reports full usability when every attempt produced a usable quote", () => {
    expect(
      calculateJupiterQuoteUsability(
        bucket,
        result({ attemptCount: 4, successCount: 4, successRate: "1" }),
        context,
      ),
    ).toMatchObject({
      jupiterQuoteOpportunityCount: 4,
      usableJupiterQuoteCount: 4,
      jupiterQuoteUsabilityRate: "1",
      status: "AVAILABLE",
    });
  });

  it("reports zero usability when no attempt produced a usable quote", () => {
    expect(
      calculateJupiterQuoteUsability(
        bucket,
        result({ attemptCount: 3, successCount: 0, successRate: "0" }),
        context,
      ),
    ).toMatchObject({
      jupiterQuoteOpportunityCount: 3,
      usableJupiterQuoteCount: 0,
      jupiterQuoteUsabilityRate: "0",
      status: "AVAILABLE",
    });
  });

  it("reports no rate rather than zero when there are no attempts", () => {
    expect(
      calculateJupiterQuoteUsability(
        bucket,
        result({
          attemptCount: 0,
          successCount: 0,
          successRate: null,
          status: "NO_ATTEMPTS",
        }),
        context,
      ),
    ).toMatchObject({
      jupiterQuoteOpportunityCount: 0,
      usableJupiterQuoteCount: 0,
      jupiterQuoteUsabilityRate: null,
      status: "NO_JUPITER_QUOTE_OPPORTUNITIES",
    });
  });

  it("preserves the canonical non-divisible upstream rate", () => {
    const upstreamRate = "0.666666666666666666";

    expect(
      calculateJupiterQuoteUsability(
        bucket,
        result({ attemptCount: 3, successCount: 2, successRate: upstreamRate }),
        context,
      ).jupiterQuoteUsabilityRate,
    ).toBe(upstreamRate);
  });

  it("preserves a zero numerator as the finite string zero", () => {
    const output = calculateJupiterQuoteUsability(
      bucket,
      result({ attemptCount: 2, successCount: 0, successRate: "0" }),
      context,
    );

    expect(output.jupiterQuoteUsabilityRate).toBe("0");
    expect(output.jupiterQuoteUsabilityRate).not.toBe("NaN");
    expect(output.jupiterQuoteUsabilityRate).not.toBe("Infinity");
  });

  it("fails closed when successes exceed attempts", () => {
    expect(() =>
      calculateJupiterQuoteUsability(
        bucket,
        result({ attemptCount: 2, successCount: 3, successRate: "1.5" }),
        context,
      ),
    ).toThrowError("CONFLICTING_JUPITER_USABILITY_ANALYTICAL_RESULT");
  });

  it.each([
    { attemptCount: -1, successCount: 0 },
    { attemptCount: 1, successCount: -1 },
  ])("fails closed for negative analytical counts: %o", (counts) => {
    expect(() =>
      calculateJupiterQuoteUsability(
        bucket,
        result({ ...counts, successRate: "0" }),
        context,
      ),
    ).toThrowError("CONFLICTING_JUPITER_USABILITY_ANALYTICAL_RESULT");
  });

  it.each(["0.67", "NaN", "Infinity"])(
    "fails closed for the inconsistent upstream rate %s",
    (successRate) => {
      expect(() =>
        calculateJupiterQuoteUsability(
          bucket,
          result({ attemptCount: 3, successCount: 2, successRate }),
          context,
        ),
      ).toThrowError("CONFLICTING_JUPITER_USABILITY_ANALYTICAL_RESULT");
    },
  );

  it("fails closed when upstream status conflicts with its counts", () => {
    expect(() =>
      calculateJupiterQuoteUsability(
        bucket,
        result({
          attemptCount: 0,
          successCount: 0,
          successRate: null,
          status: "AVAILABLE",
        }),
        context,
      ),
    ).toThrowError("CONFLICTING_JUPITER_USABILITY_ANALYTICAL_RESULT");
  });

  it.each([
    [
      "follower",
      { followerWallet: "follower-b" },
      "CROSS_FOLLOWER_COPYABILITY_BUCKET",
    ],
    ["leader", { leaderWallet: "leader-b" }, "CROSS_LEADER_COPYABILITY_BUCKET"],
    ["quote", { quoteMint: "SOL" }, "CROSS_QUOTE_COPYABILITY_BUCKET"],
  ] as const)(
    "fails closed for a mismatched %s bucket",
    (_dimension, override, error) => {
      expect(() =>
        calculateJupiterQuoteUsability(bucket, result(override), context),
      ).toThrowError(error);
    },
  );

  it("is deterministic for the same analytical result", () => {
    const input = result({
      attemptCount: 7,
      successCount: 3,
      successRate: "0.428571428571428571",
    });

    expect(calculateJupiterQuoteUsability(bucket, input, context)).toEqual(
      calculateJupiterQuoteUsability(bucket, { ...input }, context),
    );
  });
});
