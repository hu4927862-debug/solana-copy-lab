import { describe, expect, it } from "vitest";
import type { RiskDecision } from "../../src/risk/risk-engine.js";
import type {
  FollowerScopedJupiterAttemptEvidence,
  PaperFillApplicationOutcomeEvidence,
  PaperFillOutcomeEvidence,
} from "../../src/strategy-evaluation/execution-quality.js";
import {
  calculateJupiterSuccessRate,
  calculatePaperFillOutcome,
  calculatePostRiskDistribution,
  calculatePriceImpactRejectRate,
  calculateProvider429Rate,
  calculateProvider5xxRate,
} from "../../src/strategy-evaluation/execution-quality.js";
import { evaluateHistoricalEvaluation as evaluateHistoricalEvaluationWithFailurePolicy } from "../../src/strategy-evaluation/historical-evaluation.js";
import type {
  StrategyEvaluationEvidenceSnapshot,
  StrategyEvaluationOpportunityProjection,
} from "../../src/strategy-evaluation/read-model.js";

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

function evaluateHistoricalEvaluation(
  evidenceSnapshot: StrategyEvaluationEvidenceSnapshot,
  bucket: typeof BUCKET,
  strategyMetricsPolicy: typeof STRATEGY_METRICS_POLICY,
) {
  return evaluateHistoricalEvaluationWithFailurePolicy(
    evidenceSnapshot,
    bucket,
    strategyMetricsPolicy,
    FAILURE_TAXONOMY_POLICY,
  );
}

function opportunity(
  executionKey: string,
  overrides: Partial<StrategyEvaluationOpportunityProjection> = {},
): StrategyEvaluationOpportunityProjection {
  return {
    ...BUCKET,
    executionKey,
    side: "BUY",
    leaderTradeId: `leader-trade-${executionKey}`,
    sourceTimestamp: {
      valueMs: 2_000,
      precision: "MILLISECOND",
      provenance: "CHAIN_BLOCK_TIME",
    },
    normalizedEvidence: { executionKey },
    ...overrides,
  };
}

function jupiterAttempt(
  executionKey: string,
  overrides: Partial<FollowerScopedJupiterAttemptEvidence> = {},
): FollowerScopedJupiterAttemptEvidence {
  return {
    ...BUCKET,
    executionKey,
    validationEventId: `validation-${executionKey}`,
    httpStatus: 200,
    schemaValid: true,
    expectedOutputRaw: 1n,
    route: [{ swapInfo: { label: "Raydium" } }],
    ...overrides,
  };
}

function postRiskDecision(
  intentId: string,
  overrides: Partial<RiskDecision> = {},
): RiskDecision {
  return {
    ...BUCKET,
    phase: "POST_QUOTE",
    decision: "ALLOW",
    decisionId: `post-${intentId}`,
    intentId,
    leaderTradeId: `leader-trade-${intentId}`,
    side: "BUY",
    tokenMint: "token-mint",
    requestedAmountRaw: 100n,
    approvedAmountRaw: 100n,
    requestedTokenRaw: 10n,
    approvedTokenRaw: 10n,
    requestedQuoteRaw: 100n,
    approvedQuoteRaw: 100n,
    reasonCode: "ALLOW",
    policyVersion: "RISK_V1",
    decidedAtMs: 9_000,
    preDecisionId: `pre-${intentId}`,
    quoteRequestId: `quote-${intentId}`,
    ...overrides,
  };
}

function paperFill(
  id: string,
  overrides: Partial<PaperFillOutcomeEvidence> = {},
): PaperFillOutcomeEvidence {
  return {
    id,
    intentId: `execution-${id}`,
    leaderWallet: BUCKET.leaderWallet,
    followerWallet: BUCKET.followerWallet,
    side: "BUY",
    inputMint: BUCKET.quoteMint,
    outputMint: `token-${id}`,
    feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
    provider: "JUPITER_SWAP_V2_ORDER",
    fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
    ...overrides,
  };
}

function paperApplication(
  fillId: string,
  overrides: Partial<PaperFillApplicationOutcomeEvidence> = {},
): PaperFillApplicationOutcomeEvidence {
  return {
    fillId,
    positionId: 1,
    transition: "OPEN",
    positionVersionAfter: 1,
    appliedAtMs: 9_000,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<StrategyEvaluationEvidenceSnapshot> = {},
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
    ...overrides,
  };
}

function mixedExecutionQualityEvidence(): Pick<
  StrategyEvaluationEvidenceSnapshot,
  | "jupiterAttempts"
  | "riskDecisions"
  | "paperFills"
  | "paperFillApplications"
  | "opportunities"
> {
  const jupiterAttempts = Array.from({ length: 10 }, (_, index) =>
    jupiterAttempt(`execution-${index}`, {
      ...(index === 7
        ? {
            httpStatus: 429,
            schemaValid: false,
            expectedOutputRaw: null,
            route: [],
          }
        : index >= 8
          ? {
              httpStatus: 503,
              schemaValid: false,
              expectedOutputRaw: null,
              route: [],
            }
          : {}),
    }),
  );
  const riskDecisions = [
    ...Array.from({ length: 5 }, (_, index) =>
      postRiskDecision(`allow-${index}`),
    ),
    postRiskDecision("impact-0", {
      decision: "REJECT",
      approvedAmountRaw: 0n,
      approvedTokenRaw: 0n,
      approvedQuoteRaw: 0n,
      reasonCode: "PRICE_IMPACT_TOO_HIGH",
    }),
    postRiskDecision("impact-1", {
      decision: "REJECT",
      approvedAmountRaw: 0n,
      approvedTokenRaw: 0n,
      approvedQuoteRaw: 0n,
      reasonCode: "PRICE_IMPACT_TOO_HIGH",
    }),
  ];
  const paperFills = [
    paperFill("paper-0"),
    paperFill("paper-1"),
    paperFill("paper-2"),
    paperFill("paper-3"),
  ];
  return {
    jupiterAttempts,
    riskDecisions,
    paperFills,
    paperFillApplications: paperFills
      .slice(0, 3)
      .map(({ id }) => paperApplication(id)),
    opportunities: paperFills.map(({ intentId }) => opportunity(intentId)),
  };
}

describe("Historical Execution Quality", () => {
  it("composes the mixed bucket evidence into the Historical result", () => {
    const result = evaluateHistoricalEvaluation(
      snapshot(mixedExecutionQualityEvidence()),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    );

    expect(result).toMatchObject({
      executionQuality: {
        jupiterSuccess: {
          attemptCount: 10,
          successCount: 7,
          successRate: "0.7",
        },
        providerHttp: {
          provider429: { attemptCount: 10, provider429Count: 1 },
          provider5xx: { attemptCount: 10, provider5xxCount: 2 },
        },
        postRiskDistribution: {
          postRiskDecisionCount: 7,
          postRiskAllowCount: 5,
          postRiskRejectCount: 2,
        },
        priceImpactReject: {
          postRiskDecisionCount: 7,
          priceImpactRejectCount: 2,
        },
        paperFillOutcome: {
          paperFillCount: 4,
          paperFillApplicationCount: 3,
          paperFillApplicationRate: "0.75",
        },
      },
    });
  });

  it("returns exactly the existing calculators' results for filtered evidence", () => {
    const evidence = mixedExecutionQualityEvidence();
    const result = evaluateHistoricalEvaluation(
      snapshot(evidence),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    );

    expect(result.executionQuality).toEqual({
      jupiterSuccess: calculateJupiterSuccessRate(
        BUCKET,
        evidence.jupiterAttempts,
      ),
      providerHttp: {
        provider429: calculateProvider429Rate(BUCKET, evidence.jupiterAttempts),
        provider5xx: calculateProvider5xxRate(BUCKET, evidence.jupiterAttempts),
      },
      postRiskDistribution: calculatePostRiskDistribution(
        BUCKET,
        evidence.riskDecisions,
      ),
      priceImpactReject: calculatePriceImpactRejectRate(
        BUCKET,
        evidence.riskDecisions,
      ),
      paperFillOutcome: calculatePaperFillOutcome(
        BUCKET,
        evidence.paperFills,
        evidence.paperFillApplications,
      ),
    });
  });

  it("preserves all-success and zero-attempt Jupiter semantics", () => {
    const allSuccess = evaluateHistoricalEvaluation(
      snapshot({
        jupiterAttempts: [
          jupiterAttempt("success-0"),
          jupiterAttempt("success-1"),
        ],
      }),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    ).executionQuality;
    const zeroAttempts = evaluateHistoricalEvaluation(
      snapshot(),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    ).executionQuality;

    expect(allSuccess.jupiterSuccess).toMatchObject({
      attemptCount: 2,
      successCount: 2,
      successRate: "1",
      status: "AVAILABLE",
    });
    expect(allSuccess.providerHttp).toMatchObject({
      provider429: { provider429Count: 0, provider429Rate: "0" },
      provider5xx: { provider5xxCount: 0, provider5xxRate: "0" },
    });
    expect(zeroAttempts).toMatchObject({
      jupiterSuccess: {
        attemptCount: 0,
        successRate: null,
        status: "NO_ATTEMPTS",
      },
      providerHttp: {
        provider429: { provider429Rate: null, status: "NO_ATTEMPTS" },
        provider5xx: { provider5xxRate: null, status: "NO_ATTEMPTS" },
      },
    });
  });

  it("preserves POST distribution and price-impact reason semantics", () => {
    const result = evaluateHistoricalEvaluation(
      snapshot({
        riskDecisions: [
          postRiskDecision("allow"),
          postRiskDecision("too-high", {
            decision: "REJECT",
            reasonCode: "PRICE_IMPACT_TOO_HIGH",
          }),
          postRiskDecision("unavailable", {
            decision: "REJECT",
            reasonCode: "PRICE_IMPACT_UNAVAILABLE",
          }),
        ],
      }),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    ).executionQuality;

    expect(result.postRiskDistribution).toMatchObject({
      postRiskDecisionCount: 3,
      postRiskAllowCount: 1,
      postRiskRejectCount: 2,
      allowRate: "0.333333333333333333",
      rejectRate: "0.666666666666666666",
    });
    expect(result.priceImpactReject).toMatchObject({
      postRiskDecisionCount: 3,
      priceImpactRejectCount: 1,
      priceImpactRejectRate: "0.333333333333333333",
    });
  });

  it("preserves zero POST evidence semantics independently", () => {
    const result = evaluateHistoricalEvaluation(
      snapshot(),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    ).executionQuality;

    expect(result.postRiskDistribution).toMatchObject({
      postRiskDecisionCount: 0,
      allowRate: null,
      rejectRate: null,
      status: "NO_POST_RISK_DECISIONS",
    });
    expect(result.priceImpactReject).toMatchObject({
      postRiskDecisionCount: 0,
      priceImpactRejectRate: null,
      status: "NO_POST_RISK_DECISIONS",
    });
  });

  it.each([
    [2, "1"],
    [1, "0.5"],
  ] as const)(
    "preserves PaperFill application denominator with %i of 2 applied",
    (applicationCount, expectedRate) => {
      const fills = [paperFill("fill-0"), paperFill("fill-1")];
      const result = evaluateHistoricalEvaluation(
        snapshot({
          paperFills: fills,
          paperFillApplications: fills
            .slice(0, applicationCount)
            .map(({ id }) => paperApplication(id)),
          opportunities: fills.map(({ intentId }) => opportunity(intentId)),
        }),
        BUCKET,
        STRATEGY_METRICS_POLICY,
      ).executionQuality.paperFillOutcome;

      expect(result).toMatchObject({
        paperFillCount: 2,
        paperFillApplicationCount: applicationCount,
        paperFillApplicationRate: expectedRate,
        status: "AVAILABLE",
      });
    },
  );

  it("preserves zero PaperFill semantics", () => {
    expect(
      evaluateHistoricalEvaluation(snapshot(), BUCKET, STRATEGY_METRICS_POLICY)
        .executionQuality.paperFillOutcome,
    ).toMatchObject({
      paperFillCount: 0,
      paperFillApplicationCount: 0,
      paperFillApplicationRate: null,
      status: "NO_PAPER_FILLS",
    });
  });

  it("isolates follower, leader, and quote evidence before composition", () => {
    const buckets = {
      a: BUCKET,
      b: { ...BUCKET, followerWallet: "follower-b" },
      c: { ...BUCKET, leaderWallet: "leader-y" },
      d: { ...BUCKET, quoteMint: "USDC" },
    } as const;
    const fills = [
      paperFill("fill-a", { intentId: "intent-a" }),
      paperFill("fill-b", { intentId: "intent-b" }),
      paperFill("fill-c", {
        intentId: "intent-c",
        leaderWallet: buckets.c.leaderWallet,
      }),
      paperFill("fill-d", {
        intentId: "intent-d",
        inputMint: buckets.d.quoteMint,
      }),
    ];
    const result = evaluateHistoricalEvaluation(
      snapshot({
        jupiterAttempts: [
          jupiterAttempt("attempt-a"),
          jupiterAttempt("attempt-b", buckets.b),
          jupiterAttempt("attempt-c", buckets.c),
          jupiterAttempt("attempt-d", buckets.d),
        ],
        riskDecisions: [
          postRiskDecision("risk-a"),
          postRiskDecision("risk-b", buckets.b),
          postRiskDecision("risk-c", buckets.c),
          postRiskDecision("risk-d", buckets.d),
        ],
        paperFills: fills,
        paperFillApplications: fills.map(({ id }) => paperApplication(id)),
        opportunities: [
          opportunity("intent-a"),
          opportunity("intent-b", buckets.b),
          opportunity("intent-c", buckets.c),
          opportunity("intent-d", buckets.d),
        ],
      }),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    ).executionQuality;

    expect(result).toMatchObject({
      jupiterSuccess: { attemptCount: 1, successCount: 1 },
      providerHttp: {
        provider429: { attemptCount: 1 },
        provider5xx: { attemptCount: 1 },
      },
      postRiskDistribution: { postRiskDecisionCount: 1 },
      priceImpactReject: { postRiskDecisionCount: 1 },
      paperFillOutcome: {
        paperFillCount: 1,
        paperFillApplicationCount: 1,
      },
    });
  });

  it("does not re-filter downstream evidence by its later timestamps", () => {
    const fill = paperFill("late", { intentId: "late-execution" });
    const result = evaluateHistoricalEvaluation(
      snapshot({
        opportunities: [opportunity("late-execution")],
        jupiterAttempts: [jupiterAttempt("late-execution")],
        riskDecisions: [
          postRiskDecision("late-execution", { decidedAtMs: 50_000 }),
        ],
        paperFills: [fill],
        paperFillApplications: [
          paperApplication(fill.id, { appliedAtMs: 60_000 }),
        ],
      }),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    ).executionQuality;

    expect(result).toMatchObject({
      jupiterSuccess: { attemptCount: 1 },
      postRiskDistribution: { postRiskDecisionCount: 1 },
      paperFillOutcome: {
        paperFillCount: 1,
        paperFillApplicationCount: 1,
      },
    });
  });

  it("propagates context limitations without changing EQ metrics", () => {
    const evidence = mixedExecutionQualityEvidence();
    const contextLimitation = {
      ...BUCKET,
      executionKey: "limited-execution",
      reason: "CONTEXT_MODE_MISMATCH",
      expected: "PAPER",
      observed: "SHADOW",
    } as const;
    const available = evaluateHistoricalEvaluation(
      snapshot(evidence),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    );
    const limited = evaluateHistoricalEvaluation(
      snapshot({ ...evidence, contextLimitations: [contextLimitation] }),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    );

    expect(limited).toMatchObject({
      availability: "LIMITED",
      limitations: [contextLimitation],
    });
    expect(limited.executionQuality).toEqual(available.executionQuality);
  });

  it("exposes named EQ results without an overall score, rate, or grade", () => {
    const executionQuality = evaluateHistoricalEvaluation(
      snapshot(mixedExecutionQualityEvidence()),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    ).executionQuality;

    expect(Object.keys(executionQuality).sort()).toEqual([
      "jupiterSuccess",
      "paperFillOutcome",
      "postRiskDistribution",
      "priceImpactReject",
      "providerHttp",
    ]);
    expect(executionQuality).not.toHaveProperty("executionScore");
    expect(executionQuality).not.toHaveProperty("overallExecutionRate");
    expect(executionQuality).not.toHaveProperty("grade");
  });

  it("returns deterministic EQ output independent of evidence ordering", () => {
    const evidence = mixedExecutionQualityEvidence();
    const reversed = {
      jupiterAttempts: [...evidence.jupiterAttempts].reverse(),
      riskDecisions: [...evidence.riskDecisions].reverse(),
      paperFills: [...evidence.paperFills].reverse(),
      paperFillApplications: [...evidence.paperFillApplications].reverse(),
      opportunities: [...evidence.opportunities].reverse(),
    };

    expect(
      evaluateHistoricalEvaluation(
        snapshot(reversed),
        BUCKET,
        STRATEGY_METRICS_POLICY,
      ).executionQuality,
    ).toEqual(
      evaluateHistoricalEvaluation(
        snapshot(evidence),
        BUCKET,
        STRATEGY_METRICS_POLICY,
      ).executionQuality,
    );
  });

  it("leaves the lifecycle and Strategy Metrics seam unchanged", () => {
    const roundTripApplications = [
      {
        ...BUCKET,
        tokenMint: "token-round-trip",
        fillId: "open-round-trip",
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
      },
      {
        ...BUCKET,
        tokenMint: "token-round-trip",
        fillId: "close-round-trip",
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
      },
    ] as const;
    const roundTripApplicationSources = [
      {
        fillId: "open-round-trip",
        executionKey: "round-trip-open",
        leaderTradeId: "leader-trade-open",
        sourceTimestamp: {
          valueMs: 2_000,
          precision: "MILLISECOND",
          provenance: "CHAIN_BLOCK_TIME",
        },
      },
      {
        fillId: "close-round-trip",
        executionKey: "round-trip-close",
        leaderTradeId: "leader-trade-close",
        sourceTimestamp: {
          valueMs: 3_000,
          precision: "MILLISECOND",
          provenance: "CHAIN_BLOCK_TIME",
        },
      },
    ] as const;
    const lifecycleEvidence = {
      roundTripApplications,
      roundTripApplicationSources,
    };
    const before = evaluateHistoricalEvaluation(
      snapshot(lifecycleEvidence),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    );
    const after = evaluateHistoricalEvaluation(
      snapshot({ ...lifecycleEvidence, ...mixedExecutionQualityEvidence() }),
      BUCKET,
      STRATEGY_METRICS_POLICY,
    );

    expect(after.sample).toEqual(before.sample);
    expect(after.includedRoundTrips).toEqual(before.includedRoundTrips);
    expect(after.strategyMetrics).toEqual(before.strategyMetrics);
  });
});
