import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_SHA256,
  APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_VERSION,
  evaluateFollowerStrategyVerdict,
  type FollowerStrategyVerdictEvidence,
  verifyFollowerStrategyVerdictPolicy,
} from "../../src/strategy-evaluation/follower-strategy-verdict.js";

const POLICY_JSON = readFileSync(
  resolve("config/research/follower-strategy-verdict-policy-v1.json"),
  "utf8",
);

function eligibleEvidence(
  completedCycleCount = 30,
): FollowerStrategyVerdictEvidence {
  return {
    artifactIntegrity: "VALID",
    provenanceConsistency: "CONSISTENT",
    requiredEvidenceCompleteness: "COMPLETE",
    requiredBlockingUnavailableEvidence: [],
    definitionVersions: {
      report: "DETERMINISTIC_EVIDENCE_REPORT_V1",
      historicalEvaluation: "HISTORICAL_EVALUATION_V3",
      followerLifecycle: "FOLLOWER_ROUND_TRIPS_V2",
      strategyMetrics: "STRATEGY_METRICS_V1",
      costCompleteness: "COST_COMPLETENESS_V1",
      cohortCompatibility: "LEADER_COHORT_COMPATIBILITY_V1",
      reliability: "LEADER_RELIABILITY_DIAGNOSTICS_V2",
      temporalCoverage: "LEADER_TEMPORAL_COVERAGE_V1",
      temporalPerformance: "LEADER_TEMPORAL_PERFORMANCE_V1",
      failureTaxonomy: "OPPORTUNITY_FAILURE_V1",
      fillPolicy: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
      accountingPolicy: "WEIGHTED_AVERAGE_V1",
      followerOpportunityCopyability: "COPYABILITY_V1",
    },
    mode: "PAPER",
    metricSemantics: "PAPER_EXPECTANCY",
    historicalAvailability: "AVAILABLE",
    sample: {
      fullyContainedCount: completedCycleCount,
      includedLifecycleCount: completedCycleCount,
      leftCensoredCount: 0,
      rightCensoredCount: 0,
      preWindowOpenCount: 0,
      sourceUnavailableCount: 0,
    },
    cohort: { status: "COMPATIBLE", reasonCode: null },
    cost: {
      status: "COST_COMPLETE",
      evaluatedLifecycleCount: completedCycleCount,
      completeLifecycleCount: completedCycleCount,
      incompleteLifecycleCount: 0,
      monotonicMissingCostProofs: [],
    },
    executionDenominators: "CONSISTENT",
    failureTaxonomy: {
      status: "CONSISTENT",
      dataLimitationCount: 0,
      unavailableCount: 0,
      endToEndDataLimitationCount: 0,
      endToEndUnavailableCount: 0,
    },
    reliabilityBindings: "CONSISTENT",
    metrics: {
      expectancy: {
        status: "AVAILABLE",
        value: "1",
        unit: "QUOTE_RAW_PER_COMPLETED_CYCLE",
        sampleCount: completedCycleCount,
      },
      profitFactor: {
        status: "NO_LOSSES",
        value: null,
        unit: "RATIO",
        sampleCount: completedCycleCount,
        grossProfitRaw: completedCycleCount.toString(),
        grossLossRaw: "0",
      },
      winRate: {
        status: "AVAILABLE",
        value: "1",
        unit: "RATIO",
        sampleCount: completedCycleCount,
        wins: completedCycleCount,
        losses: 0,
        breakevens: 0,
      },
      realizedPnlDrawdown: {
        status: "AVAILABLE",
        value: "0",
        unit: "RAW_QUOTE",
        sampleCount: completedCycleCount,
      },
    },
    nonBlockingLimitations: [
      "LEADER_ECONOMIC_EVIDENCE_UNAVAILABLE",
      "STATISTICAL_RELIABILITY_NOT_ESTABLISHED",
    ],
  };
}

function negativeEvidence(): FollowerStrategyVerdictEvidence {
  const evidence = eligibleEvidence();
  return {
    ...evidence,
    metrics: {
      expectancy: { ...evidence.metrics.expectancy, value: "-1" },
      profitFactor: {
        ...evidence.metrics.profitFactor,
        status: "AVAILABLE",
        value: "0",
        grossProfitRaw: "0",
        grossLossRaw: "30",
      },
      winRate: {
        ...evidence.metrics.winRate,
        value: "0",
        wins: 0,
        losses: 30,
      },
      realizedPnlDrawdown: {
        ...evidence.metrics.realizedPnlDrawdown,
        value: "30",
      },
    },
  };
}

function zeroEvidence(): FollowerStrategyVerdictEvidence {
  const evidence = eligibleEvidence();
  return {
    ...evidence,
    metrics: {
      expectancy: { ...evidence.metrics.expectancy, value: "0" },
      profitFactor: {
        ...evidence.metrics.profitFactor,
        status: "NO_REALIZED_RESULT",
        value: null,
        grossProfitRaw: "0",
        grossLossRaw: "0",
      },
      winRate: {
        ...evidence.metrics.winRate,
        value: "0",
        wins: 0,
        losses: 0,
        breakevens: 30,
      },
      realizedPnlDrawdown: {
        ...evidence.metrics.realizedPnlDrawdown,
        value: "0",
      },
    },
  };
}

describe("verifyFollowerStrategyVerdictPolicy", () => {
  it("reproduces the approved SHA-256 from the raw canonical file bytes", () => {
    expect(
      `sha256:${createHash("sha256").update(POLICY_JSON).digest("hex")}`,
    ).toBe(
      "sha256:ad40550c95655c73939ee6496ea4221b2345500f813aaf72b2624d78dbda3805",
    );
  });

  it("accepts only the frozen canonical policy identity", () => {
    expect(verifyFollowerStrategyVerdictPolicy(POLICY_JSON)).toMatchObject({
      policyVersion: APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_VERSION,
      policySha256: APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_SHA256,
      minimumFullyContainedCompletedCycles: 30,
    });
  });

  it("fails closed when canonical policy bytes do not match approval", () => {
    expect(() =>
      verifyFollowerStrategyVerdictPolicy(POLICY_JSON.replace("30", "31")),
    ).toThrowError("POLICY_IDENTITY_MISMATCH");
  });
});

describe("evaluateFollowerStrategyVerdict", () => {
  it("returns insufficient evidence below 30 completed cycles", () => {
    expect(
      evaluateFollowerStrategyVerdict(eligibleEvidence(29), POLICY_JSON),
    ).toMatchObject({
      status: "AVAILABLE",
      value: "INSUFFICIENT_EVIDENCE",
      reasonCode: "VERDICT_SAMPLE_BELOW_MINIMUM",
      policyVersion: APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_VERSION,
      policySha256: APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_SHA256,
    });
  });

  it("issues a positive candidate only after every hard gate passes", () => {
    expect(
      evaluateFollowerStrategyVerdict(eligibleEvidence(), POLICY_JSON),
    ).toEqual({
      status: "AVAILABLE",
      value: "POSITIVE_CANDIDATE",
      reasonCode: "FOLLOWER_PAPER_EXPECTANCY_POSITIVE_CANDIDATE",
      limitations: [
        "LEADER_ECONOMIC_EVIDENCE_UNAVAILABLE",
        "STATISTICAL_RELIABILITY_NOT_ESTABLISHED",
      ],
      policyVersion: APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_VERSION,
      policySha256: APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_SHA256,
    });
  });

  it("issues negative expectancy when every hard gate passes", () => {
    expect(
      evaluateFollowerStrategyVerdict(negativeEvidence(), POLICY_JSON),
    ).toMatchObject({
      status: "AVAILABLE",
      value: "NEGATIVE_EXPECTANCY",
      reasonCode: "FOLLOWER_PAPER_EXPECTANCY_NEGATIVE",
    });
  });

  it("treats exact zero expectancy as insufficient without an epsilon", () => {
    expect(
      evaluateFollowerStrategyVerdict(zeroEvidence(), POLICY_JSON),
    ).toMatchObject({
      value: "INSUFFICIENT_EVIDENCE",
      reasonCode: "FOLLOWER_PAPER_EXPECTANCY_ZERO",
    });
  });

  it("rejects non-canonical negative zero instead of treating it as negative", () => {
    const evidence = zeroEvidence();
    expect(
      evaluateFollowerStrategyVerdict(
        {
          ...evidence,
          metrics: {
            ...evidence.metrics,
            expectancy: { ...evidence.metrics.expectancy, value: "-0" },
          },
        },
        POLICY_JSON,
      ),
    ).toMatchObject({
      value: "INSUFFICIENT_EVIDENCE",
      reasonCode: "METRIC_CONSISTENCY_CONFLICT",
    });
  });

  it("blocks positive expectancy when required follower costs are incomplete", () => {
    const evidence = eligibleEvidence();
    expect(
      evaluateFollowerStrategyVerdict(
        {
          ...evidence,
          cost: {
            ...evidence.cost,
            status: "COST_INCOMPLETE",
            completeLifecycleCount: 29,
            incompleteLifecycleCount: 1,
          },
        },
        POLICY_JSON,
      ),
    ).toMatchObject({
      value: "INSUFFICIENT_EVIDENCE",
      reasonCode: "COST_EVIDENCE_BLOCKING",
    });
  });

  it("allows a conservative negative only when every monotonic cost predicate is proven", () => {
    const evidence = negativeEvidence();
    const result = evaluateFollowerStrategyVerdict(
      {
        ...evidence,
        cost: {
          ...evidence.cost,
          status: "COST_INCOMPLETE",
          completeLifecycleCount: 29,
          incompleteLifecycleCount: 1,
          monotonicMissingCostProofs: [
            {
              evidenceId: "immutable-cost-evidence-1",
              nonNegativeCost: true,
              cannotIncreaseReturn: true,
              cannotAlterQuantity: true,
              cannotAlterLifecycleIdentity: true,
              cannotAlterDenominator: true,
              cannotAlterFillPriceOrDirection: true,
              noPossibleMissingRevenueOrRebate: true,
            },
          ],
        },
      },
      POLICY_JSON,
    );

    expect(result).toMatchObject({
      value: "NEGATIVE_EXPECTANCY",
      reasonCode:
        "FOLLOWER_PAPER_EXPECTANCY_NEGATIVE_COSTS_INCOMPLETE_MONOTONE",
    });
    expect(result.limitations).toContain(
      "NEGATIVE_EXPECTANCY_MONOTONIC_MISSING_COSTS",
    );
  });

  it("fails closed when the monotonic missing-cost exception is unproven", () => {
    const evidence = negativeEvidence();
    expect(
      evaluateFollowerStrategyVerdict(
        {
          ...evidence,
          cost: {
            ...evidence.cost,
            status: "COST_INCOMPLETE",
            completeLifecycleCount: 29,
            incompleteLifecycleCount: 1,
          },
        },
        POLICY_JSON,
      ),
    ).toMatchObject({
      value: "INSUFFICIENT_EVIDENCE",
      reasonCode: "COST_EVIDENCE_BLOCKING",
    });
  });

  it("fails closed when fixed required evidence is unavailable", () => {
    expect(
      evaluateFollowerStrategyVerdict(
        {
          ...eligibleEvidence(),
          requiredBlockingUnavailableEvidence: ["FOLLOWER_EXPECTANCY"],
        },
        POLICY_JSON,
      ),
    ).toMatchObject({
      value: "INSUFFICIENT_EVIDENCE",
      reasonCode: "REQUIRED_BLOCKING_EVIDENCE_UNAVAILABLE",
    });
  });

  it("fails closed on an unknown required definition version", () => {
    const evidence = eligibleEvidence();
    expect(
      evaluateFollowerStrategyVerdict(
        {
          ...evidence,
          definitionVersions: {
            ...evidence.definitionVersions,
            strategyMetrics: "STRATEGY_METRICS_V2",
          },
        },
        POLICY_JSON,
      ),
    ).toMatchObject({
      value: "INSUFFICIENT_EVIDENCE",
      reasonCode: "DEFINITION_VERSION_MISMATCH",
    });
  });

  it.each([
    {
      name: "censoring",
      evidence: {
        ...eligibleEvidence(),
        sample: {
          ...eligibleEvidence().sample,
          rightCensoredCount: 1,
        },
      },
      reasonCode: "CENSORED_LIFECYCLE_EVIDENCE",
    },
    {
      name: "cohort incompatibility",
      evidence: {
        ...eligibleEvidence(),
        cohort: {
          status: "INCOMPATIBLE" as const,
          reasonCode: "COHORT_DEFINITION_MISMATCH" as const,
        },
      },
      reasonCode: "COHORT_DEFINITION_MISMATCH",
    },
    {
      name: "cohort provenance mismatch",
      evidence: {
        ...eligibleEvidence(),
        cohort: {
          status: "INCOMPATIBLE" as const,
          reasonCode: "COHORT_PROVENANCE_MISMATCH" as const,
        },
      },
      reasonCode: "COHORT_PROVENANCE_MISMATCH",
    },
  ])("fails closed on $name", ({ evidence, reasonCode }) => {
    expect(
      evaluateFollowerStrategyVerdict(evidence, POLICY_JSON),
    ).toMatchObject({
      value: "INSUFFICIENT_EVIDENCE",
      reasonCode,
    });
  });

  it("fails closed when economics metrics conflict directionally", () => {
    const evidence = eligibleEvidence();
    expect(
      evaluateFollowerStrategyVerdict(
        {
          ...evidence,
          metrics: {
            ...evidence.metrics,
            profitFactor: {
              ...evidence.metrics.profitFactor,
              status: "AVAILABLE",
              value: "0.5",
              grossLossRaw: "60",
            },
          },
        },
        POLICY_JSON,
      ),
    ).toMatchObject({
      value: "INSUFFICIENT_EVIDENCE",
      reasonCode: "METRIC_CONSISTENCY_CONFLICT",
    });
  });

  it("keeps optional diagnostic unavailability visible without blocking", () => {
    const evidence = eligibleEvidence();
    const result = evaluateFollowerStrategyVerdict(
      {
        ...evidence,
        nonBlockingLimitations: [
          ...evidence.nonBlockingLimitations,
          "OPTIONAL_DIAGNOSTIC_UNAVAILABLE",
        ],
      },
      POLICY_JSON,
    );

    expect(result).toMatchObject({
      value: "POSITIVE_CANDIDATE",
      reasonCode: "FOLLOWER_PAPER_EXPECTANCY_POSITIVE_CANDIDATE",
    });
    expect(result.limitations).toContain("OPTIONAL_DIAGNOSTIC_UNAVAILABLE");
  });

  it.each([
    {
      name: "artifact integrity",
      evidence: {
        ...eligibleEvidence(),
        artifactIntegrity: "INVALID" as const,
      },
      reasonCode: "ARTIFACT_INTEGRITY_FAILURE",
    },
    {
      name: "provenance",
      evidence: {
        ...eligibleEvidence(),
        provenanceConsistency: "MISMATCH" as const,
      },
      reasonCode: "PROVENANCE_MISMATCH",
    },
    {
      name: "Paper context",
      evidence: { ...eligibleEvidence(), mode: "SHADOW" },
      reasonCode: "CONTEXT_MISMATCH",
    },
    {
      name: "cohort window",
      evidence: {
        ...eligibleEvidence(),
        cohort: {
          status: "INCOMPATIBLE" as const,
          reasonCode: "WINDOW_MISMATCH" as const,
        },
      },
      reasonCode: "WINDOW_MISMATCH",
    },
    {
      name: "conflicting candidate",
      evidence: {
        ...eligibleEvidence(),
        cohort: {
          status: "INCOMPATIBLE" as const,
          reasonCode: "CONFLICTING_CANDIDATE" as const,
        },
      },
      reasonCode: "CONFLICTING_CANDIDATE",
    },
    {
      name: "limited Historical evidence",
      evidence: {
        ...eligibleEvidence(),
        historicalAvailability: "LIMITED" as const,
      },
      reasonCode: "LIMITED_EVIDENCE",
    },
    {
      name: "partial required evidence",
      evidence: {
        ...eligibleEvidence(),
        requiredEvidenceCompleteness: "PARTIAL" as const,
      },
      reasonCode: "PARTIAL_REQUIRED_EVIDENCE",
    },
    {
      name: "execution denominators",
      evidence: {
        ...eligibleEvidence(),
        executionDenominators: "INCONSISTENT" as const,
      },
      reasonCode: "EXECUTION_DENOMINATOR_INCONSISTENT",
    },
    {
      name: "failure taxonomy",
      evidence: {
        ...eligibleEvidence(),
        failureTaxonomy: {
          ...eligibleEvidence().failureTaxonomy,
          status: "INCONSISTENT" as const,
        },
      },
      reasonCode: "FAILURE_TAXONOMY_INCONSISTENT",
    },
    {
      name: "required Reliability bindings",
      evidence: {
        ...eligibleEvidence(),
        reliabilityBindings: "INCONSISTENT" as const,
      },
      reasonCode: "RELIABILITY_EVIDENCE_INSUFFICIENT",
    },
  ])(
    "applies first-match insufficiency for $name",
    ({ evidence, reasonCode }) => {
      expect(
        evaluateFollowerStrategyVerdict(evidence, POLICY_JSON),
      ).toMatchObject({
        value: "INSUFFICIENT_EVIDENCE",
        reasonCode,
      });
    },
  );

  it("uses the approved reason precedence when failures conflict", () => {
    expect(
      evaluateFollowerStrategyVerdict(
        {
          ...eligibleEvidence(1),
          historicalAvailability: "LIMITED",
          requiredEvidenceCompleteness: "PARTIAL",
          requiredBlockingUnavailableEvidence: ["FOLLOWER_EXPECTANCY"],
          cohort: {
            status: "INCOMPATIBLE",
            reasonCode: "WINDOW_MISMATCH",
          },
        },
        POLICY_JSON,
      ),
    ).toMatchObject({
      value: "INSUFFICIENT_EVIDENCE",
      reasonCode: "WINDOW_MISMATCH",
    });
  });

  it("checks monotonic cost direction before the positive sign branch", () => {
    const evidence = eligibleEvidence();
    expect(
      evaluateFollowerStrategyVerdict(
        {
          ...evidence,
          cost: {
            ...evidence.cost,
            status: "COST_INCOMPLETE",
            completeLifecycleCount: 29,
            incompleteLifecycleCount: 1,
            monotonicMissingCostProofs: [
              {
                evidenceId: "immutable-cost-evidence-1",
                nonNegativeCost: true,
                cannotIncreaseReturn: true,
                cannotAlterQuantity: true,
                cannotAlterLifecycleIdentity: true,
                cannotAlterDenominator: true,
                cannotAlterFillPriceOrDirection: true,
                noPossibleMissingRevenueOrRebate: true,
              },
            ],
          },
        },
        POLICY_JSON,
      ),
    ).toMatchObject({
      value: "INSUFFICIENT_EVIDENCE",
      reasonCode: "COST_INCOMPLETE_DIRECTION_NOT_PRESERVED",
    });
  });
});
