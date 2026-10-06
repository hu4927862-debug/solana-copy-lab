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
import {
  evaluateLeaderCohortCompatibility,
  type LeaderCohortCompatibilityResult,
  type LeaderComparisonCohortResult,
} from "../../src/strategy-evaluation/leader-cohort-compatibility.js";
import { evaluateLeaderComparability } from "../../src/strategy-evaluation/leader-comparability.js";
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
  readonly window?: HistoricalEvaluationResult["window"];
  readonly context?: Partial<CopyabilityEvaluationContext>;
  readonly databasePath?: string;
  readonly migrations?: HistoricalEvaluationResult["provenance"]["observedSchemaMigrations"];
  readonly sampleStatus?: HistoricalEvaluationResult["sample"]["sampleStatus"];
  readonly availability?: HistoricalEvaluationResult["availability"];
  readonly expectancy?: string;
  readonly drawdown?: string;
  readonly winRate?: string;
  readonly endToEndRate?: string;
  readonly strategyDefinitionVersion?: string;
  readonly copyabilityDefinitionVersion?: string;
  readonly failureTaxonomyDefinitionVersion?: string;
}

function historicalFixture(
  options: HistoricalFixtureOptions = {},
): HistoricalEvaluationResult {
  const bucket: CopyabilityBucket = {
    followerWallet: options.followerWallet ?? "follower-f",
    leaderWallet: options.leaderWallet ?? "leader-a",
    quoteMint: options.quoteMint ?? "SOL_NATIVE",
  };
  const window = options.window ?? WINDOW;
  const evaluationContext: CopyabilityEvaluationContext = {
    window: { fromMs: window.windowStartMs, toMs: window.windowEndMs },
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
        options.databasePath ?? `/db/${bucket.leaderWallet}.sqlite`,
      observedSchemaMigrations: options.migrations ?? [
        { version: "0001", checksum: "sha256:schema-a" },
      ],
      requestedWindow: { ...window },
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
    availability: options.availability ?? baseline.availability,
    sample: {
      ...baseline.sample,
      fullyContainedCount: 30,
      sampleStatus: options.sampleStatus ?? "PROVISIONAL",
    },
    strategyMetrics: {
      ...baseline.strategyMetrics,
      netQuoteExpectancy: {
        ...baseline.strategyMetrics.netQuoteExpectancy,
        value: options.expectancy ?? "5",
        sampleCount: 30,
        status: "AVAILABLE",
        definitionVersion:
          options.strategyDefinitionVersion ??
          baseline.strategyMetrics.netQuoteExpectancy.definitionVersion,
      },
      winRate: {
        ...baseline.strategyMetrics.winRate,
        value: options.winRate ?? "0.5",
        sampleCount: 30,
        status: "AVAILABLE",
        definitionVersion:
          options.strategyDefinitionVersion ??
          baseline.strategyMetrics.winRate.definitionVersion,
      },
      realizedPnlDrawdown: {
        ...baseline.strategyMetrics.realizedPnlDrawdown,
        value: options.drawdown ?? "2",
        sampleCount: 30,
        status: "AVAILABLE",
        definitionVersion:
          options.strategyDefinitionVersion ??
          baseline.strategyMetrics.realizedPnlDrawdown.definitionVersion,
      },
    },
    failureClassification: {
      ...baseline.failureClassification,
      definitionVersion:
        options.failureTaxonomyDefinitionVersion ??
        baseline.failureClassification.definitionVersion,
    },
    copyability: {
      ...baseline.copyability,
      definitionVersion:
        options.copyabilityDefinitionVersion ??
        baseline.copyability.definitionVersion,
      positionMapping: {
        ...baseline.copyability.positionMapping,
        definitionVersion:
          options.copyabilityDefinitionVersion ??
          baseline.copyability.positionMapping.definitionVersion,
      },
      sizeGranularity: {
        ...baseline.copyability.sizeGranularity,
        definitionVersion:
          options.copyabilityDefinitionVersion ??
          baseline.copyability.sizeGranularity.definitionVersion,
      },
      buyCapacity: {
        ...baseline.copyability.buyCapacity,
        definitionVersion:
          options.copyabilityDefinitionVersion ??
          baseline.copyability.buyCapacity.definitionVersion,
      },
      jupiterQuoteUsability: {
        ...baseline.copyability.jupiterQuoteUsability,
        definitionVersion:
          options.copyabilityDefinitionVersion ??
          baseline.copyability.jupiterQuoteUsability.definitionVersion,
      },
      postQuoteFreshness: {
        ...baseline.copyability.postQuoteFreshness,
        definitionVersion:
          options.copyabilityDefinitionVersion ??
          baseline.copyability.postQuoteFreshness.definitionVersion,
      },
      priceImpact: {
        ...baseline.copyability.priceImpact,
        definitionVersion:
          options.copyabilityDefinitionVersion ??
          baseline.copyability.priceImpact.definitionVersion,
      },
      endToEndApplication: {
        ...baseline.copyability.endToEndApplication,
        endToEndOpportunityCount: 1,
        applicationSuccessCount: 1,
        endToEndApplicationCompatibilityRate: options.endToEndRate ?? "1",
        preconditionCount: 1,
        evaluableCount: 1,
        coverageRate: "1",
        status: "AVAILABLE",
        definitionVersion:
          options.copyabilityDefinitionVersion ??
          baseline.copyability.endToEndApplication.definitionVersion,
      },
    },
  };
}

function onlyCohort(
  candidates: readonly HistoricalEvaluationResult[],
): LeaderComparisonCohortResult {
  const result = evaluateLeaderCohortCompatibility(candidates);
  expect(result.cohorts).toHaveLength(1);
  return result.cohorts[0]!;
}

describe("evaluateLeaderCohortCompatibility", () => {
  it("partitions A-G by follower and quote, then by semantic compatibility", () => {
    const windowTwo = { windowStartMs: 2_000, windowEndMs: 3_000 };
    const candidates = [
      historicalFixture({ leaderWallet: "leader-a" }),
      historicalFixture({
        leaderWallet: "leader-b",
        expectancy: "500",
        drawdown: "90",
      }),
      historicalFixture({
        followerWallet: "follower-g",
        leaderWallet: "leader-c",
      }),
      historicalFixture({ leaderWallet: "leader-d", quoteMint: "USDC" }),
      historicalFixture({ leaderWallet: "leader-e", window: windowTwo }),
      historicalFixture({
        leaderWallet: "leader-f",
        context: { mode: "SHADOW" },
      }),
      historicalFixture({
        leaderWallet: "leader-g",
        databasePath: "/db/run-b.sqlite",
      }),
    ];

    expectTypeOf(evaluateLeaderCohortCompatibility)
      .parameter(0)
      .toEqualTypeOf<readonly VersionedHistoricalEvaluationResult[]>();
    expectTypeOf(
      evaluateLeaderCohortCompatibility,
    ).returns.toEqualTypeOf<LeaderCohortCompatibilityResult>();

    const result = evaluateLeaderCohortCompatibility(candidates);
    expect(
      result.cohorts.map(({ cohort }) => [
        cohort.followerWallet,
        cohort.quoteMint,
      ]),
    ).toEqual([
      ["follower-f", "SOL_NATIVE"],
      ["follower-f", "USDC"],
      ["follower-g", "SOL_NATIVE"],
    ]);

    const followerSol = result.cohorts[0]!;
    expect(followerSol.compatibilityGroups).toHaveLength(3);
    expect(
      followerSol.compatibilityGroups.map((group) =>
        group.members.map((member) => member.bucket.leaderWallet),
      ),
    ).toEqual(
      expect.arrayContaining([
        ["leader-a", "leader-b", "leader-g"],
        ["leader-e"],
        ["leader-f"],
      ]),
    );
    expect(result.cohorts[1]!.compatibilityGroups[0]!.members).toHaveLength(1);
    expect(result.cohorts[2]!.compatibilityGroups[0]!.members).toHaveLength(1);
  });

  it("fails closed and reports duplicate candidate identity explicitly", () => {
    const duplicate = historicalFixture({ leaderWallet: "leader-a" });
    const cohort = evaluateLeaderCohortCompatibility([duplicate, duplicate])
      .cohorts[0]!;

    expect(cohort.compatibilityGroups).toEqual([]);
    expect(cohort.observationOnlyMembers).toEqual([]);
    expect(cohort.excludedMembers).toEqual([]);
    expect(cohort.candidateConflicts).toMatchObject([
      {
        candidate: {
          followerWallet: "follower-f",
          leaderWallet: "leader-a",
          quoteMint: "SOL_NATIVE",
        },
        reason: "CONFLICTING_CANDIDATE",
        occurrences: [{ status: "COMPARABLE" }, { status: "COMPARABLE" }],
      },
    ]);
  });

  it("keeps different windows in separate groups with structured differences", () => {
    const cohort = onlyCohort([
      historicalFixture({ leaderWallet: "leader-a" }),
      historicalFixture({
        leaderWallet: "leader-b",
        window: { windowStartMs: 2_000, windowEndMs: 3_000 },
      }),
    ]);

    expect(cohort.compatibilityGroups).toHaveLength(2);
    expect(cohort.incompatibilities).toHaveLength(1);
    expect(cohort.incompatibilities[0]!.reasons).toEqual([
      {
        reason: "WINDOW_MISMATCH",
        fields: ["window.windowStartMs", "window.windowEndMs"],
      },
    ]);
  });

  it.each([
    ["mode", { mode: "SHADOW" }, "evaluationContext.mode"],
    ["copy ratio", { copyRatioBps: 5_000 }, "evaluationContext.copyRatioBps"],
    [
      "Risk policy",
      { riskPolicyVersion: "RISK_V2" },
      "evaluationContext.riskPolicyVersion",
    ],
    [
      "Fill policy",
      { fillPolicyVersion: "FILL_V2" },
      "evaluationContext.fillPolicyVersion",
    ],
    [
      "Accounting policy",
      { accountingPolicyVersion: "ACCOUNTING_V2" },
      "evaluationContext.accountingPolicyVersion",
    ],
    ["source", { source: "fixture-v2" }, "evaluationContext.source"],
  ] as const)(
    "keeps a different %s in a separate semantic group",
    (_label, context, expectedField) => {
      const cohort = onlyCohort([
        historicalFixture({ leaderWallet: "leader-a" }),
        historicalFixture({ leaderWallet: "leader-b", context }),
      ]);

      expect(cohort.compatibilityGroups).toHaveLength(2);
      expect(cohort.incompatibilities[0]!.reasons).toEqual([
        { reason: "CONTEXT_MISMATCH", fields: [expectedField] },
      ]);
    },
  );

  it("keeps a different Historical evaluator definition in a separate semantic group", () => {
    const current = historicalFixture({ leaderWallet: "leader-a" });
    const future = {
      ...historicalFixture({ leaderWallet: "leader-b" }),
      definitionVersion: "HISTORICAL_EVALUATION_V2",
    } as unknown as HistoricalEvaluationResult;
    const cohort = onlyCohort([current, future]);

    expect(cohort.compatibilityGroups).toHaveLength(2);
    expect(cohort.incompatibilities[0]!.reasons).toEqual([
      {
        reason: "DEFINITION_MISMATCH",
        fields: ["historicalEvaluationDefinitionVersion"],
      },
    ]);
  });

  it.each([
    ["Strategy metrics", { strategyDefinitionVersion: "STRATEGY_V2" }],
    ["Copyability", { copyabilityDefinitionVersion: "COPYABILITY_V2" }],
    ["Failure taxonomy", { failureTaxonomyDefinitionVersion: "FAILURE_V2" }],
  ] as const)(
    "keeps a different %s definition in a separate semantic group",
    (_label, options) => {
      const cohort = onlyCohort([
        historicalFixture({ leaderWallet: "leader-a" }),
        historicalFixture({ leaderWallet: "leader-b", ...options }),
      ]);

      expect(cohort.compatibilityGroups).toHaveLength(2);
      expect(cohort.incompatibilities[0]!.reasons).toMatchObject([
        { reason: "DEFINITION_MISMATCH" },
      ]);
    },
  );

  it("requires both migration version and checksum to match", () => {
    const cohort = onlyCohort([
      historicalFixture({ leaderWallet: "leader-a" }),
      historicalFixture({
        leaderWallet: "leader-b",
        migrations: [{ version: "0001", checksum: "sha256:schema-b" }],
      }),
    ]);

    expect(cohort.compatibilityGroups).toHaveLength(2);
    expect(cohort.incompatibilities[0]!.reasons).toEqual([
      {
        reason: "PROVENANCE_MISMATCH",
        fields: ["provenance.observedSchemaMigrations"],
      },
    ]);
  });

  it("fails closed when public window provenance is internally incoherent", () => {
    const historical = historicalFixture({ leaderWallet: "leader-a" });
    const incoherent = {
      ...historical,
      provenance: {
        ...historical.provenance,
        requestedWindow: { windowStartMs: 2_000, windowEndMs: 3_000 },
      },
    };
    const cohort = onlyCohort([incoherent]);

    expect(cohort.compatibilityGroups).toEqual([]);
    expect(cohort.compatibilityExclusions).toMatchObject([
      {
        member: { bucket: { leaderWallet: "leader-a" } },
        reasons: [
          {
            reason: "PROVENANCE_MISMATCH",
            fields: ["provenance.requestedWindow"],
          },
        ],
      },
    ]);
  });

  it("ignores physical database path and metric values when grouping", () => {
    const cohort = onlyCohort([
      historicalFixture({
        leaderWallet: "leader-a",
        databasePath: "/db/run-a.sqlite",
        expectancy: "-100",
        drawdown: "900",
        winRate: "0.1",
        endToEndRate: "0",
      }),
      historicalFixture({
        leaderWallet: "leader-b",
        databasePath: "/db/run-b.sqlite",
        expectancy: "999",
        drawdown: "0",
        winRate: "1",
        endToEndRate: "1",
      }),
    ]);

    expect(cohort.compatibilityGroups).toHaveLength(1);
    expect(
      cohort.compatibilityGroups[0]!.members.map(
        (member) => member.bucket.leaderWallet,
      ),
    ).toEqual(["leader-a", "leader-b"]);
  });

  it("keeps lifecycle timing evidence out of the semantic compatibility key", () => {
    const leaderA = historicalFixture({ leaderWallet: "leader-a" });
    const leaderB = historicalFixture({ leaderWallet: "leader-b" });
    const cohort = onlyCohort([
      {
        ...leaderA,
        includedLifecycleSourceTimingEvidence: [
          {
            ...leaderA.bucket,
            tokenMint: "TOKEN_A",
            openFillId: "open-a",
            closeFillId: "close-a",
            openSourceTimestampMs: 1_100,
            closeSourceTimestampMs: 1_200,
          },
        ],
      },
      {
        ...leaderB,
        includedLifecycleSourceTimingEvidence: [
          {
            ...leaderB.bucket,
            tokenMint: "TOKEN_B",
            openFillId: "open-b",
            closeFillId: "close-b",
            openSourceTimestampMs: 1_700,
            closeSourceTimestampMs: 1_900,
          },
        ],
      },
    ]);

    expect(cohort.compatibilityGroups).toHaveLength(1);
    expect(
      cohort.compatibilityGroups[0]!.members.map(
        (member) => member.bucket.leaderWallet,
      ),
    ).toEqual(["leader-a", "leader-b"]);
  });

  it("preserves observation-only and not-comparable members from the single-result gate", () => {
    const observation = historicalFixture({
      leaderWallet: "leader-observation",
      sampleStatus: "EXPLORATORY",
    });
    const excluded = historicalFixture({
      leaderWallet: "leader-excluded",
      sampleStatus: "INSUFFICIENT_SAMPLE",
    });
    const comparable = historicalFixture({ leaderWallet: "leader-comparable" });
    const cohort = onlyCohort([observation, excluded, comparable]);

    expect(cohort.compatibilityGroups[0]!.members).toEqual([
      evaluateLeaderComparability(comparable),
    ]);
    expect(cohort.observationOnlyMembers).toEqual([
      evaluateLeaderComparability(observation),
    ]);
    expect(cohort.excludedMembers).toEqual([
      evaluateLeaderComparability(excluded),
    ]);
  });

  it("retains a single comparable member without downgrading it", () => {
    const cohort = onlyCohort([
      historicalFixture({ leaderWallet: "leader-single" }),
    ]);

    expect(cohort.compatibilityGroups).toHaveLength(1);
    expect(cohort.compatibilityGroups[0]!.members).toMatchObject([
      { status: "COMPARABLE", bucket: { leaderWallet: "leader-single" } },
    ]);
  });

  it("fails closed for conflicting runs of the same candidate identity", () => {
    const cohort = onlyCohort([
      historicalFixture({ leaderWallet: "leader-a" }),
      historicalFixture({
        leaderWallet: "leader-a",
        window: { windowStartMs: 2_000, windowEndMs: 3_000 },
      }),
    ]);

    expect(cohort.compatibilityGroups).toEqual([]);
    expect(cohort.candidateConflicts).toMatchObject([
      {
        candidate: { leaderWallet: "leader-a" },
        reason: "CONFLICTING_CANDIDATE",
        occurrences: [{ status: "COMPARABLE" }, { status: "COMPARABLE" }],
      },
    ]);
  });

  it("uses only lexical display ordering and is invariant to reversed input", () => {
    const candidates = [
      historicalFixture({
        followerWallet: "follower-z",
        leaderWallet: "leader-z",
      }),
      historicalFixture({ leaderWallet: "leader-z" }),
      historicalFixture({ leaderWallet: "leader-a" }),
      historicalFixture({ leaderWallet: "leader-m" }),
      historicalFixture({
        leaderWallet: "leader-observation",
        sampleStatus: "EXPLORATORY",
      }),
    ];
    const forward = evaluateLeaderCohortCompatibility(candidates);
    const reversed = evaluateLeaderCohortCompatibility(
      candidates.slice().reverse(),
    );

    expect(reversed).toEqual(forward);
    expect(
      forward.cohorts[0]!.compatibilityGroups[0]!.members.map(
        (member) => member.bucket.leaderWallet,
      ),
    ).toEqual(["leader-a", "leader-m", "leader-z"]);
  });

  it("defensively copies cohort, semantic metadata, members, and arrays", () => {
    const historical = historicalFixture({ leaderWallet: "leader-a" });
    const input = [historical];
    const first = evaluateLeaderCohortCompatibility(input);
    const second = evaluateLeaderCohortCompatibility(input);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.cohorts).not.toBe(second.cohorts);
    expect(first.cohorts[0]!.compatibilityGroups).not.toBe(
      second.cohorts[0]!.compatibilityGroups,
    );

    input.push(historicalFixture({ leaderWallet: "leader-late" }));
    const mutableHistorical = historical as unknown as {
      bucket: { leaderWallet: string };
      evaluationContext: { mode: string };
      provenance: {
        observedSchemaMigrations: Array<{ version: string; checksum: string }>;
      };
    };
    mutableHistorical.bucket.leaderWallet = "mutated";
    mutableHistorical.evaluationContext.mode = "SHADOW";
    mutableHistorical.provenance.observedSchemaMigrations[0]!.checksum =
      "mutated";

    expect(first.cohorts).toHaveLength(1);
    expect(first.cohorts[0]!.cohort).toEqual({
      followerWallet: "follower-f",
      quoteMint: "SOL_NATIVE",
    });
    expect(first.cohorts[0]!.compatibilityGroups[0]!).toMatchObject({
      semantics: {
        evaluationContext: { mode: "PAPER" },
        observedSchemaMigrations: [
          { version: "0001", checksum: "sha256:schema-a" },
        ],
      },
      members: [{ bucket: { leaderWallet: "leader-a" } }],
    });
  });

  it("exposes no business-ordering, numeric assessment, or metric-value fields", () => {
    const result = evaluateLeaderCohortCompatibility([
      historicalFixture({ leaderWallet: "leader-a" }),
      historicalFixture({ leaderWallet: "leader-b" }),
    ]);
    const keys: string[] = [];
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        visit(child);
      }
    };
    visit(result);

    for (const forbiddenField of [
      "rank",
      "ranking",
      "score",
      "leaderScore",
      "compatibilityScore",
      "grade",
      "tieGroups",
      "expectancy",
      "drawdown",
      "winRateValue",
      "endToEndRate",
    ]) {
      expect(keys).not.toContain(forbiddenField);
    }
  });
});
