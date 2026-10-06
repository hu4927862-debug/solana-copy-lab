import { describe, expect, it } from "vitest";
import type { RiskReasonCode } from "../../src/risk/risk-engine.js";
import type { FailureClassification } from "../../src/strategy-evaluation/failure-taxonomy.js";
import {
  calculateBuyCapacityCompatibility,
  type BuyCapacityOpportunityEvidence,
  type CopyabilityBucket,
  type CopyabilityEvaluationContext,
  type NormalizedPreRiskSizingEvidence,
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
  copyabilityDefinitionVersion: "COPYABILITY_BUY_CAPACITY_V1",
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

function preRiskDecision(
  executionKey: string,
  decision: NormalizedPreRiskSizingEvidence["decision"],
  requestedQuoteRaw: bigint,
  approvedQuoteRaw: bigint,
  reasonCode: RiskReasonCode,
  overrides: Partial<NormalizedPreRiskSizingEvidence> = {},
): NormalizedPreRiskSizingEvidence {
  return {
    ...bucket,
    intentId: executionKey,
    phase: "PRE_QUOTE",
    side: "BUY",
    decision,
    reasonCode,
    requestedAmountRaw: requestedQuoteRaw,
    approvedAmountRaw: approvedQuoteRaw,
    requestedTokenRaw: requestedQuoteRaw * 2n,
    approvedTokenRaw: approvedQuoteRaw * 2n,
    requestedQuoteRaw,
    approvedQuoteRaw,
    ...overrides,
  };
}

function opportunity(
  executionKey: string,
  overrides: Partial<BuyCapacityOpportunityEvidence> = {},
): BuyCapacityOpportunityEvidence {
  return {
    ...bucket,
    executionKey,
    side: "BUY",
    failureClassification: classification(),
    ...overrides,
  };
}

describe("calculateBuyCapacityCompatibility", () => {
  it("preserves full-size and amount compatibility across ALLOW, capacity RESIZE, and excluded evidence", () => {
    const result = calculateBuyCapacityCompatibility(
      bucket,
      [
        opportunity("allow", {
          preRiskSizingEvidence: preRiskDecision(
            "allow",
            "ALLOW",
            100n,
            100n,
            "ALLOW",
          ),
        }),
        opportunity("resize-50", {
          failureClassification: classification({
            stage: "PRE_QUOTE_RISK",
            reasonCode: "SINGLE_TRADE_LIMIT",
          }),
          preRiskSizingEvidence: preRiskDecision(
            "resize-50",
            "RESIZE",
            100n,
            50n,
            "SINGLE_TRADE_LIMIT",
          ),
        }),
        opportunity("resize-20", {
          failureClassification: classification({
            stage: "PRE_QUOTE_RISK",
            reasonCode: "TOKEN_COST_EXPOSURE_LIMIT",
          }),
          preRiskSizingEvidence: preRiskDecision(
            "resize-20",
            "RESIZE",
            100n,
            20n,
            "TOKEN_COST_EXPOSURE_LIMIT",
          ),
        }),
        opportunity("non-capacity-risk", {
          failureClassification: classification({
            classificationStatus: "CLASSIFIED",
            primaryCategory: "RISK_REJECTION",
            stage: "PRE_QUOTE_RISK",
            reasonCode: "PROVIDER_DEGRADED",
          }),
          preRiskSizingEvidence: preRiskDecision(
            "non-capacity-risk",
            "REJECT",
            100n,
            0n,
            "PROVIDER_DEGRADED",
          ),
        }),
        opportunity("data-limited", {
          failureClassification: classification({
            classificationStatus: "CLASSIFIED",
            primaryCategory: "DATA_LIMITATION",
            stage: "OBSERVATION_CLASSIFICATION",
            reasonCode: "PARSER_FAILURE",
          }),
        }),
        opportunity("sell", {
          side: "SELL",
          preRiskSizingEvidence: preRiskDecision(
            "sell",
            "ALLOW",
            100n,
            100n,
            "ALLOW",
            { side: "SELL" },
          ),
        }),
      ],
      context,
    );

    expect(result).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
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
      dataLimitationCount: 1,
      unavailableCount: 0,
      coverageRate: "0.75",
      status: "AVAILABLE",
      definitionVersion: "COPYABILITY_BUY_CAPACITY_V1",
    });
  });

  it("reports full compatibility when every capacity outcome is ALLOW", () => {
    expect(
      calculateBuyCapacityCompatibility(
        bucket,
        [
          opportunity("allow-a", {
            preRiskSizingEvidence: preRiskDecision(
              "allow-a",
              "ALLOW",
              40n,
              40n,
              "ALLOW",
            ),
          }),
          opportunity("allow-b", {
            preRiskSizingEvidence: preRiskDecision(
              "allow-b",
              "ALLOW",
              60n,
              60n,
              "ALLOW",
            ),
          }),
        ],
        context,
      ),
    ).toMatchObject({
      capacityOpportunityCount: 2,
      fullSizeCount: 2,
      resizedCount: 0,
      capacityRejectCount: 0,
      fullSizeCompatibilityRate: "1",
      requestedQuoteRawTotal: 100n,
      approvedQuoteRawTotal: 100n,
      amountCompatibilityRate: "1",
      coverageRate: "1",
    });
  });

  it("preserves partial amounts when every capacity outcome is RESIZE", () => {
    expect(
      calculateBuyCapacityCompatibility(
        bucket,
        [
          opportunity("single", {
            preRiskSizingEvidence: preRiskDecision(
              "single",
              "RESIZE",
              100n,
              50n,
              "SINGLE_TRADE_LIMIT",
            ),
          }),
          opportunity("token", {
            preRiskSizingEvidence: preRiskDecision(
              "token",
              "RESIZE",
              100n,
              20n,
              "TOKEN_COST_EXPOSURE_LIMIT",
            ),
          }),
          opportunity("portfolio", {
            preRiskSizingEvidence: preRiskDecision(
              "portfolio",
              "RESIZE",
              100n,
              30n,
              "PORTFOLIO_COST_EXPOSURE_LIMIT",
            ),
          }),
        ],
        context,
      ),
    ).toMatchObject({
      capacityOpportunityCount: 3,
      fullSizeCount: 0,
      resizedCount: 3,
      capacityRejectCount: 0,
      fullSizeCompatibilityRate: "0",
      requestedQuoteRawTotal: 300n,
      approvedQuoteRawTotal: 100n,
      amountCompatibilityRate: "0.333333333333333333",
    });
  });

  it.each([
    "SINGLE_TRADE_LIMIT",
    "TOKEN_COST_EXPOSURE_LIMIT",
    "PORTFOLIO_COST_EXPOSURE_LIMIT",
  ] as const)(
    "counts zero remaining capacity with exact reason %s as a capacity REJECT",
    (reasonCode) => {
      expect(
        calculateBuyCapacityCompatibility(
          bucket,
          [
            opportunity(`reject-${reasonCode}`, {
              failureClassification: classification({
                classificationStatus: "CLASSIFIED",
                primaryCategory: "RISK_REJECTION",
                stage: "PRE_QUOTE_RISK",
                reasonCode,
              }),
              preRiskSizingEvidence: preRiskDecision(
                `reject-${reasonCode}`,
                "REJECT",
                100n,
                0n,
                reasonCode,
              ),
            }),
          ],
          context,
        ),
      ).toMatchObject({
        capacityOpportunityCount: 1,
        fullSizeCount: 0,
        resizedCount: 0,
        capacityRejectCount: 1,
        fullSizeCompatibilityRate: "0",
        requestedQuoteRawTotal: 100n,
        approvedQuoteRawTotal: 0n,
        amountCompatibilityRate: "0",
      });
    },
  );

  it("returns an explicit no-opportunity result for empty evidence", () => {
    expect(calculateBuyCapacityCompatibility(bucket, [], context)).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
      capacityOpportunityCount: 0,
      fullSizeCount: 0,
      resizedCount: 0,
      capacityRejectCount: 0,
      fullSizeCompatibilityRate: null,
      requestedQuoteRawTotal: 0n,
      approvedQuoteRawTotal: 0n,
      amountCompatibilityRate: null,
      preconditionCount: 0,
      evaluableCount: 0,
      nonCapacityRiskExclusionCount: 0,
      dataLimitationCount: 0,
      unavailableCount: 0,
      coverageRate: null,
      status: "NO_BUY_CAPACITY_OPPORTUNITIES",
      definitionVersion: "COPYABILITY_BUY_CAPACITY_V1",
    });
  });

  it("ignores SELL PRE Risk decisions", () => {
    expect(
      calculateBuyCapacityCompatibility(
        bucket,
        [
          opportunity("sell", {
            side: "SELL",
            preRiskSizingEvidence: preRiskDecision(
              "sell",
              "ALLOW",
              100n,
              100n,
              "ALLOW",
              { side: "SELL" },
            ),
          }),
        ],
        context,
      ),
    ).toMatchObject({
      capacityOpportunityCount: 0,
      preconditionCount: 0,
      nonCapacityRiskExclusionCount: 0,
      status: "NO_BUY_CAPACITY_OPPORTUNITIES",
    });
  });

  it.each([
    ["STALE_INTENT", "REJECT"],
    ["GLOBAL_HALT_NEW_RISK", "HALT"],
    ["DAILY_REALIZED_LOSS_LIMIT", "HALT"],
    ["PROVIDER_DEGRADED", "REJECT"],
  ] as const)(
    "excludes non-capacity PRE Risk outcome %s",
    (reasonCode, decision) => {
      expect(
        calculateBuyCapacityCompatibility(
          bucket,
          [
            opportunity(reasonCode, {
              failureClassification: classification({
                classificationStatus: "CLASSIFIED",
                primaryCategory: "RISK_REJECTION",
                stage: "PRE_QUOTE_RISK",
                reasonCode,
              }),
              preRiskSizingEvidence: preRiskDecision(
                reasonCode,
                decision,
                100n,
                0n,
                reasonCode,
              ),
            }),
          ],
          context,
        ),
      ).toMatchObject({
        capacityOpportunityCount: 0,
        preconditionCount: 0,
        evaluableCount: 0,
        nonCapacityRiskExclusionCount: 1,
        coverageRate: null,
        status: "NO_BUY_CAPACITY_OPPORTUNITIES",
      });
    },
  );

  it("excludes SIZE_ROUNDED_TO_ZERO before PRE capacity", () => {
    expect(
      calculateBuyCapacityCompatibility(
        bucket,
        [
          opportunity("rounded", {
            failureClassification: classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "COPYABILITY_FAILURE",
              stage: "COPY_DECISION",
              reasonCode: "SIZE_ROUNDED_TO_ZERO",
            }),
          }),
        ],
        context,
      ),
    ).toMatchObject({
      capacityOpportunityCount: 0,
      preconditionCount: 0,
      dataLimitationCount: 0,
      unavailableCount: 0,
      status: "NO_BUY_CAPACITY_OPPORTUNITIES",
    });
  });

  it("keeps Data Limitation out of the capacity value denominator", () => {
    expect(
      calculateBuyCapacityCompatibility(
        bucket,
        [
          opportunity("data-limited", {
            failureClassification: classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "DATA_LIMITATION",
              stage: "OBSERVATION_CLASSIFICATION",
              reasonCode: "PARSER_FAILURE",
            }),
          }),
        ],
        context,
      ),
    ).toMatchObject({
      capacityOpportunityCount: 0,
      preconditionCount: 1,
      evaluableCount: 0,
      dataLimitationCount: 1,
      unavailableCount: 0,
      coverageRate: "0",
      status: "NO_EVALUABLE_BUY_CAPACITY_OUTCOMES",
    });
  });

  it("keeps unavailable evidence out of the capacity value denominator", () => {
    expect(
      calculateBuyCapacityCompatibility(
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
      capacityOpportunityCount: 0,
      preconditionCount: 1,
      evaluableCount: 0,
      dataLimitationCount: 0,
      unavailableCount: 1,
      coverageRate: "0",
      status: "NO_EVALUABLE_BUY_CAPACITY_OUTCOMES",
    });
  });

  it("deduplicates identical PRE Risk evidence by executionKey", () => {
    const allowed = opportunity("duplicate", {
      preRiskSizingEvidence: preRiskDecision(
        "duplicate",
        "ALLOW",
        100n,
        100n,
        "ALLOW",
      ),
    });

    expect(
      calculateBuyCapacityCompatibility(
        bucket,
        [allowed, { ...allowed }],
        context,
      ),
    ).toMatchObject({
      capacityOpportunityCount: 1,
      fullSizeCount: 1,
      requestedQuoteRawTotal: 100n,
      preconditionCount: 1,
      evaluableCount: 1,
    });
  });

  it("fails closed on conflicting PRE Risk evidence for one executionKey", () => {
    const allowed = opportunity("conflict", {
      preRiskSizingEvidence: preRiskDecision(
        "conflict",
        "ALLOW",
        100n,
        100n,
        "ALLOW",
      ),
    });
    const resized = opportunity("conflict", {
      preRiskSizingEvidence: preRiskDecision(
        "conflict",
        "RESIZE",
        100n,
        30n,
        "SINGLE_TRADE_LIMIT",
      ),
    });

    expect(() =>
      calculateBuyCapacityCompatibility(bucket, [allowed, resized], context),
    ).toThrowError("CONFLICTING_BUY_CAPACITY_OPPORTUNITY_EVIDENCE");
  });

  it("fails closed when approved quote exceeds requested quote", () => {
    expect(() =>
      calculateBuyCapacityCompatibility(
        bucket,
        [
          opportunity("over-approved", {
            preRiskSizingEvidence: preRiskDecision(
              "over-approved",
              "ALLOW",
              100n,
              101n,
              "ALLOW",
            ),
          }),
        ],
        context,
      ),
    ).toThrowError("CONFLICTING_BUY_CAPACITY_OPPORTUNITY_EVIDENCE");
  });

  it.each([0n, -1n])(
    "fails closed for non-positive requestedQuoteRaw %s",
    (requestedQuoteRaw) => {
      expect(() =>
        calculateBuyCapacityCompatibility(
          bucket,
          [
            opportunity(`invalid-${requestedQuoteRaw}`, {
              preRiskSizingEvidence: preRiskDecision(
                `invalid-${requestedQuoteRaw}`,
                "ALLOW",
                requestedQuoteRaw,
                requestedQuoteRaw,
                "ALLOW",
              ),
            }),
          ],
          context,
        ),
      ).toThrowError("CONFLICTING_BUY_CAPACITY_OPPORTUNITY_EVIDENCE");
    },
  );

  it.each([0n, 100n, 101n])(
    "fails closed for invalid RESIZE approvedQuoteRaw %s",
    (approvedQuoteRaw) => {
      expect(() =>
        calculateBuyCapacityCompatibility(
          bucket,
          [
            opportunity(`invalid-resize-${approvedQuoteRaw}`, {
              preRiskSizingEvidence: preRiskDecision(
                `invalid-resize-${approvedQuoteRaw}`,
                "RESIZE",
                100n,
                approvedQuoteRaw,
                "SINGLE_TRADE_LIMIT",
              ),
            }),
          ],
          context,
        ),
      ).toThrowError("CONFLICTING_BUY_CAPACITY_OPPORTUNITY_EVIDENCE");
    },
  );

  it.each([
    [
      "follower",
      { followerWallet: "follower-b" },
      "CROSS_FOLLOWER_COPYABILITY_BUCKET",
    ],
    ["leader", { leaderWallet: "leader-b" }, "CROSS_LEADER_COPYABILITY_BUCKET"],
    ["quote", { quoteMint: "SOL_NATIVE" }, "CROSS_QUOTE_COPYABILITY_BUCKET"],
  ] as const)(
    "fails closed on a cross-%s BUY opportunity",
    (_dimension, overrides, expectedError) => {
      expect(() =>
        calculateBuyCapacityCompatibility(
          bucket,
          [opportunity("cross-bucket", overrides)],
          context,
        ),
      ).toThrowError(expectedError);
    },
  );

  it("is deterministic across input order", () => {
    const evidence = [
      opportunity("allow", {
        preRiskSizingEvidence: preRiskDecision(
          "allow",
          "ALLOW",
          100n,
          100n,
          "ALLOW",
        ),
      }),
      opportunity("resize", {
        preRiskSizingEvidence: preRiskDecision(
          "resize",
          "RESIZE",
          100n,
          30n,
          "SINGLE_TRADE_LIMIT",
        ),
      }),
      opportunity("reject", {
        preRiskSizingEvidence: preRiskDecision(
          "reject",
          "REJECT",
          100n,
          0n,
          "TOKEN_COST_EXPOSURE_LIMIT",
        ),
      }),
      opportunity("data", {
        failureClassification: classification({
          classificationStatus: "CLASSIFIED",
          primaryCategory: "DATA_LIMITATION",
          stage: "OBSERVATION_CLASSIFICATION",
          reasonCode: "PARSER_FAILURE",
        }),
      }),
    ];

    expect(
      calculateBuyCapacityCompatibility(
        bucket,
        [...evidence].reverse(),
        context,
      ),
    ).toEqual(calculateBuyCapacityCompatibility(bucket, evidence, context));
  });

  it("preserves bigint totals beyond Number.MAX_SAFE_INTEGER", () => {
    const beyondSafeInteger = 9_007_199_254_740_992n;
    expect(
      calculateBuyCapacityCompatibility(
        bucket,
        [
          opportunity("big-allow", {
            preRiskSizingEvidence: preRiskDecision(
              "big-allow",
              "ALLOW",
              beyondSafeInteger,
              beyondSafeInteger,
              "ALLOW",
            ),
          }),
          opportunity("big-resize", {
            preRiskSizingEvidence: preRiskDecision(
              "big-resize",
              "RESIZE",
              beyondSafeInteger,
              beyondSafeInteger / 2n,
              "PORTFOLIO_COST_EXPOSURE_LIMIT",
            ),
          }),
        ],
        context,
      ),
    ).toMatchObject({
      requestedQuoteRawTotal: 18_014_398_509_481_984n,
      approvedQuoteRawTotal: 13_510_798_882_111_488n,
      fullSizeCompatibilityRate: "0.5",
      amountCompatibilityRate: "0.75",
    });
  });

  it("uses deterministic 18-digit truncation for non-divisible amount ratios", () => {
    expect(
      calculateBuyCapacityCompatibility(
        bucket,
        [
          opportunity("one-third", {
            preRiskSizingEvidence: preRiskDecision(
              "one-third",
              "RESIZE",
              3n,
              1n,
              "SINGLE_TRADE_LIMIT",
            ),
          }),
        ],
        context,
      ),
    ).toMatchObject({
      fullSizeCompatibilityRate: "0",
      amountCompatibilityRate: "0.333333333333333333",
    });
  });
});
