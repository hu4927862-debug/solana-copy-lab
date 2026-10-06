import { describe, expect, expectTypeOf, it } from "vitest";
import {
  evaluateHistoricalEvaluation,
  type HistoricalEvaluationResult,
  type VersionedHistoricalEvaluationResult,
} from "../../src/strategy-evaluation/historical-evaluation.js";
import { evaluateLeaderCohortCompatibility } from "../../src/strategy-evaluation/leader-cohort-compatibility.js";
import {
  evaluateLeaderReliabilityDiagnostics,
  LEADER_RELIABILITY_DEFINITION_VERSION,
  type LeaderReliabilityDiagnosticsResult,
} from "../../src/strategy-evaluation/leader-reliability-diagnostics.js";
import { calculateStrategyMetrics } from "../../src/strategy-evaluation/metrics.js";
import type { StrategyEvaluationEvidenceSnapshot } from "../../src/strategy-evaluation/read-model.js";
import type { CompletedFollowerRoundTrip } from "../../src/strategy-evaluation/round-trips.js";

const BUCKET = {
  followerWallet: "follower-a",
  leaderWallet: "leader-a",
  quoteMint: "SOL_NATIVE",
} as const;
const WINDOW = { windowStartMs: 1_000, windowEndMs: 2_000 } as const;
const STRATEGY_METRICS_POLICY = {
  definitionVersion: "STRATEGY_METRICS_V1",
  minimumCompletedCycles: 20,
} as const;
const FAILURE_TAXONOMY_POLICY = {
  definitionVersion: "OPPORTUNITY_FAILURE_V1",
} as const;

function cycle(index: number): CompletedFollowerRoundTrip {
  return {
    ...BUCKET,
    tokenMint: `TOKEN_${index % 2}`,
    openFillId: `open-${index}`,
    closeFillId: `close-${index}`,
    fillIds: [`open-${index}`, `close-${index}`],
    entryCostQuoteRaw: 100n,
    proceedsQuoteRaw: index === 0 ? 110n : 105n,
    realizedPnlQuoteRaw: index === 0 ? 10n : 5n,
    openedAtMs: 10_000 + index * 100,
    closedAtMs: 10_050 + index * 100,
    holdingTimeMs: 50,
  };
}

function historicalFixture(): HistoricalEvaluationResult {
  const snapshot: StrategyEvaluationEvidenceSnapshot = {
    provenance: {
      resolvedDatabasePath: "/fixture/evidence.sqlite",
      observedSchemaMigrations: [
        { version: "0001_fixture", checksum: "sha256:fixture" },
      ],
      requestedWindow: { ...WINDOW },
      expectedContext: {
        window: { fromMs: WINDOW.windowStartMs, toMs: WINDOW.windowEndMs },
        source: "fixture",
        mode: "PAPER",
        copyRatioBps: 10_000,
        riskPolicyVersion: "RISK_V1",
        fillPolicyVersion: "FILL_V1",
        accountingPolicyVersion: "ACCOUNTING_V1",
        copyabilityDefinitionVersion: "COPYABILITY_V1",
      },
    },
    roundTripApplications: [],
    roundTripApplicationSources: [],
    paperFills: [],
    paperFillApplications: [],
    jupiterAttempts: [],
    riskDecisions: [],
    opportunities: [],
    observationExclusions: [],
    observationLimitations: [],
    contextLimitations: [],
  };
  const baseline = evaluateHistoricalEvaluation(
    snapshot,
    BUCKET,
    STRATEGY_METRICS_POLICY,
    FAILURE_TAXONOMY_POLICY,
  );
  const includedRoundTrips = Array.from({ length: 40 }, (_, index) =>
    cycle(index),
  );

  return {
    ...baseline,
    sample: {
      ...baseline.sample,
      fullyContainedCount: 40,
      sampleStatus: "PROVISIONAL" as const,
    },
    includedRoundTrips,
    strategyMetrics: calculateStrategyMetrics(
      includedRoundTrips,
      STRATEGY_METRICS_POLICY,
    ),
  };
}

describe("evaluateLeaderReliabilityDiagnostics", () => {
  it("projects the frozen Historical sample depth without inferring independence", () => {
    const result = evaluateLeaderReliabilityDiagnostics(historicalFixture());

    expect(result.sampleDepth).toEqual({
      fullyContainedCount: 40,
      sampleStatus: "PROVISIONAL",
      independenceStatus: "NOT_ESTABLISHED",
    });
  });

  it("returns transparent existing evidence and explicit methodology limitations", () => {
    const historical = historicalFixture();
    const result = evaluateLeaderReliabilityDiagnostics(historical);

    expectTypeOf(evaluateLeaderReliabilityDiagnostics)
      .parameter(0)
      .toEqualTypeOf<VersionedHistoricalEvaluationResult>();
    expectTypeOf(
      evaluateLeaderReliabilityDiagnostics,
    ).returns.toEqualTypeOf<LeaderReliabilityDiagnosticsResult>();
    expect(result).toEqual({
      definitionVersion: LEADER_RELIABILITY_DEFINITION_VERSION,
      historicalReference: {
        bucket: BUCKET,
        window: WINDOW,
        historicalEvaluationDefinitionVersion: "HISTORICAL_EVALUATION_V1",
        strategyMetricSemantics: "PAPER_EXPECTANCY",
      },
      sampleDepth: {
        fullyContainedCount: 40,
        sampleStatus: "PROVISIONAL",
        independenceStatus: "NOT_ESTABLISHED",
      },
      censoring: {
        leftCensoredCount: 0,
        rightCensoredCount: 0,
        preWindowOpenCount: 0,
        sourceUnavailableCount: 0,
      },
      conditionalExpectancy: {
        metricSemantics: "PAPER_EXPECTANCY",
        pointEstimate: historical.strategyMetrics.netQuoteExpectancy,
        sampleCondition: "FULLY_CONTAINED_COMPLETED_ROUND_TRIPS_ONLY",
        incompleteLifecycleTreatment:
          "EXCLUDED_FROM_STRATEGY_METRICS_DENOMINATOR",
        canonicalFailedOpportunityTreatment:
          "NOT_IMPUTED_INTO_STRATEGY_METRICS",
      },
      tradeDominance: {
        capability: "PARTIAL",
        bestTradeContribution: historical.strategyMetrics.bestTradeContribution,
        topKTradeDominance: {
          status: "UNAVAILABLE",
          reason: "TOP_K_TRADE_DOMINANCE_NOT_AVAILABLE",
        },
      },
      tokenConcentration: {
        role: "STRATEGY_STRUCTURE_DIAGNOSTIC",
        bestTokenContribution: historical.strategyMetrics.bestTokenContribution,
        tradeLevelDominanceSubstitute: false,
      },
      temporalStability: {
        status: "UNAVAILABLE",
        reason: "AUTHORITATIVE_LIFECYCLE_TIME_NOT_EXPOSED",
        dataCollectionRequired: "NO",
        historicalContract: "PARTIALLY_SUFFICIENT",
      },
      confidenceInterval: {
        status: "UNAVAILABLE",
        reason: "DEPENDENCE_AWARE_INFERENCE_METHOD_NOT_ESTABLISHED",
      },
      methodology: {
        dependenceModelStatus: "NOT_MODELED",
        heavyTailCalibrationStatus: "NOT_CALIBRATED",
        iidBootstrapStatus: "REJECTED_AS_DEFAULT_FOR_EXPECTANCY_CI",
        shrinkageStatus: "NOT_APPLIED",
        estimateDirectionInferenceStatus: "DEFERRED",
        bandThresholdsStatus: "NOT_YET_JUSTIFIED",
        realDataCalibrationStatus: "REQUIRED",
      },
      opportunityRealizationContext: {
        status: "AVAILABLE_SEPARATELY_IN_HISTORICAL_RESULT",
        failureClassificationDefinitionVersion:
          historical.failureClassification.definitionVersion,
        endToEndApplicationDefinitionVersion:
          historical.copyability.endToEndApplication.definitionVersion,
      },
      limitations: [
        "DEPENDENCE_NOT_MODELED",
        "HEAVY_TAIL_BEHAVIOR_NOT_CALIBRATED",
        "IID_CONFIDENCE_INTERVAL_NOT_AVAILABLE",
        "REAL_DATA_CALIBRATION_REQUIRED",
        "TEMPORAL_STABILITY_NOT_AVAILABLE",
        "TOP_K_TRADE_DOMINANCE_NOT_AVAILABLE",
      ],
    });
  });

  it.each([
    [29, "EXPLORATORY"],
    [9, "INSUFFICIENT_SAMPLE"],
  ] as const)(
    "passes through %s completed round trips with Historical status %s",
    (fullyContainedCount, sampleStatus) => {
      const baseline = historicalFixture();
      const historical: HistoricalEvaluationResult = {
        ...baseline,
        sample: { ...baseline.sample, fullyContainedCount, sampleStatus },
      };

      expect(
        evaluateLeaderReliabilityDiagnostics(historical).sampleDepth,
      ).toEqual({
        fullyContainedCount,
        sampleStatus,
        independenceStatus: "NOT_ESTABLISHED",
      });
    },
  );

  it("keeps positive, zero, and negative point estimates reliability-equivalent", () => {
    const baseline = historicalFixture();
    const diagnostics = ["5.125", "0", "-5.125"].map((value) =>
      evaluateLeaderReliabilityDiagnostics({
        ...baseline,
        strategyMetrics: {
          ...baseline.strategyMetrics,
          netQuoteExpectancy: {
            ...baseline.strategyMetrics.netQuoteExpectancy,
            value,
          },
        },
      }),
    );
    const withoutPointEstimateValue = (
      result: LeaderReliabilityDiagnosticsResult,
    ) => ({
      ...result,
      conditionalExpectancy: {
        ...result.conditionalExpectancy,
        pointEstimate: {
          ...result.conditionalExpectancy.pointEstimate,
          value: "POINT_ESTIMATE_VALUE",
        },
      },
    });

    expect(
      diagnostics.map(
        ({ conditionalExpectancy }) =>
          conditionalExpectancy.pointEstimate.value,
      ),
    ).toEqual(["5.125", "0", "-5.125"]);
    expect(diagnostics.map(withoutPointEstimateValue)).toEqual([
      withoutPointEstimateValue(diagnostics[0]!),
      withoutPointEstimateValue(diagnostics[0]!),
      withoutPointEstimateValue(diagnostics[0]!),
    ]);
  });

  it("preserves unavailable best-trade evidence without substituting token concentration", () => {
    const baseline = historicalFixture();
    const historical: HistoricalEvaluationResult = {
      ...baseline,
      strategyMetrics: {
        ...baseline.strategyMetrics,
        bestTradeContribution: {
          ...baseline.strategyMetrics.bestTradeContribution,
          value: null,
          status: "NON_POSITIVE_TOTAL_PNL",
          totalRealizedPnlRaw: "0",
        },
      },
    };
    const result = evaluateLeaderReliabilityDiagnostics(historical);

    expect(result.tradeDominance).toEqual({
      capability: "PARTIAL",
      bestTradeContribution: historical.strategyMetrics.bestTradeContribution,
      topKTradeDominance: {
        status: "UNAVAILABLE",
        reason: "TOP_K_TRADE_DOMINANCE_NOT_AVAILABLE",
      },
    });
    expect(result.tokenConcentration).toEqual({
      role: "STRATEGY_STRUCTURE_DIAGNOSTIC",
      bestTokenContribution: historical.strategyMetrics.bestTokenContribution,
      tradeLevelDominanceSubstitute: false,
    });
  });

  it("copies censoring counts without emitting a comparison eligibility decision", () => {
    const baseline = historicalFixture();
    const historical: HistoricalEvaluationResult = {
      ...baseline,
      sample: {
        ...baseline.sample,
        leftCensoredCount: 1,
        rightCensoredCount: 2,
        preWindowOpenCount: 3,
        sourceUnavailableCount: 4,
      },
    };
    const result = evaluateLeaderReliabilityDiagnostics(historical);

    expect(result.censoring).toEqual({
      leftCensoredCount: 1,
      rightCensoredCount: 2,
      preWindowOpenCount: 3,
      sourceUnavailableCount: 4,
    });
    expect(result).not.toHaveProperty("comparability");
    expect(result).not.toHaveProperty("eligibility");
  });

  it("is independent of cohort membership and leaves Copyability unchanged", () => {
    const baseline = historicalFixture();
    const historical: HistoricalEvaluationResult = {
      ...baseline,
      copyability: {
        ...baseline.copyability,
        endToEndApplication: {
          ...baseline.copyability.endToEndApplication,
          endToEndOpportunityCount: 1,
          applicationSuccessCount: 1,
          endToEndApplicationCompatibilityRate: "1",
          preconditionCount: 1,
          evaluableCount: 1,
          coverageRate: "1",
          status: "AVAILABLE",
        },
      },
    };
    const copyabilityBefore = structuredClone(historical.copyability);
    const standaloneReliability =
      evaluateLeaderReliabilityDiagnostics(historical);
    const standaloneCohort = evaluateLeaderCohortCompatibility([historical]);
    const peer: HistoricalEvaluationResult = {
      ...historical,
      bucket: { ...historical.bucket, leaderWallet: "leader-b" },
      provenance: {
        ...historical.provenance,
        resolvedDatabasePath: "/fixture/peer.sqlite",
      },
    };
    const groupedCohort = evaluateLeaderCohortCompatibility([historical, peer]);

    expect(
      standaloneCohort.cohorts[0]!.compatibilityGroups[0]!.members,
    ).toHaveLength(1);
    expect(
      groupedCohort.cohorts[0]!.compatibilityGroups[0]!.members,
    ).toHaveLength(2);
    expect(evaluateLeaderReliabilityDiagnostics(historical)).toEqual(
      standaloneReliability,
    );
    expect(historical.copyability).toEqual(copyabilityBefore);
    expect(standaloneReliability.opportunityRealizationContext).toEqual({
      status: "AVAILABLE_SEPARATELY_IN_HISTORICAL_RESULT",
      failureClassificationDefinitionVersion: "OPPORTUNITY_FAILURE_V1",
      endToEndApplicationDefinitionVersion: "COPYABILITY_V1",
    });
  });

  it("is deterministic and defensively copies every projected object and array", () => {
    const historical = historicalFixture();
    const first = evaluateLeaderReliabilityDiagnostics(historical);
    const second = evaluateLeaderReliabilityDiagnostics(historical);

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.historicalReference).not.toBe(first.historicalReference);
    expect(second.historicalReference.bucket).not.toBe(
      first.historicalReference.bucket,
    );
    expect(second.historicalReference.window).not.toBe(
      first.historicalReference.window,
    );
    expect(second.sampleDepth).not.toBe(first.sampleDepth);
    expect(second.censoring).not.toBe(first.censoring);
    expect(second.conditionalExpectancy.pointEstimate).not.toBe(
      first.conditionalExpectancy.pointEstimate,
    );
    expect(second.tradeDominance.bestTradeContribution).not.toBe(
      first.tradeDominance.bestTradeContribution,
    );
    expect(second.tokenConcentration.bestTokenContribution).not.toBe(
      first.tokenConcentration.bestTokenContribution,
    );
    expect(second.limitations).not.toBe(first.limitations);

    (historical.bucket as { leaderWallet: string }).leaderWallet =
      "mutated-input";
    (historical.window as { windowStartMs: number }).windowStartMs = 999;
    (historical.sample as { fullyContainedCount: number }).fullyContainedCount =
      999;
    (
      historical.strategyMetrics.netQuoteExpectancy as { value: string | null }
    ).value = "999";
    (
      historical.strategyMetrics.bestTradeContribution as {
        bestTradeCloseFillId: string | null;
      }
    ).bestTradeCloseFillId = "mutated-trade";
    (
      historical.strategyMetrics.bestTokenContribution as {
        bestTokenMint: string | null;
      }
    ).bestTokenMint = "mutated-token";
    (
      second.historicalReference.bucket as { leaderWallet: string }
    ).leaderWallet = "mutated-result";
    (second.limitations as string[]).push("MUTATED_LIMITATION");

    expect(first).toEqual(
      evaluateLeaderReliabilityDiagnostics(historicalFixture()),
    );
  });

  it("exposes no score, grade, band, ranking, recommendation, or invented statistic", () => {
    const historical = historicalFixture();
    const result = evaluateLeaderReliabilityDiagnostics(historical);
    const keys: string[] = [];
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        visit(child);
      }
    };
    visit(result);

    expect(result.definitionVersion).toBe("LEADER_RELIABILITY_DIAGNOSTICS_V1");
    expect(historical.definitionVersion).toBe("HISTORICAL_EVALUATION_V1");
    for (const forbiddenField of [
      "reliabilityScore",
      "confidenceScore",
      "score",
      "grade",
      "band",
      "reliabilityBand",
      "rank",
      "ranking",
      "ordering",
      "recommendation",
      "effectiveSampleSize",
      "standardError",
      "adjustedExpectancy",
      "unconditionalExpectancy",
      "estimateDirection",
      "top5Contribution",
      "top10Contribution",
      "hhi",
      "gini",
      "copySuccessScore",
    ]) {
      expect(keys).not.toContain(forbiddenField);
    }
  });
});
