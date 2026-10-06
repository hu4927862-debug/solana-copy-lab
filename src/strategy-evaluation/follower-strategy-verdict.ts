import { createHash } from "node:crypto";
import type { HistoricalEvaluationV3Result } from "./historical-evaluation.js";
import type { LeaderComparabilityResult } from "./leader-comparability.js";
import type { LeaderCohortCompatibilityResult } from "./leader-cohort-compatibility.js";
import type { LeaderReliabilityDiagnosticsV2Result } from "./leader-reliability-diagnostics.js";

export const APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_VERSION =
  "FOLLOWER_STRATEGY_VERDICT_POLICY_V1" as const;
export const APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_SHA256 =
  "sha256:ad40550c95655c73939ee6496ea4221b2345500f813aaf72b2624d78dbda3805" as const;

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export interface VerifiedFollowerStrategyVerdictPolicy {
  readonly policyVersion: typeof APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_VERSION;
  readonly policySha256: typeof APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_SHA256;
  readonly minimumFullyContainedCompletedCycles: 30;
  readonly content: CanonicalJsonValue;
}

export type FollowerStrategyVerdictValue =
  "POSITIVE_CANDIDATE" | "NEGATIVE_EXPECTANCY" | "INSUFFICIENT_EVIDENCE";

export type FollowerStrategyVerdictReasonCode =
  | "ARTIFACT_INTEGRITY_FAILURE"
  | "DEFINITION_VERSION_MISMATCH"
  | "PROVENANCE_MISMATCH"
  | "CONTEXT_MISMATCH"
  | "WINDOW_MISMATCH"
  | "CONFLICTING_CANDIDATE"
  | "LIMITED_EVIDENCE"
  | "PARTIAL_REQUIRED_EVIDENCE"
  | "REQUIRED_BLOCKING_EVIDENCE_UNAVAILABLE"
  | "VERDICT_SAMPLE_BELOW_MINIMUM"
  | "CENSORED_LIFECYCLE_EVIDENCE"
  | "COHORT_DEFINITION_MISMATCH"
  | "COHORT_PROVENANCE_MISMATCH"
  | "COST_EVIDENCE_BLOCKING"
  | "COST_INCOMPLETE_DIRECTION_NOT_PRESERVED"
  | "EXECUTION_DENOMINATOR_INCONSISTENT"
  | "FAILURE_TAXONOMY_INCONSISTENT"
  | "RELIABILITY_EVIDENCE_INSUFFICIENT"
  | "METRIC_CONSISTENCY_CONFLICT"
  | "FOLLOWER_PAPER_EXPECTANCY_ZERO"
  | "FOLLOWER_PAPER_EXPECTANCY_NEGATIVE_COSTS_INCOMPLETE_MONOTONE"
  | "FOLLOWER_PAPER_EXPECTANCY_NEGATIVE"
  | "FOLLOWER_PAPER_EXPECTANCY_POSITIVE_CANDIDATE";

export interface MonotonicMissingCostProof {
  readonly evidenceId: string;
  readonly nonNegativeCost: true;
  readonly cannotIncreaseReturn: true;
  readonly cannotAlterQuantity: true;
  readonly cannotAlterLifecycleIdentity: true;
  readonly cannotAlterDenominator: true;
  readonly cannotAlterFillPriceOrDirection: true;
  readonly noPossibleMissingRevenueOrRebate: true;
}

interface VerdictMetricEvidence {
  readonly status: string;
  readonly value: string | null;
  readonly unit: string;
  readonly sampleCount: number;
}

export interface FollowerStrategyVerdictEvidence {
  readonly artifactIntegrity: "VALID" | "INVALID";
  readonly provenanceConsistency: "CONSISTENT" | "MISMATCH";
  readonly requiredEvidenceCompleteness: "COMPLETE" | "PARTIAL";
  readonly requiredBlockingUnavailableEvidence: readonly string[];
  readonly definitionVersions: {
    readonly report: string;
    readonly historicalEvaluation: string;
    readonly followerLifecycle: string;
    readonly strategyMetrics: string;
    readonly costCompleteness: string;
    readonly cohortCompatibility: string;
    readonly reliability: string;
    readonly temporalCoverage: string;
    readonly temporalPerformance: string;
    readonly failureTaxonomy: string;
    readonly fillPolicy: string;
    readonly accountingPolicy: string;
    readonly followerOpportunityCopyability: string;
  };
  readonly mode: string;
  readonly metricSemantics: string;
  readonly historicalAvailability: "AVAILABLE" | "LIMITED";
  readonly sample: {
    readonly fullyContainedCount: number;
    readonly includedLifecycleCount: number;
    readonly leftCensoredCount: number;
    readonly rightCensoredCount: number;
    readonly preWindowOpenCount: number;
    readonly sourceUnavailableCount: number;
  };
  readonly cohort: {
    readonly status: "COMPATIBLE" | "INCOMPATIBLE";
    readonly reasonCode:
      | "CONFLICTING_CANDIDATE"
      | "WINDOW_MISMATCH"
      | "CONTEXT_MISMATCH"
      | "COHORT_DEFINITION_MISMATCH"
      | "COHORT_PROVENANCE_MISMATCH"
      | null;
  };
  readonly cost: {
    readonly status:
      "COST_COMPLETE" | "COST_INCOMPLETE" | "NO_EVALUABLE_LIFECYCLES";
    readonly evaluatedLifecycleCount: number;
    readonly completeLifecycleCount: number;
    readonly incompleteLifecycleCount: number;
    readonly monotonicMissingCostProofs: readonly MonotonicMissingCostProof[];
  };
  readonly executionDenominators: "CONSISTENT" | "INCONSISTENT";
  readonly failureTaxonomy: {
    readonly status: "CONSISTENT" | "INCONSISTENT";
    readonly dataLimitationCount: number;
    readonly unavailableCount: number;
    readonly endToEndDataLimitationCount: number;
    readonly endToEndUnavailableCount: number;
  };
  readonly reliabilityBindings: "CONSISTENT" | "INCONSISTENT";
  readonly metrics: {
    readonly expectancy: VerdictMetricEvidence;
    readonly profitFactor: VerdictMetricEvidence & {
      readonly grossProfitRaw: string;
      readonly grossLossRaw: string;
    };
    readonly winRate: VerdictMetricEvidence & {
      readonly wins: number;
      readonly losses: number;
      readonly breakevens: number;
    };
    readonly realizedPnlDrawdown: VerdictMetricEvidence;
  };
  readonly nonBlockingLimitations: readonly string[];
}

export interface FollowerStrategyVerdict {
  readonly status: "AVAILABLE";
  readonly value: FollowerStrategyVerdictValue;
  readonly reasonCode: FollowerStrategyVerdictReasonCode;
  readonly limitations: readonly string[];
  readonly policyVersion: typeof APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_VERSION;
  readonly policySha256: typeof APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_SHA256;
}

function canonicalJsonValue(value: unknown): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("POLICY_IDENTITY_MISMATCH");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalJsonValue(item));
  }
  if (typeof value === "object") {
    const result: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new Error("POLICY_IDENTITY_MISMATCH");
      result[key] = canonicalJsonValue(item);
    }
    return result;
  }
  throw new Error("POLICY_IDENTITY_MISMATCH");
}

function canonicalBytes(value: unknown): string {
  return `${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`;
}

const REQUIRED_DEFINITION_VERSIONS = {
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
} as const;

function divideToCanonicalDecimal(
  numerator: bigint,
  denominator: bigint,
): string {
  const negative = numerator < 0n;
  const absoluteNumerator = negative ? -numerator : numerator;
  const integerPart = absoluteNumerator / denominator;
  let remainder = absoluteNumerator % denominator;
  if (remainder === 0n) {
    return `${negative ? "-" : ""}${integerPart}`;
  }
  let fractionalPart = "";
  for (let digit = 0; digit < 18 && remainder !== 0n; digit += 1) {
    remainder *= 10n;
    fractionalPart += (remainder / denominator).toString();
    remainder %= denominator;
  }
  fractionalPart = fractionalPart.replace(/0+$/, "");
  const sign =
    negative && (integerPart !== 0n || fractionalPart !== "") ? "-" : "";
  return fractionalPart === ""
    ? `${sign}${integerPart}`
    : `${sign}${integerPart}.${fractionalPart}`;
}

function parseNonNegativeInteger(value: string): bigint | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  return BigInt(value);
}

function expectancySign(value: string | null): -1 | 0 | 1 | null {
  if (
    value === null ||
    value === "-0" ||
    !/^-?(0|[1-9]\d*)(\.\d*[1-9])?$/.test(value)
  ) {
    return null;
  }
  if (value === "0") return 0;
  return value.startsWith("-") ? -1 : 1;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasRequiredDefinitionVersions(
  evidence: FollowerStrategyVerdictEvidence,
): boolean {
  return Object.entries(REQUIRED_DEFINITION_VERSIONS).every(
    ([key, expected]) =>
      evidence.definitionVersions[
        key as keyof FollowerStrategyVerdictEvidence["definitionVersions"]
      ] === expected,
  );
}

function hasProvenMonotonicMissingCosts(
  evidence: FollowerStrategyVerdictEvidence,
): boolean {
  const { incompleteLifecycleCount, monotonicMissingCostProofs } =
    evidence.cost;
  if (
    incompleteLifecycleCount <= 0 ||
    monotonicMissingCostProofs.length !== incompleteLifecycleCount
  ) {
    return false;
  }
  const evidenceIds = new Set<string>();
  for (const proof of monotonicMissingCostProofs) {
    if (
      proof.evidenceId.trim() === "" ||
      evidenceIds.has(proof.evidenceId) ||
      proof.nonNegativeCost !== true ||
      proof.cannotIncreaseReturn !== true ||
      proof.cannotAlterQuantity !== true ||
      proof.cannotAlterLifecycleIdentity !== true ||
      proof.cannotAlterDenominator !== true ||
      proof.cannotAlterFillPriceOrDirection !== true ||
      proof.noPossibleMissingRevenueOrRebate !== true
    ) {
      return false;
    }
    evidenceIds.add(proof.evidenceId);
  }
  return true;
}

function hasConsistentMetrics(
  evidence: FollowerStrategyVerdictEvidence,
): boolean {
  const sampleCount = evidence.sample.fullyContainedCount;
  const { expectancy, profitFactor, winRate, realizedPnlDrawdown } =
    evidence.metrics;
  if (
    sampleCount <= 0 ||
    evidence.sample.includedLifecycleCount !== sampleCount ||
    expectancy.status !== "AVAILABLE" ||
    expectancy.unit !== "QUOTE_RAW_PER_COMPLETED_CYCLE" ||
    expectancy.sampleCount !== sampleCount ||
    profitFactor.sampleCount !== sampleCount ||
    profitFactor.unit !== "RATIO" ||
    winRate.status !== "AVAILABLE" ||
    winRate.sampleCount !== sampleCount ||
    winRate.unit !== "RATIO" ||
    realizedPnlDrawdown.status !== "AVAILABLE" ||
    realizedPnlDrawdown.sampleCount !== sampleCount ||
    realizedPnlDrawdown.unit !== "RAW_QUOTE" ||
    !isNonNegativeSafeInteger(winRate.wins) ||
    !isNonNegativeSafeInteger(winRate.losses) ||
    !isNonNegativeSafeInteger(winRate.breakevens) ||
    winRate.wins + winRate.losses + winRate.breakevens !== sampleCount
  ) {
    return false;
  }
  const grossProfitRaw = parseNonNegativeInteger(profitFactor.grossProfitRaw);
  const grossLossRaw = parseNonNegativeInteger(profitFactor.grossLossRaw);
  const drawdownRaw =
    realizedPnlDrawdown.value === null
      ? null
      : parseNonNegativeInteger(realizedPnlDrawdown.value);
  if (
    grossProfitRaw === null ||
    grossLossRaw === null ||
    drawdownRaw === null
  ) {
    return false;
  }
  const totalRealizedPnlRaw = grossProfitRaw - grossLossRaw;
  if (
    expectancy.value !==
      divideToCanonicalDecimal(totalRealizedPnlRaw, BigInt(sampleCount)) ||
    winRate.value !==
      divideToCanonicalDecimal(BigInt(winRate.wins), BigInt(sampleCount))
  ) {
    return false;
  }
  if (grossLossRaw > 0n) {
    return (
      profitFactor.status === "AVAILABLE" &&
      profitFactor.value ===
        divideToCanonicalDecimal(grossProfitRaw, grossLossRaw)
    );
  }
  if (grossProfitRaw > 0n) {
    return profitFactor.status === "NO_LOSSES" && profitFactor.value === null;
  }
  return (
    profitFactor.status === "NO_REALIZED_RESULT" && profitFactor.value === null
  );
}

export function verifyFollowerStrategyVerdictPolicy(
  policyJson: string,
): VerifiedFollowerStrategyVerdictPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(policyJson) as unknown;
  } catch {
    throw new Error("POLICY_IDENTITY_MISMATCH");
  }
  const bytes = canonicalBytes(parsed);
  const policySha256 = `sha256:${createHash("sha256")
    .update(bytes)
    .digest("hex")}`;
  if (
    policyJson !== bytes ||
    policySha256 !== APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_SHA256 ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("POLICY_IDENTITY_MISMATCH");
  }
  const object = parsed as Record<string, unknown>;
  if (
    object.policyVersion !==
      APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_VERSION ||
    object.minimumFullyContainedCompletedCycles !== 30
  ) {
    throw new Error("POLICY_IDENTITY_MISMATCH");
  }
  return {
    policyVersion: APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_VERSION,
    policySha256: APPROVED_FOLLOWER_STRATEGY_VERDICT_POLICY_SHA256,
    minimumFullyContainedCompletedCycles: 30,
    content: canonicalJsonValue(parsed),
  };
}

function sameBucket(
  left: { followerWallet: string; leaderWallet: string; quoteMint: string },
  right: { followerWallet: string; leaderWallet: string; quoteMint: string },
): boolean {
  return (
    left.followerWallet === right.followerWallet &&
    left.leaderWallet === right.leaderWallet &&
    left.quoteMint === right.quoteMint
  );
}

function sameWindow(
  left: { windowStartMs: number; windowEndMs: number },
  right: { windowStartMs: number; windowEndMs: number },
): boolean {
  return (
    left.windowStartMs === right.windowStartMs &&
    left.windowEndMs === right.windowEndMs
  );
}

function exactRate(numerator: number, denominator: number): string | null {
  return denominator === 0
    ? null
    : divideToCanonicalDecimal(BigInt(numerator), BigInt(denominator));
}

function executionDenominatorsAreConsistent(
  historical: HistoricalEvaluationV3Result,
): boolean {
  const {
    jupiterSuccess,
    providerHttp,
    postRiskDistribution,
    priceImpactReject,
    paperFillOutcome,
  } = historical.executionQuality;
  const endToEnd = historical.copyability.endToEndApplication;
  return (
    jupiterSuccess.status === "AVAILABLE" &&
    jupiterSuccess.attemptCount > 0 &&
    isNonNegativeSafeInteger(jupiterSuccess.attemptCount) &&
    isNonNegativeSafeInteger(jupiterSuccess.successCount) &&
    jupiterSuccess.successCount <= jupiterSuccess.attemptCount &&
    jupiterSuccess.successRate ===
      exactRate(jupiterSuccess.successCount, jupiterSuccess.attemptCount) &&
    providerHttp.provider429.status === "AVAILABLE" &&
    providerHttp.provider429.attemptCount === jupiterSuccess.attemptCount &&
    isNonNegativeSafeInteger(providerHttp.provider429.provider429Count) &&
    providerHttp.provider429.provider429Count <= jupiterSuccess.attemptCount &&
    providerHttp.provider429.provider429Rate ===
      exactRate(
        providerHttp.provider429.provider429Count,
        jupiterSuccess.attemptCount,
      ) &&
    providerHttp.provider5xx.status === "AVAILABLE" &&
    providerHttp.provider5xx.attemptCount === jupiterSuccess.attemptCount &&
    isNonNegativeSafeInteger(providerHttp.provider5xx.provider5xxCount) &&
    providerHttp.provider5xx.provider5xxCount <= jupiterSuccess.attemptCount &&
    providerHttp.provider5xx.provider5xxRate ===
      exactRate(
        providerHttp.provider5xx.provider5xxCount,
        jupiterSuccess.attemptCount,
      ) &&
    postRiskDistribution.status === "AVAILABLE" &&
    postRiskDistribution.postRiskDecisionCount > 0 &&
    isNonNegativeSafeInteger(postRiskDistribution.postRiskDecisionCount) &&
    isNonNegativeSafeInteger(postRiskDistribution.postRiskAllowCount) &&
    isNonNegativeSafeInteger(postRiskDistribution.postRiskResizeCount) &&
    isNonNegativeSafeInteger(postRiskDistribution.postRiskRejectCount) &&
    isNonNegativeSafeInteger(postRiskDistribution.postRiskHaltCount) &&
    postRiskDistribution.postRiskAllowCount +
      postRiskDistribution.postRiskResizeCount +
      postRiskDistribution.postRiskRejectCount +
      postRiskDistribution.postRiskHaltCount ===
      postRiskDistribution.postRiskDecisionCount &&
    postRiskDistribution.allowRate ===
      exactRate(
        postRiskDistribution.postRiskAllowCount,
        postRiskDistribution.postRiskDecisionCount,
      ) &&
    postRiskDistribution.resizeRate ===
      exactRate(
        postRiskDistribution.postRiskResizeCount,
        postRiskDistribution.postRiskDecisionCount,
      ) &&
    postRiskDistribution.rejectRate ===
      exactRate(
        postRiskDistribution.postRiskRejectCount,
        postRiskDistribution.postRiskDecisionCount,
      ) &&
    postRiskDistribution.haltRate ===
      exactRate(
        postRiskDistribution.postRiskHaltCount,
        postRiskDistribution.postRiskDecisionCount,
      ) &&
    priceImpactReject.status === "AVAILABLE" &&
    priceImpactReject.postRiskDecisionCount ===
      postRiskDistribution.postRiskDecisionCount &&
    isNonNegativeSafeInteger(priceImpactReject.priceImpactRejectCount) &&
    priceImpactReject.priceImpactRejectCount <=
      postRiskDistribution.postRiskRejectCount &&
    priceImpactReject.priceImpactRejectRate ===
      exactRate(
        priceImpactReject.priceImpactRejectCount,
        priceImpactReject.postRiskDecisionCount,
      ) &&
    paperFillOutcome.status === "AVAILABLE" &&
    paperFillOutcome.paperFillCount > 0 &&
    isNonNegativeSafeInteger(paperFillOutcome.paperFillCount) &&
    isNonNegativeSafeInteger(paperFillOutcome.paperFillApplicationCount) &&
    paperFillOutcome.paperFillApplicationCount <=
      paperFillOutcome.paperFillCount &&
    paperFillOutcome.paperFillApplicationRate ===
      exactRate(
        paperFillOutcome.paperFillApplicationCount,
        paperFillOutcome.paperFillCount,
      ) &&
    endToEnd.status === "AVAILABLE" &&
    endToEnd.evaluableCount > 0 &&
    isNonNegativeSafeInteger(endToEnd.preconditionCount) &&
    isNonNegativeSafeInteger(endToEnd.evaluableCount) &&
    isNonNegativeSafeInteger(endToEnd.applicationSuccessCount) &&
    isNonNegativeSafeInteger(endToEnd.terminalFailureCount) &&
    isNonNegativeSafeInteger(endToEnd.dataLimitationCount) &&
    isNonNegativeSafeInteger(endToEnd.unavailableCount) &&
    endToEnd.evaluableCount === endToEnd.endToEndOpportunityCount &&
    endToEnd.applicationSuccessCount + endToEnd.terminalFailureCount ===
      endToEnd.endToEndOpportunityCount &&
    endToEnd.preconditionCount ===
      endToEnd.evaluableCount +
        endToEnd.dataLimitationCount +
        endToEnd.unavailableCount &&
    endToEnd.endToEndApplicationCompatibilityRate ===
      exactRate(
        endToEnd.applicationSuccessCount,
        endToEnd.endToEndOpportunityCount,
      ) &&
    endToEnd.coverageRate ===
      exactRate(endToEnd.evaluableCount, endToEnd.preconditionCount)
  );
}

function failureTaxonomyIsConsistent(
  historical: HistoricalEvaluationV3Result,
): boolean {
  const { classifiedOpportunities, summary } = historical.failureClassification;
  const categories = summary.categoryCounts;
  const categoryTotal = Object.values(categories).reduce(
    (total, count) => total + count,
    0,
  );
  return (
    classifiedOpportunities.length === summary.totalCanonicalOpportunityCount &&
    Object.values(categories).every(isNonNegativeSafeInteger) &&
    summary.terminalFailureCount ===
      categories.EXECUTION_FAILURE +
        categories.MARKET_FAILURE +
        categories.RISK_REJECTION +
        categories.COPYABILITY_FAILURE &&
    summary.dataLimitationCount === categories.DATA_LIMITATION &&
    summary.policyExclusionCount === categories.POLICY_EXCLUSION &&
    categoryTotal +
      summary.paperApplicationSuccessCount +
      summary.intermediateNotAFailureCount +
      summary.unavailableCount ===
      summary.totalCanonicalOpportunityCount
  );
}

function reliabilityBindingsAreConsistent(
  historical: HistoricalEvaluationV3Result,
  reliability: LeaderReliabilityDiagnosticsV2Result,
): boolean {
  return (
    sameBucket(historical.bucket, reliability.historicalReference.bucket) &&
    sameWindow(historical.window, reliability.historicalReference.window) &&
    reliability.historicalReference.historicalEvaluationDefinitionVersion ===
      historical.definitionVersion &&
    reliability.historicalReference.strategyMetricSemantics ===
      historical.strategyMetricSemantics &&
    reliability.sampleDepth.fullyContainedCount ===
      historical.sample.fullyContainedCount &&
    reliability.sampleDepth.sampleStatus === historical.sample.sampleStatus &&
    reliability.censoring.leftCensoredCount ===
      historical.sample.leftCensoredCount &&
    reliability.censoring.rightCensoredCount ===
      historical.sample.rightCensoredCount &&
    reliability.censoring.preWindowOpenCount ===
      historical.sample.preWindowOpenCount &&
    reliability.censoring.sourceUnavailableCount ===
      historical.sample.sourceUnavailableCount &&
    JSON.stringify(reliability.conditionalExpectancy.pointEstimate) ===
      JSON.stringify(historical.strategyMetrics.netQuoteExpectancy) &&
    reliability.opportunityRealizationContext
      .failureClassificationDefinitionVersion ===
      historical.failureClassification.definitionVersion &&
    reliability.opportunityRealizationContext
      .endToEndApplicationDefinitionVersion ===
      historical.copyability.endToEndApplication.definitionVersion
  );
}

function cohortReason(
  historical: HistoricalEvaluationV3Result,
  comparability: LeaderComparabilityResult,
  cohortDiagnostics: LeaderCohortCompatibilityResult,
): FollowerStrategyVerdictEvidence["cohort"] {
  const cohort = cohortDiagnostics.cohorts.find(
    (candidate) =>
      candidate.cohort.followerWallet === historical.bucket.followerWallet &&
      candidate.cohort.quoteMint === historical.bucket.quoteMint,
  );
  if (cohort === undefined) {
    return { status: "INCOMPATIBLE", reasonCode: "COHORT_DEFINITION_MISMATCH" };
  }
  if (
    cohort.candidateConflicts.some((conflict) =>
      sameBucket(conflict.candidate, historical.bucket),
    )
  ) {
    return { status: "INCOMPATIBLE", reasonCode: "CONFLICTING_CANDIDATE" };
  }
  const exclusion = cohort.compatibilityExclusions.find((candidate) =>
    sameBucket(candidate.member.bucket, historical.bucket),
  );
  if (exclusion !== undefined) {
    const reason = exclusion.reasons[0]?.reason;
    return {
      status: "INCOMPATIBLE",
      reasonCode:
        reason === "WINDOW_MISMATCH"
          ? "WINDOW_MISMATCH"
          : reason === "CONTEXT_MISMATCH"
            ? "CONTEXT_MISMATCH"
            : reason === "PROVENANCE_MISMATCH"
              ? "COHORT_PROVENANCE_MISMATCH"
              : "COHORT_DEFINITION_MISMATCH",
    };
  }
  const grouped = cohort.compatibilityGroups.some((group) =>
    group.members.some(
      (member) =>
        member.status === "COMPARABLE" &&
        sameBucket(member.bucket, historical.bucket),
    ),
  );
  return grouped && comparability.status === "COMPARABLE"
    ? { status: "COMPATIBLE", reasonCode: null }
    : { status: "INCOMPATIBLE", reasonCode: "COHORT_DEFINITION_MISMATCH" };
}

export function projectFollowerStrategyVerdictEvidence(
  reportSchemaVersion: string,
  historical: HistoricalEvaluationV3Result,
  comparability: LeaderComparabilityResult,
  cohortDiagnostics: LeaderCohortCompatibilityResult,
  reliability: LeaderReliabilityDiagnosticsV2Result,
): FollowerStrategyVerdictEvidence {
  const metrics = historical.strategyMetrics;
  const metricDefinitionVersions = [
    metrics.netQuoteExpectancy,
    metrics.winRate,
    metrics.profitFactor,
    metrics.realizedPnlDrawdown,
    metrics.holdingTime,
    metrics.bestTradeContribution,
    metrics.bestTokenContribution,
  ].map(({ definitionVersion }) => definitionVersion);
  const executionConsistent = executionDenominatorsAreConsistent(historical);
  const failureConsistent = failureTaxonomyIsConsistent(historical);
  const reliabilityConsistent = reliabilityBindingsAreConsistent(
    historical,
    reliability,
  );
  const requiredUnavailable = new Set<string>();
  if (
    metrics.netQuoteExpectancy.status !== "AVAILABLE" ||
    metrics.netQuoteExpectancy.value === null
  ) {
    requiredUnavailable.add("FOLLOWER_EXPECTANCY");
  }
  if (
    metrics.winRate.status !== "AVAILABLE" ||
    metrics.realizedPnlDrawdown.status !== "AVAILABLE" ||
    metrics.profitFactor.status === "NO_TRADES"
  ) {
    requiredUnavailable.add("ECONOMIC_METRIC_CONSISTENCY");
  }
  if (historical.costCompleteness.status === "NO_EVALUABLE_LIFECYCLES") {
    requiredUnavailable.add("FOLLOWER_COST_DIRECTION");
  }
  if (!executionConsistent && historical.sample.fullyContainedCount === 0) {
    requiredUnavailable.add("REQUIRED_EXECUTION_DENOMINATORS");
  }
  const endToEnd = historical.copyability.endToEndApplication;
  const summary = historical.failureClassification.summary;
  const provenanceConsistent =
    sameBucket(historical.bucket, comparability.bucket) &&
    sameWindow(historical.window, comparability.historicalReference.window) &&
    sameBucket(historical.bucket, reliability.historicalReference.bucket) &&
    comparability.historicalReference.historicalEvaluationDefinitionVersion ===
      historical.definitionVersion &&
    JSON.stringify(comparability.historicalReference.evaluationContext) ===
      JSON.stringify(historical.evaluationContext);
  const limitations = new Set<string>([
    "LEADER_ECONOMIC_EVIDENCE_UNAVAILABLE",
    "STATISTICAL_RELIABILITY_NOT_ESTABLISHED",
    ...reliability.limitations,
    "TRADE_DOMINANCE_PARTIAL",
    "TEMPORAL_STABILITY_NOT_ESTABLISHED",
    "NO_INDEPENDENT_DIAGNOSTIC_RATE_THRESHOLD",
  ]);
  if (
    reliability.temporalEvidenceStatus === "UNAVAILABLE" ||
    reliability.temporalCoverage.temporalEvidenceStatus === "UNAVAILABLE" ||
    reliability.temporalPerformance.temporalPerformanceStatus === "UNAVAILABLE"
  ) {
    limitations.add("OPTIONAL_DIAGNOSTIC_UNAVAILABLE");
  }
  return {
    artifactIntegrity:
      reportSchemaVersion === "DETERMINISTIC_EVIDENCE_REPORT_V1"
        ? "VALID"
        : "INVALID",
    provenanceConsistency: provenanceConsistent ? "CONSISTENT" : "MISMATCH",
    requiredEvidenceCompleteness: "COMPLETE",
    requiredBlockingUnavailableEvidence: [...requiredUnavailable].sort(),
    definitionVersions: {
      report: reportSchemaVersion,
      historicalEvaluation: historical.definitionVersion,
      followerLifecycle: historical.roundTripDefinitionVersion,
      strategyMetrics: metricDefinitionVersions.every(
        (version) => version === metricDefinitionVersions[0],
      )
        ? metricDefinitionVersions[0]!
        : "MISMATCH",
      costCompleteness: historical.costCompleteness.definitionVersion,
      cohortCompatibility: cohortDiagnostics.definitionVersion,
      reliability: reliability.definitionVersion,
      temporalCoverage: reliability.temporalCoverage.definitionVersion,
      temporalPerformance: reliability.temporalPerformance.definitionVersion,
      failureTaxonomy: historical.failureClassification.definitionVersion,
      fillPolicy: historical.evaluationContext.fillPolicyVersion,
      accountingPolicy: historical.evaluationContext.accountingPolicyVersion,
      followerOpportunityCopyability:
        historical.evaluationContext.copyabilityDefinitionVersion,
    },
    mode: historical.evaluationContext.mode,
    metricSemantics: historical.strategyMetricSemantics,
    historicalAvailability: historical.availability,
    sample: {
      fullyContainedCount: historical.sample.fullyContainedCount,
      includedLifecycleCount: historical.includedRoundTrips.length,
      leftCensoredCount: historical.sample.leftCensoredCount,
      rightCensoredCount: historical.sample.rightCensoredCount,
      preWindowOpenCount: historical.sample.preWindowOpenCount,
      sourceUnavailableCount: historical.sample.sourceUnavailableCount,
    },
    cohort: cohortReason(historical, comparability, cohortDiagnostics),
    cost: {
      status: historical.costCompleteness.status,
      evaluatedLifecycleCount:
        historical.costCompleteness.evaluatedLifecycleCount,
      completeLifecycleCount:
        historical.costCompleteness.completeLifecycleCount,
      incompleteLifecycleCount:
        historical.costCompleteness.incompleteLifecycleCount,
      monotonicMissingCostProofs: [],
    },
    executionDenominators: executionConsistent ? "CONSISTENT" : "INCONSISTENT",
    failureTaxonomy: {
      status: failureConsistent ? "CONSISTENT" : "INCONSISTENT",
      dataLimitationCount: summary.dataLimitationCount,
      unavailableCount: summary.unavailableCount,
      endToEndDataLimitationCount: endToEnd.dataLimitationCount,
      endToEndUnavailableCount: endToEnd.unavailableCount,
    },
    reliabilityBindings: reliabilityConsistent ? "CONSISTENT" : "INCONSISTENT",
    metrics: {
      expectancy: {
        status: metrics.netQuoteExpectancy.status,
        value: metrics.netQuoteExpectancy.value,
        unit: metrics.netQuoteExpectancy.unit,
        sampleCount: metrics.netQuoteExpectancy.sampleCount,
      },
      profitFactor: {
        status: metrics.profitFactor.status,
        value: metrics.profitFactor.value,
        unit: metrics.profitFactor.unit,
        sampleCount: metrics.profitFactor.sampleCount,
        grossProfitRaw: metrics.profitFactor.grossProfitRaw,
        grossLossRaw: metrics.profitFactor.grossLossRaw,
      },
      winRate: {
        status: metrics.winRate.status,
        value: metrics.winRate.value,
        unit: metrics.winRate.unit,
        sampleCount: metrics.winRate.sampleCount,
        wins: metrics.winRate.wins,
        losses: metrics.winRate.losses,
        breakevens: metrics.winRate.breakevens,
      },
      realizedPnlDrawdown: {
        status: metrics.realizedPnlDrawdown.status,
        value: metrics.realizedPnlDrawdown.value,
        unit: metrics.realizedPnlDrawdown.unit,
        sampleCount: metrics.realizedPnlDrawdown.sampleCount,
      },
    },
    nonBlockingLimitations: [...limitations].sort(),
  };
}

export function evaluateFollowerStrategyVerdict(
  evidence: FollowerStrategyVerdictEvidence,
  policyJson: string,
): FollowerStrategyVerdict {
  const policy = verifyFollowerStrategyVerdictPolicy(policyJson);
  const limitations = [...new Set(evidence.nonBlockingLimitations)].sort();
  const issue = (
    value: FollowerStrategyVerdictValue,
    reasonCode: FollowerStrategyVerdictReasonCode,
  ): FollowerStrategyVerdict => ({
    status: "AVAILABLE",
    value,
    reasonCode,
    limitations,
    policyVersion: policy.policyVersion,
    policySha256: policy.policySha256,
  });

  if (evidence.artifactIntegrity !== "VALID") {
    return issue("INSUFFICIENT_EVIDENCE", "ARTIFACT_INTEGRITY_FAILURE");
  }
  if (!hasRequiredDefinitionVersions(evidence)) {
    return issue("INSUFFICIENT_EVIDENCE", "DEFINITION_VERSION_MISMATCH");
  }
  if (evidence.provenanceConsistency !== "CONSISTENT") {
    return issue("INSUFFICIENT_EVIDENCE", "PROVENANCE_MISMATCH");
  }
  if (
    evidence.mode !== "PAPER" ||
    evidence.metricSemantics !== "PAPER_EXPECTANCY"
  ) {
    return issue("INSUFFICIENT_EVIDENCE", "CONTEXT_MISMATCH");
  }
  if (evidence.cohort.reasonCode === "CONTEXT_MISMATCH") {
    return issue("INSUFFICIENT_EVIDENCE", "CONTEXT_MISMATCH");
  }
  if (evidence.cohort.reasonCode === "WINDOW_MISMATCH") {
    return issue("INSUFFICIENT_EVIDENCE", "WINDOW_MISMATCH");
  }
  if (evidence.cohort.reasonCode === "CONFLICTING_CANDIDATE") {
    return issue("INSUFFICIENT_EVIDENCE", "CONFLICTING_CANDIDATE");
  }
  if (evidence.historicalAvailability !== "AVAILABLE") {
    return issue("INSUFFICIENT_EVIDENCE", "LIMITED_EVIDENCE");
  }
  if (evidence.requiredEvidenceCompleteness !== "COMPLETE") {
    return issue("INSUFFICIENT_EVIDENCE", "PARTIAL_REQUIRED_EVIDENCE");
  }
  if (evidence.requiredBlockingUnavailableEvidence.length !== 0) {
    return issue(
      "INSUFFICIENT_EVIDENCE",
      "REQUIRED_BLOCKING_EVIDENCE_UNAVAILABLE",
    );
  }
  if (
    evidence.sample.fullyContainedCount <
    policy.minimumFullyContainedCompletedCycles
  ) {
    return issue("INSUFFICIENT_EVIDENCE", "VERDICT_SAMPLE_BELOW_MINIMUM");
  }
  if (
    evidence.sample.leftCensoredCount !== 0 ||
    evidence.sample.rightCensoredCount !== 0 ||
    evidence.sample.preWindowOpenCount !== 0 ||
    evidence.sample.sourceUnavailableCount !== 0
  ) {
    return issue("INSUFFICIENT_EVIDENCE", "CENSORED_LIFECYCLE_EVIDENCE");
  }
  if (evidence.cohort.status !== "COMPATIBLE") {
    return issue(
      "INSUFFICIENT_EVIDENCE",
      evidence.cohort.reasonCode ?? "COHORT_DEFINITION_MISMATCH",
    );
  }
  const sign = expectancySign(evidence.metrics.expectancy.value);
  const costPopulationConsistent =
    evidence.cost.evaluatedLifecycleCount ===
      evidence.sample.fullyContainedCount &&
    evidence.cost.completeLifecycleCount +
      evidence.cost.incompleteLifecycleCount ===
      evidence.cost.evaluatedLifecycleCount;
  const completeCosts =
    costPopulationConsistent &&
    evidence.cost.status === "COST_COMPLETE" &&
    evidence.cost.completeLifecycleCount ===
      evidence.cost.evaluatedLifecycleCount &&
    evidence.cost.incompleteLifecycleCount === 0;
  const monotonicIncompleteCosts =
    costPopulationConsistent &&
    evidence.cost.status === "COST_INCOMPLETE" &&
    hasProvenMonotonicMissingCosts(evidence);
  if (!completeCosts && !monotonicIncompleteCosts) {
    return issue("INSUFFICIENT_EVIDENCE", "COST_EVIDENCE_BLOCKING");
  }
  if (monotonicIncompleteCosts && (sign === 0 || sign === 1)) {
    return issue(
      "INSUFFICIENT_EVIDENCE",
      "COST_INCOMPLETE_DIRECTION_NOT_PRESERVED",
    );
  }
  if (evidence.executionDenominators !== "CONSISTENT") {
    return issue("INSUFFICIENT_EVIDENCE", "EXECUTION_DENOMINATOR_INCONSISTENT");
  }
  if (
    evidence.failureTaxonomy.status !== "CONSISTENT" ||
    evidence.failureTaxonomy.dataLimitationCount !== 0 ||
    evidence.failureTaxonomy.unavailableCount !== 0 ||
    evidence.failureTaxonomy.endToEndDataLimitationCount !== 0 ||
    evidence.failureTaxonomy.endToEndUnavailableCount !== 0
  ) {
    return issue("INSUFFICIENT_EVIDENCE", "FAILURE_TAXONOMY_INCONSISTENT");
  }
  if (evidence.reliabilityBindings !== "CONSISTENT") {
    return issue("INSUFFICIENT_EVIDENCE", "RELIABILITY_EVIDENCE_INSUFFICIENT");
  }
  if (sign === null || !hasConsistentMetrics(evidence)) {
    return issue("INSUFFICIENT_EVIDENCE", "METRIC_CONSISTENCY_CONFLICT");
  }
  if (sign === 0) {
    return issue("INSUFFICIENT_EVIDENCE", "FOLLOWER_PAPER_EXPECTANCY_ZERO");
  }
  if (sign < 0) {
    if (monotonicIncompleteCosts) {
      return {
        ...issue(
          "NEGATIVE_EXPECTANCY",
          "FOLLOWER_PAPER_EXPECTANCY_NEGATIVE_COSTS_INCOMPLETE_MONOTONE",
        ),
        limitations: [
          ...new Set([
            ...limitations,
            "NEGATIVE_EXPECTANCY_MONOTONIC_MISSING_COSTS",
          ]),
        ].sort(),
      };
    }
    return issue("NEGATIVE_EXPECTANCY", "FOLLOWER_PAPER_EXPECTANCY_NEGATIVE");
  }
  return issue(
    "POSITIVE_CANDIDATE",
    "FOLLOWER_PAPER_EXPECTANCY_POSITIVE_CANDIDATE",
  );
}
