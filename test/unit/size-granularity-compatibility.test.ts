import { describe, expect, it } from "vitest";
import type { FailureClassification } from "../../src/strategy-evaluation/failure-taxonomy.js";
import {
  calculateSizeGranularityCompatibility,
  type CopyabilityBucket,
  type CopyabilityEvaluationContext,
  type SizeGranularityOpportunityEvidence,
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
  copyabilityDefinitionVersion: "COPYABILITY_SIZE_GRANULARITY_V1",
};

function classification(
  overrides: Partial<FailureClassification> = {},
): FailureClassification {
  return {
    classificationStatus: "NOT_A_FAILURE",
    primaryCategory: null,
    stage: "PAPER_APPLICATION",
    reasonCode: null,
    definitionVersion: "OPPORTUNITY_FAILURE_V1",
    ...overrides,
  };
}

function opportunity(
  executionKey: string,
  overrides: Partial<SizeGranularityOpportunityEvidence> = {},
): SizeGranularityOpportunityEvidence {
  return {
    ...bucket,
    executionKey,
    side: "BUY",
    failureClassification: classification(),
    ...overrides,
  };
}

function positiveSizing(
  executionKey: string,
  side: "BUY" | "SELL",
  overrides: Partial<
    NonNullable<SizeGranularityOpportunityEvidence["preRiskSizingEvidence"]>
  > = {},
): NonNullable<SizeGranularityOpportunityEvidence["preRiskSizingEvidence"]> {
  return {
    ...bucket,
    intentId: executionKey,
    phase: "PRE_QUOTE",
    side,
    decision: "ALLOW",
    reasonCode: "ALLOW",
    requestedAmountRaw: 10n,
    approvedAmountRaw: 10n,
    requestedTokenRaw: side === "BUY" ? 20n : 10n,
    approvedTokenRaw: side === "BUY" ? 20n : 10n,
    requestedQuoteRaw: side === "BUY" ? 10n : 20n,
    approvedQuoteRaw: side === "BUY" ? 10n : 20n,
    ...overrides,
  };
}

describe("calculateSizeGranularityCompatibility", () => {
  it("counts positive BUY/SELL sizing and rounded-to-zero without contaminating the value denominator", () => {
    const result = calculateSizeGranularityCompatibility(
      bucket,
      [
        opportunity("positive-buy", {
          side: "BUY",
          preRiskSizingEvidence: positiveSizing("positive-buy", "BUY"),
        }),
        opportunity("positive-sell", {
          side: "SELL",
          preRiskSizingEvidence: positiveSizing("positive-sell", "SELL"),
        }),
        opportunity("rounded", {
          failureClassification: classification({
            classificationStatus: "CLASSIFIED",
            primaryCategory: "COPYABILITY_FAILURE",
            stage: "COPY_DECISION",
            reasonCode: "SIZE_ROUNDED_TO_ZERO",
          }),
        }),
        opportunity("mapping-failure", {
          side: "SELL",
          failureClassification: classification({
            classificationStatus: "CLASSIFIED",
            primaryCategory: "COPYABILITY_FAILURE",
            stage: "COPY_DECISION",
            reasonCode: "NO_MAPPED_POSITION",
          }),
        }),
        opportunity("data-limited", {
          failureClassification: classification({
            classificationStatus: "CLASSIFIED",
            primaryCategory: "DATA_LIMITATION",
            stage: "COPY_DECISION",
            reasonCode: "LEGACY_POSITION_COST_BASIS_UNAVAILABLE",
          }),
        }),
        opportunity("unavailable", {
          failureClassification: classification({
            classificationStatus: "UNAVAILABLE",
            primaryCategory: null,
            stage: null,
            reasonCode: "CONFLICTING_EVIDENCE",
          }),
        }),
      ],
      context,
    );

    expect(result).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
      granularityOpportunityCount: 3,
      granularOpportunityCount: 2,
      roundedToZeroCount: 1,
      granularityCompatibilityRate: "0.666666666666666666",
      preconditionCount: 5,
      evaluableCount: 3,
      dataLimitationCount: 1,
      unavailableCount: 1,
      coverageRate: "0.6",
      status: "AVAILABLE",
      definitionVersion: "COPYABILITY_SIZE_GRANULARITY_V1",
    });
  });

  it("reports full compatibility when every sizing outcome is positive", () => {
    expect(
      calculateSizeGranularityCompatibility(
        bucket,
        [
          opportunity("buy", {
            side: "BUY",
            preRiskSizingEvidence: positiveSizing("buy", "BUY"),
          }),
          opportunity("sell", {
            side: "SELL",
            preRiskSizingEvidence: positiveSizing("sell", "SELL"),
          }),
        ],
        context,
      ),
    ).toMatchObject({
      granularityOpportunityCount: 2,
      granularOpportunityCount: 2,
      roundedToZeroCount: 0,
      granularityCompatibilityRate: "1",
      coverageRate: "1",
      status: "AVAILABLE",
    });
  });

  it("reports zero compatibility when every sizing outcome rounded to zero", () => {
    const roundedClassification = classification({
      classificationStatus: "CLASSIFIED",
      primaryCategory: "COPYABILITY_FAILURE",
      stage: "COPY_DECISION",
      reasonCode: "SIZE_ROUNDED_TO_ZERO",
    });

    expect(
      calculateSizeGranularityCompatibility(
        bucket,
        [
          opportunity("rounded-buy", {
            side: "BUY",
            failureClassification: roundedClassification,
          }),
          opportunity("rounded-sell", {
            side: "SELL",
            failureClassification: roundedClassification,
          }),
        ],
        context,
      ),
    ).toMatchObject({
      granularityOpportunityCount: 2,
      granularOpportunityCount: 0,
      roundedToZeroCount: 2,
      granularityCompatibilityRate: "0",
      coverageRate: "1",
    });
  });

  it("returns an explicit no-opportunity result for empty evidence", () => {
    expect(calculateSizeGranularityCompatibility(bucket, [], context)).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
      granularityOpportunityCount: 0,
      granularOpportunityCount: 0,
      roundedToZeroCount: 0,
      granularityCompatibilityRate: null,
      preconditionCount: 0,
      evaluableCount: 0,
      dataLimitationCount: 0,
      unavailableCount: 0,
      coverageRate: null,
      status: "NO_SIZING_OPPORTUNITIES",
      definitionVersion: "COPYABILITY_SIZE_GRANULARITY_V1",
    });
  });

  it("uses BUY quote input and SELL token input as the side-specific requested amount", () => {
    expect(
      calculateSizeGranularityCompatibility(
        bucket,
        [
          opportunity("buy-side", {
            side: "BUY",
            preRiskSizingEvidence: positiveSizing("buy-side", "BUY", {
              requestedAmountRaw: 7n,
              requestedQuoteRaw: 7n,
              requestedTokenRaw: 70n,
              approvedAmountRaw: 7n,
              approvedQuoteRaw: 7n,
              approvedTokenRaw: 70n,
            }),
          }),
          opportunity("sell-side", {
            side: "SELL",
            preRiskSizingEvidence: positiveSizing("sell-side", "SELL", {
              requestedAmountRaw: 9n,
              requestedTokenRaw: 9n,
              requestedQuoteRaw: 90n,
              approvedAmountRaw: 9n,
              approvedTokenRaw: 9n,
              approvedQuoteRaw: 90n,
            }),
          }),
        ],
        context,
      ),
    ).toMatchObject({
      granularityOpportunityCount: 2,
      granularOpportunityCount: 2,
      granularityCompatibilityRate: "1",
    });
  });

  it("keeps a positive PRE Risk RESIZE as a granularity pass", () => {
    expect(
      calculateSizeGranularityCompatibility(
        bucket,
        [
          opportunity("resized", {
            preRiskSizingEvidence: positiveSizing("resized", "BUY", {
              decision: "RESIZE",
              reasonCode: "SINGLE_TRADE_LIMIT",
              approvedAmountRaw: 4n,
              approvedTokenRaw: 8n,
              approvedQuoteRaw: 4n,
            }),
          }),
        ],
        context,
      ),
    ).toMatchObject({
      granularityOpportunityCount: 1,
      granularOpportunityCount: 1,
      roundedToZeroCount: 0,
      granularityCompatibilityRate: "1",
    });
  });

  it.each(["NO_MAPPED_POSITION", "INSUFFICIENT_MAPPED_POSITION"])(
    "excludes the mapping failure %s from granularity value and coverage",
    (reasonCode) => {
      expect(
        calculateSizeGranularityCompatibility(
          bucket,
          [
            opportunity(reasonCode, {
              side: "SELL",
              failureClassification: classification({
                classificationStatus: "CLASSIFIED",
                primaryCategory: "COPYABILITY_FAILURE",
                stage: "COPY_DECISION",
                reasonCode,
              }),
            }),
          ],
          context,
        ),
      ).toMatchObject({
        granularityOpportunityCount: 0,
        preconditionCount: 0,
        evaluableCount: 0,
        dataLimitationCount: 0,
        unavailableCount: 0,
        coverageRate: null,
        status: "NO_SIZING_OPPORTUNITIES",
      });
    },
  );

  it("counts positive PRE sizing before an atomic insufficient-position reservation as a granularity pass", () => {
    expect(
      calculateSizeGranularityCompatibility(
        bucket,
        [
          opportunity("insufficient-after-pre", {
            side: "SELL",
            preRiskSizingEvidence: positiveSizing(
              "insufficient-after-pre",
              "SELL",
            ),
            failureClassification: classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "COPYABILITY_FAILURE",
              stage: "COPY_DECISION",
              reasonCode: "INSUFFICIENT_MAPPED_POSITION",
            }),
          }),
        ],
        context,
      ),
    ).toMatchObject({
      granularityOpportunityCount: 1,
      granularOpportunityCount: 1,
      roundedToZeroCount: 0,
      granularityCompatibilityRate: "1",
      preconditionCount: 1,
      evaluableCount: 1,
    });
  });

  it("keeps a Data Limitation out of the value denominator", () => {
    expect(
      calculateSizeGranularityCompatibility(
        bucket,
        [
          opportunity("data-limited", {
            failureClassification: classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "DATA_LIMITATION",
              stage: "COPY_DECISION",
              reasonCode: "LEGACY_POSITION_COST_BASIS_UNAVAILABLE",
            }),
          }),
        ],
        context,
      ),
    ).toMatchObject({
      granularityOpportunityCount: 0,
      preconditionCount: 1,
      evaluableCount: 0,
      dataLimitationCount: 1,
      unavailableCount: 0,
      coverageRate: "0",
      status: "NO_EVALUABLE_GRANULARITY_OUTCOMES",
    });
  });

  it("keeps unavailable evidence out of the value denominator", () => {
    expect(
      calculateSizeGranularityCompatibility(
        bucket,
        [
          opportunity("unavailable", {
            failureClassification: classification({
              classificationStatus: "UNAVAILABLE",
              primaryCategory: null,
              stage: null,
              reasonCode: "CONFLICTING_EVIDENCE",
            }),
          }),
        ],
        context,
      ),
    ).toMatchObject({
      granularityOpportunityCount: 0,
      preconditionCount: 1,
      evaluableCount: 0,
      dataLimitationCount: 0,
      unavailableCount: 1,
      coverageRate: "0",
      status: "NO_EVALUABLE_GRANULARITY_OUTCOMES",
    });
  });

  it("deduplicates identical opportunity evidence by executionKey", () => {
    const positive = opportunity("duplicate", {
      preRiskSizingEvidence: positiveSizing("duplicate", "BUY"),
    });

    expect(
      calculateSizeGranularityCompatibility(
        bucket,
        [positive, { ...positive }],
        context,
      ),
    ).toMatchObject({
      granularityOpportunityCount: 1,
      granularOpportunityCount: 1,
      preconditionCount: 1,
      evaluableCount: 1,
    });
  });

  it("fails closed when one executionKey is both positive and rounded to zero", () => {
    const positive = opportunity("conflict", {
      preRiskSizingEvidence: positiveSizing("conflict", "BUY"),
    });
    const rounded = opportunity("conflict", {
      failureClassification: classification({
        classificationStatus: "CLASSIFIED",
        primaryCategory: "COPYABILITY_FAILURE",
        stage: "COPY_DECISION",
        reasonCode: "SIZE_ROUNDED_TO_ZERO",
      }),
    });

    expect(() =>
      calculateSizeGranularityCompatibility(
        bucket,
        [positive, rounded],
        context,
      ),
    ).toThrowError("CONFLICTING_SIZE_GRANULARITY_OPPORTUNITY_EVIDENCE");
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
    "fails closed on a cross-%s opportunity",
    (_dimension, overrides, expectedError) => {
      expect(() =>
        calculateSizeGranularityCompatibility(
          bucket,
          [opportunity("cross-bucket", overrides)],
          context,
        ),
      ).toThrowError(expectedError);
    },
  );

  it("is deterministic across input order", () => {
    const evidence = [
      opportunity("positive", {
        preRiskSizingEvidence: positiveSizing("positive", "BUY"),
      }),
      opportunity("rounded", {
        failureClassification: classification({
          classificationStatus: "CLASSIFIED",
          primaryCategory: "COPYABILITY_FAILURE",
          stage: "COPY_DECISION",
          reasonCode: "SIZE_ROUNDED_TO_ZERO",
        }),
      }),
      opportunity("data-limited", {
        failureClassification: classification({
          classificationStatus: "CLASSIFIED",
          primaryCategory: "DATA_LIMITATION",
          stage: "COPY_DECISION",
          reasonCode: "LEGACY_POSITION_COST_BASIS_UNAVAILABLE",
        }),
      }),
    ];

    expect(
      calculateSizeGranularityCompatibility(
        bucket,
        [...evidence].reverse(),
        context,
      ),
    ).toEqual(calculateSizeGranularityCompatibility(bucket, evidence, context));
  });

  it("uses deterministic 18-digit truncation for a non-divisible ratio", () => {
    const positive = Array.from({ length: 5 }, (_, index) =>
      opportunity(`positive-${index}`, {
        preRiskSizingEvidence: positiveSizing(`positive-${index}`, "BUY"),
      }),
    );
    const rounded = Array.from({ length: 2 }, (_, index) =>
      opportunity(`rounded-${index}`, {
        failureClassification: classification({
          classificationStatus: "CLASSIFIED",
          primaryCategory: "COPYABILITY_FAILURE",
          stage: "COPY_DECISION",
          reasonCode: "SIZE_ROUNDED_TO_ZERO",
        }),
      }),
    );

    expect(
      calculateSizeGranularityCompatibility(
        bucket,
        [...positive, ...rounded],
        context,
      ),
    ).toMatchObject({
      granularityOpportunityCount: 7,
      granularOpportunityCount: 5,
      roundedToZeroCount: 2,
      granularityCompatibilityRate: "0.714285714285714285",
    });
  });
});
