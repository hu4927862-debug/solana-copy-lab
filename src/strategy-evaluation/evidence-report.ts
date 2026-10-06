import { createHash } from "node:crypto";
import type { CopyabilityBucket } from "./copyability.js";
import type { FailureTaxonomyPolicy } from "./failure-taxonomy.js";
import {
  evaluateFollowerStrategyVerdict,
  projectFollowerStrategyVerdictEvidence,
  verifyFollowerStrategyVerdictPolicy,
  type FollowerStrategyVerdict,
  type VerifiedFollowerStrategyVerdictPolicy,
} from "./follower-strategy-verdict.js";
import {
  evaluateHistoricalEvaluationV3,
  type HistoricalEvaluationV2EvidenceSnapshot,
  type HistoricalEvaluationV3Result,
} from "./historical-evaluation.js";
import {
  evaluateLeaderComparability,
  type LeaderComparabilityResult,
} from "./leader-comparability.js";
import {
  evaluateLeaderCohortCompatibility,
  type LeaderCohortCompatibilityResult,
} from "./leader-cohort-compatibility.js";
import {
  evaluateLeaderReliabilityDiagnosticsV2,
  type LeaderReliabilityDiagnosticsV2Result,
} from "./leader-reliability-diagnostics.js";
import {
  evaluateLeaderTransparentOrdering,
  type LeaderTransparentOrderingResult,
} from "./leader-transparent-ordering.js";
import type { StrategyMetricsPolicy } from "./metrics.js";
import type { ObservedSchemaMigration } from "./read-model.js";

export const DETERMINISTIC_EVIDENCE_REPORT_SCHEMA_VERSION =
  "DETERMINISTIC_EVIDENCE_REPORT_V1" as const;

const CANONICAL_DATABASE_PATH =
  "<MACHINE_SPECIFIC_DATABASE_PATH_EXCLUDED>" as const;

export interface UnavailableLeaderMetrics {
  readonly status: "UNAVAILABLE";
  readonly unavailableReason: "LEADER_ECONOMIC_EVIDENCE_UNAVAILABLE";
  readonly metrics: null;
}

export interface ApprovedVerdictPolicy {
  readonly policyVersion: VerifiedFollowerStrategyVerdictPolicy["policyVersion"];
  readonly policySha256: VerifiedFollowerStrategyVerdictPolicy["policySha256"];
}

export interface EvidenceSourceRowCounts {
  readonly roundTripApplications: number;
  readonly roundTripApplicationSources: number;
  readonly paperFills: number;
  readonly paperFillApplications: number;
  readonly jupiterAttempts: number;
  readonly riskDecisions: number;
  readonly opportunities: number;
  readonly observationExclusions: number;
  readonly observationLimitations: number;
  readonly contextLimitations: number;
}

export interface DeterministicEvidenceReportEvaluation {
  readonly bucket: CopyabilityBucket;
  readonly availability: HistoricalEvaluationV3Result["availability"];
  readonly sample: HistoricalEvaluationV3Result["sample"];
  readonly leaderComparability: LeaderComparabilityResult;
  readonly historicalEvaluationPolicyInputs: StrategyMetricsPolicy;
  readonly verdictPolicy: ApprovedVerdictPolicy;
  readonly leaderMetrics: UnavailableLeaderMetrics;
  readonly followerCycles: {
    readonly definitionVersion: HistoricalEvaluationV3Result["roundTripDefinitionVersion"];
    readonly completed: HistoricalEvaluationV3Result["includedRoundTrips"];
  };
  readonly followerMetrics: HistoricalEvaluationV3Result["strategyMetrics"];
  readonly executionQuality: HistoricalEvaluationV3Result["executionQuality"];
  readonly copyabilityComponents: HistoricalEvaluationV3Result["copyability"];
  readonly costCompleteness: HistoricalEvaluationV3Result["costCompleteness"];
  readonly failureTaxonomy: HistoricalEvaluationV3Result["failureClassification"];
  readonly reliabilityDiagnostics: LeaderReliabilityDiagnosticsV2Result;
  readonly limitations: HistoricalEvaluationV3Result["limitations"];
  readonly verdict: FollowerStrategyVerdict;
}

export interface DeterministicEvidenceReport {
  readonly schemaVersion: typeof DETERMINISTIC_EVIDENCE_REPORT_SCHEMA_VERSION;
  readonly artifactId: string;
  readonly provenance: {
    readonly snapshotId: string;
    readonly sourceDbIdentity: string;
    readonly sourceSchemaVersion: string;
    readonly sourceRowCounts: EvidenceSourceRowCounts;
    readonly observedSchemaMigrations: HistoricalEvaluationV3Result["provenance"]["observedSchemaMigrations"];
    readonly repositoryCommit: string;
    readonly historicalEvaluationDefinitionVersion: "HISTORICAL_EVALUATION_V3";
    readonly evaluationSchemaVersion: typeof DETERMINISTIC_EVIDENCE_REPORT_SCHEMA_VERSION;
  };
  readonly evidenceWindow: HistoricalEvaluationV3Result["window"];
  readonly evaluations: readonly DeterministicEvidenceReportEvaluation[];
  readonly cohortDiagnostics: LeaderCohortCompatibilityResult;
  readonly transparentOrdering: LeaderTransparentOrderingResult;
}

export interface BuildDeterministicEvidenceReportOptions {
  readonly repositoryCommit: string;
  readonly buckets: readonly CopyabilityBucket[];
  readonly historicalEvaluationPolicyInputs: StrategyMetricsPolicy;
  readonly failureTaxonomyPolicy: FailureTaxonomyPolicy;
  readonly temporalBlockCount: number;
  readonly followerStrategyVerdictPolicyJson: string;
}

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function canonicalJsonValue(value: unknown): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("NON_FINITE_CANONICAL_NUMBER");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : canonicalJsonValue(item),
    );
  }
  if (typeof value === "object") {
    const result: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = canonicalJsonValue(item);
    }
    return result;
  }
  throw new Error("UNSUPPORTED_CANONICAL_VALUE");
}

function canonicalBytes(value: unknown): string {
  return `${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalBytes(value)).digest("hex")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBucket(
  left: CopyabilityBucket,
  right: CopyabilityBucket,
): number {
  return (
    compareText(left.followerWallet, right.followerWallet) ||
    compareText(left.leaderWallet, right.leaderWallet) ||
    compareText(left.quoteMint, right.quoteMint)
  );
}

function canonicalBuckets(
  buckets: readonly CopyabilityBucket[],
): readonly CopyabilityBucket[] {
  const sorted = buckets.map((bucket) => ({ ...bucket })).sort(compareBucket);
  if (sorted.length === 0) throw new Error("EVALUATION_BUCKET_REQUIRED");
  for (const [index, bucket] of sorted.entries()) {
    if (
      bucket.followerWallet.length === 0 ||
      bucket.leaderWallet.length === 0 ||
      bucket.quoteMint.length === 0
    ) {
      throw new Error("INVALID_EVALUATION_BUCKET");
    }
    if (index > 0 && compareBucket(sorted[index - 1]!, bucket) === 0) {
      throw new Error("DUPLICATE_EVALUATION_BUCKET");
    }
  }
  return sorted;
}

function sourceRowCounts(
  snapshot: HistoricalEvaluationV2EvidenceSnapshot,
): EvidenceSourceRowCounts {
  return {
    roundTripApplications: snapshot.roundTripApplications.length,
    roundTripApplicationSources: snapshot.roundTripApplicationSources.length,
    paperFills: snapshot.paperFills.length,
    paperFillApplications: snapshot.paperFillApplications.length,
    jupiterAttempts: snapshot.jupiterAttempts.length,
    riskDecisions: snapshot.riskDecisions.length,
    opportunities: snapshot.opportunities.length,
    observationExclusions: snapshot.observationExclusions.length,
    observationLimitations: snapshot.observationLimitations.length,
    contextLimitations: snapshot.contextLimitations.length,
  };
}

function portableSnapshot(
  snapshot: HistoricalEvaluationV2EvidenceSnapshot,
): HistoricalEvaluationV2EvidenceSnapshot {
  return {
    ...snapshot,
    provenance: {
      ...snapshot.provenance,
      resolvedDatabasePath: CANONICAL_DATABASE_PATH,
      observedSchemaMigrations: sortSchemaMigrations(
        snapshot.provenance.observedSchemaMigrations,
      ),
    },
  };
}

function sortSchemaMigrations(
  migrations: readonly ObservedSchemaMigration[],
): readonly ObservedSchemaMigration[] {
  return migrations
    .map((migration) => ({ ...migration }))
    .sort(
      (left, right) =>
        compareText(left.version, right.version) ||
        compareText(left.checksum, right.checksum),
    );
}

function sortEvidenceSet<T>(evidence: readonly T[]): readonly T[] {
  return [...evidence].sort((left, right) =>
    compareText(canonicalBytes(left), canonicalBytes(right)),
  );
}

function sourceSnapshotIdentityMaterial(
  snapshot: HistoricalEvaluationV2EvidenceSnapshot,
): unknown {
  const { resolvedDatabasePath: _resolvedDatabasePath, ...portableProvenance } =
    snapshot.provenance;
  return {
    provenance: {
      ...portableProvenance,
      observedSchemaMigrations: sortSchemaMigrations(
        portableProvenance.observedSchemaMigrations,
      ),
    },
    roundTripApplications: sortEvidenceSet(snapshot.roundTripApplications),
    roundTripApplicationSources: sortEvidenceSet(
      snapshot.roundTripApplicationSources,
    ),
    paperFills: sortEvidenceSet(snapshot.paperFills),
    paperFillApplications: sortEvidenceSet(snapshot.paperFillApplications),
    jupiterAttempts: sortEvidenceSet(snapshot.jupiterAttempts),
    riskDecisions: sortEvidenceSet(snapshot.riskDecisions),
    opportunities: sortEvidenceSet(snapshot.opportunities),
    observationExclusions: sortEvidenceSet(snapshot.observationExclusions),
    observationLimitations: sortEvidenceSet(snapshot.observationLimitations),
    contextLimitations: sortEvidenceSet(snapshot.contextLimitations),
  };
}

function validateOptions(
  options: BuildDeterministicEvidenceReportOptions,
): void {
  if (options.repositoryCommit.trim().length === 0) {
    throw new Error("REPOSITORY_COMMIT_REQUIRED");
  }
  if (
    !Number.isSafeInteger(options.temporalBlockCount) ||
    options.temporalBlockCount <= 0
  ) {
    throw new Error("INVALID_TEMPORAL_BLOCK_COUNT");
  }
}

export function buildDeterministicEvidenceReport(
  snapshot: HistoricalEvaluationV2EvidenceSnapshot,
  options: BuildDeterministicEvidenceReportOptions,
): DeterministicEvidenceReport {
  validateOptions(options);
  const buckets = canonicalBuckets(options.buckets);
  const canonicalSnapshot = portableSnapshot(snapshot);
  const historicalResults = buckets.map((bucket) =>
    evaluateHistoricalEvaluationV3(
      canonicalSnapshot,
      bucket,
      options.historicalEvaluationPolicyInputs,
      options.failureTaxonomyPolicy,
    ),
  );
  const approvedVerdictPolicy = verifyFollowerStrategyVerdictPolicy(
    options.followerStrategyVerdictPolicyJson,
  );
  const comparabilityResults = historicalResults.map((historical) =>
    evaluateLeaderComparability(historical),
  );
  const cohortDiagnostics =
    evaluateLeaderCohortCompatibility(historicalResults);
  const reliabilityResults = historicalResults.map((historical) =>
    evaluateLeaderReliabilityDiagnosticsV2(historical, {
      temporalBlockCount: options.temporalBlockCount,
    }),
  );
  const evaluations = historicalResults.map((historical, index) => {
    const leaderComparability = comparabilityResults[index]!;
    const reliabilityDiagnostics = reliabilityResults[index]!;
    const verdict = evaluateFollowerStrategyVerdict(
      projectFollowerStrategyVerdictEvidence(
        DETERMINISTIC_EVIDENCE_REPORT_SCHEMA_VERSION,
        historical,
        leaderComparability,
        cohortDiagnostics,
        reliabilityDiagnostics,
      ),
      options.followerStrategyVerdictPolicyJson,
    );
    return {
      bucket: { ...historical.bucket },
      availability: historical.availability,
      sample: { ...historical.sample },
      leaderComparability,
      historicalEvaluationPolicyInputs: {
        ...options.historicalEvaluationPolicyInputs,
      },
      verdictPolicy: {
        policyVersion: approvedVerdictPolicy.policyVersion,
        policySha256: approvedVerdictPolicy.policySha256,
      },
      leaderMetrics: {
        status: "UNAVAILABLE",
        unavailableReason: "LEADER_ECONOMIC_EVIDENCE_UNAVAILABLE",
        metrics: null,
      },
      followerCycles: {
        definitionVersion: historical.roundTripDefinitionVersion,
        completed: historical.includedRoundTrips,
      },
      followerMetrics: historical.strategyMetrics,
      executionQuality: historical.executionQuality,
      copyabilityComponents: historical.copyability,
      costCompleteness: historical.costCompleteness,
      failureTaxonomy: historical.failureClassification,
      reliabilityDiagnostics,
      limitations: historical.limitations,
      verdict,
    } satisfies DeterministicEvidenceReportEvaluation;
  });
  const transparentOrdering = evaluateLeaderTransparentOrdering(
    cohortDiagnostics,
    historicalResults,
  );
  const sourceDbIdentity = sha256(sourceSnapshotIdentityMaterial(snapshot));
  const snapshotId = sha256({
    sourceDbIdentity,
    window: snapshot.provenance.requestedWindow,
    expectedContext: snapshot.provenance.expectedContext,
    sourceRowCounts: sourceRowCounts(snapshot),
  });
  const reportBody = {
    schemaVersion: DETERMINISTIC_EVIDENCE_REPORT_SCHEMA_VERSION,
    provenance: {
      snapshotId,
      sourceDbIdentity,
      sourceSchemaVersion: sha256(
        canonicalSnapshot.provenance.observedSchemaMigrations,
      ),
      sourceRowCounts: sourceRowCounts(canonicalSnapshot),
      observedSchemaMigrations:
        canonicalSnapshot.provenance.observedSchemaMigrations.map(
          (migration) => ({ ...migration }),
        ),
      repositoryCommit: options.repositoryCommit,
      historicalEvaluationDefinitionVersion:
        "HISTORICAL_EVALUATION_V3" as const,
      evaluationSchemaVersion: DETERMINISTIC_EVIDENCE_REPORT_SCHEMA_VERSION,
    },
    evidenceWindow: {
      windowStartMs: canonicalSnapshot.provenance.requestedWindow.windowStartMs,
      windowEndMs: canonicalSnapshot.provenance.requestedWindow.windowEndMs,
    },
    evaluations,
    cohortDiagnostics,
    transparentOrdering,
  };
  return {
    ...reportBody,
    artifactId: sha256(reportBody),
  };
}

export function serializeDeterministicEvidenceReport(
  report: DeterministicEvidenceReport,
): string {
  return canonicalBytes(report);
}

function markdownCell(value: unknown): string {
  if (value === null || value === undefined) return "UNAVAILABLE";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function metricRow(
  label: string,
  metric: {
    readonly status: string;
    readonly value?: string | number | null;
    readonly sampleCount?: number;
    readonly definitionVersion: string;
  },
): string {
  return `| ${label} | ${markdownCell(metric.status)} | ${markdownCell(metric.value)} | ${markdownCell(metric.sampleCount)} | ${markdownCell(metric.definitionVersion)} |`;
}

export function renderDeterministicEvidenceReportMarkdown(
  report: DeterministicEvidenceReport,
): string {
  const lines = [
    "# Deterministic Evidence Report V1",
    "",
    "> Research evidence only. Paper/Shadow results are not Live PnL or a trading recommendation.",
    "",
    "## Provenance",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Artifact ID | ${markdownCell(report.artifactId)} |`,
    `| Snapshot ID | ${markdownCell(report.provenance.snapshotId)} |`,
    `| Source DB identity | ${markdownCell(report.provenance.sourceDbIdentity)} |`,
    `| Source schema version | ${markdownCell(report.provenance.sourceSchemaVersion)} |`,
    `| Repository commit | ${markdownCell(report.provenance.repositoryCommit)} |`,
    `| Evaluation schema | ${markdownCell(report.schemaVersion)} |`,
    `| Historical evaluation | ${markdownCell(report.provenance.historicalEvaluationDefinitionVersion)} |`,
    "",
    "## Evidence Window",
    "",
    `- Start: ${report.evidenceWindow.windowStartMs}`,
    `- End (exclusive): ${report.evidenceWindow.windowEndMs}`,
    "",
    "## Source Row Counts",
    "",
    "| Source | Count |",
    "| --- | ---: |",
    ...Object.entries(report.provenance.sourceRowCounts).map(
      ([source, count]) => `| ${markdownCell(source)} | ${count} |`,
    ),
  ];

  for (const evaluation of report.evaluations) {
    const follower = evaluation.followerMetrics;
    const failureCounts = evaluation.failureTaxonomy.summary.categoryCounts;
    lines.push(
      "",
      `## Evaluation: ${markdownCell(evaluation.bucket.leaderWallet)} / ${markdownCell(evaluation.bucket.quoteMint)}`,
      "",
      `Follower wallet: ${markdownCell(evaluation.bucket.followerWallet)}`,
      "",
      "### Evidence Status",
      "",
      "| Evidence | Status | Reason / Detail |",
      "| --- | --- | --- |",
      `| Historical availability | ${evaluation.availability} | ${markdownCell(evaluation.limitations.length === 0 ? null : "SEE_LIMITATIONS")} |`,
      `| Sample tier | ${evaluation.sample.sampleStatus} | fullyContained=${evaluation.sample.fullyContainedCount} |`,
      `| Leader comparability | ${evaluation.leaderComparability.status} | ${markdownCell(evaluation.leaderComparability.reasons.join(", ") || null)} |`,
      `| Cost completeness | ${evaluation.costCompleteness.status} | evaluated=${evaluation.costCompleteness.evaluatedLifecycleCount} |`,
      `| Leader economics | ${evaluation.leaderMetrics.status} | ${evaluation.leaderMetrics.unavailableReason} |`,
      `| Verdict | ${evaluation.verdict.status} | ${evaluation.verdict.reasonCode} |`,
      "",
      "Historical Evaluation `minimumCompletedCycles` is descriptive metric policy input only and is not a Verdict threshold.",
      "",
      "### Follower Metrics",
      "",
      "| Metric | Status | Value | Sample Count | Definition |",
      "| --- | --- | ---: | ---: | --- |",
      metricRow("Net quote expectancy", follower.netQuoteExpectancy),
      metricRow("Win rate", follower.winRate),
      metricRow("Profit factor", follower.profitFactor),
      metricRow("Realized PnL drawdown", follower.realizedPnlDrawdown),
      metricRow("Holding time average ms", {
        ...follower.holdingTime,
        value: follower.holdingTime.averageMs,
      }),
      metricRow("Best trade contribution", follower.bestTradeContribution),
      metricRow("Best token contribution", follower.bestTokenContribution),
      "",
      "### Execution Quality",
      "",
      "```json",
      canonicalBytes(evaluation.executionQuality).trimEnd(),
      "```",
      "",
      "### Copyability Components",
      "",
      "```json",
      canonicalBytes(evaluation.copyabilityComponents).trimEnd(),
      "```",
      "",
      "### Reliability and Temporal Diagnostics",
      "",
      "```json",
      canonicalBytes(evaluation.reliabilityDiagnostics).trimEnd(),
      "```",
      "",
      "### Failure Taxonomy",
      "",
      "| Category | Count |",
      "| --- | ---: |",
      ...Object.entries(failureCounts).map(
        ([category, count]) => `| ${category} | ${count} |`,
      ),
      "",
      `Terminal failures: ${evaluation.failureTaxonomy.summary.terminalFailureCount}`,
      "",
      "Failed opportunities are excluded from follower realized-trade metrics and remain in this taxonomy.",
      "",
      "### Limitations",
      "",
      evaluation.limitations.length === 0
        ? "- None reported by HistoricalEvaluationV3."
        : [
            "```json",
            canonicalBytes(evaluation.limitations).trimEnd(),
            "```",
          ].join("\n"),
      "",
      "### Verdict",
      "",
      `- Status: ${evaluation.verdict.status}`,
      `- Reason: ${evaluation.verdict.reasonCode}`,
      `- Value: ${evaluation.verdict.value}`,
      `- Policy: ${evaluation.verdict.policyVersion}`,
      `- Policy SHA-256: ${evaluation.verdict.policySha256}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
