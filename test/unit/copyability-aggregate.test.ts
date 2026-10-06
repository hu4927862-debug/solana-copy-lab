import { describe, expect, it } from "vitest";
import { jsonStringify } from "../../src/domain/json.js";
import {
  calculateCopyabilityAggregate,
  type BuyCapacityCompatibilityResult,
  type CopyabilityAggregateComponents,
  type CopyabilityBucket,
  type CopyabilityEvaluationContext,
  type EndToEndApplicationCompatibilityResult,
  type JupiterQuoteUsabilityResult,
  type PositionMappingCompatibilityResult,
  type PostQuoteFreshnessCompatibilityResult,
  type PriceImpactCompatibilityResult,
  type SizeGranularityCompatibilityResult,
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
  copyabilityDefinitionVersion: "COPYABILITY_AGGREGATE_V1",
};

const positionMapping: PositionMappingCompatibilityResult = {
  ...bucket,
  mappingOpportunityCount: 4,
  mappedOpportunityCount: 2,
  mappingFailureCount: 2,
  mappingCompatibilityRate: "0.5",
  preconditionCount: 5,
  evaluableCount: 4,
  dataLimitationCount: 1,
  unavailableCount: 0,
  coverageRate: "0.8",
  status: "AVAILABLE",
  definitionVersion: "COPYABILITY_POSITION_MAPPING_V1",
};

const sizeGranularity: SizeGranularityCompatibilityResult = {
  ...bucket,
  granularityOpportunityCount: 3,
  granularOpportunityCount: 2,
  roundedToZeroCount: 1,
  granularityCompatibilityRate: "0.666666666666666666",
  preconditionCount: 4,
  evaluableCount: 3,
  dataLimitationCount: 1,
  unavailableCount: 0,
  coverageRate: "0.75",
  status: "AVAILABLE",
  definitionVersion: "COPYABILITY_SIZE_GRANULARITY_V1",
};

const buyCapacity: BuyCapacityCompatibilityResult = {
  ...bucket,
  capacityOpportunityCount: 3,
  fullSizeCount: 1,
  resizedCount: 2,
  capacityRejectCount: 0,
  fullSizeCompatibilityRate: "0.333333333333333333",
  requestedQuoteRawTotal: 300n,
  approvedQuoteRawTotal: 170n,
  amountCompatibilityRate: "0.566666666666666666",
  preconditionCount: 4,
  evaluableCount: 3,
  nonCapacityRiskExclusionCount: 1,
  dataLimitationCount: 0,
  unavailableCount: 0,
  coverageRate: "0.75",
  status: "AVAILABLE",
  definitionVersion: "COPYABILITY_BUY_CAPACITY_V1",
};

const jupiterQuoteUsability: JupiterQuoteUsabilityResult = {
  ...bucket,
  jupiterQuoteOpportunityCount: 10,
  usableJupiterQuoteCount: 7,
  jupiterQuoteUsabilityRate: "0.7",
  status: "AVAILABLE",
  definitionVersion: "JUPITER_QUOTE_USABILITY_V1",
};

const postQuoteFreshness: PostQuoteFreshnessCompatibilityResult = {
  ...bucket,
  freshnessOpportunityCount: 3,
  freshnessCompatibleCount: 2,
  staleQuoteCount: 1,
  freshnessCompatibilityRate: "0.666666666666666666",
  preconditionCount: 5,
  evaluableCount: 3,
  beforeFreshnessCount: 1,
  unavailableCount: 1,
  coverageRate: "0.6",
  status: "AVAILABLE",
  definitionVersion: "POST_QUOTE_FRESHNESS_COMPATIBILITY_V1",
};

const priceImpact: PriceImpactCompatibilityResult = {
  ...bucket,
  priceImpactOpportunityCount: 10,
  priceImpactCompatibleCount: 7,
  priceImpactRejectedCount: 3,
  priceImpactCompatibilityRate: "0.7",
  status: "AVAILABLE",
  definitionVersion: "PRICE_IMPACT_COMPATIBILITY_V1",
};

const endToEndApplication: EndToEndApplicationCompatibilityResult = {
  ...bucket,
  endToEndOpportunityCount: 5,
  applicationSuccessCount: 2,
  terminalFailureCount: 3,
  endToEndApplicationCompatibilityRate: "0.4",
  preconditionCount: 7,
  evaluableCount: 5,
  dataLimitationCount: 1,
  unavailableCount: 1,
  coverageRate: "0.714285714285714285",
  status: "AVAILABLE",
  definitionVersion: "END_TO_END_APPLICATION_COMPATIBILITY_V1",
};

const components: CopyabilityAggregateComponents = {
  positionMapping,
  sizeGranularity,
  buyCapacity,
  jupiterQuoteUsability,
  postQuoteFreshness,
  priceImpact,
  endToEndApplication,
};

describe("calculateCopyabilityAggregate", () => {
  it("preserves all seven frozen component results in one transparent aggregate", () => {
    expect(calculateCopyabilityAggregate(bucket, components, context)).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
      evaluationContext: context,
      positionMapping,
      sizeGranularity,
      buyCapacity,
      jupiterQuoteUsability,
      postQuoteFreshness,
      priceImpact,
      endToEndApplication,
      definitionVersion: "COPYABILITY_AGGREGATE_V1",
    });
  });

  it.each([
    ["position mapping", "positionMapping", { followerWallet: "follower-b" }],
    ["size granularity", "sizeGranularity", { leaderWallet: "leader-b" }],
    ["BUY capacity", "buyCapacity", { quoteMint: "SOL_NATIVE" }],
    [
      "Jupiter quote usability",
      "jupiterQuoteUsability",
      { followerWallet: "follower-b" },
    ],
    [
      "POST quote freshness",
      "postQuoteFreshness",
      { leaderWallet: "leader-b" },
    ],
    ["price impact", "priceImpact", { quoteMint: "SOL_NATIVE" }],
    [
      "end-to-end application",
      "endToEndApplication",
      { followerWallet: "follower-b" },
    ],
  ] as const)(
    "fails closed for a mismatched %s component bucket",
    (_label, componentName, bucketOverride) => {
      const mismatchedComponents = {
        ...components,
        [componentName]: {
          ...components[componentName],
          ...bucketOverride,
        },
      };

      expect(() =>
        calculateCopyabilityAggregate(bucket, mismatchedComponents, context),
      ).toThrowError("CONFLICTING_COPYABILITY_COMPONENT_BUCKETS");
    },
  );

  it("keeps EvaluationContext separate from wallet bucket identity", () => {
    const alternateContext: CopyabilityEvaluationContext = {
      ...context,
      window: { fromMs: 3_000, toMs: 4_000 },
      source: "alternate-fixture",
      copyRatioBps: 2_500,
    };

    const result = calculateCopyabilityAggregate(
      bucket,
      components,
      alternateContext,
    );

    expect(result).toMatchObject(bucket);
    expect(result.evaluationContext).toEqual(alternateContext);
    expect(result.evaluationContext).not.toHaveProperty("followerWallet");
    expect(result.evaluationContext).not.toHaveProperty("leaderWallet");
    expect(result.evaluationContext).not.toHaveProperty("quoteMint");
  });

  it("preserves component-specific no-opportunity and no-evaluable statuses", () => {
    const noDataComponents: CopyabilityAggregateComponents = {
      ...components,
      positionMapping: {
        ...positionMapping,
        mappingOpportunityCount: 0,
        mappedOpportunityCount: 0,
        mappingFailureCount: 0,
        mappingCompatibilityRate: null,
        preconditionCount: 0,
        evaluableCount: 0,
        dataLimitationCount: 0,
        coverageRate: null,
        status: "NO_SELL_OPPORTUNITIES",
      },
      postQuoteFreshness: {
        ...postQuoteFreshness,
        freshnessOpportunityCount: 0,
        freshnessCompatibleCount: 0,
        staleQuoteCount: 0,
        freshnessCompatibilityRate: null,
        evaluableCount: 0,
        coverageRate: "0",
        status: "NO_EVALUABLE_FRESHNESS_OUTCOMES",
      },
      jupiterQuoteUsability: {
        ...jupiterQuoteUsability,
        jupiterQuoteOpportunityCount: 0,
        usableJupiterQuoteCount: 0,
        jupiterQuoteUsabilityRate: null,
        status: "NO_JUPITER_QUOTE_OPPORTUNITIES",
      },
    };

    const result = calculateCopyabilityAggregate(
      bucket,
      noDataComponents,
      context,
    );

    expect(result.positionMapping.status).toBe("NO_SELL_OPPORTUNITIES");
    expect(result.postQuoteFreshness.status).toBe(
      "NO_EVALUABLE_FRESHNESS_OUTCOMES",
    );
    expect(result.jupiterQuoteUsability.status).toBe(
      "NO_JUPITER_QUOTE_OPPORTUNITIES",
    );
    expect(result).not.toHaveProperty("status");
  });

  it("preserves each component coverage without creating overall coverage", () => {
    const result = calculateCopyabilityAggregate(bucket, components, context);

    expect(result.positionMapping.coverageRate).toBe("0.8");
    expect(result.sizeGranularity.coverageRate).toBe("0.75");
    expect(result.buyCapacity.coverageRate).toBe("0.75");
    expect(result.postQuoteFreshness.coverageRate).toBe("0.6");
    expect(result.endToEndApplication.coverageRate).toBe(
      "0.714285714285714285",
    );
    expect(result).not.toHaveProperty("coverageRate");
  });

  it("preserves both BUY capacity compatibility metrics and RESIZE counts", () => {
    const result = calculateCopyabilityAggregate(bucket, components, context);

    expect(result.buyCapacity.fullSizeCompatibilityRate).toBe(
      "0.333333333333333333",
    );
    expect(result.buyCapacity.amountCompatibilityRate).toBe(
      "0.566666666666666666",
    );
    expect(result.buyCapacity.resizedCount).toBe(2);
    expect(result.buyCapacity.approvedQuoteRawTotal).toBe(170n);
  });

  it("does not expose a composite score, grade, or overall pass/fail", () => {
    const result = calculateCopyabilityAggregate(bucket, components, context);

    expect(result).not.toHaveProperty("copyabilityScore");
    expect(result).not.toHaveProperty("score");
    expect(result).not.toHaveProperty("grade");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("overallPass");
  });

  it("projects defensive component and EvaluationContext copies", () => {
    const mutablePositionMapping = { ...positionMapping };
    const mutableContext = { ...context, window: { ...context.window } };
    const mutableComponents = {
      ...components,
      positionMapping: mutablePositionMapping,
    };
    const result = calculateCopyabilityAggregate(
      bucket,
      mutableComponents,
      mutableContext,
    );

    mutablePositionMapping.mappingCompatibilityRate = "0";
    mutableContext.source = "mutated";
    mutableContext.window.fromMs = 99_999;

    expect(result.positionMapping.mappingCompatibilityRate).toBe("0.5");
    expect(result.evaluationContext.source).toBe("fixture");
    expect(result.evaluationContext.window.fromMs).toBe(1_000);
  });

  it("uses deterministic top-level field order regardless of input component order", () => {
    const reversedComponents: CopyabilityAggregateComponents = {
      endToEndApplication,
      priceImpact,
      postQuoteFreshness,
      jupiterQuoteUsability,
      buyCapacity,
      sizeGranularity,
      positionMapping,
    };

    const canonical = calculateCopyabilityAggregate(
      bucket,
      components,
      context,
    );
    const reversed = calculateCopyabilityAggregate(
      bucket,
      reversedComponents,
      context,
    );

    expect(Object.keys(canonical)).toEqual([
      "followerWallet",
      "leaderWallet",
      "quoteMint",
      "evaluationContext",
      "positionMapping",
      "sizeGranularity",
      "buyCapacity",
      "jupiterQuoteUsability",
      "postQuoteFreshness",
      "priceImpact",
      "endToEndApplication",
      "definitionVersion",
    ]);
    expect(jsonStringify(canonical)).toBe(jsonStringify(reversed));
  });

  it("uses the explicit aggregate definition version", () => {
    expect(
      calculateCopyabilityAggregate(bucket, components, context)
        .definitionVersion,
    ).toBe("COPYABILITY_AGGREGATE_V1");
  });

  it("does not introduce NaN or Infinity", () => {
    const serialized = jsonStringify(
      calculateCopyabilityAggregate(bucket, components, context),
    );

    expect(serialized).not.toContain("NaN");
    expect(serialized).not.toContain("Infinity");
  });
});
