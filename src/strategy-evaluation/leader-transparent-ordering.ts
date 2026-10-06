import type { VersionedHistoricalEvaluationResult } from "./historical-evaluation.js";
import type {
  LeaderCandidateConflict,
  LeaderCohortCompatibilityResult,
  LeaderComparisonCohortIdentity,
  LeaderCompatibilityExclusion,
  LeaderCompatibilityGroupDifference,
  LeaderSemanticCompatibilityKey,
} from "./leader-cohort-compatibility.js";
import type {
  LeaderComparabilityResult,
  LeaderComparisonBucket,
} from "./leader-comparability.js";

export const LEADER_TRANSPARENT_ORDERING_DEFINITION_VERSION =
  "LEADER_TRANSPARENT_ORDERING_V1" as const;

export interface LeaderTransparentOrderingPolicy {
  readonly primary: "PAPER_EXPECTANCY_DESC";
  readonly secondary: "REALIZED_PNL_DRAWDOWN_ASC";
  readonly comparison: "EXACT_PUBLISHED_METRIC_VALUES";
  readonly orderModel: "PARTIAL_LEXICOGRAPHIC";
  readonly tolerance: "NONE";
}

export interface LeaderOrderingHistoricalReference {
  readonly bucket: LeaderComparisonBucket;
  readonly window: VersionedHistoricalEvaluationResult["window"];
  readonly resolvedDatabasePath: string;
  readonly historicalEvaluationDefinitionVersion: VersionedHistoricalEvaluationResult["definitionVersion"];
  readonly strategyMetricSemantics: "PAPER_EXPECTANCY";
  readonly strategyMetricDefinitionVersion: string;
}

export interface LeaderSecondaryBusinessTieGroup {
  readonly realizedPnlDrawdown: string;
  readonly members: readonly LeaderOrderingHistoricalReference[];
}

export interface LeaderOrderingPrimaryGroup {
  readonly paperExpectancy: string;
  readonly orderedSecondaryBusinessTieGroups: readonly LeaderSecondaryBusinessTieGroup[];
  readonly secondaryUnavailableMembers: readonly LeaderOrderingHistoricalReference[];
}

export interface LeaderOrderedCompatibilityGroup {
  readonly compatibilityKey: string;
  readonly semantics: LeaderSemanticCompatibilityKey;
  readonly orderedPrimaryGroups: readonly LeaderOrderingPrimaryGroup[];
}

export type LeaderOrderingIntegrityReason =
  | "NON_COMPARABLE_GROUP_MEMBER"
  | "MISSING_HISTORICAL_BINDING"
  | "AMBIGUOUS_HISTORICAL_BINDING"
  | "HISTORICAL_REFERENCE_MISMATCH"
  | "INVALID_PRIMARY_METRIC"
  | "INVALID_SECONDARY_METRIC";

export interface LeaderOrderingIntegrityExclusion {
  readonly compatibilityKey: string;
  readonly member: LeaderComparabilityResult;
  readonly reason: LeaderOrderingIntegrityReason;
  readonly field: string;
}

export interface LeaderTransparentOrderingCohortResult {
  readonly cohort: LeaderComparisonCohortIdentity;
  readonly compatibilityGroups: readonly LeaderOrderedCompatibilityGroup[];
  readonly observationOnlyMembers: readonly LeaderComparabilityResult[];
  readonly excludedMembers: readonly LeaderComparabilityResult[];
  readonly candidateConflicts: readonly LeaderCandidateConflict[];
  readonly compatibilityExclusions: readonly LeaderCompatibilityExclusion[];
  readonly orderingIntegrityExclusions: readonly LeaderOrderingIntegrityExclusion[];
  readonly incompatibilities: readonly LeaderCompatibilityGroupDifference[];
}

export interface LeaderTransparentOrderingResult {
  readonly definitionVersion: typeof LEADER_TRANSPARENT_ORDERING_DEFINITION_VERSION;
  readonly purpose: "DESCRIPTIVE_HISTORICAL_STRATEGY_PERFORMANCE";
  readonly statisticalSuperiorityStatus: "NOT_ESTABLISHED";
  readonly multipleTestingCorrection: "NONE";
  readonly policy: LeaderTransparentOrderingPolicy;
  readonly limitations: readonly [
    "CONDITIONAL_ON_SUPPLIED_CANDIDATE_SET",
    "WINNERS_CURSE_NOT_CORRECTED",
    "NO_STATISTICAL_SUPERIORITY_INFERENCE",
  ];
  readonly cohorts: readonly LeaderTransparentOrderingCohortResult[];
}

interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
  readonly canonicalValue: string;
}

interface BoundOrderingCandidate {
  readonly primary: ExactDecimal;
  readonly secondary:
    | { readonly status: "AVAILABLE"; readonly value: bigint }
    | { readonly status: "UNAVAILABLE" };
  readonly reference: LeaderOrderingHistoricalReference;
}

const POLICY: LeaderTransparentOrderingPolicy = {
  primary: "PAPER_EXPECTANCY_DESC",
  secondary: "REALIZED_PNL_DRAWDOWN_ASC",
  comparison: "EXACT_PUBLISHED_METRIC_VALUES",
  orderModel: "PARTIAL_LEXICOGRAPHIC",
  tolerance: "NONE",
};

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBucket(
  left: LeaderComparisonBucket,
  right: LeaderComparisonBucket,
): number {
  return (
    compareText(left.followerWallet, right.followerWallet) ||
    compareText(left.leaderWallet, right.leaderWallet) ||
    compareText(left.quoteMint, right.quoteMint)
  );
}

function candidateKey(bucket: LeaderComparisonBucket): string {
  return JSON.stringify([
    bucket.followerWallet,
    bucket.leaderWallet,
    bucket.quoteMint,
  ]);
}

function parseExactPublishedDecimal(value: string): ExactDecimal | null {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{0,17}[1-9]))?$/.exec(value);
  if (match === null) return null;

  const negative = match[1] === "-";
  const integerPart = match[2]!;
  const fractionalPart = match[3] ?? "";
  const unsignedCoefficient = BigInt(`${integerPart}${fractionalPart}`);
  if (negative && unsignedCoefficient === 0n) return null;

  return {
    coefficient: negative ? -unsignedCoefficient : unsignedCoefficient,
    scale: fractionalPart.length,
    canonicalValue: value,
  };
}

function compareExactDecimal(left: ExactDecimal, right: ExactDecimal): number {
  const commonScale = left.scale > right.scale ? left.scale : right.scale;
  const leftAligned =
    left.coefficient * 10n ** BigInt(commonScale - left.scale);
  const rightAligned =
    right.coefficient * 10n ** BigInt(commonScale - right.scale);
  return leftAligned < rightAligned ? -1 : leftAligned > rightAligned ? 1 : 0;
}

function parseRawDrawdown(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return BigInt(value);
}

function historicalReference(
  historical: VersionedHistoricalEvaluationResult,
): LeaderOrderingHistoricalReference {
  return {
    bucket: { ...historical.bucket },
    window: { ...historical.window },
    resolvedDatabasePath: historical.provenance.resolvedDatabasePath,
    historicalEvaluationDefinitionVersion: historical.definitionVersion,
    strategyMetricSemantics: historical.strategyMetricSemantics,
    strategyMetricDefinitionVersion:
      historical.strategyMetrics.netQuoteExpectancy.definitionVersion,
  };
}

function historicalReferenceMatches(
  member: LeaderComparabilityResult,
  historical: VersionedHistoricalEvaluationResult,
): boolean {
  const expected = member.historicalReference;
  const observed = {
    resolvedDatabasePath: historical.provenance.resolvedDatabasePath,
    window: historical.window,
    evaluationContext: historical.evaluationContext,
    observedSchemaMigrations: historical.provenance.observedSchemaMigrations,
    historicalEvaluationDefinitionVersion: historical.definitionVersion,
    strategyMetricSemantics: historical.strategyMetricSemantics,
    strategyMetricDefinitionVersion:
      historical.strategyMetrics.netQuoteExpectancy.definitionVersion,
    failureTaxonomyDefinitionVersion:
      historical.failureClassification.definitionVersion,
    copyabilityDefinitionVersion: historical.copyability.definitionVersion,
    endToEndApplicationDefinitionVersion:
      historical.copyability.endToEndApplication.definitionVersion,
  };
  return JSON.stringify(expected) === JSON.stringify(observed);
}

function integrityExclusion(
  compatibilityKey: string,
  member: LeaderComparabilityResult,
  reason: LeaderOrderingIntegrityReason,
  field: string,
): LeaderOrderingIntegrityExclusion {
  return {
    compatibilityKey,
    member: cloneValue(member),
    reason,
    field,
  };
}

function bindCandidate(
  compatibilityKey: string,
  semantics: LeaderSemanticCompatibilityKey,
  member: LeaderComparabilityResult,
  historicalByCandidate: ReadonlyMap<
    string,
    readonly VersionedHistoricalEvaluationResult[]
  >,
):
  | { readonly candidate: BoundOrderingCandidate }
  | { readonly exclusion: LeaderOrderingIntegrityExclusion } {
  if (member.status !== "COMPARABLE") {
    return {
      exclusion: integrityExclusion(
        compatibilityKey,
        member,
        "NON_COMPARABLE_GROUP_MEMBER",
        "status",
      ),
    };
  }
  const matches = historicalByCandidate.get(candidateKey(member.bucket)) ?? [];
  if (matches.length === 0) {
    return {
      exclusion: integrityExclusion(
        compatibilityKey,
        member,
        "MISSING_HISTORICAL_BINDING",
        "bucket",
      ),
    };
  }
  if (matches.length !== 1) {
    return {
      exclusion: integrityExclusion(
        compatibilityKey,
        member,
        "AMBIGUOUS_HISTORICAL_BINDING",
        "bucket",
      ),
    };
  }
  const historical = matches[0]!;
  if (!historicalReferenceMatches(member, historical)) {
    return {
      exclusion: integrityExclusion(
        compatibilityKey,
        member,
        "HISTORICAL_REFERENCE_MISMATCH",
        "historicalReference",
      ),
    };
  }

  const primaryMetric = historical.strategyMetrics.netQuoteExpectancy;
  const primary =
    primaryMetric.status === "AVAILABLE" && primaryMetric.value !== null
      ? parseExactPublishedDecimal(primaryMetric.value)
      : null;
  if (
    primary === null ||
    primaryMetric.unit !== "QUOTE_RAW_PER_COMPLETED_CYCLE" ||
    primaryMetric.definitionVersion !==
      semantics.strategyMetrics.netQuoteExpectancy.definitionVersion ||
    primaryMetric.unit !== semantics.strategyMetrics.netQuoteExpectancy.unit
  ) {
    return {
      exclusion: integrityExclusion(
        compatibilityKey,
        member,
        "INVALID_PRIMARY_METRIC",
        "strategyMetrics.netQuoteExpectancy",
      ),
    };
  }

  const secondaryMetric = historical.strategyMetrics.realizedPnlDrawdown;
  if (
    secondaryMetric.unit !== "RAW_QUOTE" ||
    secondaryMetric.definitionVersion !==
      semantics.strategyMetrics.realizedPnlDrawdown.definitionVersion ||
    secondaryMetric.unit !== semantics.strategyMetrics.realizedPnlDrawdown.unit
  ) {
    return {
      exclusion: integrityExclusion(
        compatibilityKey,
        member,
        "INVALID_SECONDARY_METRIC",
        "strategyMetrics.realizedPnlDrawdown",
      ),
    };
  }

  let secondary: BoundOrderingCandidate["secondary"];
  if (secondaryMetric.status === "AVAILABLE") {
    const value =
      secondaryMetric.value === null
        ? null
        : parseRawDrawdown(secondaryMetric.value);
    if (value === null) {
      return {
        exclusion: integrityExclusion(
          compatibilityKey,
          member,
          "INVALID_SECONDARY_METRIC",
          "strategyMetrics.realizedPnlDrawdown",
        ),
      };
    }
    secondary = { status: "AVAILABLE", value };
  } else if (secondaryMetric.value === null) {
    secondary = { status: "UNAVAILABLE" };
  } else {
    return {
      exclusion: integrityExclusion(
        compatibilityKey,
        member,
        "INVALID_SECONDARY_METRIC",
        "strategyMetrics.realizedPnlDrawdown",
      ),
    };
  }

  return {
    candidate: {
      primary,
      secondary,
      reference: historicalReference(historical),
    },
  };
}

function orderCompatibilityGroup(
  group: LeaderCohortCompatibilityResult["cohorts"][number]["compatibilityGroups"][number],
  historicalByCandidate: ReadonlyMap<
    string,
    readonly VersionedHistoricalEvaluationResult[]
  >,
): {
  readonly group: LeaderOrderedCompatibilityGroup;
  readonly exclusions: readonly LeaderOrderingIntegrityExclusion[];
} {
  const candidates: BoundOrderingCandidate[] = [];
  const exclusions: LeaderOrderingIntegrityExclusion[] = [];
  for (const member of group.members) {
    const bound = bindCandidate(
      group.compatibilityKey,
      group.semantics,
      member,
      historicalByCandidate,
    );
    if ("candidate" in bound) candidates.push(bound.candidate);
    else exclusions.push(bound.exclusion);
  }

  const primaryGroupsByValue = new Map<string, BoundOrderingCandidate[]>();
  for (const candidate of candidates) {
    const entries =
      primaryGroupsByValue.get(candidate.primary.canonicalValue) ?? [];
    entries.push(candidate);
    primaryGroupsByValue.set(candidate.primary.canonicalValue, entries);
  }
  const orderedPrimaryGroups = [...primaryGroupsByValue.entries()]
    .map(([paperExpectancy, primaryCandidates]) => {
      const secondaryGroupsByValue = new Map<
        string,
        LeaderOrderingHistoricalReference[]
      >();
      const secondaryUnavailableMembers: LeaderOrderingHistoricalReference[] =
        [];
      for (const candidate of primaryCandidates) {
        if (candidate.secondary.status === "UNAVAILABLE") {
          secondaryUnavailableMembers.push(candidate.reference);
          continue;
        }
        const value = candidate.secondary.value.toString();
        const members = secondaryGroupsByValue.get(value) ?? [];
        members.push(candidate.reference);
        secondaryGroupsByValue.set(value, members);
      }
      return {
        parsed: primaryCandidates[0]!.primary,
        value: {
          paperExpectancy,
          orderedSecondaryBusinessTieGroups: [
            ...secondaryGroupsByValue.entries(),
          ]
            .sort(([left], [right]) => {
              const leftValue = BigInt(left);
              const rightValue = BigInt(right);
              return leftValue < rightValue
                ? -1
                : leftValue > rightValue
                  ? 1
                  : 0;
            })
            .map(([realizedPnlDrawdown, members]) => ({
              realizedPnlDrawdown,
              members: members
                .slice()
                .sort((left, right) =>
                  compareBucket(left.bucket, right.bucket),
                ),
            })),
          secondaryUnavailableMembers: secondaryUnavailableMembers
            .slice()
            .sort((left, right) => compareBucket(left.bucket, right.bucket)),
        },
      };
    })
    .sort((left, right) => compareExactDecimal(right.parsed, left.parsed))
    .map(({ value }) => value);

  return {
    group: {
      compatibilityKey: group.compatibilityKey,
      semantics: cloneValue(group.semantics),
      orderedPrimaryGroups,
    },
    exclusions: exclusions.sort(
      (left, right) =>
        compareBucket(left.member.bucket, right.member.bucket) ||
        compareText(left.reason, right.reason) ||
        compareText(left.field, right.field),
    ),
  };
}

function sortedMembers(
  members: readonly LeaderComparabilityResult[],
): LeaderComparabilityResult[] {
  return members
    .map((member) => cloneValue(member))
    .sort((left, right) => compareBucket(left.bucket, right.bucket));
}

export function evaluateLeaderTransparentOrdering(
  cohortCompatibilityResult: LeaderCohortCompatibilityResult,
  historicalResults: readonly VersionedHistoricalEvaluationResult[],
): LeaderTransparentOrderingResult {
  const historicalByCandidate = new Map<
    string,
    VersionedHistoricalEvaluationResult[]
  >();
  for (const historical of historicalResults) {
    const key = candidateKey(historical.bucket);
    const matches = historicalByCandidate.get(key) ?? [];
    matches.push(historical);
    historicalByCandidate.set(key, matches);
  }

  const cohorts = cohortCompatibilityResult.cohorts
    .map((cohort) => {
      const orderedGroups = cohort.compatibilityGroups
        .map((group) => orderCompatibilityGroup(group, historicalByCandidate))
        .sort((left, right) =>
          compareText(
            left.group.compatibilityKey,
            right.group.compatibilityKey,
          ),
        );
      return {
        cohort: { ...cohort.cohort },
        compatibilityGroups: orderedGroups.map(({ group }) => group),
        observationOnlyMembers: sortedMembers(cohort.observationOnlyMembers),
        excludedMembers: sortedMembers(cohort.excludedMembers),
        candidateConflicts: cohort.candidateConflicts
          .map((conflict) => cloneValue(conflict))
          .sort((left, right) =>
            compareBucket(left.candidate, right.candidate),
          ),
        compatibilityExclusions: cohort.compatibilityExclusions
          .map((exclusion) => cloneValue(exclusion))
          .sort((left, right) =>
            compareBucket(left.member.bucket, right.member.bucket),
          ),
        orderingIntegrityExclusions: orderedGroups
          .flatMap(({ exclusions }) => exclusions)
          .sort(
            (left, right) =>
              compareText(left.compatibilityKey, right.compatibilityKey) ||
              compareBucket(left.member.bucket, right.member.bucket) ||
              compareText(left.reason, right.reason) ||
              compareText(left.field, right.field),
          ),
        incompatibilities: cohort.incompatibilities
          .map((incompatibility) => cloneValue(incompatibility))
          .sort(
            (left, right) =>
              compareText(
                left.leftCompatibilityKey,
                right.leftCompatibilityKey,
              ) ||
              compareText(
                left.rightCompatibilityKey,
                right.rightCompatibilityKey,
              ),
          ),
      };
    })
    .sort(
      (left, right) =>
        compareText(left.cohort.followerWallet, right.cohort.followerWallet) ||
        compareText(left.cohort.quoteMint, right.cohort.quoteMint),
    );

  return {
    definitionVersion: LEADER_TRANSPARENT_ORDERING_DEFINITION_VERSION,
    purpose: "DESCRIPTIVE_HISTORICAL_STRATEGY_PERFORMANCE",
    statisticalSuperiorityStatus: "NOT_ESTABLISHED",
    multipleTestingCorrection: "NONE",
    policy: { ...POLICY },
    limitations: [
      "CONDITIONAL_ON_SUPPLIED_CANDIDATE_SET",
      "WINNERS_CURSE_NOT_CORRECTED",
      "NO_STATISTICAL_SUPERIORITY_INFERENCE",
    ],
    cohorts,
  };
}
