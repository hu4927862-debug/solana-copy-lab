import { describe, expect, expectTypeOf, it } from "vitest";
import {
  evaluateHistoricalEvaluation,
  evaluateHistoricalEvaluationV2,
  evaluateHistoricalEvaluationV3,
  type HistoricalEvaluationV2EvidenceSnapshot,
  type HistoricalEvaluationV3Result,
} from "../../src/strategy-evaluation/historical-evaluation.js";
import { evaluateCompletedRoundTripCostCompleteness } from "../../src/strategy-evaluation/cost-completeness.js";
import type { PaperFillOutcomeEvidence } from "../../src/strategy-evaluation/execution-quality.js";
import { evaluateLeaderCohortCompatibility } from "../../src/strategy-evaluation/leader-cohort-compatibility.js";
import { evaluateLeaderComparability } from "../../src/strategy-evaluation/leader-comparability.js";
import { evaluateLeaderReliabilityDiagnostics } from "../../src/strategy-evaluation/leader-reliability-diagnostics.js";
import { evaluateLeaderTemporalCoverageDiagnostics } from "../../src/strategy-evaluation/leader-temporal-coverage-diagnostics.js";
import { evaluateLeaderTemporalPerformanceDiagnostics } from "../../src/strategy-evaluation/leader-temporal-performance-diagnostics.js";
import { evaluateLeaderTransparentOrdering } from "../../src/strategy-evaluation/leader-transparent-ordering.js";
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

function completeFill(
  id: string,
  side: "BUY" | "SELL",
  overrides: Partial<PaperFillOutcomeEvidence> = {},
): PaperFillOutcomeEvidence {
  return {
    id,
    intentId: `execution-${id}`,
    leaderWallet: BUCKET.leaderWallet,
    followerWallet: BUCKET.followerWallet,
    side,
    inputMint: side === "BUY" ? BUCKET.quoteMint : "TOKEN_A",
    outputMint: side === "BUY" ? "TOKEN_A" : BUCKET.quoteMint,
    feeEvidence: {
      status: "AVAILABLE",
      feeMint: BUCKET.quoteMint,
      feeAmountRaw: 1n,
    },
    provider: "JUPITER_SWAP_V2_ORDER",
    fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<HistoricalEvaluationV2EvidenceSnapshot> = {},
): HistoricalEvaluationV2EvidenceSnapshot {
  const roundTripApplications = overrides.roundTripApplications ?? [
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
      positionVersionAfter: 2,
      quoteTimestampMs: 3_000,
    }),
  ];
  return {
    provenance: {
      resolvedDatabasePath: "/fixture/historical-v3.sqlite",
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
    paperFills: overrides.paperFills ?? [
      completeFill("open-a", "BUY"),
      completeFill("close-a", "SELL"),
    ],
    paperFillApplications: [],
    jupiterAttempts: [],
    riskDecisions: [],
    opportunities: [],
    observationExclusions: [],
    observationLimitations: [],
    contextLimitations: [],
    ...overrides,
    roundTripApplications,
    roundTripApplicationSources:
      overrides.roundTripApplicationSources ??
      roundTripApplications.map((item) => ({
        fillId: item.fillId,
        executionKey: `execution-${item.fillId}`,
        leaderTradeId: `leader-trade-${item.fillId}`,
        sourceTimestamp: {
          valueMs: item.quoteTimestampMs,
          precision: "MILLISECOND",
          provenance: "CHAIN_BLOCK_TIME",
        },
      })),
  };
}

function evaluateV3(evidence = snapshot()) {
  return evaluateHistoricalEvaluationV3(
    evidence,
    BUCKET,
    STRATEGY_METRICS_POLICY,
    FAILURE_TAXONOMY_POLICY,
  );
}

function twoLifecycleSnapshot(
  secondOpenFeeAvailable = true,
): HistoricalEvaluationV2EvidenceSnapshot {
  const applications = [
    application("open-b", {
      tokenMint: "TOKEN_B",
      positionId: 20,
      quoteTimestampMs: 2_100,
    }),
    application("close-b", {
      tokenMint: "TOKEN_B",
      positionId: 20,
      side: "SELL",
      transition: "CLOSE",
      inputAmountRaw: 10n,
      outputAmountRaw: 110n,
      quantityBeforeRaw: 10n,
      quantityAfterRaw: 0n,
      allocatedCostBasisRaw: 100n,
      proceedsRaw: 110n,
      realizedPnlDeltaRaw: 10n,
      positionVersionAfter: 2,
      quoteTimestampMs: 3_100,
    }),
    ...snapshot().roundTripApplications,
  ];
  return snapshot({
    roundTripApplications: applications,
    paperFills: [
      completeFill("open-b", "BUY", {
        outputMint: "TOKEN_B",
        ...(secondOpenFeeAvailable
          ? {}
          : { feeEvidence: { status: "AMOUNT_UNAVAILABLE" } }),
      }),
      completeFill("close-b", "SELL", { inputMint: "TOKEN_B" }),
      completeFill("open-a", "BUY"),
      completeFill("close-a", "SELL"),
    ],
  });
}

describe("evaluateHistoricalEvaluationV3", () => {
  it("adds complete cost evidence for one fully-contained lifecycle", () => {
    const result = evaluateV3();

    expect(result).toMatchObject({
      definitionVersion: "HISTORICAL_EVALUATION_V3",
      costCompleteness: {
        definitionVersion: "COST_COMPLETENESS_V1",
        status: "COST_COMPLETE",
        evaluatedLifecycleCount: 1,
      },
    });
  });

  it("reports no evaluable lifecycle instead of vacuous cost completeness", () => {
    expect(
      evaluateV3(snapshot({ roundTripApplications: [], paperFills: [] })),
    ).toMatchObject({
      sample: { fullyContainedCount: 0 },
      costCompleteness: {
        status: "NO_EVALUABLE_LIFECYCLES",
        evaluatedLifecycleCount: 0,
        completeLifecycleCount: 0,
        incompleteLifecycleCount: 0,
        lifecycleResults: [],
        reasons: [],
      },
    });
  });

  it("aggregates multiple complete lifecycles in Historical canonical order", () => {
    const result = evaluateV3(twoLifecycleSnapshot());

    expect(result.costCompleteness).toMatchObject({
      status: "COST_COMPLETE",
      evaluatedLifecycleCount: 2,
      completeLifecycleCount: 2,
      incompleteLifecycleCount: 0,
      reasons: [],
    });
    expect(
      result.costCompleteness.lifecycleResults.map(
        ({ reference }) => reference.openFillId,
      ),
    ).toEqual(["open-a", "open-b"]);
  });

  it("counts one incomplete lifecycle without excluding complete peers", () => {
    const result = evaluateV3(twoLifecycleSnapshot(false));

    expect(result.costCompleteness).toMatchObject({
      status: "COST_INCOMPLETE",
      evaluatedLifecycleCount: 2,
      completeLifecycleCount: 1,
      incompleteLifecycleCount: 1,
      reasons: ["FEE_AMOUNT_UNAVAILABLE", "FEE_MINT_UNAVAILABLE"],
    });
    expect(
      result.costCompleteness.lifecycleResults.map(({ status }) => status),
    ).toEqual(["COST_COMPLETE", "COST_INCOMPLETE"]);
  });

  it("aggregates incomplete lifecycle reasons without changing V2 semantics", () => {
    const evidence = snapshot({
      paperFills: [
        completeFill("open-a", "BUY", {
          feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
        }),
        completeFill("close-a", "SELL", {
          provider: "UNSUPPORTED",
          feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
        }),
      ],
    });
    const v2 = evaluateHistoricalEvaluationV2(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const v3 = evaluateV3(evidence);

    expect(v3.costCompleteness).toMatchObject({
      status: "COST_INCOMPLETE",
      evaluatedLifecycleCount: 1,
      completeLifecycleCount: 0,
      incompleteLifecycleCount: 1,
      reasons: [
        "FEE_AMOUNT_UNAVAILABLE",
        "FEE_MINT_UNAVAILABLE",
        "FILL_PROVIDER_UNSUPPORTED",
      ],
    });
    expect(v3.strategyMetrics).toEqual(v2.strategyMetrics);
    expect(v3.availability).toBe(v2.availability);
    expect(v3.limitations).toEqual(v2.limitations);
    expect(v3.availability).toBe("AVAILABLE");
    expect(v3.limitations).toEqual([]);
  });

  it("keeps V1 and V2 contracts free of the additive sidecar", () => {
    const evidence = snapshot();
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

    expect(v1.definitionVersion).toBe("HISTORICAL_EVALUATION_V1");
    expect(v2.definitionVersion).toBe("HISTORICAL_EVALUATION_V2");
    expect(v1).not.toHaveProperty("costCompleteness");
    expect(v2).not.toHaveProperty("costCompleteness");
  });

  it("fails closed for missing and conflicting included fill evidence", () => {
    const missing = evaluateV3(
      snapshot({ paperFills: [completeFill("open-a", "BUY")] }),
    );
    const open = completeFill("open-a", "BUY");
    const conflicting = evaluateV3(
      snapshot({
        paperFills: [
          open,
          {
            ...open,
            feeEvidence: { ...open.feeEvidence, feeAmountRaw: 2n },
          },
          completeFill("close-a", "SELL"),
        ],
      }),
    );

    expect(missing.costCompleteness).toMatchObject({
      status: "COST_INCOMPLETE",
      reasons: ["FILL_EVIDENCE_UNAVAILABLE"],
    });
    expect(conflicting.costCompleteness).toMatchObject({
      status: "COST_INCOMPLETE",
      reasons: ["FEE_EVIDENCE_CONFLICT"],
    });
  });

  it("excludes corrupt, censored, pre-window, and unfinished lifecycles", () => {
    const applications = [
      application("corrupt-open", {
        tokenMint: "TOKEN_CORRUPT",
        positionId: 20,
      }),
      application("corrupt-close", {
        tokenMint: "TOKEN_CORRUPT",
        positionId: 20,
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
        quoteTimestampMs: 2_100,
      }),
      application("left-open", {
        tokenMint: "TOKEN_LEFT",
        positionId: 30,
        quoteTimestampMs: 500,
      }),
      application("left-close", {
        tokenMint: "TOKEN_LEFT",
        positionId: 30,
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
        quoteTimestampMs: 1_500,
      }),
      application("right-open", {
        tokenMint: "TOKEN_RIGHT",
        positionId: 40,
        quoteTimestampMs: 4_000,
      }),
      application("right-close", {
        tokenMint: "TOKEN_RIGHT",
        positionId: 40,
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
        quoteTimestampMs: 5_500,
      }),
      application("unfinished-open", {
        tokenMint: "TOKEN_UNFINISHED",
        positionId: 50,
        quoteTimestampMs: 2_200,
      }),
      application("pre-window-open", {
        tokenMint: "TOKEN_PRE_WINDOW",
        positionId: 55,
        quoteTimestampMs: 400,
      }),
      ...snapshot().roundTripApplications.map((item) => ({
        ...item,
        tokenMint: "TOKEN_INCLUDED",
        positionId: 60,
      })),
    ];
    const result = evaluateV3(
      snapshot({
        roundTripApplications: applications,
        paperFills: [
          completeFill("open-a", "BUY", { outputMint: "TOKEN_INCLUDED" }),
          completeFill("close-a", "SELL", { inputMint: "TOKEN_INCLUDED" }),
        ],
      }),
    );

    expect(result.sample).toMatchObject({
      fullyContainedCount: 1,
      leftCensoredCount: 1,
      rightCensoredCount: 2,
      preWindowOpenCount: 1,
    });
    expect(result.limitations).toEqual([
      expect.objectContaining({
        kind: "LIFECYCLE_UNEVALUABLE",
        openFillId: "corrupt-open",
      }),
    ]);
    expect(result.costCompleteness).toMatchObject({
      status: "COST_COMPLETE",
      evaluatedLifecycleCount: 1,
      completeLifecycleCount: 1,
      incompleteLifecycleCount: 0,
      lifecycleResults: [
        { reference: { openFillId: "open-a", closeFillId: "close-a" } },
      ],
    });
    expect(result.costCompleteness.evaluatedLifecycleCount).toBe(
      result.sample.fullyContainedCount,
    );
  });

  it("isolates fee evidence across Historical buckets and completed prior-window lifecycles", () => {
    const otherBucket = {
      followerWallet: "follower-b",
      leaderWallet: BUCKET.leaderWallet,
    };
    const priorWindowApplications = [
      application("old-window-open", {
        tokenMint: "TOKEN_OLD",
        positionId: 20,
        quoteTimestampMs: 100,
      }),
      application("old-window-close", {
        tokenMint: "TOKEN_OLD",
        positionId: 20,
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
        quoteTimestampMs: 500,
      }),
    ];
    const result = evaluateV3(
      snapshot({
        roundTripApplications: [
          ...priorWindowApplications,
          ...snapshot().roundTripApplications,
        ],
        paperFills: [
          completeFill("open-a", "BUY"),
          completeFill("close-a", "SELL"),
          completeFill("open-a", "BUY", {
            ...otherBucket,
            feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
          }),
          completeFill("old-window-open", "BUY", {
            outputMint: "TOKEN_OLD",
            feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
          }),
          completeFill("old-window-close", "SELL", {
            inputMint: "TOKEN_OLD",
            feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
          }),
        ],
      }),
    );

    expect(result.costCompleteness).toMatchObject({
      status: "COST_COMPLETE",
      evaluatedLifecycleCount: 1,
      reasons: [],
    });
  });

  it("is deterministic under evidence permutations", () => {
    const evidence = snapshot();
    const reversed = snapshot({
      roundTripApplications: [...evidence.roundTripApplications].reverse(),
      roundTripApplicationSources: [
        ...evidence.roundTripApplicationSources,
      ].reverse(),
      paperFills: [...evidence.paperFills].reverse(),
    });

    expect(evaluateV3(reversed)).toEqual(evaluateV3(evidence));
  });

  it("defensively copies nested cost results across calls", () => {
    const evidence = snapshot({
      paperFills: [
        completeFill("open-a", "BUY", {
          feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
        }),
        completeFill("close-a", "SELL"),
      ],
    });
    const evidenceBefore = structuredClone(evidence);
    const v1Before = evaluateHistoricalEvaluation(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const v2Before = evaluateHistoricalEvaluationV2(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const standaloneCostBefore = evaluateCompletedRoundTripCostCompleteness(
      v2Before.includedRoundTrips[0]!,
      evidence.paperFills,
    );
    const baseline = evaluateV3(evidence);
    const mutable = baseline.costCompleteness as unknown as {
      reasons: string[];
      lifecycleResults: Array<{
        reasons: string[];
        reference: { openFillId: string; fillIds: string[] };
      }>;
    };
    mutable.reasons.push("MUTATED");
    mutable.lifecycleResults[0]!.reasons.push("MUTATED");
    mutable.lifecycleResults[0]!.reference.openFillId = "mutated";
    mutable.lifecycleResults[0]!.reference.fillIds.push("mutated");

    const after = evaluateV3(evidence);
    expect(after).not.toEqual(baseline);
    expect(after.costCompleteness).toMatchObject({
      reasons: ["FEE_AMOUNT_UNAVAILABLE", "FEE_MINT_UNAVAILABLE"],
      lifecycleResults: [
        {
          reasons: ["FEE_AMOUNT_UNAVAILABLE", "FEE_MINT_UNAVAILABLE"],
          reference: {
            openFillId: "open-a",
            fillIds: ["open-a", "close-a"],
          },
        },
      ],
    });
    expect(evidence).toEqual(evidenceBefore);
    expect(v1Before).toEqual(
      evaluateHistoricalEvaluation(
        evidence,
        BUCKET,
        STRATEGY_METRICS_POLICY,
        FAILURE_TAXONOMY_POLICY,
      ),
    );
    expect(v2Before).toEqual(
      evaluateHistoricalEvaluationV2(
        evidence,
        BUCKET,
        STRATEGY_METRICS_POLICY,
        FAILURE_TAXONOMY_POLICY,
      ),
    );
    expect(standaloneCostBefore).toEqual(
      evaluateCompletedRoundTripCostCompleteness(
        v2Before.includedRoundTrips[0]!,
        evidence.paperFills,
      ),
    );
  });

  it("exposes a future-verdict-readable status without verdict fields", () => {
    const result = evaluateV3();
    const futureCostGate = (
      status: typeof result.costCompleteness.status,
    ): boolean => status === "COST_COMPLETE";

    expectTypeOf(result.costCompleteness.status).toEqualTypeOf<
      "COST_COMPLETE" | "COST_INCOMPLETE" | "NO_EVALUABLE_LIFECYCLES"
    >();
    expect(futureCostGate(result.costCompleteness.status)).toBe(true);
    expect(result.costCompleteness).not.toHaveProperty("score");
    expect(result.costCompleteness).not.toHaveProperty("percentage");
    expect(result).not.toHaveProperty("verdict");
  });

  it("is an additive V2 contract and preserves every non-cost semantic", () => {
    const evidence = snapshot({
      paperFills: [
        completeFill("open-a", "BUY", {
          feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
        }),
        completeFill("close-a", "SELL"),
      ],
    });
    const v2 = evaluateHistoricalEvaluationV2(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const v3 = evaluateV3(evidence);
    const { definitionVersion: _v2Version, ...v2Semantics } = v2;
    const {
      definitionVersion: _v3Version,
      costCompleteness: _costCompleteness,
      ...v3Semantics
    } = v3;

    expect(v3Semantics).toEqual(v2Semantics);
    expect(v3.strategyMetrics).toEqual(v2.strategyMetrics);
    expect(v3.includedRoundTrips).toEqual(v2.includedRoundTrips);
    expect(v3.executionQuality).toEqual(v2.executionQuality);
    expect(v3.failureClassification).toEqual(v2.failureClassification);
    expect(v3.copyability).toEqual(v2.copyability);
    expect(v3).not.toHaveProperty("reliability");
    expect(v3).not.toHaveProperty("temporal");
    expect(v3).not.toHaveProperty("ordering");
  });

  it("does not add a cost gate to Comparability", () => {
    const evidence = snapshot({
      paperFills: [
        completeFill("open-a", "BUY", {
          feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
        }),
        completeFill("close-a", "SELL"),
      ],
    });
    const v2 = evaluateHistoricalEvaluationV2(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const v3 = evaluateV3(evidence);
    const v2Comparability = evaluateLeaderComparability(v2);
    const v3Comparability = evaluateLeaderComparability(v3);

    expect(v3.costCompleteness.status).toBe("COST_INCOMPLETE");
    expect(v3Comparability).toMatchObject({
      status: v2Comparability.status,
      reasons: v2Comparability.reasons,
      sampleStatus: v2Comparability.sampleStatus,
      availability: v2Comparability.availability,
    });
    expect(v3Comparability.reasons).not.toContain("COST_INCOMPLETE");
    expect(v3Comparability.historicalReference).toEqual({
      ...v2Comparability.historicalReference,
      historicalEvaluationDefinitionVersion: "HISTORICAL_EVALUATION_V3",
    });
  });

  it("keeps Ordering, Reliability, and Temporal independent of cost status", () => {
    const complete = evaluateV3();
    const costPerturbed: HistoricalEvaluationV3Result = {
      ...complete,
      costCompleteness: {
        ...complete.costCompleteness,
        status: "COST_INCOMPLETE",
        completeLifecycleCount: 0,
        incompleteLifecycleCount: 1,
        reasons: ["FEE_AMOUNT_UNAVAILABLE"],
      },
    };
    const completeCohort = evaluateLeaderCohortCompatibility([complete]);
    const perturbedCohort = evaluateLeaderCohortCompatibility([costPerturbed]);

    expect(evaluateLeaderComparability(costPerturbed)).toEqual(
      evaluateLeaderComparability(complete),
    );
    expect(perturbedCohort).toEqual(completeCohort);
    expect(
      evaluateLeaderTransparentOrdering(perturbedCohort, [costPerturbed]),
    ).toEqual(evaluateLeaderTransparentOrdering(completeCohort, [complete]));
    expect(evaluateLeaderReliabilityDiagnostics(costPerturbed)).toEqual(
      evaluateLeaderReliabilityDiagnostics(complete),
    );
    expect(
      evaluateLeaderTemporalCoverageDiagnostics(costPerturbed, {
        blockCount: 1,
      }),
    ).toEqual(
      evaluateLeaderTemporalCoverageDiagnostics(complete, { blockCount: 1 }),
    );
    expect(
      evaluateLeaderTemporalPerformanceDiagnostics(costPerturbed, {
        blockCount: 1,
      }),
    ).toEqual(
      evaluateLeaderTemporalPerformanceDiagnostics(complete, {
        blockCount: 1,
      }),
    );
  });
});
