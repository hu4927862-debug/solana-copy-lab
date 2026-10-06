import { describe, expect, it } from "vitest";
import {
  evaluateHistoricalEvaluation,
  evaluateHistoricalEvaluationV2,
  type HistoricalEvaluationV2EvidenceSnapshot,
} from "../../src/strategy-evaluation/historical-evaluation.js";
import { evaluateLeaderComparability } from "../../src/strategy-evaluation/leader-comparability.js";
import type { DetailedFollowerFillApplicationEvidence } from "../../src/strategy-evaluation/round-trips.js";

const WINDOW = { windowStartMs: 1_000, windowEndMs: 5_000 } as const;
const BUCKET = {
  followerWallet: "follower-a",
  leaderWallet: "leader-x",
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
  fillId: string,
  overrides: Partial<DetailedFollowerFillApplicationEvidence> = {},
): DetailedFollowerFillApplicationEvidence {
  return {
    ...BUCKET,
    tokenMint: "TOKEN_A",
    positionId: 10,
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
    quoteTimestampMs: 2_000,
    ...overrides,
  };
}

function closeApplication(
  fillId: string,
  overrides: Partial<DetailedFollowerFillApplicationEvidence> = {},
): DetailedFollowerFillApplicationEvidence {
  return application(fillId, {
    side: "SELL",
    transition: "CLOSE",
    inputAmountRaw: 10n,
    outputAmountRaw: 125n,
    quantityBeforeRaw: 10n,
    quantityAfterRaw: 0n,
    allocatedCostBasisRaw: 100n,
    proceedsRaw: 125n,
    realizedPnlDeltaRaw: 25n,
    positionVersionAfter: 2,
    quoteTimestampMs: 3_000,
    ...overrides,
  });
}

function snapshot(
  roundTripApplications: readonly DetailedFollowerFillApplicationEvidence[],
  sourceTimes: Readonly<Record<string, number | null>> = {},
): HistoricalEvaluationV2EvidenceSnapshot {
  return {
    provenance: {
      resolvedDatabasePath: "/fixture/historical-v2.sqlite",
      observedSchemaMigrations: [
        { version: "0001_fixture", checksum: "sha256:fixture" },
      ],
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
    roundTripApplicationSources: roundTripApplications.map((item) => {
      const sourceTime = sourceTimes[item.fillId];
      return {
        fillId: item.fillId,
        executionKey: `execution-${item.fillId}`,
        leaderTradeId: `leader-trade-${item.fillId}`,
        sourceTimestamp: {
          valueMs:
            sourceTime === undefined ? item.quoteTimestampMs : sourceTime,
          precision: "MILLISECOND",
          provenance: "CHAIN_BLOCK_TIME",
        },
      };
    }),
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

describe("evaluateHistoricalEvaluationV2", () => {
  it("propagates a non-monotonic fill application version continuity limitation", () => {
    const result = evaluateHistoricalEvaluationV2(
      snapshot([
        application("open-a"),
        application("close-a", {
          side: "SELL",
          transition: "CLOSE",
          inputAmountRaw: 10n,
          outputAmountRaw: 125n,
          quantityBeforeRaw: 10n,
          quantityAfterRaw: 0n,
          allocatedCostBasisRaw: 100n,
          proceedsRaw: 125n,
          realizedPnlDeltaRaw: 25n,
          positionVersionAfter: 1,
          quoteTimestampMs: 3_000,
        }),
      ]),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result).toMatchObject({
      definitionVersion: "HISTORICAL_EVALUATION_V2",
      availability: "LIMITED",
      sample: { fullyContainedCount: 0 },
      strategyMetrics: {
        netQuoteExpectancy: { value: null, status: "NO_TRADES" },
      },
      limitations: [
        {
          kind: "LIFECYCLE_UNEVALUABLE",
          source: "FOLLOWER_ROUND_TRIPS_V2",
          reason: "LIFECYCLE_CONTINUITY_VIOLATION",
          stage: "CONTINUATION",
          lifecycleIdentity: {
            ...BUCKET,
            tokenMint: "TOKEN_A",
          },
          openFillId: "open-a",
          affectedFillIds: ["open-a", "close-a"],
          evidence: [
            {
              field: "positionVersionAfter",
              expected: ">1",
              observed: "1",
            },
          ],
        },
      ],
    });
  });

  it("evaluates a valid completed lifecycle as AVAILABLE with explicit V2 provenance", () => {
    const result = evaluateHistoricalEvaluationV2(
      snapshot([application("open-a"), closeApplication("close-a")]),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result).toMatchObject({
      definitionVersion: "HISTORICAL_EVALUATION_V2",
      roundTripDefinitionVersion: "FOLLOWER_ROUND_TRIPS_V2",
      availability: "AVAILABLE",
      sample: { fullyContainedCount: 1 },
      strategyMetrics: {
        netQuoteExpectancy: {
          value: "25",
          sampleCount: 1,
          status: "AVAILABLE",
        },
      },
      limitations: [],
    });
  });

  it.each([
    {
      label: "quantity discontinuity",
      applications: [
        application("open-a"),
        closeApplication("close-a", { quantityBeforeRaw: 9n }),
      ],
      reason: "LIFECYCLE_CONTINUITY_VIOLATION",
    },
    {
      label: "application conflict",
      applications: [
        application("open-a"),
        application("open-a", { quantityAfterRaw: 11n }),
      ],
      reason: "APPLICATION_EVIDENCE_CONFLICT",
    },
    {
      label: "economic corruption",
      applications: [
        application("open-a"),
        closeApplication("close-a", { inputAmountRaw: -10n }),
      ],
      reason: "ECONOMIC_EVIDENCE_INVALID",
    },
    {
      label: "PnL invariant corruption",
      applications: [
        application("open-a"),
        closeApplication("close-a", {
          allocatedCostBasisRaw: 90n,
          realizedPnlDeltaRaw: 35n,
        }),
      ],
      reason: "CYCLE_PNL_INVARIANT_VIOLATION",
    },
  ] as const)(
    "projects $label as LIMITED and excludes it from every strategy sample",
    ({ applications, reason }) => {
      const result = evaluateHistoricalEvaluationV2(
        snapshot(applications),
        BUCKET,
        STRATEGY_METRICS_POLICY,
        FAILURE_TAXONOMY_POLICY,
      );

      expect(result).toMatchObject({
        availability: "LIMITED",
        sample: { fullyContainedCount: 0 },
        includedRoundTrips: [],
        includedLifecycleSourceTimingEvidence: [],
        strategyMetrics: {
          netQuoteExpectancy: { value: null, status: "NO_TRADES" },
          winRate: { value: null, status: "NO_TRADES" },
          profitFactor: { value: null, status: "NO_TRADES" },
          realizedPnlDrawdown: { value: null, status: "NO_TRADES" },
          holdingTime: { averageMs: null, status: "NO_TRADES" },
          bestTradeContribution: { value: null, status: "NO_TRADES" },
          bestTokenContribution: { value: null, status: "NO_TRADES" },
        },
        limitations: [{ kind: "LIFECYCLE_UNEVALUABLE", reason }],
      });
    },
  );

  it("preserves a conflicting fillId across bucket provenance in the canonical replay", () => {
    const otherBucket = { ...BUCKET, followerWallet: "follower-b" };
    const conflictA = application("shared-conflict", {
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
      quoteTimestampMs: 2_500,
    });
    const result = evaluateHistoricalEvaluationV2(
      snapshot([
        application("open-a"),
        application("open-b", { ...otherBucket, positionId: 20 }),
        conflictA,
        { ...conflictA, ...otherBucket, positionId: 20 },
      ]),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result).toMatchObject({
      availability: "LIMITED",
      sample: {
        fullyContainedCount: 0,
        rightCensoredCount: 0,
        preWindowOpenCount: 0,
      },
      includedRoundTrips: [],
      limitations: [
        {
          kind: "LIFECYCLE_UNEVALUABLE",
          reason: "APPLICATION_EVIDENCE_CONFLICT",
          lifecycleIdentity: { ...BUCKET, tokenMint: "TOKEN_A" },
          openFillId: null,
          affectedFillIds: ["shared-conflict"],
        },
      ],
    });
  });

  it("keeps valid metrics from one completed lifecycle while another is corrupt", () => {
    const result = evaluateHistoricalEvaluationV2(
      snapshot([
        application("corrupt-open", {
          tokenMint: "TOKEN_A",
          positionId: 10,
        }),
        closeApplication("corrupt-close", {
          tokenMint: "TOKEN_A",
          positionId: 10,
          positionVersionAfter: 1,
        }),
        application("valid-open", {
          tokenMint: "TOKEN_B",
          positionId: 11,
          quoteTimestampMs: 2_100,
        }),
        closeApplication("valid-close", {
          tokenMint: "TOKEN_B",
          positionId: 11,
          quoteTimestampMs: 3_100,
        }),
      ]),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result).toMatchObject({
      availability: "LIMITED",
      sample: { fullyContainedCount: 1 },
      includedRoundTrips: [{ openFillId: "valid-open" }],
      includedLifecycleSourceTimingEvidence: [
        { openFillId: "valid-open", closeFillId: "valid-close" },
      ],
      strategyMetrics: {
        netQuoteExpectancy: {
          value: "25",
          sampleCount: 1,
          status: "AVAILABLE",
        },
        winRate: { value: "1", sampleCount: 1, status: "AVAILABLE" },
        holdingTime: { count: 1, sampleCount: 1, status: "AVAILABLE" },
      },
      limitations: [
        {
          kind: "LIFECYCLE_UNEVALUABLE",
          openFillId: "corrupt-open",
        },
      ],
    });
  });

  it("keeps a valid unfinished lifecycle in censoring semantics without limitation", () => {
    const result = evaluateHistoricalEvaluationV2(
      snapshot([application("open-a")]),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result).toMatchObject({
      availability: "AVAILABLE",
      sample: {
        fullyContainedCount: 0,
        rightCensoredCount: 1,
        preWindowOpenCount: 0,
      },
      limitations: [],
    });
  });

  it("preserves SOURCE_UNAVAILABLE and lifecycle limitations in deterministic groups", () => {
    const evidence = snapshot([
      application("corrupt-open", { tokenMint: "TOKEN_A", positionId: 10 }),
      closeApplication("corrupt-close", {
        tokenMint: "TOKEN_A",
        positionId: 10,
        positionVersionAfter: 1,
      }),
      application("valid-open", { tokenMint: "TOKEN_B", positionId: 11 }),
      closeApplication("valid-close", { tokenMint: "TOKEN_B", positionId: 11 }),
    ]);
    const result = evaluateHistoricalEvaluationV2(
      {
        ...evidence,
        roundTripApplicationSources:
          evidence.roundTripApplicationSources.filter(
            ({ fillId }) => fillId !== "valid-close",
          ),
      },
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const reversed = evaluateHistoricalEvaluationV2(
      {
        ...evidence,
        roundTripApplications: [...evidence.roundTripApplications].reverse(),
        roundTripApplicationSources: evidence.roundTripApplicationSources
          .filter(({ fillId }) => fillId !== "valid-close")
          .reverse(),
      },
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result).toMatchObject({
      availability: "LIMITED",
      sample: { fullyContainedCount: 0, sourceUnavailableCount: 1 },
      limitations: [
        { reason: "SOURCE_UNAVAILABLE", openFillId: "valid-open" },
        {
          kind: "LIFECYCLE_UNEVALUABLE",
          openFillId: "corrupt-open",
        },
      ],
    });
    expect(reversed).toEqual(result);
  });

  it("retains and canonically orders multiple corrupt lifecycle limitations", () => {
    const applications = [
      application("z-open", { tokenMint: "TOKEN_Z", positionId: 12 }),
      closeApplication("z-close", {
        tokenMint: "TOKEN_Z",
        positionId: 12,
        quantityBeforeRaw: 9n,
      }),
      application("a-open", { tokenMint: "TOKEN_A", positionId: 10 }),
      closeApplication("a-close", {
        tokenMint: "TOKEN_A",
        positionId: 10,
        positionVersionAfter: 1,
      }),
    ];
    const canonical = evaluateHistoricalEvaluationV2(
      snapshot(applications),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const reversed = evaluateHistoricalEvaluationV2(
      snapshot([...applications].reverse()),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(canonical.limitations).toMatchObject([
      { kind: "LIFECYCLE_UNEVALUABLE", openFillId: "a-open" },
      { kind: "LIFECYCLE_UNEVALUABLE", openFillId: "z-open" },
    ]);
    expect(reversed).toEqual(canonical);
  });

  it("isolates lifecycle corruption from another Historical bucket", () => {
    const otherBucket = { ...BUCKET, followerWallet: "follower-b" };
    const result = evaluateHistoricalEvaluationV2(
      snapshot([
        application("other-open", { ...otherBucket, positionId: 20 }),
        closeApplication("other-close", {
          ...otherBucket,
          positionId: 20,
          positionVersionAfter: 3,
        }),
      ]),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result).toMatchObject({
      availability: "AVAILABLE",
      limitations: [],
    });
  });

  it("defensively copies nested lifecycle limitations across calls", () => {
    const evidence = snapshot([
      application("open-a"),
      closeApplication("close-a", { positionVersionAfter: 1 }),
    ]);
    const baseline = evaluateHistoricalEvaluationV2(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const mutable = baseline.limitations[0] as unknown as {
      lifecycleIdentity: { tokenMint: string };
      affectedFillIds: string[];
      evidence: Array<{ expected: string }>;
    };
    mutable.lifecycleIdentity.tokenMint = "MUTATED";
    mutable.affectedFillIds.push("mutated-fill");
    mutable.evidence[0]!.expected = "mutated";

    const after = evaluateHistoricalEvaluationV2(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    expect(after).not.toEqual(baseline);
    expect(after.limitations[0]).toMatchObject({
      lifecycleIdentity: { tokenMint: "TOKEN_A" },
      affectedFillIds: ["open-a", "close-a"],
      evidence: [{ expected: ">1" }],
    });
    expect(evidence.roundTripApplications).toEqual([
      application("open-a"),
      closeApplication("close-a", { positionVersionAfter: 1 }),
    ]);
  });

  it("preserves V1 observable semantics and keeps corruption out of Failure and Copyability", () => {
    const evidence = snapshot([
      application("open-a"),
      closeApplication("close-a", { positionVersionAfter: 1 }),
    ]);
    const cleanEvidence = snapshot([
      application("open-a"),
      closeApplication("close-a"),
    ]);
    const v1 = evaluateHistoricalEvaluation(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const v2 = evaluateHistoricalEvaluationV2(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const cleanV2 = evaluateHistoricalEvaluationV2(
      cleanEvidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(v1).toMatchObject({
      definitionVersion: "HISTORICAL_EVALUATION_V1",
      availability: "AVAILABLE",
      sample: { fullyContainedCount: 0 },
      limitations: [],
    });
    expect(v2).toMatchObject({
      definitionVersion: "HISTORICAL_EVALUATION_V2",
      availability: "LIMITED",
      sample: { fullyContainedCount: 0 },
      limitations: [{ kind: "LIFECYCLE_UNEVALUABLE" }],
    });
    expect(v2.failureClassification).toEqual(cleanV2.failureClassification);
    expect(v2.copyability).toEqual(cleanV2.copyability);
    expect(v2).not.toHaveProperty("reliability");
    expect(v2).not.toHaveProperty("temporal");
    expect(v2).not.toHaveProperty("ordering");
  });

  it("flows through the existing Comparability LIMITED_EVIDENCE path", () => {
    const historical = evaluateHistoricalEvaluationV2(
      snapshot([
        application("open-a"),
        closeApplication("close-a", { positionVersionAfter: 1 }),
      ]),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(evaluateLeaderComparability(historical)).toMatchObject({
      status: "NOT_COMPARABLE",
      reasons: expect.arrayContaining(["LIMITED_EVIDENCE"]),
      availability: "LIMITED",
      historicalReference: {
        historicalEvaluationDefinitionVersion: "HISTORICAL_EVALUATION_V2",
      },
    });
  });

  it("does not require a schema migration and defensively preserves migration provenance", () => {
    const evidence = snapshot([]);
    const result = evaluateHistoricalEvaluationV2(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result.provenance.observedSchemaMigrations).toEqual(
      evidence.provenance.observedSchemaMigrations,
    );
    expect(result).not.toHaveProperty("migrationRequired");
  });

  it("does not propagate a lifecycle limitation wholly before the Historical window", () => {
    const result = evaluateHistoricalEvaluationV2(
      snapshot(
        [
          application("old-open", { quoteTimestampMs: 100 }),
          application("old-close", {
            side: "SELL",
            transition: "CLOSE",
            inputAmountRaw: 10n,
            outputAmountRaw: 125n,
            quantityBeforeRaw: 10n,
            quantityAfterRaw: 0n,
            allocatedCostBasisRaw: 100n,
            proceedsRaw: 125n,
            realizedPnlDeltaRaw: 25n,
            positionVersionAfter: 1,
            quoteTimestampMs: 200,
          }),
        ],
        { "old-open": 100, "old-close": 200 },
      ),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result).toMatchObject({
      availability: "AVAILABLE",
      limitations: [],
      sample: { fullyContainedCount: 0 },
    });
  });

  it("conservatively propagates lifecycle corruption with unknown source time", () => {
    const result = evaluateHistoricalEvaluationV2(
      snapshot(
        [
          application("open-a", { quoteTimestampMs: 100 }),
          closeApplication("close-a", {
            positionVersionAfter: 1,
            quoteTimestampMs: 200,
          }),
        ],
        { "open-a": 100, "close-a": null },
      ),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result).toMatchObject({
      availability: "LIMITED",
      sample: { fullyContainedCount: 0 },
      limitations: [
        {
          kind: "LIFECYCLE_UNEVALUABLE",
          reason: "LIFECYCLE_CONTINUITY_VIOLATION",
          affectedFillIds: ["open-a", "close-a"],
        },
      ],
    });
  });
});
