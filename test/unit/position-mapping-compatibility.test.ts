import { describe, expect, it } from "vitest";
import type { FailureClassification } from "../../src/strategy-evaluation/failure-taxonomy.js";
import {
  calculatePositionMappingCompatibility,
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
  copyabilityDefinitionVersion: "COPYABILITY_POSITION_MAPPING_V1",
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
    side: "SELL",
    failureClassification,
    ...overrides,
  };
}

describe("calculatePositionMappingCompatibility", () => {
  it("counts only structured SELL mapping outcomes and isolates blocked evidence", () => {
    const result = calculatePositionMappingCompatibility(
      bucket,
      [
        opportunity("sell-a", classification()),
        opportunity(
          "sell-b",
          classification({
            classificationStatus: "CLASSIFIED",
            primaryCategory: "COPYABILITY_FAILURE",
            stage: "COPY_DECISION",
            reasonCode: "NO_MAPPED_POSITION",
          }),
        ),
        opportunity(
          "sell-c",
          classification({
            classificationStatus: "CLASSIFIED",
            primaryCategory: "COPYABILITY_FAILURE",
            stage: "COPY_DECISION",
            reasonCode: "INSUFFICIENT_MAPPED_POSITION",
          }),
        ),
        opportunity(
          "sell-d",
          classification({
            classificationStatus: "CLASSIFIED",
            primaryCategory: "COPYABILITY_FAILURE",
            stage: "COPY_DECISION",
            reasonCode: "SIZE_ROUNDED_TO_ZERO",
          }),
        ),
        opportunity(
          "sell-e",
          classification({
            classificationStatus: "CLASSIFIED",
            primaryCategory: "DATA_LIMITATION",
            stage: "COPY_DECISION",
            reasonCode: "LEGACY_POSITION_COST_BASIS_UNAVAILABLE",
          }),
        ),
        opportunity(
          "sell-f",
          classification({
            classificationStatus: "UNAVAILABLE",
            primaryCategory: null,
            stage: null,
            reasonCode: "CONFLICTING_EVIDENCE",
          }),
        ),
      ],
      context,
    );

    expect(result).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
      mappingOpportunityCount: 4,
      mappedOpportunityCount: 2,
      mappingFailureCount: 2,
      mappingCompatibilityRate: "0.5",
      preconditionCount: 6,
      evaluableCount: 4,
      dataLimitationCount: 1,
      unavailableCount: 1,
      coverageRate: "0.666666666666666666",
      status: "AVAILABLE",
      definitionVersion: "COPYABILITY_POSITION_MAPPING_V1",
    });
  });

  it("returns an explicit no-opportunity result for empty evidence", () => {
    expect(calculatePositionMappingCompatibility(bucket, [], context)).toEqual({
      followerWallet: "follower-a",
      leaderWallet: "leader-a",
      quoteMint: "USDC",
      mappingOpportunityCount: 0,
      mappedOpportunityCount: 0,
      mappingFailureCount: 0,
      mappingCompatibilityRate: null,
      preconditionCount: 0,
      evaluableCount: 0,
      dataLimitationCount: 0,
      unavailableCount: 0,
      coverageRate: null,
      status: "NO_SELL_OPPORTUNITIES",
      definitionVersion: "COPYABILITY_POSITION_MAPPING_V1",
    });
  });

  it("reports blocked SELL evidence without creating a mapping denominator", () => {
    expect(
      calculatePositionMappingCompatibility(
        bucket,
        [
          opportunity(
            "data-limited",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "DATA_LIMITATION",
              stage: "COPY_DECISION",
              reasonCode: "LEGACY_POSITION_COST_BASIS_UNAVAILABLE",
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
    ).toMatchObject({
      mappingOpportunityCount: 0,
      mappedOpportunityCount: 0,
      mappingFailureCount: 0,
      mappingCompatibilityRate: null,
      preconditionCount: 2,
      evaluableCount: 0,
      dataLimitationCount: 1,
      unavailableCount: 1,
      coverageRate: "0",
      status: "NO_EVALUABLE_MAPPING_OUTCOMES",
    });
  });

  it("reports full compatibility when every evaluable SELL is mapped", () => {
    expect(
      calculatePositionMappingCompatibility(
        bucket,
        [
          opportunity("mapped-a", classification()),
          opportunity("mapped-b", classification()),
        ],
        context,
      ),
    ).toMatchObject({
      mappingOpportunityCount: 2,
      mappedOpportunityCount: 2,
      mappingFailureCount: 0,
      mappingCompatibilityRate: "1",
      coverageRate: "1",
      status: "AVAILABLE",
    });
  });

  it("reports zero compatibility when no evaluable SELL is mapped", () => {
    expect(
      calculatePositionMappingCompatibility(
        bucket,
        [
          opportunity(
            "unmapped",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "COPYABILITY_FAILURE",
              stage: "COPY_DECISION",
              reasonCode: "NO_MAPPED_POSITION",
            }),
          ),
          opportunity(
            "insufficient",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "COPYABILITY_FAILURE",
              stage: "COPY_DECISION",
              reasonCode: "INSUFFICIENT_MAPPED_POSITION",
            }),
          ),
        ],
        context,
      ),
    ).toMatchObject({
      mappingOpportunityCount: 2,
      mappedOpportunityCount: 0,
      mappingFailureCount: 2,
      mappingCompatibilityRate: "0",
      coverageRate: "1",
    });
  });

  it("ignores BUY opportunities", () => {
    expect(
      calculatePositionMappingCompatibility(
        bucket,
        [opportunity("buy", classification(), { side: "BUY" })],
        context,
      ),
    ).toMatchObject({
      mappingOpportunityCount: 0,
      preconditionCount: 0,
      mappingCompatibilityRate: null,
      coverageRate: null,
      status: "NO_SELL_OPPORTUNITIES",
    });
  });

  it("treats SIZE_ROUNDED_TO_ZERO as proof that mapping passed", () => {
    expect(
      calculatePositionMappingCompatibility(
        bucket,
        [
          opportunity(
            "rounded",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "COPYABILITY_FAILURE",
              stage: "COPY_DECISION",
              reasonCode: "SIZE_ROUNDED_TO_ZERO",
            }),
          ),
        ],
        context,
      ),
    ).toMatchObject({
      mappingOpportunityCount: 1,
      mappedOpportunityCount: 1,
      mappingFailureCount: 0,
      mappingCompatibilityRate: "1",
    });
  });

  it("treats a downstream Data Limitation as proof that mapping passed", () => {
    expect(
      calculatePositionMappingCompatibility(
        bucket,
        [
          opportunity(
            "post-data-limitation",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "DATA_LIMITATION",
              stage: "POST_QUOTE_RISK",
              reasonCode: "PRICE_IMPACT_UNAVAILABLE",
            }),
          ),
        ],
        context,
      ),
    ).toMatchObject({
      mappingOpportunityCount: 1,
      mappedOpportunityCount: 1,
      mappingFailureCount: 0,
      mappingCompatibilityRate: "1",
      preconditionCount: 1,
      evaluableCount: 1,
      dataLimitationCount: 0,
      unavailableCount: 0,
      coverageRate: "1",
      status: "AVAILABLE",
    });
  });

  it.each(["NO_MAPPED_POSITION", "INSUFFICIENT_MAPPED_POSITION"])(
    "treats %s as a mapping failure",
    (reasonCode) => {
      expect(
        calculatePositionMappingCompatibility(
          bucket,
          [
            opportunity(
              reasonCode,
              classification({
                classificationStatus: "CLASSIFIED",
                primaryCategory: "COPYABILITY_FAILURE",
                stage: "COPY_DECISION",
                reasonCode,
              }),
            ),
          ],
          context,
        ),
      ).toMatchObject({
        mappingOpportunityCount: 1,
        mappedOpportunityCount: 0,
        mappingFailureCount: 1,
        mappingCompatibilityRate: "0",
      });
    },
  );

  it("deduplicates identical evidence by executionKey", () => {
    const mapped = opportunity("duplicate", classification());

    expect(
      calculatePositionMappingCompatibility(
        bucket,
        [mapped, { ...mapped }],
        context,
      ),
    ).toMatchObject({
      mappingOpportunityCount: 1,
      mappedOpportunityCount: 1,
      preconditionCount: 1,
      evaluableCount: 1,
    });
  });

  it("fails closed on conflicting evidence for one executionKey", () => {
    const mapped = opportunity("conflict", classification());
    const unmapped = opportunity(
      "conflict",
      classification({
        classificationStatus: "CLASSIFIED",
        primaryCategory: "COPYABILITY_FAILURE",
        stage: "COPY_DECISION",
        reasonCode: "NO_MAPPED_POSITION",
      }),
    );

    expect(() =>
      calculatePositionMappingCompatibility(
        bucket,
        [mapped, unmapped],
        context,
      ),
    ).toThrowError("CONFLICTING_POSITION_MAPPING_OPPORTUNITY_EVIDENCE");
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
    "fails closed on a cross-%s SELL opportunity",
    (_dimension, overrides, expectedError) => {
      expect(() =>
        calculatePositionMappingCompatibility(
          bucket,
          [opportunity("cross-bucket", classification(), overrides)],
          context,
        ),
      ).toThrowError(expectedError);
    },
  );

  it("treats an unknown copy-decision reason as unavailable coverage", () => {
    expect(
      calculatePositionMappingCompatibility(
        bucket,
        [
          opportunity(
            "unknown-reason",
            classification({
              classificationStatus: "CLASSIFIED",
              primaryCategory: "COPYABILITY_FAILURE",
              stage: "COPY_DECISION",
              reasonCode: "UNKNOWN_MAPPING_REASON",
            }),
          ),
        ],
        context,
      ),
    ).toMatchObject({
      mappingOpportunityCount: 0,
      mappedOpportunityCount: 0,
      mappingFailureCount: 0,
      preconditionCount: 1,
      evaluableCount: 0,
      dataLimitationCount: 0,
      unavailableCount: 1,
      coverageRate: "0",
      status: "NO_EVALUABLE_MAPPING_OUTCOMES",
    });
  });

  it("is deterministic across input order", () => {
    const evidence = [
      opportunity("mapped", classification()),
      opportunity(
        "unmapped",
        classification({
          classificationStatus: "CLASSIFIED",
          primaryCategory: "COPYABILITY_FAILURE",
          stage: "COPY_DECISION",
          reasonCode: "NO_MAPPED_POSITION",
        }),
      ),
      opportunity(
        "data-limited",
        classification({
          classificationStatus: "CLASSIFIED",
          primaryCategory: "DATA_LIMITATION",
          stage: "COPY_DECISION",
          reasonCode: "LEGACY_POSITION_COST_BASIS_UNAVAILABLE",
        }),
      ),
    ];

    expect(
      calculatePositionMappingCompatibility(
        bucket,
        [...evidence].reverse(),
        context,
      ),
    ).toEqual(calculatePositionMappingCompatibility(bucket, evidence, context));
  });
});
