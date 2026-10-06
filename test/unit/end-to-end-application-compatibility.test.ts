import { describe, expect, it } from "vitest";
import type { FailureClassification } from "../../src/strategy-evaluation/failure-taxonomy.js";
import {
  calculateEndToEndApplicationCompatibility,
  type ClassifiedCopyabilityOpportunity,
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
  copyabilityDefinitionVersion: "END_TO_END_APPLICATION_COMPATIBILITY_V1",
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
  failureClassification: FailureClassification,
  overrides: Partial<ClassifiedCopyabilityOpportunity> = {},
): ClassifiedCopyabilityOpportunity {
  return {
    ...bucket,
    executionKey,
    side: "BUY",
    failureClassification,
    ...overrides,
  };
}

describe("calculateEndToEndApplicationCompatibility", () => {
  it("composes canonical application successes and terminal failures", () => {
    expect(
      calculateEndToEndApplicationCompatibility(
        bucket,
        [
          opportunity("success-a", classification()),
          opportunity("success-b", classification()),
          opportunity(
            "execution-failure",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "EXECUTION_FAILURE",
              stage: "JUPITER_ORDER",
              reasonCode: "JUPITER_HTTP_5XX",
            }),
          ),
          opportunity(
            "market-failure",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "MARKET_FAILURE",
              stage: "POST_QUOTE_RISK",
              reasonCode: "PRICE_IMPACT_TOO_HIGH",
            }),
          ),
          opportunity(
            "risk-rejection",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "RISK_REJECTION",
              stage: "PRE_QUOTE_RISK",
              reasonCode: "SINGLE_TRADE_LIMIT",
            }),
          ),
          opportunity(
            "data-limitation",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "DATA_LIMITATION",
              stage: "OBSERVATION_CLASSIFICATION",
              reasonCode: "PARSER_FAILURE",
            }),
          ),
          opportunity(
            "policy-exclusion",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "POLICY_EXCLUSION",
              stage: "OBSERVATION_POLICY",
              reasonCode: "QUOTE_ASSET_NOT_ALLOWED",
            }),
          ),
          opportunity(
            "unavailable",
            classification({
              classificationStatus: "UNAVAILABLE",
              primaryCategory: null,
              stage: null,
              reasonCode: "CONFLICTING_EVIDENCE",
            }),
          ),
        ],
        context,
      ),
    ).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
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
    });
  });

  it("reports full compatibility when every opportunity reached application", () => {
    expect(
      calculateEndToEndApplicationCompatibility(
        bucket,
        [
          opportunity("success-a", classification()),
          opportunity("success-b", classification()),
        ],
        context,
      ),
    ).toMatchObject({
      endToEndOpportunityCount: 2,
      applicationSuccessCount: 2,
      terminalFailureCount: 0,
      endToEndApplicationCompatibilityRate: "1",
      coverageRate: "1",
      status: "AVAILABLE",
    });
  });

  it("reports zero compatibility when every outcome is a terminal failure", () => {
    const categories = [
      "EXECUTION_FAILURE",
      "MARKET_FAILURE",
      "RISK_REJECTION",
      "COPYABILITY_FAILURE",
    ] as const;

    const result = calculateEndToEndApplicationCompatibility(
      bucket,
      categories.map((primaryCategory, index) =>
        opportunity(
          `terminal-${index}`,
          classification({
            classificationStatus: "CLASSIFIED",
            primaryCategory,
            stage: "POST_QUOTE_RISK",
            reasonCode: `TERMINAL_${index}`,
          }),
        ),
      ),
      context,
    );

    expect(result).toMatchObject({
      endToEndOpportunityCount: 4,
      applicationSuccessCount: 0,
      terminalFailureCount: 4,
      endToEndApplicationCompatibilityRate: "0",
      status: "AVAILABLE",
    });
  });

  it("reports no opportunities for an empty analytical sample", () => {
    expect(
      calculateEndToEndApplicationCompatibility(bucket, [], context),
    ).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
      endToEndOpportunityCount: 0,
      applicationSuccessCount: 0,
      terminalFailureCount: 0,
      endToEndApplicationCompatibilityRate: null,
      preconditionCount: 0,
      evaluableCount: 0,
      dataLimitationCount: 0,
      unavailableCount: 0,
      coverageRate: null,
      status: "NO_END_TO_END_OPPORTUNITIES",
      definitionVersion: "END_TO_END_APPLICATION_COMPATIBILITY_V1",
    });
  });

  it("keeps Data Limitation out of value while lowering coverage", () => {
    expect(
      calculateEndToEndApplicationCompatibility(
        bucket,
        [
          opportunity(
            "data-limitation",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "DATA_LIMITATION",
              stage: "OBSERVATION_CLASSIFICATION",
              reasonCode: "PARSER_FAILURE",
            }),
          ),
        ],
        context,
      ),
    ).toMatchObject({
      endToEndOpportunityCount: 0,
      preconditionCount: 1,
      evaluableCount: 0,
      dataLimitationCount: 1,
      unavailableCount: 0,
      coverageRate: "0",
      endToEndApplicationCompatibilityRate: null,
      status: "NO_EVALUABLE_END_TO_END_OUTCOMES",
    });
  });

  it("keeps UNAVAILABLE out of value while lowering coverage", () => {
    expect(
      calculateEndToEndApplicationCompatibility(
        bucket,
        [
          opportunity(
            "unavailable",
            classification({
              classificationStatus: "UNAVAILABLE",
              primaryCategory: null,
              stage: null,
              reasonCode: "CONFLICTING_EVIDENCE",
            }),
          ),
        ],
        context,
      ),
    ).toMatchObject({
      endToEndOpportunityCount: 0,
      preconditionCount: 1,
      evaluableCount: 0,
      dataLimitationCount: 0,
      unavailableCount: 1,
      coverageRate: "0",
      endToEndApplicationCompatibilityRate: null,
      status: "NO_EVALUABLE_END_TO_END_OUTCOMES",
    });
  });

  it("ignores policy exclusions before the copyability precondition", () => {
    expect(
      calculateEndToEndApplicationCompatibility(
        bucket,
        [
          opportunity(
            "policy-exclusion",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "POLICY_EXCLUSION",
              stage: "OBSERVATION_POLICY",
              reasonCode: "QUOTE_ASSET_NOT_ALLOWED",
            }),
          ),
        ],
        context,
      ),
    ).toMatchObject({
      preconditionCount: 0,
      endToEndOpportunityCount: 0,
      coverageRate: null,
      status: "NO_END_TO_END_OPPORTUNITIES",
    });
  });

  it("ignores non-swap NOT_A_FAILURE before the copyability precondition", () => {
    expect(
      calculateEndToEndApplicationCompatibility(
        bucket,
        [
          opportunity(
            "ordinary-transfer",
            classification({
              stage: "OBSERVATION_CLASSIFICATION",
              reasonCode: "ORDINARY_TRANSFER",
            }),
          ),
        ],
        context,
      ),
    ).toMatchObject({
      preconditionCount: 0,
      endToEndOpportunityCount: 0,
      status: "NO_END_TO_END_OPPORTUNITIES",
    });
  });

  it.each([
    ["PRE RESIZE", "PRE_QUOTE_RISK", "SINGLE_TRADE_LIMIT"],
    ["Jupiter success", "JUPITER_ORDER", null],
    ["POST ALLOW", "POST_QUOTE_RISK", null],
  ] as const)(
    "does not count intermediate %s NOT_A_FAILURE as application success",
    (_label, stage, reasonCode) => {
      expect(
        calculateEndToEndApplicationCompatibility(
          bucket,
          [opportunity("intermediate", classification({ stage, reasonCode }))],
          context,
        ),
      ).toMatchObject({
        applicationSuccessCount: 0,
        terminalFailureCount: 0,
        endToEndOpportunityCount: 0,
        preconditionCount: 1,
        unavailableCount: 1,
        status: "NO_EVALUABLE_END_TO_END_OUTCOMES",
      });
    },
  );

  it("deduplicates identical canonical results by executionKey", () => {
    const success = opportunity("success", classification());

    expect(
      calculateEndToEndApplicationCompatibility(
        bucket,
        [success, { ...success }],
        context,
      ),
    ).toMatchObject({
      endToEndOpportunityCount: 1,
      applicationSuccessCount: 1,
      preconditionCount: 1,
    });
  });

  it("fails closed for application success plus terminal failure", () => {
    expect(() =>
      calculateEndToEndApplicationCompatibility(
        bucket,
        [
          opportunity("conflict", classification()),
          opportunity(
            "conflict",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "EXECUTION_FAILURE",
              stage: "JUPITER_ORDER",
              reasonCode: "JUPITER_HTTP_5XX",
            }),
          ),
        ],
        context,
      ),
    ).toThrowError("CONFLICTING_END_TO_END_APPLICATION_ANALYTICAL_RESULTS");
  });

  it("fails closed for mutually exclusive terminal categories", () => {
    expect(() =>
      calculateEndToEndApplicationCompatibility(
        bucket,
        [
          opportunity(
            "conflict",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "EXECUTION_FAILURE",
              stage: "JUPITER_ORDER",
              reasonCode: "JUPITER_HTTP_5XX",
            }),
          ),
          opportunity(
            "conflict",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "MARKET_FAILURE",
              stage: "POST_QUOTE_RISK",
              reasonCode: "PRICE_IMPACT_TOO_HIGH",
            }),
          ),
        ],
        context,
      ),
    ).toThrowError("CONFLICTING_END_TO_END_APPLICATION_ANALYTICAL_RESULTS");
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
    "fails closed for a mismatched %s bucket",
    (_dimension, override, error) => {
      expect(() =>
        calculateEndToEndApplicationCompatibility(
          bucket,
          [opportunity("success", classification(), override)],
          context,
        ),
      ).toThrowError(error);
    },
  );

  it("is deterministic across input order", () => {
    const opportunities = [
      opportunity("success", classification()),
      opportunity(
        "failure",
        classification({
          classificationStatus: "CLASSIFIED",
          primaryCategory: "EXECUTION_FAILURE",
          stage: "JUPITER_ORDER",
          reasonCode: "JUPITER_HTTP_5XX",
        }),
      ),
      opportunity(
        "unavailable",
        classification({
          classificationStatus: "UNAVAILABLE",
          primaryCategory: null,
          stage: null,
          reasonCode: null,
        }),
      ),
    ];

    expect(
      calculateEndToEndApplicationCompatibility(bucket, opportunities, context),
    ).toEqual(
      calculateEndToEndApplicationCompatibility(
        bucket,
        [...opportunities].reverse(),
        context,
      ),
    );
  });

  it("formats a non-divisible compatibility rate deterministically", () => {
    const result = calculateEndToEndApplicationCompatibility(
      bucket,
      [
        opportunity("success-a", classification()),
        opportunity("success-b", classification()),
        opportunity(
          "failure",
          classification({
            classificationStatus: "CLASSIFIED",
            primaryCategory: "EXECUTION_FAILURE",
            stage: "JUPITER_ORDER",
            reasonCode: "JUPITER_HTTP_5XX",
          }),
        ),
      ],
      context,
    );

    expect(result.endToEndApplicationCompatibilityRate).toBe(
      "0.666666666666666666",
    );
  });

  it("never represents empty or zero-numerator results as NaN or Infinity", () => {
    const noOpportunities = calculateEndToEndApplicationCompatibility(
      bucket,
      [],
      context,
    );
    const zeroSuccess = calculateEndToEndApplicationCompatibility(
      bucket,
      [
        opportunity(
          "failure",
          classification({
            classificationStatus: "CLASSIFIED",
            primaryCategory: "EXECUTION_FAILURE",
            stage: "JUPITER_ORDER",
            reasonCode: "JUPITER_HTTP_5XX",
          }),
        ),
      ],
      context,
    );

    expect(noOpportunities.endToEndApplicationCompatibilityRate).toBeNull();
    expect(zeroSuccess.endToEndApplicationCompatibilityRate).toBe("0");
    expect(zeroSuccess.endToEndApplicationCompatibilityRate).not.toBe("NaN");
    expect(zeroSuccess.endToEndApplicationCompatibilityRate).not.toBe(
      "Infinity",
    );
  });
});
