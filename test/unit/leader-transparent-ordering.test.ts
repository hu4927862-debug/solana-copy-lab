import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CopyabilityBucket,
  CopyabilityEvaluationContext,
} from "../../src/strategy-evaluation/copyability.js";
import {
  evaluateHistoricalEvaluation,
  type HistoricalEvaluationResult,
  type VersionedHistoricalEvaluationResult,
} from "../../src/strategy-evaluation/historical-evaluation.js";
import { evaluateLeaderCohortCompatibility } from "../../src/strategy-evaluation/leader-cohort-compatibility.js";
import type { LeaderComparabilityResult } from "../../src/strategy-evaluation/leader-comparability.js";
import {
  LEADER_RELIABILITY_DEFINITION_VERSION,
  LEADER_RELIABILITY_V2_DEFINITION_VERSION,
} from "../../src/strategy-evaluation/leader-reliability-diagnostics.js";
import { LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION } from "../../src/strategy-evaluation/leader-temporal-coverage-diagnostics.js";
import { LEADER_TEMPORAL_PERFORMANCE_DEFINITION_VERSION } from "../../src/strategy-evaluation/leader-temporal-performance-diagnostics.js";
import {
  evaluateLeaderTransparentOrdering,
  LEADER_TRANSPARENT_ORDERING_DEFINITION_VERSION,
  type LeaderTransparentOrderingResult,
} from "../../src/strategy-evaluation/leader-transparent-ordering.js";
import type { StrategyEvaluationEvidenceSnapshot } from "../../src/strategy-evaluation/read-model.js";

const WINDOW = { windowStartMs: 1_000, windowEndMs: 2_000 } as const;
const STRATEGY_METRICS_POLICY = {
  definitionVersion: "STRATEGY_METRICS_V1",
  minimumCompletedCycles: 20,
} as const;
const FAILURE_TAXONOMY_POLICY = {
  definitionVersion: "OPPORTUNITY_FAILURE_V1",
} as const;

interface HistoricalFixtureOptions {
  readonly followerWallet?: string;
  readonly leaderWallet?: string;
  readonly quoteMint?: string;
  readonly context?: Partial<CopyabilityEvaluationContext>;
  readonly expectancy?: string;
  readonly drawdown?: string | null;
  readonly drawdownStatus?: HistoricalEvaluationResult["strategyMetrics"]["realizedPnlDrawdown"]["status"];
  readonly sampleStatus?: HistoricalEvaluationResult["sample"]["sampleStatus"];
  readonly endToEndRate?: string;
  readonly databasePath?: string;
  readonly availability?: HistoricalEvaluationResult["availability"];
  readonly sampleCount?: number;
}

function historicalFixture(
  options: HistoricalFixtureOptions = {},
): HistoricalEvaluationResult {
  const bucket: CopyabilityBucket = {
    followerWallet: options.followerWallet ?? "follower-a",
    leaderWallet: options.leaderWallet ?? "leader-a",
    quoteMint: options.quoteMint ?? "SOL_NATIVE",
  };
  const evaluationContext: CopyabilityEvaluationContext = {
    window: { fromMs: WINDOW.windowStartMs, toMs: WINDOW.windowEndMs },
    source: "fixture",
    mode: "PAPER",
    copyRatioBps: 10_000,
    riskPolicyVersion: "RISK_V1",
    fillPolicyVersion: "FILL_V1",
    accountingPolicyVersion: "ACCOUNTING_V1",
    copyabilityDefinitionVersion: "COPYABILITY_V1",
    ...options.context,
  };
  const snapshot: StrategyEvaluationEvidenceSnapshot = {
    provenance: {
      resolvedDatabasePath:
        options.databasePath ??
        `/fixture/${bucket.followerWallet}-${bucket.leaderWallet}-${bucket.quoteMint}.sqlite`,
      observedSchemaMigrations: [
        { version: "0001", checksum: "sha256:fixture" },
      ],
      requestedWindow: { ...WINDOW },
      expectedContext: {
        ...evaluationContext,
        window: { ...evaluationContext.window },
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
  const baseline = evaluateHistoricalEvaluation(
    snapshot,
    bucket,
    STRATEGY_METRICS_POLICY,
    FAILURE_TAXONOMY_POLICY,
  );

  return {
    ...baseline,
    availability: options.availability ?? "AVAILABLE",
    sample: {
      ...baseline.sample,
      fullyContainedCount: options.sampleCount ?? 30,
      sampleStatus: options.sampleStatus ?? "PROVISIONAL",
    },
    strategyMetrics: {
      ...baseline.strategyMetrics,
      netQuoteExpectancy: {
        ...baseline.strategyMetrics.netQuoteExpectancy,
        value: options.expectancy ?? "1",
        sampleCount: options.sampleCount ?? 30,
        status: "AVAILABLE",
      },
      realizedPnlDrawdown: {
        ...baseline.strategyMetrics.realizedPnlDrawdown,
        value: options.drawdown === undefined ? "0" : options.drawdown,
        sampleCount: options.sampleCount ?? 30,
        status: options.drawdownStatus ?? "AVAILABLE",
      },
    },
    copyability: {
      ...baseline.copyability,
      endToEndApplication: {
        ...baseline.copyability.endToEndApplication,
        endToEndOpportunityCount: 1,
        applicationSuccessCount: options.endToEndRate === "0" ? 0 : 1,
        terminalFailureCount: options.endToEndRate === "0" ? 1 : 0,
        endToEndApplicationCompatibilityRate: options.endToEndRate ?? "1",
        preconditionCount: 1,
        evaluableCount: 1,
        coverageRate: "1",
        status: "AVAILABLE",
      },
    },
  };
}

function orderedWallets(
  historicalResults: readonly HistoricalEvaluationResult[],
): string[][][] {
  const cohort = evaluateLeaderCohortCompatibility(historicalResults);
  const result = evaluateLeaderTransparentOrdering(cohort, historicalResults);
  return result.cohorts[0]!.compatibilityGroups[0]!.orderedPrimaryGroups.map(
    (primaryGroup) =>
      primaryGroup.orderedSecondaryBusinessTieGroups.map((secondaryGroup) =>
        secondaryGroup.members.map(({ bucket }) => bucket.leaderWallet),
      ),
  );
}

function evaluateOrdering(
  historicalResults: readonly HistoricalEvaluationResult[],
): LeaderTransparentOrderingResult {
  return evaluateLeaderTransparentOrdering(
    evaluateLeaderCohortCompatibility(historicalResults),
    historicalResults,
  );
}

function collectKeys(
  value: unknown,
  keys: Set<string> = new Set(),
): Set<string> {
  if (value === null || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  for (const [key, entry] of Object.entries(value)) {
    keys.add(key);
    collectKeys(entry, keys);
  }
  return keys;
}

describe("evaluateLeaderTransparentOrdering", () => {
  it("orders one compatibility group by expectancy before drawdown", () => {
    const candidates = [
      historicalFixture({
        leaderWallet: "leader-a",
        expectancy: "1.2",
        drawdown: "100",
      }),
      historicalFixture({
        leaderWallet: "leader-b",
        expectancy: "1.1",
        drawdown: "1",
      }),
      historicalFixture({
        leaderWallet: "leader-c",
        expectancy: "1.2",
        drawdown: "50",
      }),
    ];

    expect(orderedWallets(candidates)).toEqual([
      [["leader-c"], ["leader-a"]],
      [["leader-b"]],
    ]);
  });

  it("publishes fixed descriptive methodology metadata through a two-input API", () => {
    expectTypeOf(evaluateLeaderTransparentOrdering)
      .parameter(0)
      .toEqualTypeOf<ReturnType<typeof evaluateLeaderCohortCompatibility>>();
    expectTypeOf(evaluateLeaderTransparentOrdering)
      .parameter(1)
      .toEqualTypeOf<readonly VersionedHistoricalEvaluationResult[]>();
    expectTypeOf(
      evaluateLeaderTransparentOrdering,
    ).returns.toEqualTypeOf<LeaderTransparentOrderingResult>();

    expect(evaluateOrdering([historicalFixture()])).toMatchObject({
      definitionVersion: "LEADER_TRANSPARENT_ORDERING_V1",
      purpose: "DESCRIPTIVE_HISTORICAL_STRATEGY_PERFORMANCE",
      statisticalSuperiorityStatus: "NOT_ESTABLISHED",
      multipleTestingCorrection: "NONE",
      policy: {
        primary: "PAPER_EXPECTANCY_DESC",
        secondary: "REALIZED_PNL_DRAWDOWN_ASC",
        comparison: "EXACT_PUBLISHED_METRIC_VALUES",
        orderModel: "PARTIAL_LEXICOGRAPHIC",
        tolerance: "NONE",
      },
      limitations: [
        "CONDITIONAL_ON_SUPPLIED_CANDIDATE_SET",
        "WINNERS_CURSE_NOT_CORRECTED",
        "NO_STATISTICAL_SUPERIORITY_INFERENCE",
      ],
    });
  });

  it("compares signed decimals and very large coefficients without floating collapse", () => {
    const candidates = [
      historicalFixture({
        leaderWallet: "leader-large",
        expectancy: "90071992547409931234567890",
      }),
      historicalFixture({
        leaderWallet: "leader-precise-high",
        expectancy: "1.000000000000000001",
      }),
      historicalFixture({ leaderWallet: "leader-one-one", expectancy: "1.1" }),
      historicalFixture({
        leaderWallet: "leader-one-zero-one",
        expectancy: "1.01",
      }),
      historicalFixture({ leaderWallet: "leader-one", expectancy: "1" }),
      historicalFixture({ leaderWallet: "leader-zero", expectancy: "0" }),
      historicalFixture({
        leaderWallet: "leader-negative-high",
        expectancy: "-0.1",
      }),
      historicalFixture({
        leaderWallet: "leader-negative-low",
        expectancy: "-0.2",
      }),
      historicalFixture({
        leaderWallet: "leader-negative-two",
        expectancy: "-2",
      }),
    ];
    const primaryGroups =
      evaluateOrdering(candidates).cohorts[0]!.compatibilityGroups[0]!
        .orderedPrimaryGroups;

    expect(primaryGroups.map(({ paperExpectancy }) => paperExpectancy)).toEqual(
      [
        "90071992547409931234567890",
        "1.1",
        "1.01",
        "1.000000000000000001",
        "1",
        "0",
        "-0.1",
        "-0.2",
        "-2",
      ],
    );
    expect(
      primaryGroups[4]!.orderedSecondaryBusinessTieGroups[0]!.members.map(
        ({ bucket }) => bucket.leaderWallet,
      ),
    ).toEqual(["leader-one"]);
  });

  it.each([
    "+1",
    ".1",
    "01",
    "1.",
    "1.0",
    "1.2300",
    "0.0",
    "1.000000000000000000",
    "1.1234567890123456789",
    "-0",
    "-0.0",
  ])("fails closed for invalid published expectancy %s", (expectancy) => {
    const historical = historicalFixture({ expectancy });
    const result = evaluateOrdering([historical]);

    expect(
      result.cohorts[0]!.compatibilityGroups[0]!.orderedPrimaryGroups,
    ).toEqual([]);
    expect(result.cohorts[0]!.orderingIntegrityExclusions).toMatchObject([
      {
        reason: "INVALID_PRIMARY_METRIC",
        field: "strategyMetrics.netQuoteExpectancy",
      },
    ]);
  });

  it("orders exact raw drawdown magnitudes and preserves unavailable secondary evidence", () => {
    const candidates = [
      historicalFixture({
        leaderWallet: "leader-a",
        expectancy: "2",
        drawdown: "100000000000000000000000000000",
      }),
      historicalFixture({
        leaderWallet: "leader-b",
        expectancy: "2",
        drawdown: "50",
      }),
      historicalFixture({
        leaderWallet: "leader-c",
        expectancy: "2",
        drawdown: null,
        drawdownStatus: "NO_TRADES",
      }),
      historicalFixture({
        leaderWallet: "leader-d",
        expectancy: "2",
        drawdown: null,
        drawdownStatus: "NO_TRADES",
      }),
    ];
    const primary =
      evaluateOrdering(candidates).cohorts[0]!.compatibilityGroups[0]!
        .orderedPrimaryGroups[0]!;

    expect(
      primary.orderedSecondaryBusinessTieGroups.map((group) => [
        group.realizedPnlDrawdown,
        group.members.map(({ bucket }) => bucket.leaderWallet),
      ]),
    ).toEqual([
      ["50", ["leader-b"]],
      ["100000000000000000000000000000", ["leader-a"]],
    ]);
    expect(
      primary.secondaryUnavailableMembers.map(
        ({ bucket }) => bucket.leaderWallet,
      ),
    ).toEqual(["leader-c", "leader-d"]);
  });

  it.each(["-1", "01", "1.0"])(
    "fails closed for invalid realized drawdown %s",
    (drawdown) => {
      const historical = historicalFixture({ drawdown });
      const result = evaluateOrdering([historical]);

      expect(
        result.cohorts[0]!.compatibilityGroups[0]!.orderedPrimaryGroups,
      ).toEqual([]);
      expect(result.cohorts[0]!.orderingIntegrityExclusions).toMatchObject([
        { reason: "INVALID_SECONDARY_METRIC" },
      ]);
    },
  );

  it("fails closed for inconsistent primary and secondary metric contracts", () => {
    const primaryStatus = historicalFixture({ leaderWallet: "leader-a" });
    const primaryUnit = historicalFixture({ leaderWallet: "leader-b" });
    const secondaryStatus = historicalFixture({ leaderWallet: "leader-c" });
    const cohort = evaluateLeaderCohortCompatibility([
      primaryStatus,
      primaryUnit,
      secondaryStatus,
    ]);
    const mutablePrimaryStatus = primaryStatus.strategyMetrics
      .netQuoteExpectancy as {
      value: string | null;
      status: HistoricalEvaluationResult["strategyMetrics"]["netQuoteExpectancy"]["status"];
    };
    mutablePrimaryStatus.value = null;
    mutablePrimaryStatus.status = "NO_TRADES";
    const mutablePrimaryUnit = primaryUnit.strategyMetrics
      .netQuoteExpectancy as { unit: string };
    mutablePrimaryUnit.unit = "RAW_QUOTE";
    const mutableSecondaryStatus = secondaryStatus.strategyMetrics
      .realizedPnlDrawdown as {
      value: string | null;
      status: HistoricalEvaluationResult["strategyMetrics"]["realizedPnlDrawdown"]["status"];
    };
    mutableSecondaryStatus.value = "1";
    mutableSecondaryStatus.status = "NO_TRADES";

    const result = evaluateLeaderTransparentOrdering(cohort, [
      secondaryStatus,
      primaryUnit,
      primaryStatus,
    ]);
    expect(
      result.cohorts[0]!.orderingIntegrityExclusions.map(
        ({ member, reason }) => [member.bucket.leaderWallet, reason],
      ),
    ).toEqual([
      ["leader-a", "INVALID_PRIMARY_METRIC"],
      ["leader-b", "INVALID_PRIMARY_METRIC"],
      ["leader-c", "INVALID_SECONDARY_METRIC"],
    ]);
    expect(
      result.cohorts[0]!.compatibilityGroups[0]!.orderedPrimaryGroups,
    ).toEqual([]);
  });

  it("preserves exact business ties and uses wallet text only inside the tie", () => {
    const forward = [
      historicalFixture({ leaderWallet: "leader-b", expectancy: "3" }),
      historicalFixture({ leaderWallet: "leader-a", expectancy: "3" }),
    ];
    const first = evaluateOrdering(forward);
    const second = evaluateOrdering(forward.slice().reverse());
    const members =
      first.cohorts[0]!.compatibilityGroups[0]!.orderedPrimaryGroups[0]!
        .orderedSecondaryBusinessTieGroups[0]!.members;

    expect(members.map(({ bucket }) => bucket.leaderWallet)).toEqual([
      "leader-a",
      "leader-b",
    ]);
    expect(first).toEqual(second);
  });

  it("keeps E2E 0% comparable while preserving observation-only and excluded sections", () => {
    const comparableZeroCopyability = historicalFixture({
      leaderWallet: "leader-a",
      expectancy: "-1",
      endToEndRate: "0",
    });
    const observationOnly = historicalFixture({
      leaderWallet: "leader-b",
      expectancy: "0",
      sampleStatus: "EXPLORATORY",
    });
    const excluded = historicalFixture({
      leaderWallet: "leader-c",
      expectancy: "1",
      sampleStatus: "INSUFFICIENT_SAMPLE",
    });
    const cohort = evaluateOrdering([
      excluded,
      observationOnly,
      comparableZeroCopyability,
    ]).cohorts[0]!;

    expect(
      cohort.compatibilityGroups[0]!.orderedPrimaryGroups[0]!
        .orderedSecondaryBusinessTieGroups[0]!.members[0]!.bucket.leaderWallet,
    ).toBe("leader-a");
    expect(
      cohort.observationOnlyMembers.map((member) => member.bucket.leaderWallet),
    ).toEqual(["leader-b"]);
    expect(
      cohort.excludedMembers.map((member) => member.bucket.leaderWallet),
    ).toEqual(["leader-c"]);
  });

  it("orders semantic groups and follower/quote cohorts independently", () => {
    const candidates = [
      historicalFixture({ leaderWallet: "leader-paper-a", expectancy: "1" }),
      historicalFixture({ leaderWallet: "leader-paper-b", expectancy: "2" }),
      historicalFixture({
        leaderWallet: "leader-shadow",
        expectancy: "999",
        context: { mode: "SHADOW" },
      }),
      historicalFixture({
        followerWallet: "follower-b",
        leaderWallet: "leader-other-follower",
        expectancy: "1000",
      }),
      historicalFixture({
        leaderWallet: "leader-usdc",
        quoteMint: "USDC",
        expectancy: "1001",
      }),
    ];
    const result = evaluateOrdering(candidates);

    expect(result.cohorts[0]!.incompatibilities).toHaveLength(1);

    expect(
      result.cohorts.map(({ cohort, compatibilityGroups }) => ({
        cohort,
        groups: compatibilityGroups.map((group) =>
          group.orderedPrimaryGroups.flatMap((primary) =>
            primary.orderedSecondaryBusinessTieGroups.flatMap((secondary) =>
              secondary.members.map(({ bucket }) => bucket.leaderWallet),
            ),
          ),
        ),
      })),
    ).toEqual([
      {
        cohort: { followerWallet: "follower-a", quoteMint: "SOL_NATIVE" },
        groups: [["leader-paper-b", "leader-paper-a"], ["leader-shadow"]],
      },
      {
        cohort: { followerWallet: "follower-a", quoteMint: "USDC" },
        groups: [["leader-usdc"]],
      },
      {
        cohort: { followerWallet: "follower-b", quoteMint: "SOL_NATIVE" },
        groups: [["leader-other-follower"]],
      },
    ]);
  });

  it("reports missing, duplicate, and mismatched Historical bindings without blocking valid members", () => {
    const missing = historicalFixture({ leaderWallet: "leader-missing" });
    const valid = historicalFixture({ leaderWallet: "leader-valid" });
    const cohort = evaluateLeaderCohortCompatibility([missing, valid]);
    const missingResult = evaluateLeaderTransparentOrdering(cohort, [valid]);

    expect(missingResult.cohorts[0]!.orderingIntegrityExclusions).toMatchObject(
      [{ reason: "MISSING_HISTORICAL_BINDING" }],
    );
    expect(
      missingResult.cohorts[0]!.compatibilityGroups[0]!.orderedPrimaryGroups[0]!.orderedSecondaryBusinessTieGroups[0]!.members.map(
        ({ bucket }) => bucket.leaderWallet,
      ),
    ).toEqual(["leader-valid"]);

    const duplicateCohort = evaluateLeaderCohortCompatibility([valid]);
    expect(
      evaluateLeaderTransparentOrdering(duplicateCohort, [
        valid,
        structuredClone(valid),
      ]).cohorts[0]!.orderingIntegrityExclusions,
    ).toMatchObject([{ reason: "AMBIGUOUS_HISTORICAL_BINDING" }]);

    const mismatched = structuredClone(valid);
    const mutableProvenance = mismatched.provenance as {
      resolvedDatabasePath: string;
    };
    mutableProvenance.resolvedDatabasePath = "/fixture/other-run.sqlite";
    expect(
      evaluateLeaderTransparentOrdering(duplicateCohort, [mismatched])
        .cohorts[0]!.orderingIntegrityExclusions,
    ).toMatchObject([{ reason: "HISTORICAL_REFERENCE_MISMATCH" }]);
  });

  it("preserves cohort candidate conflicts and compatibility integrity exclusions", () => {
    const conflictA = historicalFixture({
      leaderWallet: "leader-conflict",
      expectancy: "1",
    });
    const conflictB = historicalFixture({
      leaderWallet: "leader-conflict",
      expectancy: "2",
    });
    const incoherent = historicalFixture({ leaderWallet: "leader-integrity" });
    const mutableContext = incoherent.evaluationContext as {
      window: { fromMs: number; toMs: number };
    };
    mutableContext.window = { fromMs: 999, toMs: 2_000 };
    const cohort = evaluateLeaderCohortCompatibility([
      conflictA,
      conflictB,
      incoherent,
    ]);
    const result = evaluateLeaderTransparentOrdering(cohort, [
      conflictA,
      conflictB,
      incoherent,
    ]).cohorts[0]!;

    expect(result.candidateConflicts).toHaveLength(1);
    expect(result.candidateConflicts[0]!.candidate.leaderWallet).toBe(
      "leader-conflict",
    );
    expect(result.compatibilityExclusions).toHaveLength(1);
    expect(result.compatibilityExclusions[0]!.member.bucket.leaderWallet).toBe(
      "leader-integrity",
    );
    expect(result.compatibilityGroups).toEqual([]);
  });

  it("does not use sample depth, diagnostics, failure, or copyability as hidden keys", () => {
    const leaderA = historicalFixture({
      leaderWallet: "leader-a",
      expectancy: "4",
      drawdown: "7",
      sampleCount: 30,
      endToEndRate: "1",
    });
    const leaderB = historicalFixture({
      leaderWallet: "leader-b",
      expectancy: "4",
      drawdown: "7",
      sampleCount: 300,
      endToEndRate: "0",
    });
    const mutableMetrics = leaderB.strategyMetrics as {
      winRate: HistoricalEvaluationResult["strategyMetrics"]["winRate"];
      profitFactor: HistoricalEvaluationResult["strategyMetrics"]["profitFactor"];
      holdingTime: HistoricalEvaluationResult["strategyMetrics"]["holdingTime"];
      bestTradeContribution: HistoricalEvaluationResult["strategyMetrics"]["bestTradeContribution"];
      bestTokenContribution: HistoricalEvaluationResult["strategyMetrics"]["bestTokenContribution"];
    };
    mutableMetrics.winRate = { ...mutableMetrics.winRate, value: "0" };
    mutableMetrics.profitFactor = {
      ...mutableMetrics.profitFactor,
      value: "999",
      status: "AVAILABLE",
    };
    mutableMetrics.holdingTime = {
      ...mutableMetrics.holdingTime,
      averageMs: 999_999,
    };
    mutableMetrics.bestTradeContribution = {
      ...mutableMetrics.bestTradeContribution,
      value: "0.99",
      status: "AVAILABLE",
    };
    mutableMetrics.bestTokenContribution = {
      ...mutableMetrics.bestTokenContribution,
      value: "0.98",
      status: "AVAILABLE",
    };
    const mutableFailure = leaderB.failureClassification as {
      summary: HistoricalEvaluationResult["failureClassification"]["summary"];
    };
    mutableFailure.summary = {
      ...mutableFailure.summary,
      terminalFailureCount: 999,
    };

    const result = evaluateOrdering([leaderB, leaderA]);
    const members =
      result.cohorts[0]!.compatibilityGroups[0]!.orderedPrimaryGroups[0]!
        .orderedSecondaryBusinessTieGroups[0]!.members;
    expect(members.map(({ bucket }) => bucket.leaderWallet)).toEqual([
      "leader-a",
      "leader-b",
    ]);

    const keys = collectKeys(result);
    for (const forbidden of [
      "rank",
      "position",
      "leaderRank",
      "top1",
      "topN",
      "winner",
      "score",
      "grade",
      "recommendation",
      "allocation",
      "pareto",
      "confidenceInterval",
      "temporalPerformance",
      "temporalCoverage",
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });

  it("is deep-equal under reversed cohorts, groups, members, and Historical inputs", () => {
    const candidates = [
      historicalFixture({ leaderWallet: "leader-a", expectancy: "1" }),
      historicalFixture({ leaderWallet: "leader-b", expectancy: "2" }),
      historicalFixture({
        leaderWallet: "leader-shadow",
        context: { mode: "SHADOW" },
      }),
      historicalFixture({
        followerWallet: "follower-b",
        leaderWallet: "leader-c",
      }),
    ];
    const cohort = evaluateLeaderCohortCompatibility(candidates);
    const reversedCohort = {
      ...structuredClone(cohort),
      cohorts: cohort.cohorts
        .slice()
        .reverse()
        .map((entry) => ({
          ...structuredClone(entry),
          compatibilityGroups: entry.compatibilityGroups
            .slice()
            .reverse()
            .map((group) => ({
              ...structuredClone(group),
              members: group.members.slice().reverse(),
            })),
          observationOnlyMembers: entry.observationOnlyMembers
            .slice()
            .reverse(),
          excludedMembers: entry.excludedMembers.slice().reverse(),
        })),
    };

    expect(evaluateLeaderTransparentOrdering(cohort, candidates)).toEqual(
      evaluateLeaderTransparentOrdering(
        reversedCohort,
        candidates.slice().reverse(),
      ),
    );
  });

  it("defensively copies inputs and returns independent results", () => {
    const historical = historicalFixture({ expectancy: "5", drawdown: "9" });
    const cohort = evaluateLeaderCohortCompatibility([historical]);
    const first = evaluateLeaderTransparentOrdering(cohort, [historical]);
    const snapshot = structuredClone(first);
    const mutableMetric = historical.strategyMetrics.netQuoteExpectancy as {
      value: string | null;
    };
    mutableMetric.value = "999";
    const mutableMember = cohort.cohorts[0]!.compatibilityGroups[0]!
      .members[0] as LeaderComparabilityResult & {
      reasons: string[];
    };
    mutableMember.reasons.push("mutated-after-return");

    expect(first).toEqual(snapshot);

    const secondHistorical = historicalFixture({
      expectancy: "5",
      drawdown: "9",
    });
    const second = evaluateOrdering([secondHistorical]);
    const mutablePolicy = second.policy as { primary: string };
    mutablePolicy.primary = "mutated-result";
    expect(first.policy.primary).toBe("PAPER_EXPECTANCY_DESC");
  });

  it("keeps inputs and a second result isolated from nested result mutations", () => {
    const historicalResults = [
      historicalFixture({ leaderWallet: "leader-a" }),
      historicalFixture({
        leaderWallet: "leader-b",
        sampleStatus: "EXPLORATORY",
      }),
      historicalFixture({
        leaderWallet: "leader-c",
        sampleStatus: "INSUFFICIENT_SAMPLE",
      }),
    ];
    const cohort = evaluateLeaderCohortCompatibility(historicalResults);
    const historicalSnapshot = structuredClone(historicalResults);
    const cohortSnapshot = structuredClone(cohort);
    const resultA = evaluateLeaderTransparentOrdering(
      cohort,
      historicalResults,
    );
    const resultB = evaluateLeaderTransparentOrdering(
      cohort,
      historicalResults,
    );
    const resultBSnapshot = structuredClone(resultB);
    const mutableResultA = resultA as unknown as {
      policy: { primary: string };
      limitations: string[];
      cohorts: Array<{
        cohort: { followerWallet: string };
        compatibilityGroups: Array<{
          semantics: { window: { windowStartMs: number } };
          orderedPrimaryGroups: Array<{
            paperExpectancy: string;
            orderedSecondaryBusinessTieGroups: Array<{
              realizedPnlDrawdown: string;
              members: Array<{ bucket: { leaderWallet: string } }>;
            }>;
          }>;
        }>;
        observationOnlyMembers: Array<{ reasons: string[] }>;
        excludedMembers: Array<{ reasons: string[] }>;
      }>;
    };

    mutableResultA.policy.primary = "MUTATED";
    mutableResultA.limitations.push("MUTATED");
    mutableResultA.cohorts[0]!.cohort.followerWallet = "mutated-follower";
    const group = mutableResultA.cohorts[0]!.compatibilityGroups[0]!;
    group.semantics.window.windowStartMs = -1;
    group.orderedPrimaryGroups[0]!.paperExpectancy = "999";
    const secondary =
      group.orderedPrimaryGroups[0]!.orderedSecondaryBusinessTieGroups[0]!;
    secondary.realizedPnlDrawdown = "999";
    secondary.members[0]!.bucket.leaderWallet = "mutated-leader";
    mutableResultA.cohorts[0]!.observationOnlyMembers[0]!.reasons.push(
      "MUTATED",
    );
    mutableResultA.cohorts[0]!.excludedMembers[0]!.reasons.push("MUTATED");

    expect(resultB).toEqual(resultBSnapshot);
    expect(historicalResults).toEqual(historicalSnapshot);
    expect(cohort).toEqual(cohortSnapshot);
  });

  it("introduces only the Ordering definition and leaves existing definitions unchanged", () => {
    expect(LEADER_TRANSPARENT_ORDERING_DEFINITION_VERSION).toBe(
      "LEADER_TRANSPARENT_ORDERING_V1",
    );
    expect(evaluateLeaderCohortCompatibility([]).definitionVersion).toBe(
      "LEADER_COHORT_COMPATIBILITY_V1",
    );
    expect(historicalFixture().definitionVersion).toBe(
      "HISTORICAL_EVALUATION_V1",
    );
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
  });
});
