import type { VersionedHistoricalEvaluationResult } from "./historical-evaluation.js";
import {
  evaluateLeaderTemporalCoverageDiagnostics,
  LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION,
  type LeaderTemporalCoverageReportingConvention,
  type LeaderTemporalCoverageUnavailableReason,
} from "./leader-temporal-coverage-diagnostics.js";
import {
  calculateNetQuoteExpectancyMetric,
  type StrategyMetricResult,
} from "./metrics.js";
import type { CompletedFollowerRoundTrip } from "./round-trips.js";
import {
  associateIncludedRoundTripsWithTiming,
  findAlignedTemporalBlock,
} from "./leader-temporal-diagnostics-shared.js";

export const LEADER_TEMPORAL_PERFORMANCE_DEFINITION_VERSION =
  "LEADER_TEMPORAL_PERFORMANCE_V1" as const;

export type LeaderTemporalPerformanceReportingConvention =
  LeaderTemporalCoverageReportingConvention;

export interface LeaderTemporalPerformanceBlock {
  readonly blockIndex: number;
  readonly blockStartMs: number;
  readonly blockEndMs: number;
  readonly completedLifecycleCount: number;
  readonly realizedPnlRawTotal: bigint;
  readonly blockConditionalPaperExpectancy: StrategyMetricResult;
}

interface LeaderTemporalPerformanceReference {
  readonly bucket: VersionedHistoricalEvaluationResult["bucket"];
  readonly historicalEvaluationDefinitionVersion: VersionedHistoricalEvaluationResult["definitionVersion"];
  readonly temporalCoverageDefinitionVersion: typeof LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION;
  readonly strategyMetricSemantics: VersionedHistoricalEvaluationResult["strategyMetricSemantics"];
}

interface LeaderTemporalPerformanceWindow {
  readonly evaluationWindowStartMs: number;
  readonly evaluationWindowEndMs: number;
  readonly evaluationWindowSpanMs: number;
}

interface LeaderTemporalPerformanceMetadata {
  readonly placementReference: "AUTHORITATIVE_OPEN_SOURCE_TIME";
  readonly sampleCondition: "FULLY_CONTAINED_COMPLETED_ROUND_TRIPS_ONLY";
  readonly economicsSource: "PERSISTED_INCLUDED_ROUND_TRIP_ECONOMICS";
  readonly failedOpportunityTreatment: "EXCLUDED_NOT_IMPUTED";
  readonly censoredLifecycleTreatment: "EXCLUDED";
  readonly blockCountSelection: "EXPLICIT_CALLER_REPORTING_CONVENTION";
  readonly crossLeaderComparisonRequirement: "SAME_WINDOW_BLOCK_COUNT_AND_TEMPORAL_COVERAGE_DEFINITION";
  readonly cohortIdentityTreatment: "BLOCK_COUNT_EXCLUDED_FROM_LEADER_COHORT_COMPATIBILITY_KEY";
}

export interface LeaderTemporalPerformanceAvailableResult {
  readonly definitionVersion: typeof LEADER_TEMPORAL_PERFORMANCE_DEFINITION_VERSION;
  readonly temporalPerformanceStatus: "AVAILABLE";
  readonly reference: LeaderTemporalPerformanceReference;
  readonly window: LeaderTemporalPerformanceWindow;
  readonly blocks: readonly LeaderTemporalPerformanceBlock[];
  readonly metadata: LeaderTemporalPerformanceMetadata;
  readonly limitations: readonly [
    "DESCRIPTIVE_POINT_ESTIMATES_ONLY",
    "BLOCK_COUNT_IS_A_REPORTING_CONVENTION_NOT_A_STATISTICAL_RULE",
  ];
}

export interface LeaderTemporalPerformanceUnavailableResult {
  readonly definitionVersion: typeof LEADER_TEMPORAL_PERFORMANCE_DEFINITION_VERSION;
  readonly temporalPerformanceStatus: "UNAVAILABLE";
  readonly unavailableReason:
    | LeaderTemporalCoverageUnavailableReason
    | "BLOCK_COUNT_INVARIANT_VIOLATION"
    | "BLOCK_PNL_INVARIANT_VIOLATION";
  readonly reference: LeaderTemporalPerformanceReference;
  readonly window: LeaderTemporalPerformanceWindow;
  readonly blocks: null;
  readonly metadata: LeaderTemporalPerformanceMetadata;
  readonly limitations: readonly [
    LeaderTemporalPerformanceUnavailableResult["unavailableReason"],
  ];
}

export type LeaderTemporalPerformanceDiagnosticsResult =
  | LeaderTemporalPerformanceAvailableResult
  | LeaderTemporalPerformanceUnavailableResult;

function reference(
  historical: VersionedHistoricalEvaluationResult,
): LeaderTemporalPerformanceReference {
  return {
    bucket: { ...historical.bucket },
    historicalEvaluationDefinitionVersion: historical.definitionVersion,
    temporalCoverageDefinitionVersion:
      LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION,
    strategyMetricSemantics: historical.strategyMetricSemantics,
  };
}

function windowReference(
  historical: VersionedHistoricalEvaluationResult,
): LeaderTemporalPerformanceWindow {
  return {
    evaluationWindowStartMs: historical.window.windowStartMs,
    evaluationWindowEndMs: historical.window.windowEndMs,
    evaluationWindowSpanMs:
      historical.window.windowEndMs - historical.window.windowStartMs,
  };
}

function metadata(): LeaderTemporalPerformanceMetadata {
  return {
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
  };
}

function unavailable(
  historical: VersionedHistoricalEvaluationResult,
  unavailableReason: LeaderTemporalPerformanceUnavailableResult["unavailableReason"],
): LeaderTemporalPerformanceUnavailableResult {
  return {
    definitionVersion: LEADER_TEMPORAL_PERFORMANCE_DEFINITION_VERSION,
    temporalPerformanceStatus: "UNAVAILABLE",
    unavailableReason,
    reference: reference(historical),
    window: windowReference(historical),
    blocks: null,
    metadata: metadata(),
    limitations: [unavailableReason],
  };
}

export function evaluateLeaderTemporalPerformanceDiagnostics(
  historical: VersionedHistoricalEvaluationResult,
  reportingConvention: LeaderTemporalPerformanceReportingConvention,
): LeaderTemporalPerformanceDiagnosticsResult {
  const coverage = evaluateLeaderTemporalCoverageDiagnostics(
    historical,
    reportingConvention,
  );
  if (coverage.temporalEvidenceStatus === "UNAVAILABLE") {
    return unavailable(historical, coverage.unavailableReason);
  }

  const associations = associateIncludedRoundTripsWithTiming(historical)!;
  const cyclesByBlock = coverage.distribution.blocks.map(
    () => [] as CompletedFollowerRoundTrip[],
  );
  for (const { roundTrip, timing } of associations) {
    const block = findAlignedTemporalBlock(
      coverage.distribution.blocks,
      timing.openSourceTimestampMs,
    )!;
    cyclesByBlock[block.blockIndex]!.push(roundTrip);
  }

  const strategyMetricDefinitionVersion =
    historical.strategyMetrics.netQuoteExpectancy.definitionVersion;
  const blocks = coverage.distribution.blocks.map((coverageBlock) => {
    const cycles = cyclesByBlock[coverageBlock.blockIndex]!;
    const realizedPnlRawTotal = cycles.reduce(
      (total, cycle) => total + cycle.realizedPnlQuoteRaw,
      0n,
    );
    return {
      ...coverageBlock,
      realizedPnlRawTotal,
      blockConditionalPaperExpectancy: calculateNetQuoteExpectancyMetric(
        realizedPnlRawTotal,
        cycles.length,
        strategyMetricDefinitionVersion,
      ),
    };
  });

  const blockLifecycleCount = blocks.reduce(
    (total, block) => total + block.completedLifecycleCount,
    0,
  );
  const associatedLifecycleCount = cyclesByBlock.reduce(
    (total, cycles) => total + cycles.length,
    0,
  );
  if (
    blockLifecycleCount !== historical.sample.fullyContainedCount ||
    blockLifecycleCount !== historical.includedRoundTrips.length ||
    associatedLifecycleCount !== blockLifecycleCount ||
    blocks.some(
      (block) =>
        block.blockConditionalPaperExpectancy.sampleCount !==
        block.completedLifecycleCount,
    )
  ) {
    return unavailable(historical, "BLOCK_COUNT_INVARIANT_VIOLATION");
  }
  const blockPnlRawTotal = blocks.reduce(
    (total, block) => total + block.realizedPnlRawTotal,
    0n,
  );
  const historicalPnlRawTotal = historical.includedRoundTrips.reduce(
    (total, roundTrip) => total + roundTrip.realizedPnlQuoteRaw,
    0n,
  );
  if (blockPnlRawTotal !== historicalPnlRawTotal) {
    return unavailable(historical, "BLOCK_PNL_INVARIANT_VIOLATION");
  }

  return {
    definitionVersion: LEADER_TEMPORAL_PERFORMANCE_DEFINITION_VERSION,
    temporalPerformanceStatus: "AVAILABLE",
    reference: reference(historical),
    window: windowReference(historical),
    blocks,
    metadata: metadata(),
    limitations: [
      "DESCRIPTIVE_POINT_ESTIMATES_ONLY",
      "BLOCK_COUNT_IS_A_REPORTING_CONVENTION_NOT_A_STATISTICAL_RULE",
    ],
  };
}
