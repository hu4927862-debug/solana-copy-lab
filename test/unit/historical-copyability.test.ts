import { describe, expect, it } from "vitest";
import type { RiskDecision } from "../../src/risk/risk-engine.js";
import {
  calculateBuyCapacityCompatibility,
  calculateCopyabilityAggregate,
  calculateEndToEndApplicationCompatibility,
  calculateJupiterQuoteUsability,
  calculatePositionMappingCompatibility,
  calculatePostQuoteFreshnessCompatibility,
  calculatePriceImpactCompatibility,
  calculateSizeGranularityCompatibility,
  type ClassifiedCopyabilityOpportunity,
  type NormalizedPreRiskSizingEvidence,
  type SizeGranularityOpportunityEvidence,
} from "../../src/strategy-evaluation/copyability.js";
import {
  calculateJupiterSuccessRate,
  calculatePostRiskDistribution,
  calculatePriceImpactRejectRate,
  type FollowerScopedJupiterAttemptEvidence,
  type PaperFillApplicationOutcomeEvidence,
  type PaperFillOutcomeEvidence,
} from "../../src/strategy-evaluation/execution-quality.js";
import {
  classifyOpportunityFailure,
  projectPostQuoteFreshnessOutcome,
  type FailureTaxonomyPolicy,
  type NormalizedOpportunityEvidence,
} from "../../src/strategy-evaluation/failure-taxonomy.js";
import { evaluateHistoricalEvaluation } from "../../src/strategy-evaluation/historical-evaluation.js";
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
const FAILURE_TAXONOMY_POLICY: FailureTaxonomyPolicy = {
  definitionVersion: "OPPORTUNITY_FAILURE_V1",
};

function opportunity(
  executionKey: string,
  normalizedEvidence: NormalizedOpportunityEvidence = { executionKey },
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
    normalizedEvidence,
    ...overrides,
  };
}

function preRiskSizing(
  executionKey: string,
  decision: NormalizedPreRiskSizingEvidence["decision"],
  requestedQuoteRaw: bigint,
  approvedQuoteRaw: bigint,
  reasonCode: NormalizedPreRiskSizingEvidence["reasonCode"],
  overrides: Partial<NormalizedPreRiskSizingEvidence> = {},
): NormalizedPreRiskSizingEvidence {
  return {
    ...BUCKET,
    intentId: executionKey,
    phase: "PRE_QUOTE",
    side: "BUY",
    decision,
    reasonCode,
    requestedAmountRaw: requestedQuoteRaw,
    approvedAmountRaw: approvedQuoteRaw,
    requestedTokenRaw: requestedQuoteRaw * 2n,
    approvedTokenRaw: approvedQuoteRaw * 2n,
    requestedQuoteRaw,
    approvedQuoteRaw,
    ...overrides,
  };
}

function riskDecision(
  intentId: string,
  overrides: Partial<RiskDecision> = {},
): RiskDecision {
  return {
    ...BUCKET,
    phase: "POST_QUOTE",
    decision: "ALLOW",
    decisionId: `risk-${intentId}`,
    intentId,
    leaderTradeId: `leader-trade-${intentId}`,
    side: "BUY",
    tokenMint: `token-${intentId}`,
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

function paperFill(id: string, intentId: string): PaperFillOutcomeEvidence {
  return {
    id,
    intentId,
    leaderWallet: BUCKET.leaderWallet,
    followerWallet: BUCKET.followerWallet,
    side: "BUY",
    inputMint: BUCKET.quoteMint,
    outputMint: `token-${intentId}`,
    feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
    provider: "JUPITER_SWAP_V2_ORDER",
    fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
  };
}

function paperApplication(fillId: string): PaperFillApplicationOutcomeEvidence {
  return {
    fillId,
    positionId: 1,
    transition: "OPEN",
    positionVersionAfter: 1,
    appliedAtMs: 9_000,
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

function mixedEvidence(): StrategyEvaluationEvidenceSnapshot {
  const allowSizing = preRiskSizing(
    "a-paper-success",
    "ALLOW",
    100n,
    100n,
    "ALLOW",
  );
  const resizeSizing = preRiskSizing(
    "c-capacity-resize",
    "RESIZE",
    100n,
    40n,
    "SINGLE_TRADE_LIMIT",
  );
  const rejectSizing = preRiskSizing(
    "j-capacity-reject",
    "REJECT",
    100n,
    0n,
    "TOKEN_COST_EXPOSURE_LIMIT",
  );
  const opportunities = [
    opportunity(
      "a-paper-success",
      {
        executionKey: "a-paper-success",
        riskDecisions: [allowSizing],
        paperFill: { id: "fill-a", intentId: "a-paper-success" },
        paperFillApplication: { fillId: "fill-a" },
      },
      { preRiskSizingEvidence: allowSizing },
    ),
    opportunity(
      "b-rounded-zero",
      {
        executionKey: "b-rounded-zero",
        followerTrade: {
          executionKey: "b-rounded-zero",
          state: "SKIPPED",
          structuredReasonCode: "SIZE_ROUNDED_TO_ZERO",
        },
      },
      { side: "SELL" },
    ),
    opportunity(
      "c-capacity-resize",
      { executionKey: "c-capacity-resize", riskDecisions: [resizeSizing] },
      { preRiskSizingEvidence: resizeSizing },
    ),
    opportunity("d-jupiter-unusable", {
      executionKey: "d-jupiter-unusable",
      jupiterAttempts: [
        {
          executionKey: "d-jupiter-unusable",
          httpStatus: 503,
          schemaValid: false,
        },
      ],
    }),
    opportunity("e-stale-quote", {
      executionKey: "e-stale-quote",
      riskDecisions: [
        {
          intentId: "e-stale-quote",
          phase: "POST_QUOTE",
          decision: "REJECT",
          reasonCode: "STALE_QUOTE",
        },
      ],
    }),
    opportunity("f-price-impact", {
      executionKey: "f-price-impact",
      riskDecisions: [
        {
          intentId: "f-price-impact",
          phase: "POST_QUOTE",
          decision: "REJECT",
          reasonCode: "PRICE_IMPACT_TOO_HIGH",
        },
      ],
    }),
    opportunity("g-intermediate", {
      executionKey: "g-intermediate",
      jupiterAttempts: [
        {
          executionKey: "g-intermediate",
          httpStatus: 200,
          schemaValid: true,
          expectedOutputRaw: 1n,
          route: [{ provider: "JUPITER" }],
        },
      ],
      riskDecisions: [
        {
          intentId: "g-intermediate",
          phase: "POST_QUOTE",
          decision: "ALLOW",
          reasonCode: "ALLOW",
        },
      ],
    }),
    opportunity("h-data-limitation", {
      executionKey: "h-data-limitation",
      followerTrade: {
        executionKey: "h-data-limitation",
        state: "SKIPPED",
        structuredReasonCode: "LEADER_PRE_BALANCE_ZERO",
      },
    }),
    opportunity(
      "i-position-mapping-failure",
      {
        executionKey: "i-position-mapping-failure",
        followerTrade: {
          executionKey: "i-position-mapping-failure",
          state: "SKIPPED",
          structuredReasonCode: "NO_MAPPED_POSITION",
        },
      },
      { side: "SELL" },
    ),
    opportunity(
      "j-capacity-reject",
      { executionKey: "j-capacity-reject", riskDecisions: [rejectSizing] },
      { preRiskSizingEvidence: rejectSizing },
    ),
    opportunity("k-policy-exclusion", {
      executionKey: "k-policy-exclusion",
      policyExclusionReasonCode: "QUOTE_ASSET_NOT_ALLOWED",
    }),
    opportunity("l-unavailable"),
  ];
  return snapshot({
    opportunities,
    jupiterAttempts: [
      jupiterAttempt("d-jupiter-unusable", {
        httpStatus: 503,
        schemaValid: false,
        expectedOutputRaw: null,
        route: null,
      }),
      jupiterAttempt("g-intermediate"),
    ],
    riskDecisions: [
      riskDecision("a-paper-success", {
        phase: "PRE_QUOTE",
        decisionId: "risk-a",
        reasonCode: "ALLOW",
      }),
      riskDecision("c-capacity-resize", {
        phase: "PRE_QUOTE",
        decision: "RESIZE",
        approvedAmountRaw: 40n,
        approvedTokenRaw: 80n,
        approvedQuoteRaw: 40n,
        reasonCode: "SINGLE_TRADE_LIMIT",
      }),
      riskDecision("e-stale-quote", {
        decision: "REJECT",
        approvedAmountRaw: 0n,
        approvedTokenRaw: 0n,
        approvedQuoteRaw: 0n,
        reasonCode: "STALE_QUOTE",
      }),
      riskDecision("f-price-impact", {
        decision: "REJECT",
        approvedAmountRaw: 0n,
        approvedTokenRaw: 0n,
        approvedQuoteRaw: 0n,
        reasonCode: "PRICE_IMPACT_TOO_HIGH",
      }),
      riskDecision("g-intermediate"),
      riskDecision("j-capacity-reject", {
        phase: "PRE_QUOTE",
        decision: "REJECT",
        approvedAmountRaw: 0n,
        approvedTokenRaw: 0n,
        approvedQuoteRaw: 0n,
        reasonCode: "TOKEN_COST_EXPOSURE_LIMIT",
      }),
    ],
    paperFills: [paperFill("fill-a", "a-paper-success")],
    paperFillApplications: [paperApplication("fill-a")],
  });
}

function directCopyability(
  evidenceSnapshot: StrategyEvaluationEvidenceSnapshot,
) {
  const context = evidenceSnapshot.provenance.expectedContext;
  const opportunities = evidenceSnapshot.opportunities
    .filter(
      (item) =>
        item.followerWallet === BUCKET.followerWallet &&
        item.leaderWallet === BUCKET.leaderWallet &&
        item.quoteMint === BUCKET.quoteMint,
    )
    .slice()
    .sort((left, right) => left.executionKey.localeCompare(right.executionKey));
  const classified: ClassifiedCopyabilityOpportunity[] = opportunities.map(
    (item) => ({
      ...BUCKET,
      executionKey: item.executionKey,
      side: item.side,
      failureClassification: classifyOpportunityFailure(
        item.normalizedEvidence,
        FAILURE_TAXONOMY_POLICY,
      ),
    }),
  );
  const sizing: SizeGranularityOpportunityEvidence[] = classified.map(
    (item, index) => ({
      ...item,
      ...(opportunities[index]!.preRiskSizingEvidence === undefined
        ? {}
        : {
            preRiskSizingEvidence: opportunities[index]!.preRiskSizingEvidence,
          }),
    }),
  );
  const jupiterSuccess = calculateJupiterSuccessRate(
    BUCKET,
    evidenceSnapshot.jupiterAttempts.filter(
      (item) =>
        item.followerWallet === BUCKET.followerWallet &&
        item.leaderWallet === BUCKET.leaderWallet &&
        item.quoteMint === BUCKET.quoteMint,
    ),
  );
  const riskDecisions = evidenceSnapshot.riskDecisions.filter(
    (item) =>
      item.followerWallet === BUCKET.followerWallet &&
      item.leaderWallet === BUCKET.leaderWallet &&
      item.quoteMint === BUCKET.quoteMint,
  );
  const postRiskDistribution = calculatePostRiskDistribution(
    BUCKET,
    riskDecisions,
  );
  const priceImpactRejectRate = calculatePriceImpactRejectRate(
    BUCKET,
    riskDecisions,
  );
  const components = {
    positionMapping: calculatePositionMappingCompatibility(
      BUCKET,
      classified,
      context,
    ),
    sizeGranularity: calculateSizeGranularityCompatibility(
      BUCKET,
      sizing,
      context,
    ),
    buyCapacity: calculateBuyCapacityCompatibility(BUCKET, sizing, context),
    jupiterQuoteUsability: calculateJupiterQuoteUsability(
      BUCKET,
      jupiterSuccess,
      context,
    ),
    postQuoteFreshness: calculatePostQuoteFreshnessCompatibility(
      BUCKET,
      opportunities.flatMap((item) =>
        (item.normalizedEvidence.riskDecisions ?? [])
          .filter((decision) => decision.phase === "POST_QUOTE")
          .map((decision) => ({
            ...BUCKET,
            executionKey: item.executionKey,
            outcome: projectPostQuoteFreshnessOutcome(decision),
          })),
      ),
      context,
    ),
    priceImpact: calculatePriceImpactCompatibility(
      BUCKET,
      { postRiskDistribution, priceImpactRejectRate },
      context,
    ),
    endToEndApplication: calculateEndToEndApplicationCompatibility(
      BUCKET,
      classified,
      context,
    ),
  };
  return calculateCopyabilityAggregate(BUCKET, components, context);
}

function evaluate(evidenceSnapshot: StrategyEvaluationEvidenceSnapshot) {
  return evaluateHistoricalEvaluation(
    evidenceSnapshot,
    BUCKET,
    STRATEGY_METRICS_POLICY,
    FAILURE_TAXONOMY_POLICY,
  );
}

describe("Historical Copyability", () => {
  it("GREEN: composes the mixed A-L cohort only through the seven frozen calculators", () => {
    const evidence = mixedEvidence();
    const result = evaluate(evidence);

    expect(result.copyability).toEqual(directCopyability(evidence));
    expect(result.copyability).toMatchObject({
      positionMapping: {
        mappedOpportunityCount: 1,
        mappingFailureCount: 1,
      },
      sizeGranularity: { roundedToZeroCount: 1 },
      buyCapacity: {
        fullSizeCount: 1,
        resizedCount: 1,
        capacityRejectCount: 1,
        requestedQuoteRawTotal: 300n,
        approvedQuoteRawTotal: 140n,
      },
      jupiterQuoteUsability: {
        jupiterQuoteOpportunityCount: 2,
        usableJupiterQuoteCount: 1,
      },
      postQuoteFreshness: {
        freshnessCompatibleCount: 2,
        staleQuoteCount: 1,
      },
      priceImpact: {
        priceImpactCompatibleCount: 1,
        priceImpactRejectedCount: 1,
      },
      endToEndApplication: {
        applicationSuccessCount: 1,
        dataLimitationCount: 1,
        unavailableCount: 3,
      },
    });
    expect(result.copyability.endToEndApplication.terminalFailureCount).toBe(6);
    expect(result.copyability.endToEndApplication.preconditionCount).toBe(11);
  });

  it("keeps intermediate NOT_A_FAILURE unavailable rather than E2E success", () => {
    const endToEnd = evaluate(mixedEvidence()).copyability.endToEndApplication;

    expect(endToEnd.applicationSuccessCount).toBe(1);
    expect(endToEnd.unavailableCount).toBe(3);
    expect(endToEnd.endToEndApplicationCompatibilityRate).not.toBe("1");
  });

  it("preserves Data Limitation, POLICY_EXCLUSION, and UNAVAILABLE semantics", () => {
    const result = evaluate(mixedEvidence());

    expect(result.copyability.endToEndApplication).toMatchObject({
      dataLimitationCount: 1,
      unavailableCount: 3,
      preconditionCount: 11,
    });
    expect(result.failureClassification.summary.policyExclusionCount).toBe(1);
    expect(result.copyability.endToEndApplication.preconditionCount).toBe(
      result.failureClassification.summary.totalCanonicalOpportunityCount - 1,
    );
  });

  it("preserves component-specific denominators, coverage, bigint, and null semantics", () => {
    const result = evaluate(mixedEvidence()).copyability;

    expect(result.positionMapping.evaluableCount).toBe(
      result.positionMapping.mappingOpportunityCount,
    );
    expect(result.sizeGranularity.evaluableCount).toBe(
      result.sizeGranularity.granularityOpportunityCount,
    );
    expect(result.buyCapacity.evaluableCount).toBe(
      result.buyCapacity.capacityOpportunityCount,
    );
    expect(result.postQuoteFreshness.evaluableCount).toBe(
      result.postQuoteFreshness.freshnessOpportunityCount,
    );
    expect(result.endToEndApplication.evaluableCount).toBe(
      result.endToEndApplication.endToEndOpportunityCount,
    );
    expect(result.buyCapacity.requestedQuoteRawTotal).toBeTypeOf("bigint");
    expect(result.positionMapping.coverageRate).not.toBeNull();
    expect(result.endToEndApplication.coverageRate).not.toBeNull();
    expect(result).not.toHaveProperty("coverageRate");
  });

  it("returns each calculator's no-evidence result for zero opportunities", () => {
    const result = evaluate(snapshot()).copyability;

    expect(result).toEqual(directCopyability(snapshot()));
    expect(result.positionMapping.status).toBe("NO_SELL_OPPORTUNITIES");
    expect(result.sizeGranularity.status).toBe("NO_SIZING_OPPORTUNITIES");
    expect(result.buyCapacity.status).toBe("NO_BUY_CAPACITY_OPPORTUNITIES");
    expect(result.jupiterQuoteUsability.status).toBe(
      "NO_JUPITER_QUOTE_OPPORTUNITIES",
    );
    expect(result.postQuoteFreshness.status).toBe(
      "NO_EVALUABLE_FRESHNESS_OUTCOMES",
    );
    expect(result.priceImpact.status).toBe("NO_PRICE_IMPACT_OPPORTUNITIES");
    expect(result.endToEndApplication.status).toBe(
      "NO_END_TO_END_OPPORTUNITIES",
    );
    expect(result.positionMapping.mappingCompatibilityRate).toBeNull();
    expect(result.endToEndApplication.coverageRate).toBeNull();
  });

  it("contains exactly the frozen aggregate and no composite score, grade, or overall status", () => {
    const result = evaluate(mixedEvidence()).copyability;

    expect(Object.keys(result)).toEqual([
      "followerWallet",
      "leaderWallet",
      "quoteMint",
      "evaluationContext",
      "positionMapping",
      "sizeGranularity",
      "buyCapacity",
      "jupiterQuoteUsability",
      "postQuoteFreshness",
      "priceImpact",
      "endToEndApplication",
      "definitionVersion",
    ]);
    expect(result).not.toHaveProperty("copyabilityScore");
    expect(result).not.toHaveProperty("overallCopyabilityRate");
    expect(result).not.toHaveProperty("weightedScore");
    expect(result).not.toHaveProperty("score");
    expect(result).not.toHaveProperty("grade");
    expect(result).not.toHaveProperty("status");
  });

  it("isolates follower, leader, and quote while retaining multiple same-bucket opportunities", () => {
    const opportunities = [
      opportunity("token-a", {
        executionKey: "token-a",
        riskDecisions: [
          {
            intentId: "token-a",
            phase: "POST_QUOTE",
            decision: "ALLOW",
            reasonCode: "ALLOW",
          },
        ],
      }),
      opportunity("token-b", {
        executionKey: "token-b",
        riskDecisions: [
          {
            intentId: "token-b",
            phase: "POST_QUOTE",
            decision: "ALLOW",
            reasonCode: "ALLOW",
          },
        ],
      }),
      opportunity("cross-follower", undefined, {
        followerWallet: "follower-b",
      }),
      opportunity("cross-leader", undefined, { leaderWallet: "leader-y" }),
      opportunity("cross-quote", undefined, { quoteMint: "USDC" }),
    ];
    const attempts = [
      jupiterAttempt("token-a"),
      jupiterAttempt("token-b"),
      jupiterAttempt("cross-follower", { followerWallet: "follower-b" }),
      jupiterAttempt("cross-leader", { leaderWallet: "leader-y" }),
      jupiterAttempt("cross-quote", { quoteMint: "USDC" }),
    ];
    const riskDecisions = [
      riskDecision("token-a", { tokenMint: "TOKEN_A" }),
      riskDecision("token-b", { tokenMint: "TOKEN_B" }),
      riskDecision("cross-follower", { followerWallet: "follower-b" }),
      riskDecision("cross-leader", { leaderWallet: "leader-y" }),
      riskDecision("cross-quote", { quoteMint: "USDC" }),
    ];
    const result = evaluate(
      snapshot({ opportunities, jupiterAttempts: attempts, riskDecisions }),
    );

    expect(
      result.failureClassification.summary.totalCanonicalOpportunityCount,
    ).toBe(2);
    expect(result.copyability.jupiterQuoteUsability).toMatchObject({
      jupiterQuoteOpportunityCount: 2,
      usableJupiterQuoteCount: 2,
    });
    expect(
      result.copyability.postQuoteFreshness.freshnessOpportunityCount,
    ).toBe(2);
    expect(result.copyability.priceImpact.priceImpactOpportunityCount).toBe(2);
  });

  it("propagates a matching context limitation without creating component failures", () => {
    const evidence = mixedEvidence();
    const limitation = {
      ...BUCKET,
      executionKey: "context-limited-not-accepted",
      reason: "CONTEXT_MODE_MISMATCH",
      expected: "PAPER",
      observed: "SHADOW",
    } as const;
    const available = evaluate(evidence);
    const limited = evaluate({ ...evidence, contextLimitations: [limitation] });

    expect(limited.availability).toBe("LIMITED");
    expect(limited.limitations).toEqual([limitation]);
    expect(limited.copyability).toEqual(available.copyability);
  });

  it("is deterministic when opportunity and downstream evidence orders reverse", () => {
    const evidence = mixedEvidence();
    const reversed = {
      ...evidence,
      opportunities: [...evidence.opportunities].reverse(),
      jupiterAttempts: [...evidence.jupiterAttempts].reverse(),
      riskDecisions: [...evidence.riskDecisions].reverse(),
      paperFills: [...evidence.paperFills].reverse(),
      paperFillApplications: [...evidence.paperFillApplications].reverse(),
    };

    expect(evaluate(reversed)).toEqual(evaluate(evidence));
  });

  it("does not change the prior Historical seams when only sizing projection is added", () => {
    const canonical = opportunity("sizing-only", {
      executionKey: "sizing-only",
      jupiterAttempts: [
        {
          executionKey: "sizing-only",
          httpStatus: 200,
          schemaValid: true,
          expectedOutputRaw: 1n,
          route: [{ provider: "JUPITER" }],
        },
      ],
    });
    const sizing = preRiskSizing("sizing-only", "ALLOW", 100n, 100n, "ALLOW");
    const before = evaluate(snapshot({ opportunities: [canonical] }));
    const after = evaluate(
      snapshot({
        opportunities: [{ ...canonical, preRiskSizingEvidence: sizing }],
      }),
    );

    expect(after.sample).toEqual(before.sample);
    expect(after.includedRoundTrips).toEqual(before.includedRoundTrips);
    expect(after.strategyMetrics).toEqual(before.strategyMetrics);
    expect(after.executionQuality).toEqual(before.executionQuality);
    expect(after.failureClassification).toEqual(before.failureClassification);
    expect(after.copyability).not.toEqual(before.copyability);
  });

  it("fails closed for duplicate canonical executionKey evidence", () => {
    const duplicate = opportunity("duplicate");

    expect(() =>
      evaluate(snapshot({ opportunities: [duplicate, { ...duplicate }] })),
    ).toThrowError("DUPLICATE_CANONICAL_OPPORTUNITY:duplicate");
  });
});
