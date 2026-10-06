import { describe, expect, it } from "vitest";
import { evaluateHistoricalEvaluation } from "../../src/strategy-evaluation/historical-evaluation.js";
import { evaluateLeaderReliabilityDiagnostics } from "../../src/strategy-evaluation/leader-reliability-diagnostics.js";
import type { StrategyEvaluationEvidenceSnapshot } from "../../src/strategy-evaluation/read-model.js";
import type { FollowerFillApplicationEvidence } from "../../src/strategy-evaluation/round-trips.js";

const WINDOW = { windowStartMs: 1_000, windowEndMs: 5_000 } as const;
const BUCKET = {
  followerWallet: "follower-a",
  leaderWallet: "leader-a",
  quoteMint: "SOL_NATIVE",
} as const;
const STRATEGY_METRICS_POLICY = {
  definitionVersion: "STRATEGY_METRICS_V1",
  minimumCompletedCycles: 20,
} as const;
const FAILURE_TAXONOMY_POLICY = {
  definitionVersion: "OPPORTUNITY_FAILURE_V1",
} as const;

function application(
  tokenMint: string,
  fillId: string,
  overrides: Partial<FollowerFillApplicationEvidence>,
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
    quoteTimestampMs: 99_999,
    ...overrides,
  };
}

function lifecycle(
  tokenMint: string,
  suffix: string,
  realizedPnlQuoteRaw: bigint,
  scope: Partial<FollowerFillApplicationEvidence> = {},
): readonly FollowerFillApplicationEvidence[] {
  return [
    application(tokenMint, `open-${suffix}`, scope),
    application(tokenMint, `close-${suffix}`, {
      ...scope,
      side: "SELL",
      transition: "CLOSE",
      inputAmountRaw: 10n,
      outputAmountRaw: 100n + realizedPnlQuoteRaw,
      quantityBeforeRaw: 10n,
      quantityAfterRaw: 0n,
      allocatedCostBasisRaw: 100n,
      proceedsRaw: 100n + realizedPnlQuoteRaw,
      realizedPnlDeltaRaw: realizedPnlQuoteRaw,
      positionVersionAfter: 2,
    }),
  ];
}

function snapshot(): StrategyEvaluationEvidenceSnapshot {
  const roundTripApplications = [
    ...lifecycle("TOKEN_A", "a", 25n),
    ...lifecycle("TOKEN_B", "b", -10n),
  ];
  return {
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
    roundTripApplications,
    roundTripApplicationSources: [
      source("open-a", 1_000),
      source("close-a", 2_000),
      source("open-b", 3_000),
      source("close-b", 4_500),
    ],
    paperFills: [],
    paperFillApplications: [],
    jupiterAttempts: [],
    riskDecisions: [],
    opportunities: [],
    observationExclusions: [],
    observationLimitations: [],
    contextLimitations: [],
  };
}

function source(fillId: string, valueMs: number) {
  return {
    fillId,
    executionKey: `execution-${fillId}`,
    leaderTradeId: `leader-trade-${fillId}`,
    sourceTimestamp: {
      valueMs,
      precision: "MILLISECOND" as const,
      provenance: "CHAIN_BLOCK_TIME" as const,
    },
  };
}

function evaluate(evidence: StrategyEvaluationEvidenceSnapshot = snapshot()) {
  return evaluateHistoricalEvaluation(
    evidence,
    BUCKET,
    STRATEGY_METRICS_POLICY,
    FAILURE_TAXONOMY_POLICY,
  );
}

describe("Historical reliability evidence projection", () => {
  it("projects authoritative OPEN and CLOSE source times for included lifecycles", () => {
    const result = evaluate();

    expect(result).toHaveProperty("includedLifecycleSourceTimingEvidence", [
      {
        ...BUCKET,
        tokenMint: "TOKEN_A",
        openFillId: "open-a",
        closeFillId: "close-a",
        openSourceTimestampMs: 1_000,
        closeSourceTimestampMs: 2_000,
      },
      {
        ...BUCKET,
        tokenMint: "TOKEN_B",
        openFillId: "open-b",
        closeFillId: "close-b",
        openSourceTimestampMs: 3_000,
        closeSourceTimestampMs: 4_500,
      },
    ]);
  });

  it("projects one included lifecycle without copying its economics", () => {
    const evidence = snapshot();
    const onlyA = evaluate({
      ...evidence,
      roundTripApplications: evidence.roundTripApplications.filter(
        ({ fillId }) => fillId.endsWith("-a"),
      ),
      roundTripApplicationSources: evidence.roundTripApplicationSources.filter(
        ({ fillId }) => fillId.endsWith("-a"),
      ),
    });

    expect(onlyA.includedLifecycleSourceTimingEvidence).toHaveLength(1);
    expect(
      Object.keys(onlyA.includedLifecycleSourceTimingEvidence[0]!),
    ).toEqual([
      "followerWallet",
      "leaderWallet",
      "tokenMint",
      "quoteMint",
      "openFillId",
      "closeFillId",
      "openSourceTimestampMs",
      "closeSourceTimestampMs",
    ]);
    expect(onlyA.includedLifecycleSourceTimingEvidence[0]).not.toHaveProperty(
      "realizedPnlQuoteRaw",
    );
    expect(onlyA.includedRoundTrips[0]!.realizedPnlQuoteRaw).toBe(25n);
  });

  it("keeps boundary-censored and incomplete lifecycles out of the timing projection", () => {
    const base = snapshot();
    const closeAtWindowEnd = evaluate({
      ...base,
      roundTripApplicationSources: base.roundTripApplicationSources.map(
        (item) => (item.fillId === "close-b" ? source("close-b", 5_000) : item),
      ),
    });
    const leftCensored = evaluate({
      ...base,
      roundTripApplicationSources: base.roundTripApplicationSources.map(
        (item) => (item.fillId === "open-a" ? source("open-a", 999) : item),
      ),
    });
    const preWindowOpen = evaluate({
      ...base,
      roundTripApplications: [base.roundTripApplications[0]!],
      roundTripApplicationSources: [source("open-a", 999)],
    });
    const inWindowIncomplete = evaluate({
      ...base,
      roundTripApplications: [base.roundTripApplications[0]!],
      roundTripApplicationSources: [source("open-a", 1_000)],
    });

    expect(closeAtWindowEnd.includedLifecycleSourceTimingEvidence).toEqual([
      expect.objectContaining({ openFillId: "open-a" }),
    ]);
    expect(closeAtWindowEnd.sample.rightCensoredCount).toBe(1);
    expect(leftCensored.includedLifecycleSourceTimingEvidence).toEqual([
      expect.objectContaining({ openFillId: "open-b" }),
    ]);
    expect(leftCensored.sample.leftCensoredCount).toBe(1);
    expect(preWindowOpen.includedLifecycleSourceTimingEvidence).toEqual([]);
    expect(preWindowOpen.sample.preWindowOpenCount).toBe(1);
    expect(inWindowIncomplete.includedLifecycleSourceTimingEvidence).toEqual(
      [],
    );
    expect(inWindowIncomplete.sample.rightCensoredCount).toBe(1);
  });

  it.each([
    [
      "missing",
      (base: StrategyEvaluationEvidenceSnapshot) =>
        base.roundTripApplicationSources.filter(
          ({ fillId }) => fillId !== "close-a",
        ),
    ],
    [
      "duplicate",
      (base: StrategyEvaluationEvidenceSnapshot) => [
        ...base.roundTripApplicationSources,
        source("close-a", 2_000),
      ],
    ],
    [
      "non-authoritative",
      (base: StrategyEvaluationEvidenceSnapshot) =>
        base.roundTripApplicationSources.map((item) =>
          item.fillId === "close-a"
            ? {
                ...item,
                sourceTimestamp: {
                  valueMs: 2_000,
                  precision: "MILLISECOND" as const,
                  provenance: "UNKNOWN" as const,
                },
              }
            : item,
        ),
    ],
  ] as const)(
    "fails closed when exact source evidence is %s",
    (_case, alter) => {
      const base = snapshot();
      const result = evaluate({
        ...base,
        roundTripApplicationSources: alter(base),
      });

      expect(result.includedLifecycleSourceTimingEvidence).toEqual([
        expect.objectContaining({ openFillId: "open-b" }),
      ]);
      expect(result).toMatchObject({
        availability: "LIMITED",
        sample: { fullyContainedCount: 1, sourceUnavailableCount: 1 },
        limitations: [
          {
            reason: "SOURCE_UNAVAILABLE",
            lifecycleStatus: "COMPLETED",
            openFillId: "open-a",
            unavailableFillIds: ["close-a"],
          },
        ],
      });
    },
  );

  it("uses normalized authoritative valueMs without substituting application time or guessing units", () => {
    const base = snapshot();
    const result = evaluate({
      ...base,
      roundTripApplicationSources: base.roundTripApplicationSources.map(
        (item) =>
          item.fillId === "open-a"
            ? {
                ...item,
                sourceTimestamp: {
                  valueMs: 1_000,
                  precision: "SECOND" as const,
                  provenance: "CHAIN_BLOCK_TIME" as const,
                },
              }
            : item,
      ),
    });

    expect(base.roundTripApplications[0]!.quoteTimestampMs).toBe(99_999);
    expect(
      result.includedLifecycleSourceTimingEvidence[0]!.openSourceTimestampMs,
    ).toBe(1_000);
  });

  it.each([
    ["follower", { followerWallet: "other-follower" }],
    ["leader", { leaderWallet: "other-leader" }],
    ["quote", { quoteMint: "USDC" }],
  ] as const)("isolates cross-%s lifecycle timing", (_scope, override) => {
    const base = snapshot();
    const suffix = `foreign-${_scope}`;
    const result = evaluate({
      ...base,
      roundTripApplications: [
        ...base.roundTripApplications,
        ...lifecycle("TOKEN_FOREIGN", suffix, 500n, override),
      ],
      roundTripApplicationSources: [
        ...base.roundTripApplicationSources,
        source(`open-${suffix}`, 1_500),
        source(`close-${suffix}`, 2_500),
      ],
    });

    expect(
      result.includedLifecycleSourceTimingEvidence.map(
        ({ openFillId }) => openFillId,
      ),
    ).toEqual(["open-a", "open-b"]);
  });

  it("orders by authoritative OPEN source time with stable fill-id tie-breakers and is reversal-deterministic", () => {
    const base = snapshot();
    const tied = {
      ...base,
      roundTripApplicationSources: base.roundTripApplicationSources.map(
        (item) => (item.fillId === "open-b" ? source("open-b", 1_000) : item),
      ),
    };
    const reversed = {
      ...tied,
      roundTripApplications: [...tied.roundTripApplications].reverse(),
      roundTripApplicationSources: [
        ...tied.roundTripApplicationSources,
      ].reverse(),
    };

    expect(evaluate(reversed)).toEqual(evaluate(tied));
    expect(
      evaluate(tied).includedLifecycleSourceTimingEvidence.map(
        ({ openFillId }) => openFillId,
      ),
    ).toEqual(["open-a", "open-b"]);
  });

  it("defensively separates timing evidence from snapshot sources, included round trips, and other results", () => {
    const evidence = snapshot();
    const first = evaluate(evidence);
    const second = evaluate(evidence);
    const expected = structuredClone(
      second.includedLifecycleSourceTimingEvidence,
    );

    (
      evidence.roundTripApplicationSources[0]!.sourceTimestamp as {
        valueMs: number;
      }
    ).valueMs = 4_999;
    (
      evidence.roundTripApplicationSources as Array<
        (typeof evidence.roundTripApplicationSources)[number]
      >
    ).reverse();
    (
      evidence.roundTripApplications as FollowerFillApplicationEvidence[]
    ).reverse();

    expect(first.includedLifecycleSourceTimingEvidence).toEqual(expected);

    (first.includedRoundTrips[0] as { openFillId: string }).openFillId =
      "mutated-round-trip";
    expect(first.includedLifecycleSourceTimingEvidence).toEqual(expected);

    (
      first.includedLifecycleSourceTimingEvidence[0] as {
        openSourceTimestampMs: number;
      }
    ).openSourceTimestampMs = 4_999;

    expect(second.includedLifecycleSourceTimingEvidence).toEqual(expected);
    expect(first.includedRoundTrips[0]!.openFillId).toBe("mutated-round-trip");
  });

  it("adds timing metadata without changing historical analytics or definition versions", () => {
    const base = snapshot();
    const shifted = {
      ...base,
      roundTripApplicationSources: base.roundTripApplicationSources.map(
        (item) => ({
          ...item,
          sourceTimestamp: {
            ...item.sourceTimestamp,
            valueMs: item.sourceTimestamp.valueMs! + 100,
          },
        }),
      ),
    };
    const before = evaluate(base);
    const after = evaluate(shifted);

    expect(after.includedRoundTrips).toEqual(before.includedRoundTrips);
    expect(after.sample).toEqual(before.sample);
    expect(after.strategyMetrics).toEqual(before.strategyMetrics);
    expect(after.executionQuality).toEqual(before.executionQuality);
    expect(after.failureClassification).toEqual(before.failureClassification);
    expect(after.copyability).toEqual(before.copyability);
    expect(after.definitionVersion).toBe("HISTORICAL_EVALUATION_V1");
    expect(after.strategyMetricSemantics).toBe("PAPER_EXPECTANCY");
    expect(after.strategyMetrics.netQuoteExpectancy.sampleCount).toBe(2);
  });

  it("does not change frozen Reliability V1 diagnostics before a future calculator consumes timing", () => {
    const historical = evaluate();
    const shiftedTiming = {
      ...historical,
      includedLifecycleSourceTimingEvidence:
        historical.includedLifecycleSourceTimingEvidence.map((timing) => ({
          ...timing,
          openSourceTimestampMs: timing.openSourceTimestampMs + 100,
          closeSourceTimestampMs: timing.closeSourceTimestampMs + 100,
        })),
    };

    expect(evaluateLeaderReliabilityDiagnostics(shiftedTiming)).toEqual(
      evaluateLeaderReliabilityDiagnostics(historical),
    );
    expect(
      evaluateLeaderReliabilityDiagnostics(historical).definitionVersion,
    ).toBe("LEADER_RELIABILITY_DIAGNOSTICS_V1");
  });

  it("contains lifecycle economics and authoritative timing at the Historical result boundary only", () => {
    const result = evaluate();
    const economicsByLifecycle = new Map(
      result.includedRoundTrips.map((cycle) => [
        `${cycle.openFillId}:${cycle.closeFillId}`,
        cycle.realizedPnlQuoteRaw,
      ]),
    );

    expect(
      result.includedLifecycleSourceTimingEvidence.map((timing) => ({
        openFillId: timing.openFillId,
        closeFillId: timing.closeFillId,
        openSourceTimestampMs: timing.openSourceTimestampMs,
        closeSourceTimestampMs: timing.closeSourceTimestampMs,
        realizedPnlQuoteRaw: economicsByLifecycle.get(
          `${timing.openFillId}:${timing.closeFillId}`,
        ),
      })),
    ).toEqual([
      {
        openFillId: "open-a",
        closeFillId: "close-a",
        openSourceTimestampMs: 1_000,
        closeSourceTimestampMs: 2_000,
        realizedPnlQuoteRaw: 25n,
      },
      {
        openFillId: "open-b",
        closeFillId: "close-b",
        openSourceTimestampMs: 3_000,
        closeSourceTimestampMs: 4_500,
        realizedPnlQuoteRaw: -10n,
      },
    ]);
  });
});
