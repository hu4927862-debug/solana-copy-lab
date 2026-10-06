import { describe, expect, expectTypeOf, it } from "vitest";
import {
  evaluateHistoricalEvaluation,
  type HistoricalEvaluationResult,
  type VersionedHistoricalEvaluationResult,
} from "../../src/strategy-evaluation/historical-evaluation.js";
import { evaluateLeaderCohortCompatibility } from "../../src/strategy-evaluation/leader-cohort-compatibility.js";
import {
  evaluateLeaderReliabilityDiagnostics,
  evaluateLeaderReliabilityDiagnosticsV2,
  LEADER_RELIABILITY_DEFINITION_VERSION,
  LEADER_RELIABILITY_V2_DEFINITION_VERSION,
  type LeaderReliabilityDiagnosticsV2ReportingConvention,
} from "../../src/strategy-evaluation/leader-reliability-diagnostics.js";
import {
  evaluateLeaderTemporalCoverageDiagnostics,
  LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION,
} from "../../src/strategy-evaluation/leader-temporal-coverage-diagnostics.js";
import {
  evaluateLeaderTemporalPerformanceDiagnostics,
  LEADER_TEMPORAL_PERFORMANCE_DEFINITION_VERSION,
} from "../../src/strategy-evaluation/leader-temporal-performance-diagnostics.js";
import { calculateStrategyMetrics } from "../../src/strategy-evaluation/metrics.js";
import type { StrategyEvaluationEvidenceSnapshot } from "../../src/strategy-evaluation/read-model.js";
import type { CompletedFollowerRoundTrip } from "../../src/strategy-evaluation/round-trips.js";

const BUCKET = {
  followerWallet: "follower-a",
  leaderWallet: "leader-a",
  quoteMint: "SOL_NATIVE",
} as const;
const WINDOW = { windowStartMs: 0, windowEndMs: 3_000 } as const;
const STRATEGY_METRICS_POLICY = {
  definitionVersion: "STRATEGY_METRICS_V1",
  minimumCompletedCycles: 20,
} as const;
const FAILURE_TAXONOMY_POLICY = {
  definitionVersion: "OPPORTUNITY_FAILURE_V1",
} as const;

function emptyHistorical(): HistoricalEvaluationResult {
  const snapshot: StrategyEvaluationEvidenceSnapshot = {
    provenance: {
      resolvedDatabasePath: "/fixture/historical.sqlite",
      observedSchemaMigrations: [],
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
  return evaluateHistoricalEvaluation(
    snapshot,
    BUCKET,
    STRATEGY_METRICS_POLICY,
    FAILURE_TAXONOMY_POLICY,
  );
}

function cycle(
  suffix: string,
  realizedPnlQuoteRaw: bigint,
): CompletedFollowerRoundTrip {
  return {
    ...BUCKET,
    tokenMint: `TOKEN_${suffix}`,
    openFillId: `open-${suffix}`,
    closeFillId: `close-${suffix}`,
    fillIds: [`open-${suffix}`, `close-${suffix}`],
    entryCostQuoteRaw: 100n,
    proceedsQuoteRaw: 100n + realizedPnlQuoteRaw,
    realizedPnlQuoteRaw,
    openedAtMs: 99_000,
    closedAtMs: 99_100,
    holdingTimeMs: 100,
  };
}

function historicalFixture(sampleCount = 30): HistoricalEvaluationResult {
  const baseline = emptyHistorical();
  const entries = Array.from({ length: sampleCount }, (_, index) => {
    const blockIndex = index % 3;
    const offsetWithinBlock = Math.floor(index / 3);
    const openSourceTimestampMs =
      blockIndex * 1_000 + 100 + offsetWithinBlock * 50;
    const firstPnlByBlock = [100n, -50n, 150n] as const;
    return {
      suffix: String(index),
      openSourceTimestampMs,
      closeSourceTimestampMs: openSourceTimestampMs + 100,
      realizedPnlQuoteRaw:
        offsetWithinBlock === 0 ? firstPnlByBlock[blockIndex]! : 0n,
    };
  });
  const includedRoundTrips = entries.map(({ suffix, realizedPnlQuoteRaw }) =>
    cycle(suffix, realizedPnlQuoteRaw),
  );
  return {
    ...baseline,
    sample: {
      ...baseline.sample,
      fullyContainedCount: entries.length,
      sampleStatus:
        entries.length >= 30
          ? "PROVISIONAL"
          : entries.length >= 10
            ? "EXPLORATORY"
            : "INSUFFICIENT_SAMPLE",
    },
    includedRoundTrips,
    includedLifecycleSourceTimingEvidence: entries.map(
      ({ suffix, openSourceTimestampMs, closeSourceTimestampMs }) => ({
        ...BUCKET,
        tokenMint: `TOKEN_${suffix}`,
        openFillId: `open-${suffix}`,
        closeFillId: `close-${suffix}`,
        openSourceTimestampMs,
        closeSourceTimestampMs,
      }),
    ),
    strategyMetrics: calculateStrategyMetrics(
      includedRoundTrips,
      STRATEGY_METRICS_POLICY,
    ),
  };
}

function allObjectKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(allObjectKeys);
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...allObjectKeys(child),
  ]);
}

function allStringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(allStringValues);
}

describe("evaluateLeaderReliabilityDiagnosticsV2", () => {
  it("combines provisional V1 reliability evidence with descriptive temporal diagnostics", () => {
    const result = evaluateLeaderReliabilityDiagnosticsV2(historicalFixture(), {
      temporalBlockCount: 3,
    });

    expectTypeOf(evaluateLeaderReliabilityDiagnosticsV2)
      .parameter(0)
      .toEqualTypeOf<VersionedHistoricalEvaluationResult>();
    expect(result).toMatchObject({
      definitionVersion: LEADER_RELIABILITY_V2_DEFINITION_VERSION,
      sampleDepth: {
        fullyContainedCount: 30,
        sampleStatus: "PROVISIONAL",
        independenceStatus: "NOT_ESTABLISHED",
      },
      temporalEvidenceStatus: "AVAILABLE",
      temporalStabilityConclusion: "NOT_ESTABLISHED",
      temporalCoverage: {
        temporalEvidenceStatus: "AVAILABLE",
        coverage: {
          status: "AVAILABLE",
          firstIncludedOpenTimestampMs: 100,
          lastIncludedCloseTimestampMs: 2_650,
          observedLifecycleSpanMs: 2_550,
        },
        distribution: { blockCount: 3 },
      },
      temporalPerformance: {
        temporalPerformanceStatus: "AVAILABLE",
        blocks: [
          {
            realizedPnlRawTotal: 100n,
            blockConditionalPaperExpectancy: {
              value: "10",
              status: "AVAILABLE",
            },
          },
          {
            realizedPnlRawTotal: -50n,
            blockConditionalPaperExpectancy: {
              value: "-5",
              status: "AVAILABLE",
            },
          },
          {
            realizedPnlRawTotal: 150n,
            blockConditionalPaperExpectancy: {
              value: "15",
              status: "AVAILABLE",
            },
          },
        ],
      },
    });
  });

  it("preserves V1 diagnostics while resolving only the obsolete timing gap", () => {
    const historical = historicalFixture();
    const reliabilityV1 = evaluateLeaderReliabilityDiagnostics(historical);
    const result = evaluateLeaderReliabilityDiagnosticsV2(historical, {
      temporalBlockCount: 3,
    });

    expectTypeOf(evaluateLeaderReliabilityDiagnosticsV2)
      .parameter(1)
      .toEqualTypeOf<LeaderReliabilityDiagnosticsV2ReportingConvention>();
    expect(result).toMatchObject({
      historicalReference: reliabilityV1.historicalReference,
      sampleDepth: reliabilityV1.sampleDepth,
      censoring: reliabilityV1.censoring,
      conditionalExpectancy: reliabilityV1.conditionalExpectancy,
      tradeDominance: reliabilityV1.tradeDominance,
      tokenConcentration: reliabilityV1.tokenConcentration,
      confidenceInterval: reliabilityV1.confidenceInterval,
      methodology: reliabilityV1.methodology,
      opportunityRealizationContext:
        reliabilityV1.opportunityRealizationContext,
      temporalCoverage: evaluateLeaderTemporalCoverageDiagnostics(historical, {
        blockCount: 3,
      }),
      temporalPerformance: evaluateLeaderTemporalPerformanceDiagnostics(
        historical,
        { blockCount: 3 },
      ),
      limitations: [
        "DEPENDENCE_NOT_MODELED",
        "HEAVY_TAIL_BEHAVIOR_NOT_CALIBRATED",
        "IID_CONFIDENCE_INTERVAL_NOT_AVAILABLE",
        "REAL_DATA_CALIBRATION_REQUIRED",
        "TOP_K_TRADE_DOMINANCE_NOT_AVAILABLE",
      ],
    });
    expect(result).not.toHaveProperty("temporalStability");
    expect(
      JSON.stringify(result, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain("AUTHORITATIVE_LIFECYCLE_TIME_NOT_EXPOSED");
    expect(LEADER_RELIABILITY_DEFINITION_VERSION).toBe(
      "LEADER_RELIABILITY_DIAGNOSTICS_V1",
    );
    expect(LEADER_RELIABILITY_V2_DEFINITION_VERSION).toBe(
      "LEADER_RELIABILITY_DIAGNOSTICS_V2",
    );
    expect(LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION).toBe(
      "LEADER_TEMPORAL_COVERAGE_V1",
    );
    expect(LEADER_TEMPORAL_PERFORMANCE_DEFINITION_VERSION).toBe(
      "LEADER_TEMPORAL_PERFORMANCE_V1",
    );
    expect(historical.definitionVersion).toBe("HISTORICAL_EVALUATION_V1");
  });

  it("returns full aligned NO_TRADES blocks for a zero sample without implying zero return or confidence", () => {
    const result = evaluateLeaderReliabilityDiagnosticsV2(emptyHistorical(), {
      temporalBlockCount: 3,
    });

    expect(result.sampleDepth).toEqual({
      fullyContainedCount: 0,
      sampleStatus: "INSUFFICIENT_SAMPLE",
      independenceStatus: "NOT_ESTABLISHED",
    });
    expect(result.temporalEvidenceStatus).toBe("AVAILABLE");
    expect(result.temporalStabilityConclusion).toBe("NOT_ESTABLISHED");
    expect(result.temporalCoverage).toMatchObject({
      coverage: {
        status: "NO_INCLUDED_LIFECYCLES",
        firstIncludedOpenTimestampMs: null,
        lastIncludedCloseTimestampMs: null,
        observedLifecycleSpanMs: null,
      },
      distribution: {
        blockCount: 3,
        blocks: [
          { completedLifecycleCount: 0 },
          { completedLifecycleCount: 0 },
          { completedLifecycleCount: 0 },
        ],
      },
    });
    expect(result.temporalPerformance).toMatchObject({
      temporalPerformanceStatus: "AVAILABLE",
      blocks: [
        {
          completedLifecycleCount: 0,
          realizedPnlRawTotal: 0n,
          blockConditionalPaperExpectancy: {
            value: null,
            sampleCount: 0,
            status: "NO_TRADES",
          },
        },
        {
          completedLifecycleCount: 0,
          realizedPnlRawTotal: 0n,
          blockConditionalPaperExpectancy: {
            value: null,
            sampleCount: 0,
            status: "NO_TRADES",
          },
        },
        {
          completedLifecycleCount: 0,
          realizedPnlRawTotal: 0n,
          blockConditionalPaperExpectancy: {
            value: null,
            sampleCount: 0,
            status: "NO_TRADES",
          },
        },
      ],
    });
  });

  it.each([
    [20, "EXPLORATORY"],
    [3, "INSUFFICIENT_SAMPLE"],
  ] as const)(
    "keeps descriptive temporal evidence available for %s-sample %s evidence",
    (sampleCount, sampleStatus) => {
      const historical = historicalFixture(sampleCount);
      const result = evaluateLeaderReliabilityDiagnosticsV2(historical, {
        temporalBlockCount: 3,
      });

      expect(result.sampleDepth.fullyContainedCount).toBe(sampleCount);
      expect(result.sampleDepth.sampleStatus).toBe(sampleStatus);
      expect(result.temporalEvidenceStatus).toBe("AVAILABLE");
      expect(result.temporalCoverage.temporalEvidenceStatus).toBe("AVAILABLE");
      expect(result.temporalPerformance.temporalPerformanceStatus).toBe(
        "AVAILABLE",
      );
      expect(result.temporalStabilityConclusion).toBe("NOT_ESTABLISHED");
    },
  );

  it("does not change reliability semantics for positive, zero, or negative global expectancy", () => {
    const baseline = historicalFixture();
    const results = [3n, 0n, -3n].map((firstPnl) => {
      const includedRoundTrips = baseline.includedRoundTrips.map(
        (roundTrip, index) => ({
          ...roundTrip,
          proceedsQuoteRaw:
            roundTrip.entryCostQuoteRaw + (index === 0 ? firstPnl : 0n),
          realizedPnlQuoteRaw: index === 0 ? firstPnl : 0n,
        }),
      );
      return evaluateLeaderReliabilityDiagnosticsV2(
        {
          ...baseline,
          includedRoundTrips,
          strategyMetrics: calculateStrategyMetrics(
            includedRoundTrips,
            STRATEGY_METRICS_POLICY,
          ),
        },
        { temporalBlockCount: 3 },
      );
    });

    expect(
      results.map((result) => result.conditionalExpectancy.pointEstimate.value),
    ).toEqual(["0.1", "0", "-0.1"]);
    expect(
      results.map((result) => ({
        sampleDepth: result.sampleDepth,
        temporalEvidenceStatus: result.temporalEvidenceStatus,
        temporalStabilityConclusion: result.temporalStabilityConclusion,
        confidenceInterval: result.confidenceInterval,
        methodology: result.methodology,
        limitations: result.limitations,
      })),
    ).toEqual([
      {
        sampleDepth: results[0]!.sampleDepth,
        temporalEvidenceStatus: "AVAILABLE",
        temporalStabilityConclusion: "NOT_ESTABLISHED",
        confidenceInterval: results[0]!.confidenceInterval,
        methodology: results[0]!.methodology,
        limitations: results[0]!.limitations,
      },
      {
        sampleDepth: results[0]!.sampleDepth,
        temporalEvidenceStatus: "AVAILABLE",
        temporalStabilityConclusion: "NOT_ESTABLISHED",
        confidenceInterval: results[0]!.confidenceInterval,
        methodology: results[0]!.methodology,
        limitations: results[0]!.limitations,
      },
      {
        sampleDepth: results[0]!.sampleDepth,
        temporalEvidenceStatus: "AVAILABLE",
        temporalStabilityConclusion: "NOT_ESTABLISHED",
        confidenceInterval: results[0]!.confidenceInterval,
        methodology: results[0]!.methodology,
        limitations: results[0]!.limitations,
      },
    ]);
  });

  it("preserves censoring while excluding censored lifecycles and failed opportunities from temporal blocks", () => {
    const baseline = historicalFixture();
    const includedRoundTrips = [
      baseline.includedRoundTrips[0]!,
      baseline.includedRoundTrips[2]!,
    ];
    const includedLifecycleSourceTimingEvidence = [
      baseline.includedLifecycleSourceTimingEvidence[0]!,
      baseline.includedLifecycleSourceTimingEvidence[2]!,
    ];
    const historical: HistoricalEvaluationResult = {
      ...baseline,
      sample: {
        ...baseline.sample,
        fullyContainedCount: 2,
        sampleStatus: "INSUFFICIENT_SAMPLE",
        leftCensoredCount: 4,
        rightCensoredCount: 5,
        preWindowOpenCount: 6,
        sourceUnavailableCount: 7,
      },
      includedRoundTrips,
      includedLifecycleSourceTimingEvidence,
      strategyMetrics: calculateStrategyMetrics(
        includedRoundTrips,
        STRATEGY_METRICS_POLICY,
      ),
      failureClassification: {
        ...baseline.failureClassification,
        summary: {
          ...baseline.failureClassification.summary,
          totalCanonicalOpportunityCount: 99,
          terminalFailureCount: 88,
        },
      },
    };
    const copyabilityBefore = structuredClone(historical.copyability);
    const result = evaluateLeaderReliabilityDiagnosticsV2(historical, {
      temporalBlockCount: 3,
    });

    expect(result.censoring).toEqual({
      leftCensoredCount: 4,
      rightCensoredCount: 5,
      preWindowOpenCount: 6,
      sourceUnavailableCount: 7,
    });
    expect(result.temporalCoverage).toMatchObject({
      distribution: {
        blocks: [
          { completedLifecycleCount: 1 },
          { completedLifecycleCount: 0 },
          { completedLifecycleCount: 1 },
        ],
      },
    });
    expect(result.temporalPerformance).toMatchObject({
      blocks: [
        { completedLifecycleCount: 1, realizedPnlRawTotal: 100n },
        {
          completedLifecycleCount: 0,
          realizedPnlRawTotal: 0n,
          blockConditionalPaperExpectancy: {
            value: null,
            sampleCount: 0,
            status: "NO_TRADES",
          },
        },
        { completedLifecycleCount: 1, realizedPnlRawTotal: 150n },
      ],
      metadata: {
        failedOpportunityTreatment: "EXCLUDED_NOT_IMPUTED",
        censoredLifecycleTreatment: "EXCLUDED",
      },
    });
    expect(
      result.conditionalExpectancy.canonicalFailedOpportunityTreatment,
    ).toBe("NOT_IMPUTED_INTO_STRATEGY_METRICS");
    expect(result.opportunityRealizationContext).toEqual({
      status: "AVAILABLE_SEPARATELY_IN_HISTORICAL_RESULT",
      failureClassificationDefinitionVersion: "OPPORTUNITY_FAILURE_V1",
      endToEndApplicationDefinitionVersion: "COPYABILITY_V1",
    });
    expect(result).not.toHaveProperty("failureClassification");
    expect(result).not.toHaveProperty("copyability");
    expect(historical.copyability).toEqual(copyabilityBefore);
  });

  it("is deterministic when RoundTrips and timing evidence are independently reversed", () => {
    const historical = historicalFixture();
    const expected = evaluateLeaderReliabilityDiagnosticsV2(historical, {
      temporalBlockCount: 3,
    });

    for (const permuted of [
      {
        ...historical,
        includedRoundTrips: [...historical.includedRoundTrips].reverse(),
      },
      {
        ...historical,
        includedLifecycleSourceTimingEvidence: [
          ...historical.includedLifecycleSourceTimingEvidence,
        ].reverse(),
      },
      {
        ...historical,
        includedRoundTrips: [...historical.includedRoundTrips].reverse(),
        includedLifecycleSourceTimingEvidence: [
          ...historical.includedLifecycleSourceTimingEvidence,
        ].reverse(),
      },
    ]) {
      expect(
        evaluateLeaderReliabilityDiagnosticsV2(permuted, {
          temporalBlockCount: 3,
        }),
      ).toEqual(expected);
    }
  });

  it("returns isolated nested copies across V2, V1, Coverage V1, and Performance V1 calls", () => {
    const historical = historicalFixture();
    const historicalBefore = structuredClone(historical);
    const reliabilityV1Before =
      evaluateLeaderReliabilityDiagnostics(historical);
    const coverageBefore = evaluateLeaderTemporalCoverageDiagnostics(
      historical,
      { blockCount: 3 },
    );
    const performanceBefore = evaluateLeaderTemporalPerformanceDiagnostics(
      historical,
      { blockCount: 3 },
    );
    const resultA = evaluateLeaderReliabilityDiagnosticsV2(historical, {
      temporalBlockCount: 3,
    });
    const resultB = evaluateLeaderReliabilityDiagnosticsV2(historical, {
      temporalBlockCount: 3,
    });
    const expected = structuredClone(resultB);

    expect(resultA).toEqual(resultB);
    expect(resultA).not.toBe(resultB);
    expect(resultA.temporalCoverage).not.toBe(resultB.temporalCoverage);
    expect(resultA.temporalPerformance).not.toBe(resultB.temporalPerformance);
    expect(resultA.limitations).not.toBe(resultB.limitations);
    if (
      resultA.temporalCoverage.temporalEvidenceStatus !== "AVAILABLE" ||
      resultA.temporalPerformance.temporalPerformanceStatus !== "AVAILABLE"
    ) {
      throw new Error("fixture must expose temporal diagnostics");
    }
    (
      resultA.historicalReference.bucket as { leaderWallet: string }
    ).leaderWallet = "mutated-result";
    (
      resultA.conditionalExpectancy.pointEstimate as { value: string | null }
    ).value = "999";
    (
      resultA.temporalCoverage.distribution.blocks[0] as {
        completedLifecycleCount: number;
      }
    ).completedLifecycleCount = 999;
    (
      resultA.temporalPerformance.blocks[0]!
        .blockConditionalPaperExpectancy as { value: string | null }
    ).value = "999";
    (resultA.limitations as string[]).push("MUTATED_LIMITATION");

    expect(resultB).toEqual(expected);
    expect(
      evaluateLeaderReliabilityDiagnosticsV2(historical, {
        temporalBlockCount: 3,
      }),
    ).toEqual(expected);
    expect(evaluateLeaderReliabilityDiagnostics(historical)).toEqual(
      reliabilityV1Before,
    );
    expect(
      evaluateLeaderTemporalCoverageDiagnostics(historical, { blockCount: 3 }),
    ).toEqual(coverageBefore);
    expect(
      evaluateLeaderTemporalPerformanceDiagnostics(historical, {
        blockCount: 3,
      }),
    ).toEqual(performanceBefore);
    expect(historical).toEqual(historicalBefore);
  });

  it("uses only the caller's explicit temporalBlockCount reporting convention", () => {
    const historical = historicalFixture();
    const oneBlock = evaluateLeaderReliabilityDiagnosticsV2(historical, {
      temporalBlockCount: 1,
    });
    const threeBlocks = evaluateLeaderReliabilityDiagnosticsV2(historical, {
      temporalBlockCount: 3,
    });

    expect(oneBlock.temporalCoverage).toMatchObject({
      distribution: { blockCount: 1, blocks: [{ blockIndex: 0 }] },
      metadata: {
        blockCountSelection: "EXPLICIT_CALLER_REPORTING_CONVENTION",
        blockCountUpperBoundSemantics:
          "ENGINEERING_RESOURCE_LIMIT_NOT_STATISTICAL_RULE",
      },
    });
    expect(threeBlocks.temporalCoverage).toMatchObject({
      distribution: {
        blockCount: 3,
        blocks: [{ blockIndex: 0 }, { blockIndex: 1 }, { blockIndex: 2 }],
      },
    });
    expect(oneBlock.temporalPerformance).toMatchObject({
      blocks: [{ blockIndex: 0 }],
      metadata: {
        blockCountSelection: "EXPLICIT_CALLER_REPORTING_CONVENTION",
      },
    });
  });

  it("is independent of cohort membership and keeps block count out of cohort identity", () => {
    const historical = historicalFixture();
    const standalone = evaluateLeaderReliabilityDiagnosticsV2(historical, {
      temporalBlockCount: 3,
    });
    const cohortBefore = evaluateLeaderCohortCompatibility([historical]);
    const peer: HistoricalEvaluationResult = {
      ...historical,
      bucket: { ...historical.bucket, leaderWallet: "leader-b" },
      includedRoundTrips: historical.includedRoundTrips.map((roundTrip) => ({
        ...roundTrip,
        leaderWallet: "leader-b",
      })),
      includedLifecycleSourceTimingEvidence:
        historical.includedLifecycleSourceTimingEvidence.map((timing) => ({
          ...timing,
          leaderWallet: "leader-b",
        })),
      provenance: {
        ...historical.provenance,
        resolvedDatabasePath: "/fixture/peer.sqlite",
      },
    };

    evaluateLeaderCohortCompatibility([historical, peer]);
    const afterCohortEvaluation = evaluateLeaderReliabilityDiagnosticsV2(
      historical,
      { temporalBlockCount: 3 },
    );
    evaluateLeaderReliabilityDiagnosticsV2(historical, {
      temporalBlockCount: 1,
    });
    const afterDifferentReportingConvention = evaluateLeaderCohortCompatibility(
      [historical],
    );

    expect(afterCohortEvaluation).toEqual(standalone);
    expect(afterDifferentReportingConvention).toEqual(cohortBefore);
    expect(standalone.temporalPerformance).toMatchObject({
      metadata: {
        crossLeaderComparisonRequirement:
          "SAME_WINDOW_BLOCK_COUNT_AND_TEMPORAL_COVERAGE_DEFINITION",
        cohortIdentityTreatment:
          "BLOCK_COUNT_EXCLUDED_FROM_LEADER_COHORT_COMPATIBILITY_KEY",
      },
    });
    expect(standalone).not.toHaveProperty("cohort");
    expect(standalone).not.toHaveProperty("compatibilityGroupId");
  });

  it("exposes no score, band, rank, stability classification, or statistical inference", () => {
    const result = evaluateLeaderReliabilityDiagnosticsV2(historicalFixture(), {
      temporalBlockCount: 3,
    });
    const keys = allObjectKeys(result);
    const stringValues = allStringValues(result);

    for (const forbiddenField of [
      "reliabilityScore",
      "confidenceScore",
      "temporalScore",
      "score",
      "grade",
      "band",
      "reliabilityBand",
      "rank",
      "ranking",
      "ordering",
      "recommendation",
      "estimateDirection",
      "standardError",
      "variance",
      "pValue",
      "confidenceIntervalLower",
      "confidenceIntervalUpper",
      "autocorrelation",
      "effectiveSampleSize",
      "significance",
      "copySuccessScore",
    ]) {
      expect(keys).not.toContain(forbiddenField);
    }
    for (const forbiddenConclusion of [
      "STABLE",
      "UNSTABLE",
      "IMPROVING",
      "DEGRADING",
      "PERSISTENT_ALPHA",
    ]) {
      expect(stringValues).not.toContain(forbiddenConclusion);
    }
    expect(result.confidenceInterval).toEqual({
      status: "UNAVAILABLE",
      reason: "DEPENDENCE_AWARE_INFERENCE_METHOD_NOT_ESTABLISHED",
    });
    expect(result.methodology).toMatchObject({
      iidBootstrapStatus: "REJECTED_AS_DEFAULT_FOR_EXPECTANCY_CI",
      shrinkageStatus: "NOT_APPLIED",
      estimateDirectionInferenceStatus: "DEFERRED",
      bandThresholdsStatus: "NOT_YET_JUSTIFIED",
    });
  });
});
