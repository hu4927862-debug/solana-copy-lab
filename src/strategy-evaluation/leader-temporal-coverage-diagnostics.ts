import type { VersionedHistoricalEvaluationResult } from "./historical-evaluation.js";
import {
  associateIncludedRoundTripsWithTiming,
  findAlignedTemporalBlock,
} from "./leader-temporal-diagnostics-shared.js";

export const LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION =
  "LEADER_TEMPORAL_COVERAGE_V1" as const;
export const LEADER_TEMPORAL_COVERAGE_MAX_BLOCK_COUNT = 10_000 as const;

export interface LeaderTemporalCoverageReportingConvention {
  readonly blockCount: number;
}

export interface LeaderTemporalCoverageBlock {
  readonly blockIndex: number;
  readonly blockStartMs: number;
  readonly blockEndMs: number;
  readonly completedLifecycleCount: number;
}

export type LeaderTemporalCoverageUnavailableReason =
  | "HISTORICAL_COUNT_INVARIANT_VIOLATION"
  | "TIMING_EVIDENCE_ASSOCIATION_INVARIANT_VIOLATION"
  | "BUCKET_INVARIANT_VIOLATION"
  | "TIMING_EVIDENCE_INVARIANT_VIOLATION"
  | "BLOCK_COUNT_INVARIANT_VIOLATION"
  | "INVALID_HISTORICAL_WINDOW"
  | "INVALID_REPORTING_CONVENTION";

interface LeaderTemporalCoverageReference {
  readonly bucket: VersionedHistoricalEvaluationResult["bucket"];
  readonly historicalEvaluationDefinitionVersion: VersionedHistoricalEvaluationResult["definitionVersion"];
  readonly strategyMetricSemantics: VersionedHistoricalEvaluationResult["strategyMetricSemantics"];
}

interface LeaderTemporalCoverageWindow {
  readonly evaluationWindowStartMs: number;
  readonly evaluationWindowEndMs: number;
  readonly evaluationWindowSpanMs: number;
}

interface LeaderTemporalCoverageMetadata {
  readonly placementReference: "AUTHORITATIVE_OPEN_SOURCE_TIME";
  readonly sampleCondition: "FULLY_CONTAINED_COMPLETED_ROUND_TRIPS_ONLY";
  readonly emptyBlockSemantics: "NO_INCLUDED_LIFECYCLE_OPEN_IN_CALENDAR_INTERVAL";
  readonly blockCountSelection: "EXPLICIT_CALLER_REPORTING_CONVENTION";
  readonly blockCountUpperBound: typeof LEADER_TEMPORAL_COVERAGE_MAX_BLOCK_COUNT;
  readonly blockCountUpperBoundSemantics: "ENGINEERING_RESOURCE_LIMIT_NOT_STATISTICAL_RULE";
}

export interface LeaderTemporalCoverageAvailableResult {
  readonly definitionVersion: typeof LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION;
  readonly temporalEvidenceStatus: "AVAILABLE";
  readonly reference: LeaderTemporalCoverageReference;
  readonly window: LeaderTemporalCoverageWindow;
  readonly coverage: {
    readonly status: "AVAILABLE" | "NO_INCLUDED_LIFECYCLES";
    readonly firstIncludedOpenTimestampMs: number | null;
    readonly lastIncludedCloseTimestampMs: number | null;
    readonly observedLifecycleSpanMs: number | null;
  };
  readonly distribution: {
    readonly convention: "ALIGNED_EQUAL_CALENDAR_TIME_BLOCKS";
    readonly blockCount: number;
    readonly remainderDistribution: "EARLIEST_BLOCKS_RECEIVE_ONE_ADDITIONAL_MILLISECOND";
    readonly blocks: readonly LeaderTemporalCoverageBlock[];
  };
  readonly metadata: LeaderTemporalCoverageMetadata;
  readonly limitations: readonly [
    "DESCRIPTIVE_COVERAGE_AND_ENTRY_DISTRIBUTION_ONLY",
    "BLOCK_COUNT_IS_A_REPORTING_CONVENTION_NOT_A_STATISTICAL_RULE",
  ];
}

export interface LeaderTemporalCoverageUnavailableResult {
  readonly definitionVersion: typeof LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION;
  readonly temporalEvidenceStatus: "UNAVAILABLE";
  readonly unavailableReason: LeaderTemporalCoverageUnavailableReason;
  readonly reference: LeaderTemporalCoverageReference;
  readonly window: LeaderTemporalCoverageWindow;
  readonly coverage: {
    readonly status: "UNAVAILABLE";
    readonly firstIncludedOpenTimestampMs: null;
    readonly lastIncludedCloseTimestampMs: null;
    readonly observedLifecycleSpanMs: null;
  };
  readonly distribution: null;
  readonly metadata: LeaderTemporalCoverageMetadata;
  readonly limitations: readonly [LeaderTemporalCoverageUnavailableReason];
}

export type LeaderTemporalCoverageDiagnosticsResult =
  | LeaderTemporalCoverageAvailableResult
  | LeaderTemporalCoverageUnavailableResult;

function reference(
  historical: VersionedHistoricalEvaluationResult,
): LeaderTemporalCoverageReference {
  return {
    bucket: { ...historical.bucket },
    historicalEvaluationDefinitionVersion: historical.definitionVersion,
    strategyMetricSemantics: historical.strategyMetricSemantics,
  };
}

function windowReference(
  historical: VersionedHistoricalEvaluationResult,
): LeaderTemporalCoverageWindow {
  return {
    evaluationWindowStartMs: historical.window.windowStartMs,
    evaluationWindowEndMs: historical.window.windowEndMs,
    evaluationWindowSpanMs:
      historical.window.windowEndMs - historical.window.windowStartMs,
  };
}

function metadata(): LeaderTemporalCoverageMetadata {
  return {
    placementReference: "AUTHORITATIVE_OPEN_SOURCE_TIME",
    sampleCondition: "FULLY_CONTAINED_COMPLETED_ROUND_TRIPS_ONLY",
    emptyBlockSemantics: "NO_INCLUDED_LIFECYCLE_OPEN_IN_CALENDAR_INTERVAL",
    blockCountSelection: "EXPLICIT_CALLER_REPORTING_CONVENTION",
    blockCountUpperBound: LEADER_TEMPORAL_COVERAGE_MAX_BLOCK_COUNT,
    blockCountUpperBoundSemantics:
      "ENGINEERING_RESOURCE_LIMIT_NOT_STATISTICAL_RULE",
  };
}

function unavailable(
  historical: VersionedHistoricalEvaluationResult,
  unavailableReason: LeaderTemporalCoverageUnavailableReason,
): LeaderTemporalCoverageUnavailableResult {
  return {
    definitionVersion: LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION,
    temporalEvidenceStatus: "UNAVAILABLE",
    unavailableReason,
    reference: reference(historical),
    window: windowReference(historical),
    coverage: {
      status: "UNAVAILABLE",
      firstIncludedOpenTimestampMs: null,
      lastIncludedCloseTimestampMs: null,
      observedLifecycleSpanMs: null,
    },
    distribution: null,
    metadata: metadata(),
    limitations: [unavailableReason],
  };
}

function hasExactBucketIdentity(
  historical: VersionedHistoricalEvaluationResult,
): boolean {
  const isInBucket = (evidence: {
    readonly followerWallet: string;
    readonly leaderWallet: string;
    readonly quoteMint: string;
  }): boolean =>
    evidence.followerWallet === historical.bucket.followerWallet &&
    evidence.leaderWallet === historical.bucket.leaderWallet &&
    evidence.quoteMint === historical.bucket.quoteMint;

  return (
    historical.includedRoundTrips.every(isInBucket) &&
    historical.includedLifecycleSourceTimingEvidence.every(isInBucket)
  );
}

function hasValidAuthoritativeTimingValues(
  historical: VersionedHistoricalEvaluationResult,
): boolean {
  const { windowStartMs, windowEndMs } = historical.window;
  return historical.includedLifecycleSourceTimingEvidence.every(
    ({ openSourceTimestampMs, closeSourceTimestampMs }) =>
      Number.isSafeInteger(openSourceTimestampMs) &&
      Number.isSafeInteger(closeSourceTimestampMs) &&
      openSourceTimestampMs >= windowStartMs &&
      openSourceTimestampMs < windowEndMs &&
      closeSourceTimestampMs >= openSourceTimestampMs &&
      closeSourceTimestampMs < windowEndMs,
  );
}

export function evaluateLeaderTemporalCoverageDiagnostics(
  historical: VersionedHistoricalEvaluationResult,
  reportingConvention: LeaderTemporalCoverageReportingConvention,
): LeaderTemporalCoverageDiagnosticsResult {
  const { windowStartMs, windowEndMs } = historical.window;
  const evaluationWindowSpanMs = windowEndMs - windowStartMs;
  if (
    !Number.isSafeInteger(windowStartMs) ||
    !Number.isSafeInteger(windowEndMs) ||
    !Number.isSafeInteger(evaluationWindowSpanMs) ||
    evaluationWindowSpanMs <= 0
  ) {
    return unavailable(historical, "INVALID_HISTORICAL_WINDOW");
  }
  if (
    !Number.isSafeInteger(reportingConvention.blockCount) ||
    reportingConvention.blockCount <= 0 ||
    reportingConvention.blockCount > LEADER_TEMPORAL_COVERAGE_MAX_BLOCK_COUNT ||
    reportingConvention.blockCount > evaluationWindowSpanMs
  ) {
    return unavailable(historical, "INVALID_REPORTING_CONVENTION");
  }
  if (
    historical.sample.fullyContainedCount !==
    historical.includedRoundTrips.length
  ) {
    return unavailable(historical, "HISTORICAL_COUNT_INVARIANT_VIOLATION");
  }
  if (!hasExactBucketIdentity(historical)) {
    return unavailable(historical, "BUCKET_INVARIANT_VIOLATION");
  }
  if (associateIncludedRoundTripsWithTiming(historical) === null) {
    return unavailable(
      historical,
      "TIMING_EVIDENCE_ASSOCIATION_INVARIANT_VIOLATION",
    );
  }
  if (!hasValidAuthoritativeTimingValues(historical)) {
    return unavailable(historical, "TIMING_EVIDENCE_INVARIANT_VIOLATION");
  }
  const baseBlockSpanMs = Math.floor(
    evaluationWindowSpanMs / reportingConvention.blockCount,
  );
  const remainderMs = evaluationWindowSpanMs % reportingConvention.blockCount;
  const blocks: LeaderTemporalCoverageBlock[] = [];
  let blockStartMs = windowStartMs;

  for (
    let blockIndex = 0;
    blockIndex < reportingConvention.blockCount;
    blockIndex += 1
  ) {
    const blockEndMs =
      blockStartMs + baseBlockSpanMs + (blockIndex < remainderMs ? 1 : 0);
    blocks.push({
      blockIndex,
      blockStartMs,
      blockEndMs,
      completedLifecycleCount: 0,
    });
    blockStartMs = blockEndMs;
  }

  let firstIncludedOpenTimestampMs: number | null = null;
  let lastIncludedCloseTimestampMs: number | null = null;
  for (const evidence of historical.includedLifecycleSourceTimingEvidence) {
    firstIncludedOpenTimestampMs =
      firstIncludedOpenTimestampMs === null
        ? evidence.openSourceTimestampMs
        : Math.min(
            firstIncludedOpenTimestampMs,
            evidence.openSourceTimestampMs,
          );
    lastIncludedCloseTimestampMs =
      lastIncludedCloseTimestampMs === null
        ? evidence.closeSourceTimestampMs
        : Math.max(
            lastIncludedCloseTimestampMs,
            evidence.closeSourceTimestampMs,
          );
    const block = findAlignedTemporalBlock(
      blocks,
      evidence.openSourceTimestampMs,
    );
    if (block !== undefined) {
      (block as { completedLifecycleCount: number }).completedLifecycleCount +=
        1;
    }
  }

  const distributedLifecycleCount = blocks.reduce(
    (total, block) => total + block.completedLifecycleCount,
    0,
  );
  if (
    distributedLifecycleCount !== historical.sample.fullyContainedCount ||
    distributedLifecycleCount !== historical.includedRoundTrips.length
  ) {
    return unavailable(historical, "BLOCK_COUNT_INVARIANT_VIOLATION");
  }

  return {
    definitionVersion: LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION,
    temporalEvidenceStatus: "AVAILABLE",
    reference: reference(historical),
    window: windowReference(historical),
    coverage: {
      status:
        firstIncludedOpenTimestampMs === null
          ? "NO_INCLUDED_LIFECYCLES"
          : "AVAILABLE",
      firstIncludedOpenTimestampMs,
      lastIncludedCloseTimestampMs,
      observedLifecycleSpanMs:
        firstIncludedOpenTimestampMs === null ||
        lastIncludedCloseTimestampMs === null
          ? null
          : lastIncludedCloseTimestampMs - firstIncludedOpenTimestampMs,
    },
    distribution: {
      convention: "ALIGNED_EQUAL_CALENDAR_TIME_BLOCKS",
      blockCount: reportingConvention.blockCount,
      remainderDistribution:
        "EARLIEST_BLOCKS_RECEIVE_ONE_ADDITIONAL_MILLISECOND",
      blocks,
    },
    metadata: metadata(),
    limitations: [
      "DESCRIPTIVE_COVERAGE_AND_ENTRY_DISTRIBUTION_ONLY",
      "BLOCK_COUNT_IS_A_REPORTING_CONVENTION_NOT_A_STATISTICAL_RULE",
    ],
  };
}
