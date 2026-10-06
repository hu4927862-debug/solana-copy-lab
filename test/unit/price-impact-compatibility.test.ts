import { describe, expect, it } from "vitest";
import type {
  PostRiskDistributionResult,
  PriceImpactRejectRateResult,
} from "../../src/strategy-evaluation/execution-quality.js";
import {
  calculatePriceImpactCompatibility,
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
  copyabilityDefinitionVersion: "PRICE_IMPACT_COMPATIBILITY_V1",
};

function analyticalRate(numerator: number, denominator: number): string | null {
  if (denominator === 0) return null;
  let remainder = BigInt(numerator) % BigInt(denominator);
  const integerPart = BigInt(numerator) / BigInt(denominator);
  if (remainder === 0n) return integerPart.toString();

  let fractionalPart = "";
  for (let digit = 0; digit < 18 && remainder !== 0n; digit += 1) {
    remainder *= 10n;
    fractionalPart += (remainder / BigInt(denominator)).toString();
    remainder %= BigInt(denominator);
  }
  return `${integerPart}.${fractionalPart.replace(/0+$/, "")}`;
}

function postRiskDistribution(
  overrides: Partial<PostRiskDistributionResult> = {},
): PostRiskDistributionResult {
  const result = {
    ...bucket,
    postRiskDecisionCount: 10,
    postRiskAllowCount: 7,
    postRiskResizeCount: 0,
    postRiskRejectCount: 3,
    postRiskHaltCount: 0,
    allowRate: "0.7",
    resizeRate: "0",
    rejectRate: "0.3",
    haltRate: "0",
    status: "AVAILABLE" as const,
    ...overrides,
  };
  return {
    ...result,
    allowRate: Object.hasOwn(overrides, "allowRate")
      ? result.allowRate
      : analyticalRate(result.postRiskAllowCount, result.postRiskDecisionCount),
    resizeRate: Object.hasOwn(overrides, "resizeRate")
      ? result.resizeRate
      : analyticalRate(
          result.postRiskResizeCount,
          result.postRiskDecisionCount,
        ),
    rejectRate: Object.hasOwn(overrides, "rejectRate")
      ? result.rejectRate
      : analyticalRate(
          result.postRiskRejectCount,
          result.postRiskDecisionCount,
        ),
    haltRate: Object.hasOwn(overrides, "haltRate")
      ? result.haltRate
      : analyticalRate(result.postRiskHaltCount, result.postRiskDecisionCount),
  };
}

function priceImpactRejectRate(
  overrides: Partial<PriceImpactRejectRateResult> = {},
): PriceImpactRejectRateResult {
  const result = {
    ...bucket,
    postRiskDecisionCount: 10,
    priceImpactRejectCount: 3,
    priceImpactRejectRate: "0.3",
    status: "AVAILABLE" as const,
    ...overrides,
  };
  return {
    ...result,
    priceImpactRejectRate: Object.hasOwn(overrides, "priceImpactRejectRate")
      ? result.priceImpactRejectRate
      : analyticalRate(
          result.priceImpactRejectCount,
          result.postRiskDecisionCount,
        ),
  };
}

describe("calculatePriceImpactCompatibility", () => {
  it("composes POST ALLOW and price-impact reject analytical counts", () => {
    expect(
      calculatePriceImpactCompatibility(
        bucket,
        {
          postRiskDistribution: postRiskDistribution(),
          priceImpactRejectRate: priceImpactRejectRate(),
        },
        context,
      ),
    ).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
      priceImpactOpportunityCount: 10,
      priceImpactCompatibleCount: 7,
      priceImpactRejectedCount: 3,
      priceImpactCompatibilityRate: "0.7",
      status: "AVAILABLE",
      definitionVersion: "PRICE_IMPACT_COMPATIBILITY_V1",
    });
  });

  it("reports full compatibility when every evaluable opportunity is POST ALLOW", () => {
    expect(
      calculatePriceImpactCompatibility(
        bucket,
        {
          postRiskDistribution: postRiskDistribution({
            postRiskDecisionCount: 3,
            postRiskAllowCount: 3,
            postRiskRejectCount: 0,
          }),
          priceImpactRejectRate: priceImpactRejectRate({
            postRiskDecisionCount: 3,
            priceImpactRejectCount: 0,
          }),
        },
        context,
      ),
    ).toMatchObject({
      priceImpactOpportunityCount: 3,
      priceImpactCompatibleCount: 3,
      priceImpactRejectedCount: 0,
      priceImpactCompatibilityRate: "1",
      status: "AVAILABLE",
    });
  });

  it("reports zero compatibility when every evaluable opportunity is a price-impact reject", () => {
    expect(
      calculatePriceImpactCompatibility(
        bucket,
        {
          postRiskDistribution: postRiskDistribution({
            postRiskDecisionCount: 3,
            postRiskAllowCount: 0,
            postRiskRejectCount: 3,
          }),
          priceImpactRejectRate: priceImpactRejectRate({
            postRiskDecisionCount: 3,
            priceImpactRejectCount: 3,
          }),
        },
        context,
      ),
    ).toMatchObject({
      priceImpactOpportunityCount: 3,
      priceImpactCompatibleCount: 0,
      priceImpactRejectedCount: 3,
      priceImpactCompatibilityRate: "0",
      status: "AVAILABLE",
    });
  });

  it("does not manufacture a zero rate when POST decisions contain no evaluable price-impact outcome", () => {
    expect(
      calculatePriceImpactCompatibility(
        bucket,
        {
          postRiskDistribution: postRiskDistribution({
            postRiskDecisionCount: 4,
            postRiskAllowCount: 0,
            postRiskRejectCount: 4,
          }),
          priceImpactRejectRate: priceImpactRejectRate({
            postRiskDecisionCount: 4,
            priceImpactRejectCount: 0,
          }),
        },
        context,
      ),
    ).toMatchObject({
      priceImpactOpportunityCount: 0,
      priceImpactCompatibleCount: 0,
      priceImpactRejectedCount: 0,
      priceImpactCompatibilityRate: null,
      status: "NO_PRICE_IMPACT_OPPORTUNITIES",
    });
  });

  it("keeps upstream PRICE_IMPACT_UNAVAILABLE outcomes outside the value denominator", () => {
    expect(
      calculatePriceImpactCompatibility(
        bucket,
        {
          postRiskDistribution: postRiskDistribution({
            postRiskDecisionCount: 2,
            postRiskAllowCount: 1,
            postRiskRejectCount: 1,
          }),
          priceImpactRejectRate: priceImpactRejectRate({
            postRiskDecisionCount: 2,
            priceImpactRejectCount: 0,
          }),
        },
        context,
      ),
    ).toMatchObject({
      priceImpactOpportunityCount: 1,
      priceImpactCompatibleCount: 1,
      priceImpactRejectedCount: 0,
      priceImpactCompatibilityRate: "1",
    });
  });

  it("does not let unrelated POST rejects lower price-impact compatibility", () => {
    expect(
      calculatePriceImpactCompatibility(
        bucket,
        {
          postRiskDistribution: postRiskDistribution({
            postRiskDecisionCount: 5,
            postRiskAllowCount: 2,
            postRiskRejectCount: 3,
          }),
          priceImpactRejectRate: priceImpactRejectRate({
            postRiskDecisionCount: 5,
            priceImpactRejectCount: 0,
          }),
        },
        context,
      ),
    ).toMatchObject({
      priceImpactOpportunityCount: 2,
      priceImpactCompatibleCount: 2,
      priceImpactRejectedCount: 0,
      priceImpactCompatibilityRate: "1",
    });
  });

  it("uses deterministic 18-digit truncation for a non-divisible ratio", () => {
    expect(
      calculatePriceImpactCompatibility(
        bucket,
        {
          postRiskDistribution: postRiskDistribution({
            postRiskDecisionCount: 3,
            postRiskAllowCount: 2,
            postRiskRejectCount: 1,
          }),
          priceImpactRejectRate: priceImpactRejectRate({
            postRiskDecisionCount: 3,
            priceImpactRejectCount: 1,
          }),
        },
        context,
      ).priceImpactCompatibilityRate,
    ).toBe("0.666666666666666666");
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
    "fails closed when an analytical result crosses the %s bucket",
    (_dimension, overrides, expectedError) => {
      expect(() =>
        calculatePriceImpactCompatibility(
          bucket,
          {
            postRiskDistribution: postRiskDistribution(),
            priceImpactRejectRate: priceImpactRejectRate(overrides),
          },
          context,
        ),
      ).toThrowError(expectedError);
    },
  );

  it("is deterministic across analytical input property insertion order", () => {
    const distribution = postRiskDistribution();
    const rejects = priceImpactRejectRate();

    expect(
      calculatePriceImpactCompatibility(
        bucket,
        {
          priceImpactRejectRate: rejects,
          postRiskDistribution: distribution,
        },
        context,
      ),
    ).toEqual(
      calculatePriceImpactCompatibility(
        bucket,
        {
          postRiskDistribution: distribution,
          priceImpactRejectRate: rejects,
        },
        context,
      ),
    );
  });

  it("maps consistent upstream NO_POST_RISK_DECISIONS to no price-impact opportunities", () => {
    expect(
      calculatePriceImpactCompatibility(
        bucket,
        {
          postRiskDistribution: postRiskDistribution({
            postRiskDecisionCount: 0,
            postRiskAllowCount: 0,
            postRiskRejectCount: 0,
            status: "NO_POST_RISK_DECISIONS",
          }),
          priceImpactRejectRate: priceImpactRejectRate({
            postRiskDecisionCount: 0,
            priceImpactRejectCount: 0,
            status: "NO_POST_RISK_DECISIONS",
          }),
        },
        context,
      ),
    ).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
      priceImpactOpportunityCount: 0,
      priceImpactCompatibleCount: 0,
      priceImpactRejectedCount: 0,
      priceImpactCompatibilityRate: null,
      status: "NO_PRICE_IMPACT_OPPORTUNITIES",
      definitionVersion: "PRICE_IMPACT_COMPATIBILITY_V1",
    });
  });

  it("fails closed when upstream analytical counts or statuses conflict", () => {
    expect(() =>
      calculatePriceImpactCompatibility(
        bucket,
        {
          postRiskDistribution: postRiskDistribution(),
          priceImpactRejectRate: priceImpactRejectRate({
            postRiskDecisionCount: 9,
          }),
        },
        context,
      ),
    ).toThrowError("CONFLICTING_PRICE_IMPACT_ANALYTICAL_RESULTS");

    expect(() =>
      calculatePriceImpactCompatibility(
        bucket,
        {
          postRiskDistribution: postRiskDistribution(),
          priceImpactRejectRate: priceImpactRejectRate({
            status: "NO_POST_RISK_DECISIONS",
          }),
        },
        context,
      ),
    ).toThrowError("CONFLICTING_PRICE_IMPACT_ANALYTICAL_RESULTS");
  });

  it("fails closed when an upstream analytical rate conflicts with its counts", () => {
    expect(() =>
      calculatePriceImpactCompatibility(
        bucket,
        {
          postRiskDistribution: postRiskDistribution({ allowRate: "0.1" }),
          priceImpactRejectRate: priceImpactRejectRate(),
        },
        context,
      ),
    ).toThrowError("CONFLICTING_PRICE_IMPACT_ANALYTICAL_RESULTS");

    expect(() =>
      calculatePriceImpactCompatibility(
        bucket,
        {
          postRiskDistribution: postRiskDistribution(),
          priceImpactRejectRate: priceImpactRejectRate({
            priceImpactRejectRate: "0",
          }),
        },
        context,
      ),
    ).toThrowError("CONFLICTING_PRICE_IMPACT_ANALYTICAL_RESULTS");
  });

  it("returns only finite decimal strings or null", () => {
    const zero = calculatePriceImpactCompatibility(
      bucket,
      {
        postRiskDistribution: postRiskDistribution({
          postRiskDecisionCount: 0,
          postRiskAllowCount: 0,
          postRiskRejectCount: 0,
          status: "NO_POST_RISK_DECISIONS",
        }),
        priceImpactRejectRate: priceImpactRejectRate({
          postRiskDecisionCount: 0,
          priceImpactRejectCount: 0,
          status: "NO_POST_RISK_DECISIONS",
        }),
      },
      context,
    );
    const rejected = calculatePriceImpactCompatibility(
      bucket,
      {
        postRiskDistribution: postRiskDistribution({
          postRiskDecisionCount: 1,
          postRiskAllowCount: 0,
          postRiskRejectCount: 1,
        }),
        priceImpactRejectRate: priceImpactRejectRate({
          postRiskDecisionCount: 1,
          priceImpactRejectCount: 1,
        }),
      },
      context,
    );

    expect(zero.priceImpactCompatibilityRate).toBeNull();
    expect(rejected.priceImpactCompatibilityRate).toBe("0");
    expect(JSON.stringify([zero, rejected])).not.toMatch(/NaN|Infinity/);
  });
});
