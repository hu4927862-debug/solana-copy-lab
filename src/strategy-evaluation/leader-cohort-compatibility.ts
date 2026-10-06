import type { VersionedHistoricalEvaluationResult } from "./historical-evaluation.js";
import {
  evaluateLeaderComparability,
  type LeaderComparabilityResult,
  type LeaderComparisonBucket,
} from "./leader-comparability.js";

export interface LeaderComparisonCohortIdentity {
  readonly followerWallet: string;
  readonly quoteMint: string;
}

export interface LeaderMetricDefinitionIdentity {
  readonly definitionVersion: string;
  readonly unit?: string;
}

export interface LeaderSemanticCompatibilityKey {
  readonly window: VersionedHistoricalEvaluationResult["window"];
  readonly evaluationContext: VersionedHistoricalEvaluationResult["evaluationContext"];
  readonly historicalEvaluationDefinitionVersion: VersionedHistoricalEvaluationResult["definitionVersion"];
  readonly strategyMetricSemantics: VersionedHistoricalEvaluationResult["strategyMetricSemantics"];
  readonly strategyMetrics: {
    readonly netQuoteExpectancy: LeaderMetricDefinitionIdentity;
    readonly winRate: LeaderMetricDefinitionIdentity;
    readonly profitFactor: LeaderMetricDefinitionIdentity;
    readonly realizedPnlDrawdown: LeaderMetricDefinitionIdentity;
    readonly holdingTime: LeaderMetricDefinitionIdentity;
    readonly bestTradeContribution: LeaderMetricDefinitionIdentity;
    readonly bestTokenContribution: LeaderMetricDefinitionIdentity;
  };
  readonly copyability: {
    readonly aggregate: string;
    readonly positionMapping: string;
    readonly sizeGranularity: string;
    readonly buyCapacity: string;
    readonly jupiterQuoteUsability: string;
    readonly postQuoteFreshness: string;
    readonly priceImpact: string;
    readonly endToEndApplication: string;
  };
  readonly failureTaxonomyDefinitionVersion: string;
  readonly observedSchemaMigrations: VersionedHistoricalEvaluationResult["provenance"]["observedSchemaMigrations"];
}

export type LeaderCohortCompatibilityReason =
  | "WINDOW_MISMATCH"
  | "CONTEXT_MISMATCH"
  | "DEFINITION_MISMATCH"
  | "PROVENANCE_MISMATCH"
  | "CONFLICTING_CANDIDATE";

export interface LeaderCohortCompatibilityReasonDetail {
  readonly reason: LeaderCohortCompatibilityReason;
  readonly fields: readonly string[];
}

export interface LeaderCompatibilityGroup {
  readonly compatibilityKey: string;
  readonly semantics: LeaderSemanticCompatibilityKey;
  readonly members: readonly LeaderComparabilityResult[];
}

export interface LeaderCompatibilityGroupDifference {
  readonly leftCompatibilityKey: string;
  readonly rightCompatibilityKey: string;
  readonly reasons: readonly LeaderCohortCompatibilityReasonDetail[];
}

export interface LeaderCandidateConflict {
  readonly candidate: LeaderComparisonBucket;
  readonly reason: "CONFLICTING_CANDIDATE";
  readonly occurrences: readonly LeaderComparabilityResult[];
}

export interface LeaderCompatibilityExclusion {
  readonly member: LeaderComparabilityResult;
  readonly reasons: readonly LeaderCohortCompatibilityReasonDetail[];
}

export interface LeaderComparisonCohortResult {
  readonly cohort: LeaderComparisonCohortIdentity;
  readonly compatibilityGroups: readonly LeaderCompatibilityGroup[];
  readonly observationOnlyMembers: readonly LeaderComparabilityResult[];
  readonly excludedMembers: readonly LeaderComparabilityResult[];
  readonly candidateConflicts: readonly LeaderCandidateConflict[];
  readonly compatibilityExclusions: readonly LeaderCompatibilityExclusion[];
  readonly incompatibilities: readonly LeaderCompatibilityGroupDifference[];
}

export interface LeaderCohortCompatibilityResult {
  readonly definitionVersion: "LEADER_COHORT_COMPATIBILITY_V1";
  readonly cohorts: readonly LeaderComparisonCohortResult[];
}

interface CandidateProjection {
  readonly historical: VersionedHistoricalEvaluationResult;
  readonly comparability: LeaderComparabilityResult;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCandidate(
  left: LeaderComparabilityResult,
  right: LeaderComparabilityResult,
): number {
  return (
    compareText(left.bucket.followerWallet, right.bucket.followerWallet) ||
    compareText(left.bucket.leaderWallet, right.bucket.leaderWallet) ||
    compareText(left.bucket.quoteMint, right.bucket.quoteMint)
  );
}

function metricDefinition(metric: {
  readonly definitionVersion: string;
  readonly unit?: string;
}): LeaderMetricDefinitionIdentity {
  return {
    definitionVersion: metric.definitionVersion,
    ...(metric.unit === undefined ? {} : { unit: metric.unit }),
  };
}

function semanticCompatibilityKey(
  historical: VersionedHistoricalEvaluationResult,
): LeaderSemanticCompatibilityKey {
  return {
    window: { ...historical.window },
    evaluationContext: {
      ...historical.evaluationContext,
      window: { ...historical.evaluationContext.window },
    },
    historicalEvaluationDefinitionVersion: historical.definitionVersion,
    strategyMetricSemantics: historical.strategyMetricSemantics,
    strategyMetrics: {
      netQuoteExpectancy: metricDefinition(
        historical.strategyMetrics.netQuoteExpectancy,
      ),
      winRate: metricDefinition(historical.strategyMetrics.winRate),
      profitFactor: metricDefinition(historical.strategyMetrics.profitFactor),
      realizedPnlDrawdown: metricDefinition(
        historical.strategyMetrics.realizedPnlDrawdown,
      ),
      holdingTime: metricDefinition(historical.strategyMetrics.holdingTime),
      bestTradeContribution: metricDefinition(
        historical.strategyMetrics.bestTradeContribution,
      ),
      bestTokenContribution: metricDefinition(
        historical.strategyMetrics.bestTokenContribution,
      ),
    },
    copyability: {
      aggregate: historical.copyability.definitionVersion,
      positionMapping: historical.copyability.positionMapping.definitionVersion,
      sizeGranularity: historical.copyability.sizeGranularity.definitionVersion,
      buyCapacity: historical.copyability.buyCapacity.definitionVersion,
      jupiterQuoteUsability:
        historical.copyability.jupiterQuoteUsability.definitionVersion,
      postQuoteFreshness:
        historical.copyability.postQuoteFreshness.definitionVersion,
      priceImpact: historical.copyability.priceImpact.definitionVersion,
      endToEndApplication:
        historical.copyability.endToEndApplication.definitionVersion,
    },
    failureTaxonomyDefinitionVersion:
      historical.failureClassification.definitionVersion,
    observedSchemaMigrations:
      historical.provenance.observedSchemaMigrations.map((migration) => ({
        version: migration.version,
        checksum: migration.checksum,
      })),
  };
}

function canonicalCompatibilityKey(
  semantics: LeaderSemanticCompatibilityKey,
): string {
  return JSON.stringify(semantics);
}

function cohortKey(identity: LeaderComparisonCohortIdentity): string {
  return JSON.stringify([identity.followerWallet, identity.quoteMint]);
}

function candidateKey(bucket: LeaderComparisonBucket): string {
  return JSON.stringify([
    bucket.followerWallet,
    bucket.leaderWallet,
    bucket.quoteMint,
  ]);
}

function contextDifferenceFields(
  left: VersionedHistoricalEvaluationResult["evaluationContext"],
  right: VersionedHistoricalEvaluationResult["evaluationContext"],
): string[] {
  const fields: string[] = [];
  for (const field of [
    "source",
    "mode",
    "copyRatioBps",
    "riskPolicyVersion",
    "fillPolicyVersion",
    "accountingPolicyVersion",
    "copyabilityDefinitionVersion",
  ] as const) {
    if (left[field] !== right[field]) {
      fields.push(`evaluationContext.${field}`);
    }
  }
  return fields;
}

function sameEvaluationContext(
  left: VersionedHistoricalEvaluationResult["evaluationContext"],
  right: VersionedHistoricalEvaluationResult["evaluationContext"],
): boolean {
  return (
    left.window.fromMs === right.window.fromMs &&
    left.window.toMs === right.window.toMs &&
    contextDifferenceFields(left, right).length === 0
  );
}

function groupDifferences(
  left: LeaderCompatibilityGroup,
  right: LeaderCompatibilityGroup,
): LeaderCohortCompatibilityReasonDetail[] {
  const reasons: LeaderCohortCompatibilityReasonDetail[] = [];
  const windowFields: string[] = [];
  if (
    left.semantics.window.windowStartMs !== right.semantics.window.windowStartMs
  ) {
    windowFields.push("window.windowStartMs");
  }
  if (
    left.semantics.window.windowEndMs !== right.semantics.window.windowEndMs
  ) {
    windowFields.push("window.windowEndMs");
  }
  if (windowFields.length !== 0) {
    reasons.push({ reason: "WINDOW_MISMATCH", fields: windowFields });
  }

  const contextFields = contextDifferenceFields(
    left.semantics.evaluationContext,
    right.semantics.evaluationContext,
  );
  if (contextFields.length !== 0) {
    reasons.push({ reason: "CONTEXT_MISMATCH", fields: contextFields });
  }

  const definitionFields: string[] = [];
  if (
    left.semantics.historicalEvaluationDefinitionVersion !==
    right.semantics.historicalEvaluationDefinitionVersion
  ) {
    definitionFields.push("historicalEvaluationDefinitionVersion");
  }
  if (
    left.semantics.strategyMetricSemantics !==
    right.semantics.strategyMetricSemantics
  ) {
    definitionFields.push("strategyMetricSemantics");
  }
  if (
    JSON.stringify(left.semantics.strategyMetrics) !==
    JSON.stringify(right.semantics.strategyMetrics)
  ) {
    definitionFields.push("strategyMetrics");
  }
  if (
    JSON.stringify(left.semantics.copyability) !==
    JSON.stringify(right.semantics.copyability)
  ) {
    definitionFields.push("copyability");
  }
  if (
    left.semantics.failureTaxonomyDefinitionVersion !==
    right.semantics.failureTaxonomyDefinitionVersion
  ) {
    definitionFields.push("failureTaxonomyDefinitionVersion");
  }
  if (definitionFields.length !== 0) {
    reasons.push({ reason: "DEFINITION_MISMATCH", fields: definitionFields });
  }

  if (
    JSON.stringify(left.semantics.observedSchemaMigrations) !==
    JSON.stringify(right.semantics.observedSchemaMigrations)
  ) {
    reasons.push({
      reason: "PROVENANCE_MISMATCH",
      fields: ["provenance.observedSchemaMigrations"],
    });
  }
  return reasons;
}

function compatibilityIntegrityReasons(
  historical: VersionedHistoricalEvaluationResult,
): LeaderCohortCompatibilityReasonDetail[] {
  const reasons: LeaderCohortCompatibilityReasonDetail[] = [];
  const contextFields: string[] = [];
  if (
    historical.evaluationContext.window.fromMs !==
      historical.window.windowStartMs ||
    historical.evaluationContext.window.toMs !== historical.window.windowEndMs
  ) {
    contextFields.push("evaluationContext.window");
  }
  if (
    !sameEvaluationContext(
      historical.copyability.evaluationContext,
      historical.evaluationContext,
    )
  ) {
    contextFields.push("copyability.evaluationContext");
  }
  if (contextFields.length !== 0) {
    reasons.push({ reason: "CONTEXT_MISMATCH", fields: contextFields });
  }

  const provenanceFields: string[] = [];
  if (
    historical.provenance.requestedWindow.windowStartMs !==
      historical.window.windowStartMs ||
    historical.provenance.requestedWindow.windowEndMs !==
      historical.window.windowEndMs
  ) {
    provenanceFields.push("provenance.requestedWindow");
  }
  if (
    !sameEvaluationContext(
      historical.provenance.expectedContext,
      historical.evaluationContext,
    )
  ) {
    provenanceFields.push("provenance.expectedContext");
  }
  if (provenanceFields.length !== 0) {
    reasons.push({ reason: "PROVENANCE_MISMATCH", fields: provenanceFields });
  }
  return reasons;
}

function buildCohort(
  cohort: LeaderComparisonCohortIdentity,
  candidates: readonly CandidateProjection[],
): LeaderComparisonCohortResult {
  const compatibilityGroupsByKey = new Map<
    string,
    {
      semantics: LeaderSemanticCompatibilityKey;
      members: LeaderComparabilityResult[];
    }
  >();
  const observationOnlyMembers: LeaderComparabilityResult[] = [];
  const excludedMembers: LeaderComparabilityResult[] = [];
  const compatibilityExclusions: LeaderCompatibilityExclusion[] = [];
  const candidatesByIdentity = new Map<string, CandidateProjection[]>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate.comparability.bucket);
    const occurrences = candidatesByIdentity.get(key) ?? [];
    occurrences.push(candidate);
    candidatesByIdentity.set(key, occurrences);
  }
  const candidateConflicts: LeaderCandidateConflict[] = [];
  const uniqueCandidates: CandidateProjection[] = [];
  for (const occurrences of candidatesByIdentity.values()) {
    if (occurrences.length === 1) {
      uniqueCandidates.push(occurrences[0]!);
      continue;
    }
    const sortedOccurrences = occurrences
      .map(({ comparability }) => comparability)
      .sort((left, right) =>
        compareText(JSON.stringify(left), JSON.stringify(right)),
      );
    candidateConflicts.push({
      candidate: { ...sortedOccurrences[0]!.bucket },
      reason: "CONFLICTING_CANDIDATE",
      occurrences: sortedOccurrences,
    });
  }

  for (const candidate of uniqueCandidates) {
    if (candidate.comparability.status === "OBSERVATION_ONLY") {
      observationOnlyMembers.push(candidate.comparability);
      continue;
    }
    if (candidate.comparability.status === "NOT_COMPARABLE") {
      excludedMembers.push(candidate.comparability);
      continue;
    }
    const integrityReasons = compatibilityIntegrityReasons(
      candidate.historical,
    );
    if (integrityReasons.length !== 0) {
      compatibilityExclusions.push({
        member: candidate.comparability,
        reasons: integrityReasons,
      });
      continue;
    }
    const semantics = semanticCompatibilityKey(candidate.historical);
    const key = canonicalCompatibilityKey(semantics);
    const group = compatibilityGroupsByKey.get(key) ?? {
      semantics,
      members: [],
    };
    group.members.push(candidate.comparability);
    compatibilityGroupsByKey.set(key, group);
  }

  const compatibilityGroups = [...compatibilityGroupsByKey.entries()]
    .map(([compatibilityKey, group]) => ({
      compatibilityKey,
      semantics: group.semantics,
      members: group.members.slice().sort(compareCandidate),
    }))
    .sort((left, right) =>
      compareText(left.compatibilityKey, right.compatibilityKey),
    );
  const incompatibilities: LeaderCompatibilityGroupDifference[] = [];
  for (
    let leftIndex = 0;
    leftIndex < compatibilityGroups.length;
    leftIndex += 1
  ) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < compatibilityGroups.length;
      rightIndex += 1
    ) {
      const left = compatibilityGroups[leftIndex]!;
      const right = compatibilityGroups[rightIndex]!;
      incompatibilities.push({
        leftCompatibilityKey: left.compatibilityKey,
        rightCompatibilityKey: right.compatibilityKey,
        reasons: groupDifferences(left, right),
      });
    }
  }

  return {
    cohort: { ...cohort },
    compatibilityGroups,
    observationOnlyMembers: observationOnlyMembers.sort(compareCandidate),
    excludedMembers: excludedMembers.sort(compareCandidate),
    candidateConflicts: candidateConflicts.sort((left, right) =>
      compareCandidate(left.occurrences[0]!, right.occurrences[0]!),
    ),
    compatibilityExclusions: compatibilityExclusions.sort((left, right) =>
      compareCandidate(left.member, right.member),
    ),
    incompatibilities,
  };
}

export function evaluateLeaderCohortCompatibility(
  historicalResults: readonly VersionedHistoricalEvaluationResult[],
): LeaderCohortCompatibilityResult {
  const cohortsByKey = new Map<
    string,
    {
      identity: LeaderComparisonCohortIdentity;
      candidates: CandidateProjection[];
    }
  >();

  for (const historical of historicalResults) {
    const comparability = evaluateLeaderComparability(historical);
    const identity = {
      followerWallet: comparability.bucket.followerWallet,
      quoteMint: comparability.bucket.quoteMint,
    };
    const key = cohortKey(identity);
    const cohort = cohortsByKey.get(key) ?? { identity, candidates: [] };
    cohort.candidates.push({ historical, comparability });
    cohortsByKey.set(key, cohort);
  }

  return {
    definitionVersion: "LEADER_COHORT_COMPATIBILITY_V1",
    cohorts: [...cohortsByKey.values()]
      .sort(
        (left, right) =>
          compareText(
            left.identity.followerWallet,
            right.identity.followerWallet,
          ) || compareText(left.identity.quoteMint, right.identity.quoteMint),
      )
      .map(({ identity, candidates }) => buildCohort(identity, candidates)),
  };
}
