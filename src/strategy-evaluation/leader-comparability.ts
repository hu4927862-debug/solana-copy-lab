import type {
  HistoricalEvaluationAvailability,
  HistoricalEvaluationSampleStatus,
  VersionedHistoricalEvaluationResult,
} from "./historical-evaluation.js";

export type LeaderComparabilityStatus =
  "NOT_COMPARABLE" | "OBSERVATION_ONLY" | "COMPARABLE";

export type LeaderComparabilityReason =
  | "INSUFFICIENT_SAMPLE"
  | "EXPLORATORY_SAMPLE"
  | "LIMITED_EVIDENCE"
  | "CENSORED_LIFECYCLE_EVIDENCE"
  | "NO_EVALUABLE_STRATEGY_DATA"
  | "NO_EVALUABLE_COPYABILITY_DATA";

export interface LeaderComparisonBucket {
  readonly followerWallet: string;
  readonly leaderWallet: string;
  readonly quoteMint: string;
}

export interface LeaderHistoricalReference {
  readonly resolvedDatabasePath: string;
  readonly window: VersionedHistoricalEvaluationResult["window"];
  readonly evaluationContext: VersionedHistoricalEvaluationResult["evaluationContext"];
  readonly observedSchemaMigrations: VersionedHistoricalEvaluationResult["provenance"]["observedSchemaMigrations"];
  readonly historicalEvaluationDefinitionVersion: VersionedHistoricalEvaluationResult["definitionVersion"];
  readonly strategyMetricSemantics: "PAPER_EXPECTANCY";
  readonly strategyMetricDefinitionVersion: string;
  readonly failureTaxonomyDefinitionVersion: string;
  readonly copyabilityDefinitionVersion: string;
  readonly endToEndApplicationDefinitionVersion: string;
}

export interface LeaderComparabilityResult {
  readonly bucket: LeaderComparisonBucket;
  readonly status: LeaderComparabilityStatus;
  readonly reasons: readonly LeaderComparabilityReason[];
  readonly sampleStatus: HistoricalEvaluationSampleStatus;
  readonly availability: HistoricalEvaluationAvailability;
  readonly historicalReference: LeaderHistoricalReference;
}

function copyEvaluationContext(
  context: VersionedHistoricalEvaluationResult["evaluationContext"],
): VersionedHistoricalEvaluationResult["evaluationContext"] {
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

export function evaluateLeaderComparability(
  historical: VersionedHistoricalEvaluationResult,
): LeaderComparabilityResult {
  const reasons: LeaderComparabilityReason[] = [];
  let hasHardExclusion = false;
  let hasObservationOnlyCondition = false;

  if (historical.sample.sampleStatus === "INSUFFICIENT_SAMPLE") {
    reasons.push("INSUFFICIENT_SAMPLE");
    hasHardExclusion = true;
  } else if (historical.sample.sampleStatus === "EXPLORATORY") {
    reasons.push("EXPLORATORY_SAMPLE");
    hasObservationOnlyCondition = true;
  }

  if (historical.availability === "LIMITED") {
    reasons.push("LIMITED_EVIDENCE");
    hasHardExclusion = true;
  }

  if (
    historical.sample.leftCensoredCount !== 0 ||
    historical.sample.rightCensoredCount !== 0 ||
    historical.sample.preWindowOpenCount !== 0 ||
    historical.sample.sourceUnavailableCount !== 0
  ) {
    reasons.push("CENSORED_LIFECYCLE_EVIDENCE");
    hasObservationOnlyCondition = true;
  }

  const expectancy = historical.strategyMetrics.netQuoteExpectancy;
  if (expectancy.status !== "AVAILABLE" || expectancy.value === null) {
    reasons.push("NO_EVALUABLE_STRATEGY_DATA");
    hasHardExclusion = true;
  }

  const endToEnd = historical.copyability.endToEndApplication;
  if (
    endToEnd.status !== "AVAILABLE" ||
    endToEnd.endToEndApplicationCompatibilityRate === null ||
    endToEnd.evaluableCount === 0
  ) {
    reasons.push("NO_EVALUABLE_COPYABILITY_DATA");
    hasHardExclusion = true;
  }

  return {
    bucket: {
      followerWallet: historical.bucket.followerWallet,
      leaderWallet: historical.bucket.leaderWallet,
      quoteMint: historical.bucket.quoteMint,
    },
    status: hasHardExclusion
      ? "NOT_COMPARABLE"
      : hasObservationOnlyCondition
        ? "OBSERVATION_ONLY"
        : "COMPARABLE",
    reasons,
    sampleStatus: historical.sample.sampleStatus,
    availability: historical.availability,
    historicalReference: {
      resolvedDatabasePath: historical.provenance.resolvedDatabasePath,
      window: { ...historical.window },
      evaluationContext: copyEvaluationContext(historical.evaluationContext),
      observedSchemaMigrations:
        historical.provenance.observedSchemaMigrations.map((migration) => ({
          ...migration,
        })),
      historicalEvaluationDefinitionVersion: historical.definitionVersion,
      strategyMetricSemantics: historical.strategyMetricSemantics,
      strategyMetricDefinitionVersion: expectancy.definitionVersion,
      failureTaxonomyDefinitionVersion:
        historical.failureClassification.definitionVersion,
      copyabilityDefinitionVersion: historical.copyability.definitionVersion,
      endToEndApplicationDefinitionVersion: endToEnd.definitionVersion,
    },
  };
}
