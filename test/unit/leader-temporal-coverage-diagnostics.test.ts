import { describe, expect, it } from "vitest";
import {
  evaluateHistoricalEvaluation,
  type HistoricalEvaluationResult,
} from "../../src/strategy-evaluation/historical-evaluation.js";
import {
  evaluateLeaderTemporalCoverageDiagnostics,
  LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION,
  LEADER_TEMPORAL_COVERAGE_MAX_BLOCK_COUNT,
  type LeaderTemporalCoverageAvailableResult,
  type LeaderTemporalCoverageDiagnosticsResult,
} from "../../src/strategy-evaluation/leader-temporal-coverage-diagnostics.js";
import {
  evaluateLeaderReliabilityDiagnostics,
  LEADER_RELIABILITY_DEFINITION_VERSION,
} from "../../src/strategy-evaluation/leader-reliability-diagnostics.js";
import type { StrategyEvaluationEvidenceSnapshot } from "../../src/strategy-evaluation/read-model.js";
import type { CompletedFollowerRoundTrip } from "../../src/strategy-evaluation/round-trips.js";

const BUCKET = {
  followerWallet: "follower-a",
  leaderWallet: "leader-a",
  quoteMint: "SOL_NATIVE",
} as const;
const WINDOW = { windowStartMs: 0, windowEndMs: 3_000 } as const;
const STRATEGY_METRICS_POLICY = {
  definitionVersion: "STRATEGY_METRICS_V1",
  minimumCompletedCycles: 20,
} as const;
const FAILURE_TAXONOMY_POLICY = {
  definitionVersion: "OPPORTUNITY_FAILURE_V1",
} as const;

function emptyHistorical(): HistoricalEvaluationResult {
  const snapshot: StrategyEvaluationEvidenceSnapshot = {
    provenance: {
      resolvedDatabasePath: "/fixture/historical.sqlite",
      observedSchemaMigrations: [],
      requestedWindow: { ...WINDOW },
      expectedContext: {
        window: { fromMs: WINDOW.windowStartMs, toMs: WINDOW.windowEndMs },
        source: "fixture",
        mode: "PAPER",
        copyRatioBps: 10_000,
        riskPolicyVersion: "RISK_V1",
        fillPolicyVersion: "FILL_V1",
        accountingPolicyVersion: "ACCOUNTING_V1",
        copyabilityDefinitionVersion: "COPYABILITY_V1",
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
  return evaluateHistoricalEvaluation(
    snapshot,
    BUCKET,
    STRATEGY_METRICS_POLICY,
    FAILURE_TAXONOMY_POLICY,
  );
}

function cycle(suffix: string): CompletedFollowerRoundTrip {
  return {
    ...BUCKET,
    tokenMint: `TOKEN_${suffix}`,
    openFillId: `open-${suffix}`,
    closeFillId: `close-${suffix}`,
    fillIds: [`open-${suffix}`, `close-${suffix}`],
    entryCostQuoteRaw: 100n,
    proceedsQuoteRaw: 100n,
    realizedPnlQuoteRaw: 0n,
    openedAtMs: 99_000,
    closedAtMs: 99_100,
    holdingTimeMs: 100,
  };
}

function historicalWithTiming(
  entries: readonly {
    readonly suffix: string;
    readonly openSourceTimestampMs: number;
    readonly closeSourceTimestampMs: number;
  }[],
): HistoricalEvaluationResult {
  const baseline = emptyHistorical();
  const includedRoundTrips = entries.map(({ suffix }) => cycle(suffix));
  return {
    ...baseline,
    sample: {
      ...baseline.sample,
      fullyContainedCount: entries.length,
    },
    includedRoundTrips,
    includedLifecycleSourceTimingEvidence: entries.map(
      ({ suffix, openSourceTimestampMs, closeSourceTimestampMs }) => ({
        ...BUCKET,
        tokenMint: `TOKEN_${suffix}`,
        openFillId: `open-${suffix}`,
        closeFillId: `close-${suffix}`,
        openSourceTimestampMs,
        closeSourceTimestampMs,
      }),
    ),
  };
}

function requireAvailable(
  result: LeaderTemporalCoverageDiagnosticsResult,
): asserts result is LeaderTemporalCoverageAvailableResult {
  expect(result.temporalEvidenceStatus).toBe("AVAILABLE");
  if (result.temporalEvidenceStatus !== "AVAILABLE") {
    throw new Error(result.unavailableReason);
  }
}

function allObjectKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(allObjectKeys);
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...allObjectKeys(child),
  ]);
}

describe("evaluateLeaderTemporalCoverageDiagnostics", () => {
  it("counts evenly distributed lifecycle OPENs and reports the lifecycle coverage envelope", () => {
    const historical = historicalWithTiming([
      { suffix: "A", openSourceTimestampMs: 100, closeSourceTimestampMs: 500 },
      {
        suffix: "B",
        openSourceTimestampMs: 1_100,
        closeSourceTimestampMs: 1_700,
      },
      {
        suffix: "C",
        openSourceTimestampMs: 2_500,
        closeSourceTimestampMs: 2_900,
      },
    ]);

    const result = evaluateLeaderTemporalCoverageDiagnostics(historical, {
      blockCount: 3,
    });

    expect(result).toMatchObject({
      temporalEvidenceStatus: "AVAILABLE",
      coverage: {
        firstIncludedOpenTimestampMs: 100,
        lastIncludedCloseTimestampMs: 2_900,
        observedLifecycleSpanMs: 2_800,
      },
      distribution: {
        blocks: [
          {
            blockIndex: 0,
            blockStartMs: 0,
            blockEndMs: 1_000,
            completedLifecycleCount: 1,
          },
          {
            blockIndex: 1,
            blockStartMs: 1_000,
            blockEndMs: 2_000,
            completedLifecycleCount: 1,
          },
          {
            blockIndex: 2,
            blockStartMs: 2_000,
            blockEndMs: 3_000,
            completedLifecycleCount: 1,
          },
        ],
      },
    });
    if (result.temporalEvidenceStatus === "AVAILABLE") {
      expect(
        result.distribution.blocks.reduce(
          (total, block) => total + block.completedLifecycleCount,
          0,
        ),
      ).toBe(historical.sample.fullyContainedCount);
      expect(historical.sample.fullyContainedCount).toBe(
        historical.includedRoundTrips.length,
      );
    }
  });

  it("fails closed when the Historical fully-contained count disagrees with included RoundTrips", () => {
    const historical = historicalWithTiming([
      { suffix: "A", openSourceTimestampMs: 100, closeSourceTimestampMs: 500 },
    ]);

    const result = evaluateLeaderTemporalCoverageDiagnostics(
      {
        ...historical,
        sample: { ...historical.sample, fullyContainedCount: 2 },
      },
      { blockCount: 3 },
    );

    expect(result).toMatchObject({
      temporalEvidenceStatus: "UNAVAILABLE",
      unavailableReason: "HISTORICAL_COUNT_INVARIANT_VIOLATION",
      coverage: {
        status: "UNAVAILABLE",
        firstIncludedOpenTimestampMs: null,
        lastIncludedCloseTimestampMs: null,
        observedLifecycleSpanMs: null,
      },
      distribution: null,
    });
  });

  it.each([
    [
      "missing timing evidence",
      (historical: HistoricalEvaluationResult): HistoricalEvaluationResult => ({
        ...historical,
        includedLifecycleSourceTimingEvidence: [],
      }),
    ],
    [
      "duplicate timing evidence",
      (historical: HistoricalEvaluationResult): HistoricalEvaluationResult => ({
        ...historical,
        includedLifecycleSourceTimingEvidence: [
          ...historical.includedLifecycleSourceTimingEvidence,
          { ...historical.includedLifecycleSourceTimingEvidence[0]! },
        ],
      }),
    ],
    [
      "orphan timing evidence",
      (historical: HistoricalEvaluationResult): HistoricalEvaluationResult => ({
        ...historical,
        includedLifecycleSourceTimingEvidence:
          historical.includedLifecycleSourceTimingEvidence.map((timing) => ({
            ...timing,
            openFillId: "orphan-open",
            closeFillId: "orphan-close",
          })),
      }),
    ],
    [
      "lifecycle identity mismatch",
      (historical: HistoricalEvaluationResult): HistoricalEvaluationResult => ({
        ...historical,
        includedLifecycleSourceTimingEvidence:
          historical.includedLifecycleSourceTimingEvidence.map((timing) => ({
            ...timing,
            tokenMint: "OTHER_TOKEN",
          })),
      }),
    ],
  ] as const)("fails closed for %s", (_case, corrupt) => {
    const historical = historicalWithTiming([
      { suffix: "A", openSourceTimestampMs: 100, closeSourceTimestampMs: 500 },
    ]);

    expect(
      evaluateLeaderTemporalCoverageDiagnostics(corrupt(historical), {
        blockCount: 3,
      }),
    ).toMatchObject({
      temporalEvidenceStatus: "UNAVAILABLE",
      unavailableReason: "TIMING_EVIDENCE_ASSOCIATION_INVARIANT_VIOLATION",
      distribution: null,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 3_001])(
    "fails closed for invalid blockCount %s",
    (blockCount) => {
      const result = evaluateLeaderTemporalCoverageDiagnostics(
        emptyHistorical(),
        { blockCount },
      );

      expect(result).toMatchObject({
        temporalEvidenceStatus: "UNAVAILABLE",
        unavailableReason: "INVALID_REPORTING_CONVENTION",
        distribution: null,
      });
    },
  );

  it("applies its documented engineering block limit independently of sample size", () => {
    const historical = emptyHistorical();
    const result = evaluateLeaderTemporalCoverageDiagnostics(
      {
        ...historical,
        window: { windowStartMs: 0, windowEndMs: 20_000 },
      },
      { blockCount: LEADER_TEMPORAL_COVERAGE_MAX_BLOCK_COUNT + 1 },
    );

    expect(result).toMatchObject({
      temporalEvidenceStatus: "UNAVAILABLE",
      unavailableReason: "INVALID_REPORTING_CONVENTION",
    });
  });

  it.each([
    ["followerWallet", "other-follower"],
    ["leaderWallet", "other-leader"],
    ["quoteMint", "USDC"],
  ] as const)(
    "fails closed for cross-bucket timing evidence by %s",
    (field, value) => {
      const historical = historicalWithTiming([
        {
          suffix: "A",
          openSourceTimestampMs: 100,
          closeSourceTimestampMs: 500,
        },
      ]);

      const result = evaluateLeaderTemporalCoverageDiagnostics(
        {
          ...historical,
          includedLifecycleSourceTimingEvidence:
            historical.includedLifecycleSourceTimingEvidence.map((timing) => ({
              ...timing,
              [field]: value,
            })),
        },
        { blockCount: 3 },
      );

      expect(result).toMatchObject({
        temporalEvidenceStatus: "UNAVAILABLE",
        unavailableReason: "BUCKET_INVARIANT_VIOLATION",
        distribution: null,
      });
    },
  );

  it.each([
    ["unsafe OPEN", Number.NaN, 500],
    ["unsafe CLOSE", 100, Number.POSITIVE_INFINITY],
    ["OPEN before window", -1, 500],
    ["OPEN at window end", 3_000, 3_000],
    ["CLOSE at window end", 100, 3_000],
    ["CLOSE before OPEN", 500, 499],
  ] as const)(
    "fails closed for %s timing evidence",
    (_case, openSourceTimestampMs, closeSourceTimestampMs) => {
      const historical = historicalWithTiming([
        {
          suffix: "A",
          openSourceTimestampMs,
          closeSourceTimestampMs,
        },
      ]);

      expect(
        evaluateLeaderTemporalCoverageDiagnostics(historical, {
          blockCount: 3,
        }),
      ).toMatchObject({
        temporalEvidenceStatus: "UNAVAILABLE",
        unavailableReason: "TIMING_EVIDENCE_INVARIANT_VIOLATION",
        distribution: null,
      });
    },
  );

  it("retains empty blocks when all lifecycle OPENs are in the first block", () => {
    const result = evaluateLeaderTemporalCoverageDiagnostics(
      historicalWithTiming([
        {
          suffix: "A",
          openSourceTimestampMs: 100,
          closeSourceTimestampMs: 2_500,
        },
        {
          suffix: "B",
          openSourceTimestampMs: 900,
          closeSourceTimestampMs: 2_900,
        },
      ]),
      { blockCount: 3 },
    );
    requireAvailable(result);

    expect(
      result.distribution.blocks.map(
        ({ completedLifecycleCount }) => completedLifecycleCount,
      ),
    ).toEqual([2, 0, 0]);
  });

  it("retains an empty middle block without merging or redistributing it", () => {
    const result = evaluateLeaderTemporalCoverageDiagnostics(
      historicalWithTiming([
        {
          suffix: "A",
          openSourceTimestampMs: 100,
          closeSourceTimestampMs: 500,
        },
        {
          suffix: "B",
          openSourceTimestampMs: 2_100,
          closeSourceTimestampMs: 2_900,
        },
      ]),
      { blockCount: 3 },
    );
    requireAvailable(result);

    expect(
      result.distribution.blocks.map(
        ({ completedLifecycleCount }) => completedLifecycleCount,
      ),
    ).toEqual([1, 0, 1]);
  });

  it("returns aligned zero-count blocks and unavailable envelope values for a zero sample", () => {
    const result = evaluateLeaderTemporalCoverageDiagnostics(
      emptyHistorical(),
      { blockCount: 3 },
    );
    requireAvailable(result);

    expect(result.coverage).toEqual({
      status: "NO_INCLUDED_LIFECYCLES",
      firstIncludedOpenTimestampMs: null,
      lastIncludedCloseTimestampMs: null,
      observedLifecycleSpanMs: null,
    });
    expect(result.distribution.blocks).toEqual([
      {
        blockIndex: 0,
        blockStartMs: 0,
        blockEndMs: 1_000,
        completedLifecycleCount: 0,
      },
      {
        blockIndex: 1,
        blockStartMs: 1_000,
        blockEndMs: 2_000,
        completedLifecycleCount: 0,
      },
      {
        blockIndex: 2,
        blockStartMs: 2_000,
        blockEndMs: 3_000,
        completedLifecycleCount: 0,
      },
    ]);
  });

  it("reports coverage and one OPEN placement for a single lifecycle", () => {
    const result = evaluateLeaderTemporalCoverageDiagnostics(
      historicalWithTiming([
        {
          suffix: "A",
          openSourceTimestampMs: 100,
          closeSourceTimestampMs: 500,
        },
      ]),
      { blockCount: 3 },
    );
    requireAvailable(result);

    expect(result.coverage).toEqual({
      status: "AVAILABLE",
      firstIncludedOpenTimestampMs: 100,
      lastIncludedCloseTimestampMs: 500,
      observedLifecycleSpanMs: 400,
    });
    expect(
      result.distribution.blocks.map(
        ({ completedLifecycleCount }) => completedLifecycleCount,
      ),
    ).toEqual([1, 0, 0]);
  });

  it.each([
    ["window start", 0, [1, 0, 0]],
    ["just before an internal boundary", 999, [1, 0, 0]],
    ["on an internal boundary", 1_000, [0, 1, 0]],
  ] as const)(
    "uses half-open block placement for an OPEN at %s",
    (_case, openSourceTimestampMs, expectedCounts) => {
      const result = evaluateLeaderTemporalCoverageDiagnostics(
        historicalWithTiming([
          { suffix: "A", openSourceTimestampMs, closeSourceTimestampMs: 1_500 },
        ]),
        { blockCount: 3 },
      );
      requireAvailable(result);

      expect(
        result.distribution.blocks.map(
          ({ completedLifecycleCount }) => completedLifecycleCount,
        ),
      ).toEqual(expectedCounts);
    },
  );

  it("places a lifecycle only by OPEN when its CLOSE spans later blocks", () => {
    const result = evaluateLeaderTemporalCoverageDiagnostics(
      historicalWithTiming([
        {
          suffix: "A",
          openSourceTimestampMs: 100,
          closeSourceTimestampMs: 2_500,
        },
      ]),
      { blockCount: 3 },
    );
    requireAvailable(result);

    expect(
      result.distribution.blocks.map(
        ({ completedLifecycleCount }) => completedLifecycleCount,
      ),
    ).toEqual([1, 0, 0]);
    expect(result.coverage.lastIncludedCloseTimestampMs).toBe(2_500);
  });

  it("assigns non-divisible remainder milliseconds to the earliest blocks", () => {
    const historical = historicalWithTiming([
      { suffix: "A", openSourceTimestampMs: 3, closeSourceTimestampMs: 3 },
      { suffix: "B", openSourceTimestampMs: 4, closeSourceTimestampMs: 4 },
      { suffix: "C", openSourceTimestampMs: 7, closeSourceTimestampMs: 9 },
    ]);
    const result = evaluateLeaderTemporalCoverageDiagnostics(
      {
        ...historical,
        window: { windowStartMs: 0, windowEndMs: 10 },
      },
      { blockCount: 3 },
    );
    requireAvailable(result);

    expect(result.distribution.blocks).toEqual([
      {
        blockIndex: 0,
        blockStartMs: 0,
        blockEndMs: 4,
        completedLifecycleCount: 1,
      },
      {
        blockIndex: 1,
        blockStartMs: 4,
        blockEndMs: 7,
        completedLifecycleCount: 1,
      },
      {
        blockIndex: 2,
        blockStartMs: 7,
        blockEndMs: 10,
        completedLifecycleCount: 1,
      },
    ]);
  });

  it("supports one block spanning the exact Historical window", () => {
    const result = evaluateLeaderTemporalCoverageDiagnostics(
      historicalWithTiming([
        {
          suffix: "A",
          openSourceTimestampMs: 2_500,
          closeSourceTimestampMs: 2_900,
        },
      ]),
      { blockCount: 1 },
    );
    requireAvailable(result);

    expect(result.distribution.blocks).toEqual([
      {
        blockIndex: 0,
        blockStartMs: 0,
        blockEndMs: 3_000,
        completedLifecycleCount: 1,
      },
    ]);
  });

  it("is invariant to reversed timing-evidence and RoundTrip order", () => {
    const historical = historicalWithTiming([
      { suffix: "A", openSourceTimestampMs: 100, closeSourceTimestampMs: 500 },
      {
        suffix: "B",
        openSourceTimestampMs: 1_100,
        closeSourceTimestampMs: 2_900,
      },
    ]);
    const expected = evaluateLeaderTemporalCoverageDiagnostics(historical, {
      blockCount: 3,
    });

    expect(
      evaluateLeaderTemporalCoverageDiagnostics(
        {
          ...historical,
          includedRoundTrips: [...historical.includedRoundTrips].reverse(),
          includedLifecycleSourceTimingEvidence: [
            ...historical.includedLifecycleSourceTimingEvidence,
          ].reverse(),
        },
        { blockCount: 3 },
      ),
    ).toEqual(expected);
    expect(
      evaluateLeaderTemporalCoverageDiagnostics(
        {
          ...historical,
          includedRoundTrips: [...historical.includedRoundTrips].reverse(),
        },
        { blockCount: 3 },
      ),
    ).toEqual(expected);
    expect(
      evaluateLeaderTemporalCoverageDiagnostics(
        {
          ...historical,
          includedLifecycleSourceTimingEvidence: [
            ...historical.includedLifecycleSourceTimingEvidence,
          ].reverse(),
        },
        { blockCount: 3 },
      ),
    ).toEqual(expected);
  });

  it("uses identical boundaries for different Leaders with the exact same window", () => {
    const leaderA = historicalWithTiming([
      { suffix: "A", openSourceTimestampMs: 100, closeSourceTimestampMs: 500 },
    ]);
    const leaderB: HistoricalEvaluationResult = {
      ...leaderA,
      bucket: { ...leaderA.bucket, leaderWallet: "leader-b" },
      includedRoundTrips: leaderA.includedRoundTrips.map((roundTrip) => ({
        ...roundTrip,
        leaderWallet: "leader-b",
      })),
      includedLifecycleSourceTimingEvidence:
        leaderA.includedLifecycleSourceTimingEvidence.map((timing) => ({
          ...timing,
          leaderWallet: "leader-b",
        })),
    };
    const resultA = evaluateLeaderTemporalCoverageDiagnostics(leaderA, {
      blockCount: 3,
    });
    const resultB = evaluateLeaderTemporalCoverageDiagnostics(leaderB, {
      blockCount: 3,
    });
    requireAvailable(resultA);
    requireAvailable(resultB);

    expect(
      resultB.distribution.blocks.map(({ blockStartMs, blockEndMs }) => ({
        blockStartMs,
        blockEndMs,
      })),
    ).toEqual(
      resultA.distribution.blocks.map(({ blockStartMs, blockEndMs }) => ({
        blockStartMs,
        blockEndMs,
      })),
    );
  });

  it("returns deterministic, defensively copied output", () => {
    const historical = historicalWithTiming([
      { suffix: "A", openSourceTimestampMs: 100, closeSourceTimestampMs: 500 },
    ]);
    const first = evaluateLeaderTemporalCoverageDiagnostics(historical, {
      blockCount: 3,
    });
    const second = evaluateLeaderTemporalCoverageDiagnostics(historical, {
      blockCount: 3,
    });
    const expected = structuredClone(first);

    expect(second).toEqual(first);
    (historical.bucket as { leaderWallet: string }).leaderWallet = "mutated";
    (
      historical.includedLifecycleSourceTimingEvidence[0] as {
        openSourceTimestampMs: number;
      }
    ).openSourceTimestampMs = 2_500;
    (historical.includedRoundTrips as CompletedFollowerRoundTrip[]).reverse();

    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
  });

  it("exposes only coverage and completed-entry distribution, with no performance or ranking fields", () => {
    const result = evaluateLeaderTemporalCoverageDiagnostics(
      historicalWithTiming([
        {
          suffix: "A",
          openSourceTimestampMs: 100,
          closeSourceTimestampMs: 500,
        },
      ]),
      { blockCount: 3 },
    );
    const normalizedKeys = allObjectKeys(result).map((key) =>
      key.replaceAll("_", "").toLowerCase(),
    );

    for (const forbidden of [
      "realizedpnl",
      "expectancy",
      "winrate",
      "profitfactor",
      "drawdown",
      "stability",
      "trend",
      "slope",
      "variance",
      "confidenceinterval",
      "bootstrap",
      "pvalue",
      "score",
      "band",
      "rank",
    ]) {
      expect(normalizedKeys.some((key) => key.includes(forbidden))).toBe(false);
    }
    expect(result.coverage).not.toHaveProperty(
      "observedLifecycleEnvelopeCoverageRatio",
    );
  });

  it("declares the reporting-only conditional semantics and engineering limit", () => {
    const result = evaluateLeaderTemporalCoverageDiagnostics(
      emptyHistorical(),
      { blockCount: 3 },
    );
    requireAvailable(result);

    expect(result).toMatchObject({
      definitionVersion: LEADER_TEMPORAL_COVERAGE_DEFINITION_VERSION,
      reference: {
        historicalEvaluationDefinitionVersion: "HISTORICAL_EVALUATION_V1",
        strategyMetricSemantics: "PAPER_EXPECTANCY",
      },
      metadata: {
        placementReference: "AUTHORITATIVE_OPEN_SOURCE_TIME",
        sampleCondition: "FULLY_CONTAINED_COMPLETED_ROUND_TRIPS_ONLY",
        emptyBlockSemantics: "NO_INCLUDED_LIFECYCLE_OPEN_IN_CALENDAR_INTERVAL",
        blockCountSelection: "EXPLICIT_CALLER_REPORTING_CONVENTION",
        blockCountUpperBound: LEADER_TEMPORAL_COVERAGE_MAX_BLOCK_COUNT,
        blockCountUpperBoundSemantics:
          "ENGINEERING_RESOURCE_LIMIT_NOT_STATISTICAL_RULE",
      },
      limitations: [
        "DESCRIPTIVE_COVERAGE_AND_ENTRY_DISTRIBUTION_ONLY",
        "BLOCK_COUNT_IS_A_REPORTING_CONVENTION_NOT_A_STATISTICAL_RULE",
      ],
    });
  });

  it("does not consume censoring or failed-opportunity evidence as block members", () => {
    const historical = historicalWithTiming([
      { suffix: "A", openSourceTimestampMs: 100, closeSourceTimestampMs: 500 },
    ]);
    const baseline = evaluateLeaderTemporalCoverageDiagnostics(historical, {
      blockCount: 3,
    });
    const unrelatedEvidenceChanged: HistoricalEvaluationResult = {
      ...historical,
      sample: {
        ...historical.sample,
        leftCensoredCount: 50,
        rightCensoredCount: 60,
        preWindowOpenCount: 70,
        sourceUnavailableCount: 80,
      },
      failureClassification: {
        ...historical.failureClassification,
        summary: {
          ...historical.failureClassification.summary,
          totalCanonicalOpportunityCount: 999,
          terminalFailureCount: 999,
        },
      },
    };

    expect(
      evaluateLeaderTemporalCoverageDiagnostics(unrelatedEvidenceChanged, {
        blockCount: 3,
      }),
    ).toEqual(baseline);
  });

  it("leaves Historical Evaluation V1 and frozen Reliability V1 unchanged", () => {
    const historical = historicalWithTiming([
      { suffix: "A", openSourceTimestampMs: 100, closeSourceTimestampMs: 500 },
    ]);
    const reliabilityBefore = evaluateLeaderReliabilityDiagnostics(historical);

    evaluateLeaderTemporalCoverageDiagnostics(historical, { blockCount: 3 });

    expect(historical.definitionVersion).toBe("HISTORICAL_EVALUATION_V1");
    expect(LEADER_RELIABILITY_DEFINITION_VERSION).toBe(
      "LEADER_RELIABILITY_DIAGNOSTICS_V1",
    );
    expect(evaluateLeaderReliabilityDiagnostics(historical)).toEqual(
      reliabilityBefore,
    );
  });
});
