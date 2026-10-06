import { describe, expect, it } from "vitest";
import {
  calculatePostQuoteFreshnessCompatibility,
  type CopyabilityBucket,
  type CopyabilityEvaluationContext,
} from "../../src/strategy-evaluation/copyability.js";
import type { PostQuoteFreshnessAnalyticalProjection } from "../../src/strategy-evaluation/failure-taxonomy.js";

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
  copyabilityDefinitionVersion: "POST_QUOTE_FRESHNESS_COMPATIBILITY_V1",
};

function projection(
  executionKey: string,
  outcome: PostQuoteFreshnessAnalyticalProjection["outcome"],
  overrides: Partial<PostQuoteFreshnessAnalyticalProjection> = {},
): PostQuoteFreshnessAnalyticalProjection {
  return {
    ...bucket,
    executionKey,
    outcome,
    ...overrides,
  };
}

describe("calculatePostQuoteFreshnessCompatibility", () => {
  it("counts only opportunities proven to reach the actual freshness gate", () => {
    expect(
      calculatePostQuoteFreshnessCompatibility(
        bucket,
        [
          projection("allow", "PASS"),
          projection("price-impact-too-high", "PASS"),
          projection("route-invalid-after-freshness", "PASS"),
          projection("stale", "STALE"),
          projection("quote-mismatch-before-freshness", "BEFORE_FRESHNESS"),
          projection("unavailable", "UNAVAILABLE"),
        ],
        context,
      ),
    ).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
      freshnessOpportunityCount: 4,
      freshnessCompatibleCount: 3,
      staleQuoteCount: 1,
      freshnessCompatibilityRate: "0.75",
      preconditionCount: 6,
      evaluableCount: 4,
      beforeFreshnessCount: 1,
      unavailableCount: 1,
      coverageRate: "0.666666666666666666",
      status: "AVAILABLE",
      definitionVersion: "POST_QUOTE_FRESHNESS_COMPATIBILITY_V1",
    });
  });

  it("reports full compatibility when every evaluable quote is fresh", () => {
    expect(
      calculatePostQuoteFreshnessCompatibility(
        bucket,
        [projection("fresh-a", "PASS"), projection("fresh-b", "PASS")],
        context,
      ),
    ).toMatchObject({
      freshnessOpportunityCount: 2,
      freshnessCompatibleCount: 2,
      staleQuoteCount: 0,
      freshnessCompatibilityRate: "1",
      coverageRate: "1",
      status: "AVAILABLE",
    });
  });

  it("reports zero compatibility when every evaluable quote is stale", () => {
    expect(
      calculatePostQuoteFreshnessCompatibility(
        bucket,
        [projection("stale-a", "STALE"), projection("stale-b", "STALE")],
        context,
      ),
    ).toMatchObject({
      freshnessOpportunityCount: 2,
      freshnessCompatibleCount: 0,
      staleQuoteCount: 2,
      freshnessCompatibilityRate: "0",
      coverageRate: "1",
      status: "AVAILABLE",
    });
  });

  it("returns an explicit no-evaluable result for empty projections", () => {
    expect(
      calculatePostQuoteFreshnessCompatibility(bucket, [], context),
    ).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
      freshnessOpportunityCount: 0,
      freshnessCompatibleCount: 0,
      staleQuoteCount: 0,
      freshnessCompatibilityRate: null,
      preconditionCount: 0,
      evaluableCount: 0,
      beforeFreshnessCount: 0,
      unavailableCount: 0,
      coverageRate: null,
      status: "NO_EVALUABLE_FRESHNESS_OUTCOMES",
      definitionVersion: "POST_QUOTE_FRESHNESS_COMPATIBILITY_V1",
    });
  });

  it("keeps terminal outcomes before freshness outside the value denominator", () => {
    expect(
      calculatePostQuoteFreshnessCompatibility(
        bucket,
        [projection("before", "BEFORE_FRESHNESS")],
        context,
      ),
    ).toMatchObject({
      freshnessOpportunityCount: 0,
      freshnessCompatibilityRate: null,
      preconditionCount: 1,
      evaluableCount: 0,
      beforeFreshnessCount: 1,
      unavailableCount: 0,
      coverageRate: "0",
      status: "NO_EVALUABLE_FRESHNESS_OUTCOMES",
    });
  });

  it("keeps unavailable analytical outcomes outside the value denominator", () => {
    expect(
      calculatePostQuoteFreshnessCompatibility(
        bucket,
        [projection("unavailable", "UNAVAILABLE")],
        context,
      ),
    ).toMatchObject({
      freshnessOpportunityCount: 0,
      freshnessCompatibilityRate: null,
      preconditionCount: 1,
      evaluableCount: 0,
      beforeFreshnessCount: 0,
      unavailableCount: 1,
      coverageRate: "0",
      status: "NO_EVALUABLE_FRESHNESS_OUTCOMES",
    });
  });

  it("deduplicates identical projections by executionKey", () => {
    const fresh = projection("duplicate", "PASS");

    expect(
      calculatePostQuoteFreshnessCompatibility(
        bucket,
        [fresh, { ...fresh }],
        context,
      ),
    ).toMatchObject({
      freshnessOpportunityCount: 1,
      freshnessCompatibleCount: 1,
      preconditionCount: 1,
      evaluableCount: 1,
    });
  });

  it("fails closed when one executionKey is both stale and freshness-compatible", () => {
    expect(() =>
      calculatePostQuoteFreshnessCompatibility(
        bucket,
        [projection("conflict", "STALE"), projection("conflict", "PASS")],
        context,
      ),
    ).toThrowError("CONFLICTING_FRESHNESS_ANALYTICAL_RESULTS");
  });

  it.each([
    [
      "follower",
      { followerWallet: "follower-b" },
      "CROSS_FOLLOWER_COPYABILITY_BUCKET",
    ],
    ["leader", { leaderWallet: "leader-b" }, "CROSS_LEADER_COPYABILITY_BUCKET"],
    ["quote", { quoteMint: "SOL_NATIVE" }, "CROSS_QUOTE_COPYABILITY_BUCKET"],
  ] as const)(
    "fails closed when a projection crosses the %s bucket",
    (_dimension, overrides, expectedError) => {
      expect(() =>
        calculatePostQuoteFreshnessCompatibility(
          bucket,
          [projection("cross-bucket", "PASS", overrides)],
          context,
        ),
      ).toThrowError(expectedError);
    },
  );

  it("is deterministic across projection input order", () => {
    const projections = [
      projection("fresh", "PASS"),
      projection("stale", "STALE"),
      projection("before", "BEFORE_FRESHNESS"),
      projection("unavailable", "UNAVAILABLE"),
    ];

    expect(
      calculatePostQuoteFreshnessCompatibility(
        bucket,
        [...projections].reverse(),
        context,
      ),
    ).toEqual(
      calculatePostQuoteFreshnessCompatibility(bucket, projections, context),
    );
  });

  it("uses deterministic 18-digit truncation for a non-divisible ratio", () => {
    expect(
      calculatePostQuoteFreshnessCompatibility(
        bucket,
        [
          projection("fresh-a", "PASS"),
          projection("fresh-b", "PASS"),
          projection("stale", "STALE"),
        ],
        context,
      ).freshnessCompatibilityRate,
    ).toBe("0.666666666666666666");
  });

  it("never returns NaN or Infinity", () => {
    const result = calculatePostQuoteFreshnessCompatibility(
      bucket,
      [projection("before", "BEFORE_FRESHNESS")],
      context,
    );

    expect(result.freshnessCompatibilityRate).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });
});
