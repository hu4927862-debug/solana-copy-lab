import { describe, expect, it } from "vitest";
import { evaluateHistoricalEvaluation as evaluateHistoricalEvaluationWithFailurePolicy } from "../../src/strategy-evaluation/historical-evaluation.js";
import type {
  StrategyEvaluationEvidenceSnapshot,
  StrategyEvaluationReadLimitation,
} from "../../src/strategy-evaluation/read-model.js";
import type { FollowerFillApplicationEvidence } from "../../src/strategy-evaluation/round-trips.js";
import type { CopyabilityBucket } from "../../src/strategy-evaluation/copyability.js";

const WINDOW = { windowStartMs: 1_000, windowEndMs: 5_000 } as const;
const BUCKET = {
  followerWallet: "follower-wallet",
  leaderWallet: "leader-wallet",
  quoteMint: "SOL_NATIVE",
} as const;
const STRATEGY_METRICS_POLICY = {
  definitionVersion: "STRATEGY_METRICS_V1",
  minimumCompletedCycles: 20,
} as const;
const FAILURE_TAXONOMY_POLICY = {
  definitionVersion: "OPPORTUNITY_FAILURE_V1",
} as const;

function evaluateHistoricalEvaluation(
  evidenceSnapshot: StrategyEvaluationEvidenceSnapshot,
  bucket: CopyabilityBucket,
  strategyMetricsPolicy: typeof STRATEGY_METRICS_POLICY,
) {
  return evaluateHistoricalEvaluationWithFailurePolicy(
    evidenceSnapshot,
    bucket,
    strategyMetricsPolicy,
    FAILURE_TAXONOMY_POLICY,
  );
}

function openApplication(
  tokenMint: string,
  fillId: string,
  overrides: Partial<FollowerFillApplicationEvidence> = {},
): FollowerFillApplicationEvidence {
  return {
    ...BUCKET,
    tokenMint,
    fillId,
    side: "BUY",
    transition: "OPEN",
    inputAmountRaw: 100n,
    outputAmountRaw: 10n,
    quantityBeforeRaw: 0n,
    quantityAfterRaw: 10n,
    allocatedCostBasisRaw: 0n,
    proceedsRaw: 0n,
    realizedPnlDeltaRaw: 0n,
    positionVersionAfter: 1,
    quoteTimestampMs: 90_000,
    ...overrides,
  };
}

function closeApplication(
  tokenMint: string,
  fillId: string,
  realizedPnlDeltaRaw: bigint,
  overrides: Partial<FollowerFillApplicationEvidence> = {},
): FollowerFillApplicationEvidence {
  return {
    ...BUCKET,
    tokenMint,
    fillId,
    side: "SELL",
    transition: "CLOSE",
    inputAmountRaw: 10n,
    outputAmountRaw: 100n + realizedPnlDeltaRaw,
    quantityBeforeRaw: 10n,
    quantityAfterRaw: 0n,
    allocatedCostBasisRaw: 100n,
    proceedsRaw: 100n + realizedPnlDeltaRaw,
    realizedPnlDeltaRaw,
    positionVersionAfter: 2,
    quoteTimestampMs: 100_000,
    ...overrides,
  };
}

function snapshot(
  applications: readonly FollowerFillApplicationEvidence[],
  sourceTimes: Readonly<Record<string, number>>,
  contextLimitations: readonly StrategyEvaluationReadLimitation[] = [],
): StrategyEvaluationEvidenceSnapshot {
  return {
    provenance: {
      resolvedDatabasePath: "/evidence.sqlite",
      observedSchemaMigrations: [],
      requestedWindow: WINDOW,
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
    roundTripApplications: applications,
    roundTripApplicationSources: applications.map(({ fillId }) => ({
      fillId,
      executionKey: `execution-${fillId}`,
      leaderTradeId: `leader-trade-${fillId}`,
      sourceTimestamp: {
        valueMs: sourceTimes[fillId]!,
        precision: "MILLISECOND",
        provenance: "CHAIN_BLOCK_TIME",
      },
    })),
    paperFills: [],
    paperFillApplications: [],
    jupiterAttempts: [],
    riskDecisions: [],
    opportunities: [],
    observationExclusions: [],
    observationLimitations: [],
    contextLimitations,
  };
}

function evaluate(
  applications: readonly FollowerFillApplicationEvidence[],
  sourceTimes: Readonly<Record<string, number>>,
  bucket: CopyabilityBucket = BUCKET,
  contextLimitations: readonly StrategyEvaluationReadLimitation[] = [],
) {
  return evaluateHistoricalEvaluation(
    snapshot(applications, sourceTimes, contextLimitations),
    bucket,
    STRATEGY_METRICS_POLICY,
  );
}

function completedLifecycles(
  count: number,
  sourceTimes: Readonly<{ open: number; close: number }> = {
    open: 2_000,
    close: 3_000,
  },
): {
  readonly applications: readonly FollowerFillApplicationEvidence[];
  readonly sourceTimesByFillId: Readonly<Record<string, number>>;
} {
  const applications: FollowerFillApplicationEvidence[] = [];
  const sourceTimesByFillId: Record<string, number> = {};
  for (let index = 0; index < count; index += 1) {
    const openFillId = `open-${String(index).padStart(2, "0")}`;
    const closeFillId = `close-${String(index).padStart(2, "0")}`;
    const tokenMint = `token-${String(index).padStart(2, "0")}`;
    applications.push(
      openApplication(tokenMint, openFillId),
      closeApplication(tokenMint, closeFillId, BigInt(index + 1)),
    );
    sourceTimesByFillId[openFillId] = sourceTimes.open;
    sourceTimesByFillId[closeFillId] = sourceTimes.close;
  }
  return { applications, sourceTimesByFillId };
}

describe("evaluateHistoricalEvaluation", () => {
  it("selects only fully-contained lifecycles from authoritative source time", () => {
    const applications = [
      openApplication("token-a", "open-a"),
      closeApplication("token-a", "close-a", -25n),
      openApplication("token-b", "open-b"),
      closeApplication("token-b", "close-b", 20n),
      openApplication("token-c", "open-c"),
      openApplication("token-d", "open-d"),
      closeApplication("token-d", "close-d", 30n),
    ] as const;

    const result = evaluateHistoricalEvaluation(
      snapshot(applications, {
        "open-a": 900,
        "close-a": 2_000,
        "open-b": 1_000,
        "close-b": 3_000,
        "open-c": 4_000,
        "open-d": 2_000,
        "close-d": 4_500,
      }),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    );

    expect(result.sample).toMatchObject({
      fullyContainedCount: 2,
      leftCensoredCount: 1,
      rightCensoredCount: 1,
      sourceUnavailableCount: 0,
      sampleStatus: "INSUFFICIENT_SAMPLE",
    });
    expect(
      result.includedRoundTrips.map(({ openFillId }) => openFillId),
    ).toEqual(["open-b", "open-d"]);
    expect(result.strategyMetrics.netQuoteExpectancy).toMatchObject({
      value: "25",
      sampleCount: 2,
    });
    expect(result.strategyMetrics.holdingTime.sampleCount).toBe(2);
  });

  it("includes all completed lifecycles when all are fully contained", () => {
    const evidence = completedLifecycles(3);

    const result = evaluate(
      evidence.applications,
      evidence.sourceTimesByFillId,
    );

    expect(result.sample).toMatchObject({
      fullyContainedCount: 3,
      leftCensoredCount: 0,
      rightCensoredCount: 0,
      sourceUnavailableCount: 0,
    });
    expect(result.strategyMetrics.netQuoteExpectancy.sampleCount).toBe(3);
  });

  it("excludes all left-censored completed lifecycles from Strategy Metrics", () => {
    const evidence = completedLifecycles(3, { open: 999, close: 3_000 });

    const result = evaluate(
      evidence.applications,
      evidence.sourceTimesByFillId,
    );

    expect(result.sample).toMatchObject({
      fullyContainedCount: 0,
      leftCensoredCount: 3,
      rightCensoredCount: 0,
    });
    expect(result.strategyMetrics.netQuoteExpectancy.status).toBe("NO_TRADES");
  });

  it("excludes all in-window incomplete lifecycles as right-censored", () => {
    const applications = [
      openApplication("token-a", "open-a"),
      openApplication("token-b", "open-b"),
      openApplication("token-c", "open-c"),
    ];

    const result = evaluate(applications, {
      "open-a": 1_500,
      "open-b": 2_000,
      "open-c": 4_999,
    });

    expect(result.sample).toMatchObject({
      fullyContainedCount: 0,
      leftCensoredCount: 0,
      rightCensoredCount: 3,
    });
    expect(result.strategyMetrics.netQuoteExpectancy.sampleCount).toBe(0);
  });

  it("keeps a pre-window OPEN still active at the boundary out of the sample", () => {
    const result = evaluate(
      [openApplication("token-pre-window", "open-pre-window")],
      { "open-pre-window": 999 },
    );

    expect(result.sample).toMatchObject({
      fullyContainedCount: 0,
      rightCensoredCount: 0,
      preWindowOpenCount: 1,
    });
    expect(result.strategyMetrics.netQuoteExpectancy.sampleCount).toBe(0);
  });

  it("includes OPEN exactly at windowStart", () => {
    const evidence = completedLifecycles(1, { open: 1_000, close: 4_999 });

    expect(
      evaluate(evidence.applications, evidence.sourceTimesByFillId).sample,
    ).toMatchObject({ fullyContainedCount: 1, leftCensoredCount: 0 });
  });

  it("excludes CLOSE exactly at windowEnd", () => {
    const evidence = completedLifecycles(1, { open: 1_000, close: 5_000 });

    const result = evaluate(
      evidence.applications,
      evidence.sourceTimesByFillId,
    );

    expect(result.sample).toMatchObject({
      fullyContainedCount: 0,
      rightCensoredCount: 1,
    });
    expect(result.strategyMetrics.netQuoteExpectancy.status).toBe("NO_TRADES");
  });

  it("marks a lifecycle LIMITED when an exact fill source is missing", () => {
    const evidence = completedLifecycles(1);

    const result = evaluate(evidence.applications, { "open-00": 2_000 });

    expect(result).toMatchObject({
      availability: "LIMITED",
      sample: {
        fullyContainedCount: 0,
        sourceUnavailableCount: 1,
      },
      limitations: [
        {
          reason: "SOURCE_UNAVAILABLE",
          lifecycleStatus: "COMPLETED",
          openFillId: "open-00",
          unavailableFillIds: ["close-00"],
        },
      ],
    });
  });

  it("requires the exact latest fill source for an incomplete lifecycle", () => {
    const applications = [
      openApplication("token-incomplete", "open-incomplete"),
      openApplication("token-incomplete", "reduce-incomplete", {
        side: "SELL",
        transition: "REDUCE",
        inputAmountRaw: 4n,
        outputAmountRaw: 50n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 6n,
        allocatedCostBasisRaw: 40n,
        proceedsRaw: 50n,
        realizedPnlDeltaRaw: 10n,
        positionVersionAfter: 2,
      }),
    ];

    const result = evaluate(applications, { "open-incomplete": 2_000 });

    expect(result).toMatchObject({
      availability: "LIMITED",
      sample: {
        rightCensoredCount: 0,
        sourceUnavailableCount: 1,
      },
      limitations: [
        {
          lifecycleStatus: "INCOMPLETE",
          openFillId: "open-incomplete",
          requiredFillIds: ["open-incomplete", "reduce-incomplete"],
          unavailableFillIds: ["reduce-incomplete"],
        },
      ],
    });
  });

  it("does not substitute a neighboring source identity for a missing fill", () => {
    const evidence = completedLifecycles(1);
    const baseSnapshot = snapshot(evidence.applications, {
      "open-00": 2_000,
      "close-00": 3_000,
    });
    const mismatched: StrategyEvaluationEvidenceSnapshot = {
      ...baseSnapshot,
      roundTripApplicationSources: baseSnapshot.roundTripApplicationSources.map(
        (source) =>
          source.fillId === "close-00"
            ? { ...source, fillId: "close-neighbor" }
            : source,
      ),
    };

    const result = evaluateHistoricalEvaluation(
      mismatched,
      BUCKET,
      STRATEGY_METRICS_POLICY,
    );

    expect(result.sample).toMatchObject({
      fullyContainedCount: 0,
      sourceUnavailableCount: 1,
    });
    expect(result.limitations[0]).toMatchObject({
      reason: "SOURCE_UNAVAILABLE",
      unavailableFillIds: ["close-00"],
    });
  });

  it("retains multiple token identities inside one evaluation bucket", () => {
    const applications = [
      openApplication("token-z", "open-z"),
      closeApplication("token-z", "close-z", 10n),
      openApplication("token-a", "open-a"),
      closeApplication("token-a", "close-a", 30n),
    ];

    const result = evaluate(applications, {
      "open-z": 2_000,
      "close-z": 3_000,
      "open-a": 2_500,
      "close-a": 4_000,
    });

    expect(result.includedRoundTrips.map(({ tokenMint }) => tokenMint)).toEqual(
      ["token-z", "token-a"],
    );
    expect(result.strategyMetrics.bestTokenContribution.bestTokenMint).toBe(
      "token-a",
    );
  });

  it.each([
    ["follower", { followerWallet: "other-follower" }],
    ["leader", { leaderWallet: "other-leader" }],
    ["quote", { quoteMint: "USDC" }],
  ] as const)("isolates cross-%s lifecycle evidence", (_scope, overrides) => {
    const applications = [
      openApplication("token-in", "open-in"),
      closeApplication("token-in", "close-in", 10n),
      openApplication("token-out", "open-out", overrides),
      closeApplication("token-out", "close-out", 500n, overrides),
    ];

    const result = evaluate(applications, {
      "open-in": 2_000,
      "close-in": 3_000,
      "open-out": 2_000,
      "close-out": 3_000,
    });

    expect(result.sample.fullyContainedCount).toBe(1);
    expect(
      result.includedRoundTrips.map(({ openFillId }) => openFillId),
    ).toEqual(["open-in"]);
    expect(result.strategyMetrics.netQuoteExpectancy.value).toBe("10");
  });

  it("applies context limitations only to their exact bucket", () => {
    const evidence = completedLifecycles(1);
    const limitations = [
      {
        ...BUCKET,
        executionKey: "execution-matching",
        reason: "CONTEXT_MODE_MISMATCH",
        expected: "PAPER",
        observed: "SHADOW",
      },
      {
        ...BUCKET,
        followerWallet: "other-follower",
        executionKey: "execution-other",
        reason: "CONTEXT_MODE_MISMATCH",
        expected: "PAPER",
        observed: "SHADOW",
      },
    ] as const;

    const result = evaluate(
      evidence.applications,
      evidence.sourceTimesByFillId,
      BUCKET,
      limitations,
    );

    expect(result.availability).toBe("LIMITED");
    expect(result.limitations).toEqual([limitations[0]]);
    expect(
      evaluate(
        evidence.applications,
        evidence.sourceTimesByFillId,
        { ...BUCKET, followerWallet: "unaffected-follower" },
        limitations,
      ),
    ).toMatchObject({ availability: "AVAILABLE", limitations: [] });
  });

  it("preserves existing no-sample Strategy Metrics semantics", () => {
    const result = evaluate([], {});

    expect(result.sample).toEqual({
      fullyContainedCount: 0,
      leftCensoredCount: 0,
      rightCensoredCount: 0,
      preWindowOpenCount: 0,
      sourceUnavailableCount: 0,
      sampleStatus: "INSUFFICIENT_SAMPLE",
    });
    expect(result.strategyMetrics).toMatchObject({
      netQuoteExpectancy: { value: null, status: "NO_TRADES" },
      winRate: { value: null, status: "NO_TRADES" },
      profitFactor: { value: null, status: "NO_TRADES" },
      holdingTime: { averageMs: null, status: "NO_TRADES" },
    });
  });

  it.each([
    [9, "INSUFFICIENT_SAMPLE"],
    [10, "EXPLORATORY"],
    [29, "EXPLORATORY"],
    [30, "PROVISIONAL"],
  ] as const)(
    "classifies %i fully-contained lifecycles as %s",
    (count, expectedStatus) => {
      const evidence = completedLifecycles(count);

      expect(
        evaluate(evidence.applications, evidence.sourceTimesByFillId).sample
          .sampleStatus,
      ).toBe(expectedStatus);
    },
  );

  it("never passes incomplete lifecycles to any Strategy Metrics denominator", () => {
    const applications = [
      openApplication("token-complete", "open-complete"),
      closeApplication("token-complete", "close-complete", 25n),
      openApplication("token-incomplete", "open-incomplete"),
    ];

    const result = evaluate(applications, {
      "open-complete": 2_000,
      "close-complete": 3_000,
      "open-incomplete": 4_000,
    });

    expect(result.sample).toMatchObject({
      fullyContainedCount: 1,
      rightCensoredCount: 1,
    });
    expect(
      Object.values(result.strategyMetrics).map(
        ({ sampleCount }) => sampleCount,
      ),
    ).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("orders lifecycle results deterministically independent of evidence order", () => {
    const applications = [
      openApplication("token-z", "open-z"),
      closeApplication("token-z", "close-z", 10n),
      openApplication("token-a", "open-a"),
      closeApplication("token-a", "close-a", 20n),
    ];
    const sourceTimes = {
      "open-z": 3_000,
      "close-z": 4_000,
      "open-a": 2_000,
      "close-a": 4_500,
    };

    const first = evaluate(applications, sourceTimes);
    const second = evaluate([...applications].reverse(), sourceTimes);

    expect(second).toEqual(first);
    expect(
      first.includedRoundTrips.map(({ openFillId }) => openFillId),
    ).toEqual(["open-a", "open-z"]);
  });

  it("preserves bigint lifecycle PnL and delegates formatting to Strategy Metrics", () => {
    const pnl = 9_007_199_254_740_993n;
    const applications = [
      openApplication("token-bigint", "open-bigint"),
      closeApplication("token-bigint", "close-bigint", pnl),
    ];

    const result = evaluate(applications, {
      "open-bigint": 2_000,
      "close-bigint": 3_000,
    });

    expect(result.includedRoundTrips[0]!.realizedPnlQuoteRaw).toBe(pnl);
    expect(result.strategyMetrics.netQuoteExpectancy.value).toBe(
      "9007199254740993",
    );
  });
});
