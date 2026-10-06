import {
  calculateBuyCapacityCompatibility,
  calculateCopyabilityAggregate,
  calculateEndToEndApplicationCompatibility,
  calculateJupiterQuoteUsability,
  calculatePositionMappingCompatibility,
  calculatePostQuoteFreshnessCompatibility,
  calculatePriceImpactCompatibility,
  calculateSizeGranularityCompatibility,
  type CopyabilityAggregateResult,
  type CopyabilityBucket,
  type CopyabilityEvaluationContext,
} from "./copyability.js";
import {
  calculateJupiterSuccessRate,
  calculatePaperFillOutcome,
  calculatePostRiskDistribution,
  calculatePriceImpactRejectRate,
  calculateProvider429Rate,
  calculateProvider5xxRate,
  type FollowerScopedJupiterSuccessRateResult,
  type PaperFillOutcomeResult,
  type PostRiskDistributionResult,
  type PriceImpactRejectRateResult,
  type Provider429RateResult,
  type Provider5xxRateResult,
} from "./execution-quality.js";
import {
  calculateStrategyMetrics,
  type StrategyMetrics,
  type StrategyMetricsPolicy,
} from "./metrics.js";
import {
  COST_COMPLETENESS_DEFINITION_VERSION,
  evaluateCompletedRoundTripCostCompleteness,
  type CompletedRoundTripCostCompletenessResult,
  type CostCompletenessReason,
} from "./cost-completeness.js";
import {
  classifyOpportunityFailure,
  isTerminalOpportunityFailure,
  projectPostQuoteFreshnessOutcome,
  type FailureClassification,
  type FailureTaxonomyPolicy,
  type OpportunityFailureCategory,
} from "./failure-taxonomy.js";
import type {
  BucketScopedStrategyEvaluationReadLimitation,
  RoundTripApplicationSourceEvidence,
  StrategyEvaluationEvidenceSnapshot,
  StrategyEvaluationSnapshotProvenance,
} from "./read-model.js";
import {
  FOLLOWER_ROUND_TRIPS_DEFINITION_VERSION,
  matchFollowerRoundTrips,
  matchFollowerRoundTripsDetailed,
  type CompletedFollowerRoundTrip,
  type DetailedFollowerFillApplicationEvidence,
  type FollowerFillApplicationEvidence,
  type FollowerRoundTripDetailedResult,
  type FollowerRoundTripUnevaluableLimitation,
  type IncompleteFollowerRoundTrip,
} from "./round-trips.js";

export type HistoricalEvaluationSampleStatus =
  "INSUFFICIENT_SAMPLE" | "EXPLORATORY" | "PROVISIONAL";

export interface HistoricalEvaluationSample {
  readonly fullyContainedCount: number;
  readonly leftCensoredCount: number;
  readonly rightCensoredCount: number;
  readonly preWindowOpenCount: number;
  readonly sourceUnavailableCount: number;
  readonly sampleStatus: HistoricalEvaluationSampleStatus;
}

export interface HistoricalSourceUnavailableLimitation {
  readonly reason: "SOURCE_UNAVAILABLE";
  readonly lifecycleStatus: "COMPLETED" | "INCOMPLETE";
  readonly openFillId: string;
  readonly requiredFillIds: readonly string[];
  readonly unavailableFillIds: readonly string[];
}

export type HistoricalEvaluationLimitation =
  | BucketScopedStrategyEvaluationReadLimitation
  | HistoricalSourceUnavailableLimitation;

export interface HistoricalLifecycleUnevaluableLimitation {
  readonly kind: "LIFECYCLE_UNEVALUABLE";
  readonly source: typeof FOLLOWER_ROUND_TRIPS_DEFINITION_VERSION;
  readonly scope: FollowerRoundTripUnevaluableLimitation["scope"];
  readonly reason: FollowerRoundTripUnevaluableLimitation["reason"];
  readonly stage: FollowerRoundTripUnevaluableLimitation["stage"];
  readonly lifecycleIdentity: {
    readonly followerWallet: string;
    readonly leaderWallet: string;
    readonly tokenMint: string;
    readonly quoteMint: string;
  };
  readonly openFillId: string | null;
  readonly affectedFillIds: readonly string[];
  readonly evidence: readonly {
    readonly field: string;
    readonly expected: string;
    readonly observed: string;
  }[];
}

export type HistoricalEvaluationV2Limitation =
  HistoricalEvaluationLimitation | HistoricalLifecycleUnevaluableLimitation;

export type HistoricalEvaluationAvailability = "AVAILABLE" | "LIMITED";

export interface HistoricalEvaluationV2EvidenceSnapshot extends Omit<
  StrategyEvaluationEvidenceSnapshot,
  "roundTripApplications"
> {
  readonly roundTripApplications: readonly DetailedFollowerFillApplicationEvidence[];
}

export interface HistoricalIncludedLifecycleSourceTimingEvidence {
  readonly followerWallet: string;
  readonly leaderWallet: string;
  readonly tokenMint: string;
  readonly quoteMint: string;
  readonly openFillId: string;
  readonly closeFillId: string;
  readonly openSourceTimestampMs: number;
  readonly closeSourceTimestampMs: number;
}

export interface HistoricalEvaluationResult {
  readonly definitionVersion: "HISTORICAL_EVALUATION_V1";
  readonly bucket: CopyabilityBucket;
  readonly window: {
    readonly windowStartMs: number;
    readonly windowEndMs: number;
  };
  readonly evaluationContext: CopyabilityEvaluationContext;
  readonly provenance: StrategyEvaluationSnapshotProvenance;
  readonly availability: HistoricalEvaluationAvailability;
  readonly sample: HistoricalEvaluationSample;
  readonly includedRoundTrips: readonly CompletedFollowerRoundTrip[];
  readonly includedLifecycleSourceTimingEvidence: readonly HistoricalIncludedLifecycleSourceTimingEvidence[];
  readonly strategyMetricSemantics: "PAPER_EXPECTANCY";
  readonly strategyMetrics: StrategyMetrics;
  readonly executionQuality: HistoricalExecutionQualityResult;
  readonly failureClassification: HistoricalFailureClassificationResult;
  readonly copyability: CopyabilityAggregateResult;
  readonly limitations: readonly HistoricalEvaluationLimitation[];
}

export interface HistoricalEvaluationV2Result extends Omit<
  HistoricalEvaluationResult,
  "definitionVersion" | "limitations"
> {
  readonly definitionVersion: "HISTORICAL_EVALUATION_V2";
  readonly roundTripDefinitionVersion: typeof FOLLOWER_ROUND_TRIPS_DEFINITION_VERSION;
  readonly limitations: readonly HistoricalEvaluationV2Limitation[];
}

export const HISTORICAL_EVALUATION_V3_DEFINITION_VERSION =
  "HISTORICAL_EVALUATION_V3" as const;

export interface HistoricalCostCompletenessResult {
  readonly definitionVersion: typeof COST_COMPLETENESS_DEFINITION_VERSION;
  readonly status:
    "COST_COMPLETE" | "COST_INCOMPLETE" | "NO_EVALUABLE_LIFECYCLES";
  readonly evaluatedLifecycleCount: number;
  readonly completeLifecycleCount: number;
  readonly incompleteLifecycleCount: number;
  readonly lifecycleResults: readonly CompletedRoundTripCostCompletenessResult[];
  readonly reasons: readonly CostCompletenessReason[];
}

export interface HistoricalEvaluationV3Result extends Omit<
  HistoricalEvaluationV2Result,
  "definitionVersion"
> {
  readonly definitionVersion: typeof HISTORICAL_EVALUATION_V3_DEFINITION_VERSION;
  readonly costCompleteness: HistoricalCostCompletenessResult;
}

export type VersionedHistoricalEvaluationResult =
  | HistoricalEvaluationResult
  | HistoricalEvaluationV2Result
  | HistoricalEvaluationV3Result;

export interface HistoricalExecutionQualityResult {
  readonly jupiterSuccess: FollowerScopedJupiterSuccessRateResult;
  readonly providerHttp: {
    readonly provider429: Provider429RateResult;
    readonly provider5xx: Provider5xxRateResult;
  };
  readonly postRiskDistribution: PostRiskDistributionResult;
  readonly priceImpactReject: PriceImpactRejectRateResult;
  readonly paperFillOutcome: PaperFillOutcomeResult;
}

export interface HistoricalClassifiedOpportunity {
  readonly executionKey: string;
  readonly classification: FailureClassification;
}

export type HistoricalFailureCategoryCounts = Readonly<
  Record<OpportunityFailureCategory, number>
>;

export interface HistoricalFailureClassificationSummary {
  readonly totalCanonicalOpportunityCount: number;
  readonly terminalFailureCount: number;
  readonly categoryCounts: HistoricalFailureCategoryCounts;
  readonly paperApplicationSuccessCount: number;
  readonly intermediateNotAFailureCount: number;
  readonly dataLimitationCount: number;
  readonly policyExclusionCount: number;
  readonly unavailableCount: number;
}

export interface HistoricalFailureClassificationResult {
  readonly definitionVersion: string;
  readonly classifiedOpportunities: readonly HistoricalClassifiedOpportunity[];
  readonly summary: HistoricalFailureClassificationSummary;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInBucket(
  evidence: Pick<
    FollowerFillApplicationEvidence,
    "followerWallet" | "leaderWallet" | "quoteMint"
  >,
  bucket: CopyabilityBucket,
): boolean {
  return (
    evidence.followerWallet === bucket.followerWallet &&
    evidence.leaderWallet === bucket.leaderWallet &&
    evidence.quoteMint === bucket.quoteMint
  );
}

function isCostEvidenceInBucket(
  fill: HistoricalEvaluationV2EvidenceSnapshot["paperFills"][number],
  bucket: CopyabilityBucket,
): boolean {
  const quoteMint = fill.side === "BUY" ? fill.inputMint : fill.outputMint;
  return (
    fill.followerWallet === bucket.followerWallet &&
    fill.leaderWallet === bucket.leaderWallet &&
    quoteMint === bucket.quoteMint
  );
}

function compareApplications(
  left: FollowerFillApplicationEvidence,
  right: FollowerFillApplicationEvidence,
): number {
  return (
    compareText(left.tokenMint, right.tokenMint) ||
    left.positionVersionAfter - right.positionVersionAfter ||
    left.quoteTimestampMs - right.quoteTimestampMs ||
    compareText(left.fillId, right.fillId)
  );
}

function authoritativeSourceTime(
  sourcesByFillId: ReadonlyMap<
    string,
    readonly RoundTripApplicationSourceEvidence[]
  >,
  fillId: string,
): number | undefined {
  const matches = sourcesByFillId.get(fillId);
  if (matches?.length !== 1) return undefined;
  const source = matches[0]!.sourceTimestamp;
  if (
    source.valueMs === null ||
    !Number.isSafeInteger(source.valueMs) ||
    source.provenance !== "CHAIN_BLOCK_TIME" ||
    (source.precision !== "MILLISECOND" && source.precision !== "SECOND")
  ) {
    return undefined;
  }
  return source.valueMs;
}

function sampleStatus(count: number): HistoricalEvaluationSampleStatus {
  if (count < 10) return "INSUFFICIENT_SAMPLE";
  if (count < 30) return "EXPLORATORY";
  return "PROVISIONAL";
}

function copyEvaluationContext(
  context: CopyabilityEvaluationContext,
): CopyabilityEvaluationContext {
  return {
    window: { ...context.window },
    source: context.source,
    mode: context.mode,
    copyRatioBps: context.copyRatioBps,
    riskPolicyVersion: context.riskPolicyVersion,
    fillPolicyVersion: context.fillPolicyVersion,
    accountingPolicyVersion: context.accountingPolicyVersion,
    copyabilityDefinitionVersion: context.copyabilityDefinitionVersion,
  };
}

function copyProvenance(
  provenance: StrategyEvaluationSnapshotProvenance,
): StrategyEvaluationSnapshotProvenance {
  return {
    resolvedDatabasePath: provenance.resolvedDatabasePath,
    observedSchemaMigrations: provenance.observedSchemaMigrations
      .map((migration) => ({ ...migration }))
      .sort(
        (left, right) =>
          compareText(left.version, right.version) ||
          compareText(left.checksum, right.checksum),
      ),
    requestedWindow: { ...provenance.requestedWindow },
    expectedContext: copyEvaluationContext(provenance.expectedContext),
    ...(provenance.shadowPaperEvidenceBinding === undefined
      ? {}
      : {
          shadowPaperEvidenceBinding: {
            ...provenance.shadowPaperEvidenceBinding,
          },
        }),
  };
}

interface HistoricalLifecycleReplay {
  readonly completed: readonly CompletedFollowerRoundTrip[];
  readonly incomplete: readonly IncompleteFollowerRoundTrip[];
}

function projectLifecycleLimitation(
  limitation: FollowerRoundTripUnevaluableLimitation,
): HistoricalLifecycleUnevaluableLimitation {
  return {
    kind: "LIFECYCLE_UNEVALUABLE",
    source: FOLLOWER_ROUND_TRIPS_DEFINITION_VERSION,
    scope: limitation.scope,
    reason: limitation.reason,
    stage: limitation.stage,
    lifecycleIdentity: { ...limitation.lifecycleIdentity },
    openFillId: limitation.openFillId,
    affectedFillIds: [...limitation.affectedFillIds],
    evidence: limitation.evidence.map((item) => ({ ...item })),
  };
}

function compareLifecycleLimitations(
  left: HistoricalLifecycleUnevaluableLimitation,
  right: HistoricalLifecycleUnevaluableLimitation,
): number {
  return (
    compareText(
      left.lifecycleIdentity.followerWallet,
      right.lifecycleIdentity.followerWallet,
    ) ||
    compareText(
      left.lifecycleIdentity.leaderWallet,
      right.lifecycleIdentity.leaderWallet,
    ) ||
    compareText(
      left.lifecycleIdentity.tokenMint,
      right.lifecycleIdentity.tokenMint,
    ) ||
    compareText(
      left.lifecycleIdentity.quoteMint,
      right.lifecycleIdentity.quoteMint,
    ) ||
    compareText(left.openFillId ?? "", right.openFillId ?? "") ||
    compareText(left.stage, right.stage) ||
    compareText(left.reason, right.reason) ||
    compareText(
      left.affectedFillIds.join("\u0000"),
      right.affectedFillIds.join("\u0000"),
    )
  );
}

function isLifecycleLimitationRelevantToWindow(
  limitation: HistoricalLifecycleUnevaluableLimitation,
  sourcesByFillId: ReadonlyMap<
    string,
    readonly RoundTripApplicationSourceEvidence[]
  >,
  window: StrategyEvaluationSnapshotProvenance["requestedWindow"],
): boolean {
  const sourceTimes = limitation.affectedFillIds.map((fillId) =>
    authoritativeSourceTime(sourcesByFillId, fillId),
  );
  if (sourceTimes.some((sourceTime) => sourceTime === undefined)) return true;
  return sourceTimes.some(
    (sourceTime) =>
      sourceTime! >= window.windowStartMs && sourceTime! < window.windowEndMs,
  );
}

function evaluateHistoricalEvaluationFromReplay(
  snapshot: StrategyEvaluationEvidenceSnapshot,
  bucket: CopyabilityBucket,
  strategyMetricsPolicy: StrategyMetricsPolicy,
  failureTaxonomyPolicy: FailureTaxonomyPolicy,
  lifecycles: HistoricalLifecycleReplay,
  lifecycleLimitations: readonly HistoricalLifecycleUnevaluableLimitation[],
): Omit<HistoricalEvaluationResult, "definitionVersion" | "limitations"> & {
  readonly limitations: readonly HistoricalEvaluationV2Limitation[];
} {
  const window = snapshot.provenance.requestedWindow;

  const sourcesByFillId = new Map<
    string,
    RoundTripApplicationSourceEvidence[]
  >();
  for (const source of snapshot.roundTripApplicationSources) {
    const sources = sourcesByFillId.get(source.fillId) ?? [];
    sources.push(source);
    sourcesByFillId.set(source.fillId, sources);
  }

  const included: Array<{
    readonly cycle: CompletedFollowerRoundTrip;
    readonly openSourceTimeMs: number;
    readonly closeSourceTimeMs: number;
  }> = [];
  const sourceLimitations: HistoricalSourceUnavailableLimitation[] = [];
  let leftCensoredCount = 0;
  let rightCensoredCount = 0;
  let preWindowOpenCount = 0;

  for (const cycle of lifecycles.completed) {
    const openSourceTimeMs = authoritativeSourceTime(
      sourcesByFillId,
      cycle.openFillId,
    );
    const closeSourceTimeMs = authoritativeSourceTime(
      sourcesByFillId,
      cycle.closeFillId,
    );
    const unavailableFillIds: string[] = [
      ...(openSourceTimeMs === undefined ? [cycle.openFillId] : []),
      ...(closeSourceTimeMs === undefined ? [cycle.closeFillId] : []),
    ];
    if (openSourceTimeMs === undefined || closeSourceTimeMs === undefined) {
      sourceLimitations.push({
        reason: "SOURCE_UNAVAILABLE",
        lifecycleStatus: "COMPLETED",
        openFillId: cycle.openFillId,
        requiredFillIds: [cycle.openFillId, cycle.closeFillId],
        unavailableFillIds,
      });
      continue;
    }
    if (
      openSourceTimeMs >= window.windowStartMs &&
      openSourceTimeMs < window.windowEndMs &&
      closeSourceTimeMs < window.windowEndMs
    ) {
      included.push({
        cycle,
        openSourceTimeMs,
        closeSourceTimeMs,
      });
    } else if (
      openSourceTimeMs < window.windowStartMs &&
      closeSourceTimeMs >= window.windowStartMs &&
      closeSourceTimeMs < window.windowEndMs
    ) {
      leftCensoredCount += 1;
    } else if (
      openSourceTimeMs >= window.windowStartMs &&
      openSourceTimeMs < window.windowEndMs &&
      closeSourceTimeMs >= window.windowEndMs
    ) {
      rightCensoredCount += 1;
    }
  }

  for (const lifecycle of lifecycles.incomplete) {
    const openSourceTimeMs = authoritativeSourceTime(
      sourcesByFillId,
      lifecycle.openFillId,
    );
    const latestSourceTimeMs = authoritativeSourceTime(
      sourcesByFillId,
      lifecycle.latestFillId,
    );
    const unavailableFillIds: string[] = [
      ...(openSourceTimeMs === undefined ? [lifecycle.openFillId] : []),
      ...(latestSourceTimeMs === undefined &&
      lifecycle.latestFillId !== lifecycle.openFillId
        ? [lifecycle.latestFillId]
        : []),
    ];
    if (openSourceTimeMs === undefined || latestSourceTimeMs === undefined) {
      sourceLimitations.push({
        reason: "SOURCE_UNAVAILABLE",
        lifecycleStatus: "INCOMPLETE",
        openFillId: lifecycle.openFillId,
        requiredFillIds: [
          ...new Set([lifecycle.openFillId, lifecycle.latestFillId]),
        ],
        unavailableFillIds,
      });
      continue;
    }
    if (openSourceTimeMs < window.windowStartMs) {
      preWindowOpenCount += 1;
    } else if (
      openSourceTimeMs < window.windowEndMs &&
      lifecycle.remainingQuantityRaw > 0n
    ) {
      rightCensoredCount += 1;
    }
  }

  included.sort(
    (left, right) =>
      left.openSourceTimeMs - right.openSourceTimeMs ||
      compareText(left.cycle.openFillId, right.cycle.openFillId) ||
      left.closeSourceTimeMs - right.closeSourceTimeMs ||
      compareText(left.cycle.closeFillId, right.cycle.closeFillId),
  );
  sourceLimitations.sort(
    (left, right) =>
      compareText(left.openFillId, right.openFillId) ||
      compareText(left.lifecycleStatus, right.lifecycleStatus),
  );
  const contextLimitations = snapshot.contextLimitations
    .filter(
      (
        limitation,
      ): limitation is BucketScopedStrategyEvaluationReadLimitation =>
        "executionKey" in limitation && isInBucket(limitation, bucket),
    )
    .slice()
    .sort(
      (left, right) =>
        compareText(left.executionKey, right.executionKey) ||
        compareText(left.reason, right.reason),
    )
    .map((limitation) => ({ ...limitation }));
  const includedRoundTrips = included.map(({ cycle }) => cycle);
  const includedLifecycleSourceTimingEvidence = included.map(
    ({ cycle, openSourceTimeMs, closeSourceTimeMs }) => ({
      followerWallet: cycle.followerWallet,
      leaderWallet: cycle.leaderWallet,
      tokenMint: cycle.tokenMint,
      quoteMint: cycle.quoteMint,
      openFillId: cycle.openFillId,
      closeFillId: cycle.closeFillId,
      openSourceTimestampMs: openSourceTimeMs,
      closeSourceTimestampMs: closeSourceTimeMs,
    }),
  );
  const relevantLifecycleLimitations = lifecycleLimitations.filter(
    (limitation) =>
      isLifecycleLimitationRelevantToWindow(
        limitation,
        sourcesByFillId,
        window,
      ),
  );
  const limitations = [
    ...contextLimitations,
    ...sourceLimitations,
    ...relevantLifecycleLimitations,
  ];
  const jupiterAttempts = snapshot.jupiterAttempts.filter((attempt) =>
    isInBucket(attempt, bucket),
  );
  const riskDecisions = snapshot.riskDecisions.filter((decision) =>
    isInBucket(decision, bucket),
  );
  const bucketExecutionKeys = new Set(
    snapshot.opportunities
      .filter((opportunity) => isInBucket(opportunity, bucket))
      .map(({ executionKey }) => executionKey),
  );
  const paperFills = snapshot.paperFills.filter(({ intentId }) =>
    bucketExecutionKeys.has(intentId),
  );
  const paperFillIds = new Set(paperFills.map(({ id }) => id));
  const paperFillApplications = snapshot.paperFillApplications.filter(
    ({ fillId }) => paperFillIds.has(fillId),
  );
  const canonicalOpportunities = snapshot.opportunities
    .filter((opportunity) => isInBucket(opportunity, bucket))
    .slice()
    .sort((left, right) => compareText(left.executionKey, right.executionKey));
  const seenExecutionKeys = new Set<string>();
  for (const opportunity of canonicalOpportunities) {
    if (seenExecutionKeys.has(opportunity.executionKey)) {
      throw new Error(
        `DUPLICATE_CANONICAL_OPPORTUNITY:${opportunity.executionKey}`,
      );
    }
    seenExecutionKeys.add(opportunity.executionKey);
  }
  const classifiedOpportunities = canonicalOpportunities.map(
    ({ executionKey, normalizedEvidence }) => ({
      executionKey,
      classification: classifyOpportunityFailure(
        normalizedEvidence,
        failureTaxonomyPolicy,
      ),
    }),
  );
  const classifiedCopyabilityOpportunities = canonicalOpportunities.map(
    (opportunity, index) => ({
      ...bucket,
      executionKey: opportunity.executionKey,
      side: opportunity.side,
      failureClassification: classifiedOpportunities[index]!.classification,
    }),
  );
  const sizingOpportunities = classifiedCopyabilityOpportunities.map(
    (opportunity, index) => ({
      ...opportunity,
      ...(canonicalOpportunities[index]!.preRiskSizingEvidence === undefined
        ? {}
        : {
            preRiskSizingEvidence:
              canonicalOpportunities[index]!.preRiskSizingEvidence,
          }),
    }),
  );
  const postQuoteFreshnessProjections = canonicalOpportunities.flatMap(
    (opportunity) =>
      (opportunity.normalizedEvidence.riskDecisions ?? [])
        .filter((decision) => decision.phase === "POST_QUOTE")
        .map((decision) => ({
          ...bucket,
          executionKey: opportunity.executionKey,
          outcome: projectPostQuoteFreshnessOutcome(decision),
        })),
  );
  const categoryCounts: Record<OpportunityFailureCategory, number> = {
    EXECUTION_FAILURE: 0,
    MARKET_FAILURE: 0,
    RISK_REJECTION: 0,
    COPYABILITY_FAILURE: 0,
    DATA_LIMITATION: 0,
    POLICY_EXCLUSION: 0,
  };
  let terminalFailureCount = 0;
  let paperApplicationSuccessCount = 0;
  let intermediateNotAFailureCount = 0;
  let unavailableCount = 0;
  for (const { classification } of classifiedOpportunities) {
    if (
      classification.classificationStatus === "CLASSIFIED" &&
      classification.primaryCategory !== null
    ) {
      categoryCounts[classification.primaryCategory] += 1;
    }
    if (isTerminalOpportunityFailure(classification)) {
      terminalFailureCount += 1;
    } else if (classification.classificationStatus === "UNAVAILABLE") {
      unavailableCount += 1;
    } else if (classification.classificationStatus === "NOT_A_FAILURE") {
      if (classification.stage === "PAPER_APPLICATION") {
        paperApplicationSuccessCount += 1;
      } else {
        intermediateNotAFailureCount += 1;
      }
    }
  }
  const executionQuality: HistoricalExecutionQualityResult = {
    jupiterSuccess: calculateJupiterSuccessRate(bucket, jupiterAttempts),
    providerHttp: {
      provider429: calculateProvider429Rate(bucket, jupiterAttempts),
      provider5xx: calculateProvider5xxRate(bucket, jupiterAttempts),
    },
    postRiskDistribution: calculatePostRiskDistribution(bucket, riskDecisions),
    priceImpactReject: calculatePriceImpactRejectRate(bucket, riskDecisions),
    paperFillOutcome: calculatePaperFillOutcome(
      bucket,
      paperFills,
      paperFillApplications,
    ),
  };
  const evaluationContext = copyEvaluationContext(
    snapshot.provenance.expectedContext,
  );
  const copyabilityComponents = {
    positionMapping: calculatePositionMappingCompatibility(
      bucket,
      classifiedCopyabilityOpportunities,
      evaluationContext,
    ),
    sizeGranularity: calculateSizeGranularityCompatibility(
      bucket,
      sizingOpportunities,
      evaluationContext,
    ),
    buyCapacity: calculateBuyCapacityCompatibility(
      bucket,
      sizingOpportunities,
      evaluationContext,
    ),
    jupiterQuoteUsability: calculateJupiterQuoteUsability(
      bucket,
      executionQuality.jupiterSuccess,
      evaluationContext,
    ),
    postQuoteFreshness: calculatePostQuoteFreshnessCompatibility(
      bucket,
      postQuoteFreshnessProjections,
      evaluationContext,
    ),
    priceImpact: calculatePriceImpactCompatibility(
      bucket,
      {
        postRiskDistribution: executionQuality.postRiskDistribution,
        priceImpactRejectRate: executionQuality.priceImpactReject,
      },
      evaluationContext,
    ),
    endToEndApplication: calculateEndToEndApplicationCompatibility(
      bucket,
      classifiedCopyabilityOpportunities,
      evaluationContext,
    ),
  };

  return {
    bucket: { ...bucket },
    window: { ...window },
    evaluationContext,
    provenance: copyProvenance(snapshot.provenance),
    availability: limitations.length === 0 ? "AVAILABLE" : "LIMITED",
    sample: {
      fullyContainedCount: includedRoundTrips.length,
      leftCensoredCount,
      rightCensoredCount,
      preWindowOpenCount,
      sourceUnavailableCount: sourceLimitations.length,
      sampleStatus: sampleStatus(includedRoundTrips.length),
    },
    includedRoundTrips,
    includedLifecycleSourceTimingEvidence,
    strategyMetricSemantics: "PAPER_EXPECTANCY",
    strategyMetrics: calculateStrategyMetrics(
      includedRoundTrips,
      strategyMetricsPolicy,
    ),
    executionQuality,
    failureClassification: {
      definitionVersion: failureTaxonomyPolicy.definitionVersion,
      classifiedOpportunities,
      summary: {
        totalCanonicalOpportunityCount: classifiedOpportunities.length,
        terminalFailureCount,
        categoryCounts,
        paperApplicationSuccessCount,
        intermediateNotAFailureCount,
        dataLimitationCount: categoryCounts.DATA_LIMITATION,
        policyExclusionCount: categoryCounts.POLICY_EXCLUSION,
        unavailableCount,
      },
    },
    copyability: calculateCopyabilityAggregate(
      bucket,
      copyabilityComponents,
      evaluationContext,
    ),
    limitations,
  };
}

export function evaluateHistoricalEvaluation(
  snapshot: StrategyEvaluationEvidenceSnapshot,
  bucket: CopyabilityBucket,
  strategyMetricsPolicy: StrategyMetricsPolicy,
  failureTaxonomyPolicy: FailureTaxonomyPolicy,
): HistoricalEvaluationResult {
  const bucketApplications = snapshot.roundTripApplications
    .filter((application) => isInBucket(application, bucket))
    .slice()
    .sort(compareApplications);
  const result = evaluateHistoricalEvaluationFromReplay(
    snapshot,
    bucket,
    strategyMetricsPolicy,
    failureTaxonomyPolicy,
    matchFollowerRoundTrips(bucketApplications),
    [],
  );
  return {
    definitionVersion: "HISTORICAL_EVALUATION_V1",
    ...result,
    limitations:
      result.limitations as readonly HistoricalEvaluationLimitation[],
  };
}

export function evaluateHistoricalEvaluationV2(
  snapshot: HistoricalEvaluationV2EvidenceSnapshot,
  bucket: CopyabilityBucket,
  strategyMetricsPolicy: StrategyMetricsPolicy,
  failureTaxonomyPolicy: FailureTaxonomyPolicy,
): HistoricalEvaluationV2Result {
  const replayApplications = snapshot.roundTripApplications
    .slice()
    .sort(compareApplications);
  const detailed: FollowerRoundTripDetailedResult =
    matchFollowerRoundTripsDetailed(replayApplications);
  const bucketLifecycles: HistoricalLifecycleReplay = {
    completed: detailed.completed.filter((cycle) => isInBucket(cycle, bucket)),
    incomplete: detailed.incomplete.filter((lifecycle) =>
      isInBucket(lifecycle, bucket),
    ),
  };
  const result = evaluateHistoricalEvaluationFromReplay(
    snapshot,
    bucket,
    strategyMetricsPolicy,
    failureTaxonomyPolicy,
    bucketLifecycles,
    detailed.limitations
      .filter((limitation) => isInBucket(limitation.lifecycleIdentity, bucket))
      .map(projectLifecycleLimitation)
      .sort(compareLifecycleLimitations),
  );
  return {
    definitionVersion: "HISTORICAL_EVALUATION_V2",
    roundTripDefinitionVersion: detailed.definitionVersion,
    ...result,
  };
}

function evaluateHistoricalCostCompleteness(
  includedRoundTrips: readonly CompletedFollowerRoundTrip[],
  fillEvidence: HistoricalEvaluationV2EvidenceSnapshot["paperFills"],
  expectedLifecycleCount: number,
): HistoricalCostCompletenessResult {
  const lifecycleResults = includedRoundTrips.map((cycle) => {
    const result = evaluateCompletedRoundTripCostCompleteness(
      cycle,
      fillEvidence,
    );
    return {
      definitionVersion: result.definitionVersion,
      status: result.status,
      reasons: [...result.reasons],
      reference: {
        ...result.reference,
        fillIds: [...result.reference.fillIds],
      },
    };
  });
  if (lifecycleResults.length !== expectedLifecycleCount) {
    throw new Error("COST_COMPLETENESS_POPULATION_MISMATCH");
  }
  const completeLifecycleCount = lifecycleResults.filter(
    ({ status }) => status === "COST_COMPLETE",
  ).length;
  const incompleteLifecycleCount =
    lifecycleResults.length - completeLifecycleCount;
  const reasons = [
    ...new Set(lifecycleResults.flatMap(({ reasons }) => reasons)),
  ].sort(compareText);

  return {
    definitionVersion: COST_COMPLETENESS_DEFINITION_VERSION,
    status:
      lifecycleResults.length === 0
        ? "NO_EVALUABLE_LIFECYCLES"
        : incompleteLifecycleCount === 0
          ? "COST_COMPLETE"
          : "COST_INCOMPLETE",
    evaluatedLifecycleCount: lifecycleResults.length,
    completeLifecycleCount,
    incompleteLifecycleCount,
    lifecycleResults,
    reasons,
  };
}

export function evaluateHistoricalEvaluationV3(
  snapshot: HistoricalEvaluationV2EvidenceSnapshot,
  bucket: CopyabilityBucket,
  strategyMetricsPolicy: StrategyMetricsPolicy,
  failureTaxonomyPolicy: FailureTaxonomyPolicy,
): HistoricalEvaluationV3Result {
  const v2 = evaluateHistoricalEvaluationV2(
    snapshot,
    bucket,
    strategyMetricsPolicy,
    failureTaxonomyPolicy,
  );
  const { definitionVersion: _v2DefinitionVersion, ...v2Semantics } = v2;
  return {
    definitionVersion: HISTORICAL_EVALUATION_V3_DEFINITION_VERSION,
    ...v2Semantics,
    costCompleteness: evaluateHistoricalCostCompleteness(
      v2.includedRoundTrips,
      snapshot.paperFills.filter((fill) =>
        isCostEvidenceInBucket(fill, bucket),
      ),
      v2.sample.fullyContainedCount,
    ),
  };
}
