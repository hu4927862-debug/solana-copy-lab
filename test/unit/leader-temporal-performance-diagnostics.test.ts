import { describe, expect, it } from "vitest";
import {
  evaluateHistoricalEvaluation,
  type HistoricalEvaluationResult,
} from "../../src/strategy-evaluation/historical-evaluation.js";
import {
  evaluateLeaderTemporalPerformanceDiagnostics,
  LEADER_TEMPORAL_PERFORMANCE_DEFINITION_VERSION,
  type LeaderTemporalPerformanceAvailableResult,
  type LeaderTemporalPerformanceDiagnosticsResult,
} from "../../src/strategy-evaluation/leader-temporal-performance-diagnostics.js";
import {
  evaluateLeaderTemporalCoverageDiagnostics,
  LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION,
} from "../../src/strategy-evaluation/leader-temporal-coverage-diagnostics.js";
import {
  evaluateLeaderReliabilityDiagnostics,
  LEADER_RELIABILITY_DEFINITION_VERSION,
} from "../../src/strategy-evaluation/leader-reliability-diagnostics.js";
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
  tokenMint = `TOKEN_${suffix}`,
): CompletedFollowerRoundTrip {
  return {
    ...BUCKET,
    tokenMint,
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

function historicalWithPerformance(
  entries: readonly {
    readonly suffix: string;
    readonly openSourceTimestampMs: number;
    readonly closeSourceTimestampMs: number;
    readonly realizedPnlQuoteRaw: bigint;
    readonly tokenMint?: string;
  }[],
): HistoricalEvaluationResult {
  const baseline = emptyHistorical();
  const includedRoundTrips = entries.map(
    ({ suffix, realizedPnlQuoteRaw, tokenMint }) =>
      cycle(suffix, realizedPnlQuoteRaw, tokenMint),
  );
  return {
    ...baseline,
    sample: {
      ...baseline.sample,
      fullyContainedCount: entries.length,
    },
    includedRoundTrips,
    includedLifecycleSourceTimingEvidence: entries.map(
      ({
        suffix,
        openSourceTimestampMs,
        closeSourceTimestampMs,
        tokenMint = `TOKEN_${suffix}`,
      }) => ({
        ...BUCKET,
        tokenMint,
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

function requireAvailable(
  result: LeaderTemporalPerformanceDiagnosticsResult,
): asserts result is LeaderTemporalPerformanceAvailableResult {
  expect(result.temporalPerformanceStatus).toBe("AVAILABLE");
  if (result.temporalPerformanceStatus !== "AVAILABLE") {
    throw new Error(result.unavailableReason);
  }
}

function allObjectKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(allObjectKeys);
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...allObjectKeys(child),
  ]);
}

describe("evaluateLeaderTemporalPerformanceDiagnostics", () => {
  it("reports persisted PnL and conditional Paper Expectancy in aligned calendar blocks", () => {
    const historical = historicalWithPerformance([
      {
        suffix: "A",
        openSourceTimestampMs: 100,
        closeSourceTimestampMs: 500,
        realizedPnlQuoteRaw: 100n,
      },
      {
        suffix: "B",
        openSourceTimestampMs: 1_100,
        closeSourceTimestampMs: 1_700,
        realizedPnlQuoteRaw: -50n,
      },
      {
        suffix: "C",
        openSourceTimestampMs: 2_500,
        closeSourceTimestampMs: 2_900,
        realizedPnlQuoteRaw: 150n,
      },
    ]);

    const result = evaluateLeaderTemporalPerformanceDiagnostics(historical, {
      blockCount: 3,
    });
    requireAvailable(result);

    expect(result.blocks).toEqual([
      {
        blockIndex: 0,
        blockStartMs: 0,
        blockEndMs: 1_000,
        completedLifecycleCount: 1,
        realizedPnlRawTotal: 100n,
        blockConditionalPaperExpectancy: {
          value: "100",
          unit: "QUOTE_RAW_PER_COMPLETED_CYCLE",
          sampleCount: 1,
          status: "AVAILABLE",
          definitionVersion: "STRATEGY_METRICS_V1",
        },
      },
      {
        blockIndex: 1,
        blockStartMs: 1_000,
        blockEndMs: 2_000,
        completedLifecycleCount: 1,
        realizedPnlRawTotal: -50n,
        blockConditionalPaperExpectancy: {
          value: "-50",
          unit: "QUOTE_RAW_PER_COMPLETED_CYCLE",
          sampleCount: 1,
          status: "AVAILABLE",
          definitionVersion: "STRATEGY_METRICS_V1",
        },
      },
      {
        blockIndex: 2,
        blockStartMs: 2_000,
        blockEndMs: 3_000,
        completedLifecycleCount: 1,
        realizedPnlRawTotal: 150n,
        blockConditionalPaperExpectancy: {
          value: "150",
          unit: "QUOTE_RAW_PER_COMPLETED_CYCLE",
          sampleCount: 1,
          status: "AVAILABLE",
          definitionVersion: "STRATEGY_METRICS_V1",
        },
      },
    ]);
  });

  it("uses the existing exact ratio semantics for multiple mixed-PnL trades in one block", () => {
    const result = evaluateLeaderTemporalPerformanceDiagnostics(
      historicalWithPerformance([
        {
          suffix: "A",
          openSourceTimestampMs: 100,
          closeSourceTimestampMs: 500,
          realizedPnlQuoteRaw: 100n,
        },
        {
          suffix: "B",
          openSourceTimestampMs: 200,
          closeSourceTimestampMs: 900,
          realizedPnlQuoteRaw: -40n,
        },
      ]),
      { blockCount: 3 },
    );
    requireAvailable(result);

    expect(result.blocks[0]).toMatchObject({
      completedLifecycleCount: 2,
      realizedPnlRawTotal: 60n,
      blockConditionalPaperExpectancy: {
        value: "30",
        unit: "QUOTE_RAW_PER_COMPLETED_CYCLE",
        sampleCount: 2,
        status: "AVAILABLE",
      },
    });
  });

  it("preserves an empty middle block while keeping zero expectancy distinct from no observations", () => {
    const result = evaluateLeaderTemporalPerformanceDiagnostics(
      historicalWithPerformance([
        {
          suffix: "A",
          openSourceTimestampMs: 100,
          closeSourceTimestampMs: 500,
          realizedPnlQuoteRaw: 100n,
        },
        {
          suffix: "B",
          openSourceTimestampMs: 200,
          closeSourceTimestampMs: 900,
          realizedPnlQuoteRaw: -40n,
        },
        {
          suffix: "C",
          openSourceTimestampMs: 2_100,
          closeSourceTimestampMs: 2_900,
          realizedPnlQuoteRaw: 0n,
        },
      ]),
      { blockCount: 3 },
    );
    requireAvailable(result);

    expect(
      result.blocks.map(
        ({ completedLifecycleCount }) => completedLifecycleCount,
      ),
    ).toEqual([2, 0, 1]);
    expect(result.blocks[1]).toMatchObject({
      realizedPnlRawTotal: 0n,
      blockConditionalPaperExpectancy: {
        value: null,
        sampleCount: 0,
        status: "NO_TRADES",
      },
    });
    expect(result.blocks[2]).toMatchObject({
      realizedPnlRawTotal: 0n,
      blockConditionalPaperExpectancy: {
        value: "0",
        sampleCount: 1,
        status: "AVAILABLE",
      },
    });
  });

  it("returns every aligned block with unavailable expectancy for a zero sample", () => {
    const result = evaluateLeaderTemporalPerformanceDiagnostics(
      emptyHistorical(),
      { blockCount: 3 },
    );
    requireAvailable(result);

    expect(result.blocks).toHaveLength(3);
    expect(result.blocks).toEqual(
      [
        [0, 0, 1_000],
        [1, 1_000, 2_000],
        [2, 2_000, 3_000],
      ].map(([blockIndex, blockStartMs, blockEndMs]) => ({
        blockIndex,
        blockStartMs,
        blockEndMs,
        completedLifecycleCount: 0,
        realizedPnlRawTotal: 0n,
        blockConditionalPaperExpectancy: {
          value: null,
          unit: "QUOTE_RAW_PER_COMPLETED_CYCLE",
          sampleCount: 0,
          status: "NO_TRADES",
          definitionVersion: "STRATEGY_METRICS_V1",
        },
      })),
    );
  });

  it("places by half-open OPEN time even when CLOSE is in a later block and tokens differ", () => {
    const result = evaluateLeaderTemporalPerformanceDiagnostics(
      historicalWithPerformance([
        {
          suffix: "A",
          tokenMint: "TOKEN_X",
          openSourceTimestampMs: 100,
          closeSourceTimestampMs: 2_500,
          realizedPnlQuoteRaw: 10n,
        },
        {
          suffix: "B",
          tokenMint: "TOKEN_Y",
          openSourceTimestampMs: 1_000,
          closeSourceTimestampMs: 2_900,
          realizedPnlQuoteRaw: 20n,
        },
      ]),
      { blockCount: 3 },
    );
    requireAvailable(result);

    expect(
      result.blocks.map(({ completedLifecycleCount, realizedPnlRawTotal }) => ({
        completedLifecycleCount,
        realizedPnlRawTotal,
      })),
    ).toEqual([
      { completedLifecycleCount: 1, realizedPnlRawTotal: 10n },
      { completedLifecycleCount: 1, realizedPnlRawTotal: 20n },
      { completedLifecycleCount: 0, realizedPnlRawTotal: 0n },
    ]);
  });

  it("inherits Coverage V1 validation and fails closed for malformed lifecycle association", () => {
    const historical = historicalWithPerformance([
      {
        suffix: "A",
        openSourceTimestampMs: 100,
        closeSourceTimestampMs: 500,
        realizedPnlQuoteRaw: 100n,
      },
    ]);
    const malformedCases: HistoricalEvaluationResult[] = [
      {
        ...historical,
        includedLifecycleSourceTimingEvidence: [],
      },
      {
        ...historical,
        includedLifecycleSourceTimingEvidence: [
          ...historical.includedLifecycleSourceTimingEvidence,
          { ...historical.includedLifecycleSourceTimingEvidence[0]! },
        ],
      },
      {
        ...historical,
        includedLifecycleSourceTimingEvidence:
          historical.includedLifecycleSourceTimingEvidence.map((timing) => ({
            ...timing,
            openFillId: "orphan-open",
            closeFillId: "orphan-close",
          })),
      },
      {
        ...historical,
        includedLifecycleSourceTimingEvidence:
          historical.includedLifecycleSourceTimingEvidence.map((timing) => ({
            ...timing,
            tokenMint: "OTHER_TOKEN",
          })),
      },
    ];

    for (const malformed of malformedCases) {
      expect(
        evaluateLeaderTemporalPerformanceDiagnostics(malformed, {
          blockCount: 3,
        }),
      ).toMatchObject({
        temporalPerformanceStatus: "UNAVAILABLE",
        unavailableReason: "TIMING_EVIDENCE_ASSOCIATION_INVARIANT_VIOLATION",
        blocks: null,
      });
    }
  });

  it("fails closed when the Historical fully-contained count is inconsistent", () => {
    const historical = historicalWithPerformance([
      {
        suffix: "A",
        openSourceTimestampMs: 100,
        closeSourceTimestampMs: 500,
        realizedPnlQuoteRaw: 100n,
      },
    ]);

    expect(
      evaluateLeaderTemporalPerformanceDiagnostics(
        {
          ...historical,
          sample: { ...historical.sample, fullyContainedCount: 2 },
        },
        { blockCount: 3 },
      ),
    ).toMatchObject({
      temporalPerformanceStatus: "UNAVAILABLE",
      unavailableReason: "HISTORICAL_COUNT_INVARIANT_VIOLATION",
      blocks: null,
    });
  });

  it("excludes failed opportunities and censored or source-unavailable lifecycles without zero imputation", () => {
    const historical = historicalWithPerformance([
      {
        suffix: "A",
        openSourceTimestampMs: 100,
        closeSourceTimestampMs: 500,
        realizedPnlQuoteRaw: 100n,
      },
    ]);
    const baseline = evaluateLeaderTemporalPerformanceDiagnostics(historical, {
      blockCount: 3,
    });
    const unrelatedEvidenceChanged: HistoricalEvaluationResult = {
      ...historical,
      sample: {
        ...historical.sample,
        leftCensoredCount: 10,
        rightCensoredCount: 20,
        preWindowOpenCount: 30,
        sourceUnavailableCount: 40,
      },
      failureClassification: {
        ...historical.failureClassification,
        summary: {
          ...historical.failureClassification.summary,
          totalCanonicalOpportunityCount: 999,
          terminalFailureCount: 999,
        },
      },
    };

    expect(
      evaluateLeaderTemporalPerformanceDiagnostics(unrelatedEvidenceChanged, {
        blockCount: 3,
      }),
    ).toEqual(baseline);
  });

  it("preserves bigint economics above Number.MAX_SAFE_INTEGER without floating conversion", () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 12_345_678_901_234n;
    const result = evaluateLeaderTemporalPerformanceDiagnostics(
      historicalWithPerformance([
        {
          suffix: "A",
          openSourceTimestampMs: 100,
          closeSourceTimestampMs: 500,
          realizedPnlQuoteRaw: huge,
        },
        {
          suffix: "B",
          openSourceTimestampMs: 200,
          closeSourceTimestampMs: 900,
          realizedPnlQuoteRaw: 1n,
        },
      ]),
      { blockCount: 3 },
    );
    requireAvailable(result);

    expect(result.blocks[0]!.realizedPnlRawTotal).toBe(huge + 1n);
    expect(result.blocks[0]!.blockConditionalPaperExpectancy.value).toBe(
      "4509772466821113",
    );
  });

  it("partitions counts and PnL exactly and preserves global Paper Expectancy semantics", () => {
    const historical = historicalWithPerformance([
      {
        suffix: "A",
        openSourceTimestampMs: 100,
        closeSourceTimestampMs: 500,
        realizedPnlQuoteRaw: 100n,
      },
      {
        suffix: "B",
        openSourceTimestampMs: 200,
        closeSourceTimestampMs: 900,
        realizedPnlQuoteRaw: -39n,
      },
      {
        suffix: "C",
        openSourceTimestampMs: 2_100,
        closeSourceTimestampMs: 2_900,
        realizedPnlQuoteRaw: -1n,
      },
    ]);
    const result = evaluateLeaderTemporalPerformanceDiagnostics(historical, {
      blockCount: 3,
    });
    requireAvailable(result);

    expect(result.blocks[0]!.blockConditionalPaperExpectancy.value).toBe(
      "30.5",
    );
    expect(result.blocks[2]!.blockConditionalPaperExpectancy.value).toBe("-1");
    expect(
      result.blocks.reduce(
        (total, block) => total + block.completedLifecycleCount,
        0,
      ),
    ).toBe(historical.sample.fullyContainedCount);
    expect(historical.sample.fullyContainedCount).toBe(
      historical.includedRoundTrips.length,
    );
    expect(
      result.blocks.reduce(
        (total, block) => total + block.realizedPnlRawTotal,
        0n,
      ),
    ).toBe(60n);
    expect(historical.strategyMetrics.netQuoteExpectancy).toMatchObject({
      value: "20",
      unit: "QUOTE_RAW_PER_COMPLETED_CYCLE",
      sampleCount: 3,
      status: "AVAILABLE",
    });
  });

  it("is deep-equal when RoundTrips and timing evidence are independently reversed", () => {
    const historical = historicalWithPerformance([
      {
        suffix: "A",
        openSourceTimestampMs: 100,
        closeSourceTimestampMs: 500,
        realizedPnlQuoteRaw: 100n,
      },
      {
        suffix: "B",
        openSourceTimestampMs: 200,
        closeSourceTimestampMs: 900,
        realizedPnlQuoteRaw: -40n,
      },
      {
        suffix: "C",
        openSourceTimestampMs: 2_100,
        closeSourceTimestampMs: 2_900,
        realizedPnlQuoteRaw: 30n,
      },
    ]);
    const expected = evaluateLeaderTemporalPerformanceDiagnostics(historical, {
      blockCount: 3,
    });

    for (const reversed of [
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
        evaluateLeaderTemporalPerformanceDiagnostics(reversed, {
          blockCount: 3,
        }),
      ).toEqual(expected);
    }
  });

  it("returns deterministic defensive copies of reference, blocks, performance, and metadata", () => {
    const historical = historicalWithPerformance([
      {
        suffix: "A",
        openSourceTimestampMs: 100,
        closeSourceTimestampMs: 500,
        realizedPnlQuoteRaw: 100n,
      },
    ]);
    const first = evaluateLeaderTemporalPerformanceDiagnostics(historical, {
      blockCount: 3,
    });
    const second = evaluateLeaderTemporalPerformanceDiagnostics(historical, {
      blockCount: 3,
    });
    const expected = structuredClone(first);

    expect(second).toEqual(first);
    (historical.bucket as { leaderWallet: string }).leaderWallet = "mutated";
    (
      historical.includedRoundTrips[0] as { realizedPnlQuoteRaw: bigint }
    ).realizedPnlQuoteRaw = -999n;
    (
      historical.includedLifecycleSourceTimingEvidence[0] as {
        openSourceTimestampMs: number;
      }
    ).openSourceTimestampMs = 2_500;

    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
  });

  it("declares reporting-convention and conditioning semantics without expanding cohort identity", () => {
    const result = evaluateLeaderTemporalPerformanceDiagnostics(
      emptyHistorical(),
      { blockCount: 3 },
    );
    requireAvailable(result);

    expect(result).toMatchObject({
      definitionVersion: LEADER_TEMPORAL_PERFORMANCE_DEFINITION_VERSION,
      reference: {
        historicalEvaluationDefinitionVersion: "HISTORICAL_EVALUATION_V1",
        temporalCoverageDefinitionVersion:
          LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION,
        strategyMetricSemantics: "PAPER_EXPECTANCY",
      },
      metadata: {
        placementReference: "AUTHORITATIVE_OPEN_SOURCE_TIME",
        sampleCondition: "FULLY_CONTAINED_COMPLETED_ROUND_TRIPS_ONLY",
        economicsSource: "PERSISTED_INCLUDED_ROUND_TRIP_ECONOMICS",
        failedOpportunityTreatment: "EXCLUDED_NOT_IMPUTED",
        censoredLifecycleTreatment: "EXCLUDED",
        blockCountSelection: "EXPLICIT_CALLER_REPORTING_CONVENTION",
        crossLeaderComparisonRequirement:
          "SAME_WINDOW_BLOCK_COUNT_AND_TEMPORAL_COVERAGE_DEFINITION",
        cohortIdentityTreatment:
          "BLOCK_COUNT_EXCLUDED_FROM_LEADER_COHORT_COMPATIBILITY_KEY",
      },
      limitations: [
        "DESCRIPTIVE_POINT_ESTIMATES_ONLY",
        "BLOCK_COUNT_IS_A_REPORTING_CONVENTION_NOT_A_STATISTICAL_RULE",
      ],
    });
  });

  it("does not expose statistical inference, stability, trend, scoring, ordering, or ranking fields", () => {
    const result = evaluateLeaderTemporalPerformanceDiagnostics(
      historicalWithPerformance([
        {
          suffix: "A",
          openSourceTimestampMs: 100,
          closeSourceTimestampMs: 500,
          realizedPnlQuoteRaw: 100n,
        },
      ]),
      { blockCount: 3 },
    );
    const normalizedKeys = allObjectKeys(result).map((key) =>
      key.replaceAll("_", "").toLowerCase(),
    );

    for (const forbidden of [
      "variance",
      "standarddeviation",
      "standarderror",
      "confidenceinterval",
      "tstat",
      "pvalue",
      "bootstrap",
      "autocorrelation",
      "effectivesamplesize",
      "shrinkage",
      "estimatedirection",
      "reliabilityband",
      "stable",
      "unstable",
      "trend",
      "score",
      "ordering",
      "rank",
    ]) {
      expect(normalizedKeys.some((key) => key.includes(forbidden))).toBe(false);
    }
  });

  it("leaves Historical V1, Coverage V1, and Reliability V1 unchanged", () => {
    const historical = historicalWithPerformance([
      {
        suffix: "A",
        openSourceTimestampMs: 100,
        closeSourceTimestampMs: 500,
        realizedPnlQuoteRaw: 100n,
      },
    ]);
    const coverageBefore = evaluateLeaderTemporalCoverageDiagnostics(
      historical,
      { blockCount: 3 },
    );
    const reliabilityBefore = evaluateLeaderReliabilityDiagnostics(historical);

    evaluateLeaderTemporalPerformanceDiagnostics(historical, {
      blockCount: 3,
    });

    expect(historical.definitionVersion).toBe("HISTORICAL_EVALUATION_V1");
    expect(LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION).toBe(
      "LEADER_TEMPORAL_COVERAGE_V1",
    );
    expect(LEADER_RELIABILITY_DEFINITION_VERSION).toBe(
      "LEADER_RELIABILITY_DIAGNOSTICS_V1",
    );
    expect(
      evaluateLeaderTemporalCoverageDiagnostics(historical, {
        blockCount: 3,
      }),
    ).toEqual(coverageBefore);
    expect(evaluateLeaderReliabilityDiagnostics(historical)).toEqual(
      reliabilityBefore,
    );
  });
});
