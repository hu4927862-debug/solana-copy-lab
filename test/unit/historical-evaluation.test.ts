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
} from "../../src/strategy-evaluation/copyability.js";
import {
  calculateJupiterSuccessRate,
  calculatePaperFillOutcome,
  calculatePostRiskDistribution,
  calculatePriceImpactRejectRate,
  calculateProvider429Rate,
  calculateProvider5xxRate,
} from "../../src/strategy-evaluation/execution-quality.js";
import {
  classifyOpportunityFailure,
  projectPostQuoteFreshnessOutcome,
} from "../../src/strategy-evaluation/failure-taxonomy.js";
import { evaluateHistoricalEvaluation } from "../../src/strategy-evaluation/historical-evaluation.js";
import * as historicalEvaluationModule from "../../src/strategy-evaluation/historical-evaluation.js";
import { calculateStrategyMetrics } from "../../src/strategy-evaluation/metrics.js";
import type {
  BucketScopedStrategyEvaluationReadLimitation,
  StrategyEvaluationEvidenceSnapshot,
} from "../../src/strategy-evaluation/read-model.js";
import {
  matchFollowerRoundTrips,
  type FollowerFillApplicationEvidence,
} from "../../src/strategy-evaluation/round-trips.js";

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
const EVALUATION_CONTEXT = {
  window: { fromMs: WINDOW.windowStartMs, toMs: WINDOW.windowEndMs },
  source: "fixture",
  mode: "PAPER",
  copyRatioBps: 10_000,
  riskPolicyVersion: "RISK_V1",
  fillPolicyVersion: "FILL_V1",
  accountingPolicyVersion: "ACCOUNTING_V1",
  copyabilityDefinitionVersion: "COPYABILITY_V1",
} as const;

function application(
  fillId: string,
  overrides: Partial<FollowerFillApplicationEvidence>,
): FollowerFillApplicationEvidence {
  return {
    ...BUCKET,
    tokenMint: "TOKEN_A",
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

function postAllowRiskDecision(): RiskDecision {
  return {
    ...BUCKET,
    phase: "POST_QUOTE",
    decision: "ALLOW",
    decisionId: "post-execution-a",
    intentId: "execution-a",
    leaderTradeId: "leader-trade-a",
    side: "BUY",
    tokenMint: "TOKEN_A",
    requestedAmountRaw: 100n,
    approvedAmountRaw: 100n,
    requestedTokenRaw: 10n,
    approvedTokenRaw: 10n,
    requestedQuoteRaw: 100n,
    approvedQuoteRaw: 100n,
    reasonCode: "ALLOW",
    policyVersion: "RISK_V1",
    decidedAtMs: 6_000,
    preDecisionId: "pre-execution-a",
    quoteRequestId: "quote-execution-a",
  };
}

function completeSnapshot(): StrategyEvaluationEvidenceSnapshot {
  const roundTripApplications = [
    application("open-a", {}),
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
  const postDecision = postAllowRiskDecision();
  return {
    provenance: {
      resolvedDatabasePath: "/fixture/historical.sqlite",
      observedSchemaMigrations: [
        { version: "0001_fixture", checksum: "sha256:fixture" },
      ],
      requestedWindow: { ...WINDOW },
      expectedContext: {
        ...EVALUATION_CONTEXT,
        window: { ...EVALUATION_CONTEXT.window },
      },
    },
    roundTripApplications,
    roundTripApplicationSources: [
      {
        fillId: "open-a",
        executionKey: "open-execution-a",
        leaderTradeId: "open-leader-trade-a",
        sourceTimestamp: {
          valueMs: 2_000,
          precision: "MILLISECOND",
          provenance: "CHAIN_BLOCK_TIME",
        },
      },
      {
        fillId: "close-a",
        executionKey: "close-execution-a",
        leaderTradeId: "close-leader-trade-a",
        sourceTimestamp: {
          valueMs: 3_000,
          precision: "MILLISECOND",
          provenance: "CHAIN_BLOCK_TIME",
        },
      },
    ],
    paperFills: [
      {
        id: "paper-a",
        intentId: "execution-a",
        leaderWallet: BUCKET.leaderWallet,
        followerWallet: BUCKET.followerWallet,
        side: "BUY",
        inputMint: BUCKET.quoteMint,
        outputMint: "TOKEN_A",
        feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
        provider: "JUPITER_SWAP_V2_ORDER",
        fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
      },
    ],
    paperFillApplications: [
      {
        fillId: "paper-a",
        positionId: 1,
        transition: "OPEN",
        positionVersionAfter: 1,
        appliedAtMs: 7_000,
      },
    ],
    jupiterAttempts: [
      {
        ...BUCKET,
        executionKey: "execution-a",
        validationEventId: "validation-a",
        httpStatus: 200,
        schemaValid: true,
        expectedOutputRaw: 10n,
        route: [{ swapInfo: { label: "Raydium" } }],
      },
    ],
    riskDecisions: [postDecision],
    opportunities: [
      {
        ...BUCKET,
        executionKey: "execution-a",
        side: "BUY",
        leaderTradeId: "leader-trade-a",
        sourceTimestamp: {
          valueMs: 2_000,
          precision: "MILLISECOND",
          provenance: "CHAIN_BLOCK_TIME",
        },
        normalizedEvidence: {
          executionKey: "execution-a",
          jupiterAttempts: [
            {
              executionKey: "execution-a",
              httpStatus: 200,
              schemaValid: true,
              expectedOutputRaw: 10n,
              route: [{ provider: "JUPITER" }],
            },
          ],
          riskDecisions: [postDecision],
          paperFill: { id: "paper-a", intentId: "execution-a" },
          paperFillApplication: { fillId: "paper-a" },
        },
      },
    ],
    observationExclusions: [],
    observationLimitations: [],
    contextLimitations: [],
  };
}

describe("evaluateHistoricalEvaluation", () => {
  it("binds evaluator and failure-taxonomy definitions even without canonical opportunities", () => {
    const evidence = completeSnapshot();
    const result = evaluateHistoricalEvaluation(
      {
        ...evidence,
        opportunities: [],
      },
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result.definitionVersion).toBe("HISTORICAL_EVALUATION_V1");
    expect(result.failureClassification.definitionVersion).toBe(
      "OPPORTUNITY_FAILURE_V1",
    );
    expect(result.failureClassification.classifiedOpportunities).toEqual([]);
  });

  it("returns the complete public Historical Evaluation contract", () => {
    const result = evaluateHistoricalEvaluation(
      completeSnapshot(),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result).toMatchObject({
      bucket: BUCKET,
      window: WINDOW,
      evaluationContext: EVALUATION_CONTEXT,
      provenance: {
        resolvedDatabasePath: "/fixture/historical.sqlite",
        observedSchemaMigrations: [
          { version: "0001_fixture", checksum: "sha256:fixture" },
        ],
        requestedWindow: WINDOW,
        expectedContext: EVALUATION_CONTEXT,
      },
      availability: "AVAILABLE",
      sample: {
        fullyContainedCount: 1,
        leftCensoredCount: 0,
        rightCensoredCount: 0,
        preWindowOpenCount: 0,
        sourceUnavailableCount: 0,
        sampleStatus: "INSUFFICIENT_SAMPLE",
      },
      strategyMetrics: {},
      executionQuality: {},
      failureClassification: {},
      copyability: {},
      limitations: [],
    });
    expect(Object.keys(result)).toEqual([
      "definitionVersion",
      "bucket",
      "window",
      "evaluationContext",
      "provenance",
      "availability",
      "sample",
      "includedRoundTrips",
      "includedLifecycleSourceTimingEvidence",
      "strategyMetricSemantics",
      "strategyMetrics",
      "executionQuality",
      "failureClassification",
      "copyability",
      "limitations",
    ]);
    expect(Object.keys(result.provenance)).toEqual([
      "resolvedDatabasePath",
      "observedSchemaMigrations",
      "requestedWindow",
      "expectedContext",
    ]);
  });

  it("keeps Historical V1 availability unchanged for RoundTrip corruption", () => {
    const evidence = completeSnapshot();
    const baseline = evaluateHistoricalEvaluation(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const result = evaluateHistoricalEvaluation(
      {
        ...evidence,
        roundTripApplications: evidence.roundTripApplications.map(
          (application) =>
            application.fillId === "close-a"
              ? { ...application, positionVersionAfter: 3 }
              : application,
        ),
      },
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result).toMatchObject({
      definitionVersion: "HISTORICAL_EVALUATION_V1",
      availability: "AVAILABLE",
      sample: { fullyContainedCount: 0 },
      limitations: [],
    });
    expect(result).not.toHaveProperty("unevaluableLifecycleCount");
    expect(result).not.toHaveProperty("roundTripLimitations");
    expect(result.executionQuality).toEqual(baseline.executionQuality);
    expect(result.failureClassification).toEqual(
      baseline.failureClassification,
    );
    expect(result.copyability).toEqual(baseline.copyability);
  });

  it("exports one accurately named evaluator without the stale Strategy-only API", () => {
    expect(historicalEvaluationModule).toHaveProperty(
      "evaluateHistoricalEvaluation",
    );
    expect(historicalEvaluationModule).not.toHaveProperty(
      "evaluateHistoricalStrategyMetrics",
    );
  });

  it("preserves all four analytical seam results through direct composition", () => {
    const evidence = completeSnapshot();
    const result = evaluateHistoricalEvaluation(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const evaluationContext = evidence.provenance.expectedContext;
    const roundTrips = matchFollowerRoundTrips(evidence.roundTripApplications);
    const opportunity = evidence.opportunities[0]!;
    const classification = classifyOpportunityFailure(
      opportunity.normalizedEvidence,
      FAILURE_TAXONOMY_POLICY,
    );
    const classifiedOpportunity = {
      ...BUCKET,
      executionKey: opportunity.executionKey,
      side: opportunity.side,
      failureClassification: classification,
    };
    const jupiterSuccess = calculateJupiterSuccessRate(
      BUCKET,
      evidence.jupiterAttempts,
    );
    const postRiskDistribution = calculatePostRiskDistribution(
      BUCKET,
      evidence.riskDecisions,
    );
    const priceImpactRejectRate = calculatePriceImpactRejectRate(
      BUCKET,
      evidence.riskDecisions,
    );
    const copyabilityComponents = {
      positionMapping: calculatePositionMappingCompatibility(
        BUCKET,
        [classifiedOpportunity],
        evaluationContext,
      ),
      sizeGranularity: calculateSizeGranularityCompatibility(
        BUCKET,
        [classifiedOpportunity],
        evaluationContext,
      ),
      buyCapacity: calculateBuyCapacityCompatibility(
        BUCKET,
        [classifiedOpportunity],
        evaluationContext,
      ),
      jupiterQuoteUsability: calculateJupiterQuoteUsability(
        BUCKET,
        jupiterSuccess,
        evaluationContext,
      ),
      postQuoteFreshness: calculatePostQuoteFreshnessCompatibility(
        BUCKET,
        opportunity.normalizedEvidence.riskDecisions!.map((decision) => ({
          ...BUCKET,
          executionKey: opportunity.executionKey,
          outcome: projectPostQuoteFreshnessOutcome(decision),
        })),
        evaluationContext,
      ),
      priceImpact: calculatePriceImpactCompatibility(
        BUCKET,
        { postRiskDistribution, priceImpactRejectRate },
        evaluationContext,
      ),
      endToEndApplication: calculateEndToEndApplicationCompatibility(
        BUCKET,
        [classifiedOpportunity],
        evaluationContext,
      ),
    };

    expect(roundTrips.incomplete).toEqual([]);
    expect(result.includedRoundTrips).toEqual(roundTrips.completed);
    expect(result.strategyMetrics).toEqual(
      calculateStrategyMetrics(roundTrips.completed, STRATEGY_METRICS_POLICY),
    );
    expect(result.executionQuality).toEqual({
      jupiterSuccess,
      providerHttp: {
        provider429: calculateProvider429Rate(BUCKET, evidence.jupiterAttempts),
        provider5xx: calculateProvider5xxRate(BUCKET, evidence.jupiterAttempts),
      },
      postRiskDistribution,
      priceImpactReject: priceImpactRejectRate,
      paperFillOutcome: calculatePaperFillOutcome(
        BUCKET,
        evidence.paperFills,
        evidence.paperFillApplications,
      ),
    });
    expect(result.failureClassification).toEqual({
      definitionVersion: FAILURE_TAXONOMY_POLICY.definitionVersion,
      classifiedOpportunities: [
        { executionKey: opportunity.executionKey, classification },
      ],
      summary: {
        totalCanonicalOpportunityCount: 1,
        terminalFailureCount: 0,
        categoryCounts: {
          EXECUTION_FAILURE: 0,
          MARKET_FAILURE: 0,
          RISK_REJECTION: 0,
          COPYABILITY_FAILURE: 0,
          DATA_LIMITATION: 0,
          POLICY_EXCLUSION: 0,
        },
        paperApplicationSuccessCount: 1,
        intermediateNotAFailureCount: 0,
        dataLimitationCount: 0,
        policyExclusionCount: 0,
        unavailableCount: 0,
      },
    });
    expect(result.copyability).toEqual(
      calculateCopyabilityAggregate(
        BUCKET,
        copyabilityComponents,
        evaluationContext,
      ),
    );
  });

  it("keeps every denominator local and exposes no score, rate, recommendation, or readiness aggregate", () => {
    const result = evaluateHistoricalEvaluation(
      completeSnapshot(),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result.sample.fullyContainedCount).toBe(1);
    expect(result.strategyMetrics.netQuoteExpectancy.sampleCount).toBe(1);
    expect(result.executionQuality.jupiterSuccess.attemptCount).toBe(1);
    expect(
      result.failureClassification.summary.totalCanonicalOpportunityCount,
    ).toBe(1);
    expect(result.copyability.postQuoteFreshness.preconditionCount).toBe(1);
    for (const forbiddenField of [
      "historicalScore",
      "strategyScore",
      "leaderScore",
      "copyabilityScore",
      "overallScore",
      "weightedScore",
      "grade",
      "overallFailureRate",
      "recommendation",
      "liveReady",
      "leaderEligible",
      "capitalWeight",
    ]) {
      expect(result).not.toHaveProperty(forbiddenField);
    }
  });

  it("isolates matching bucket limitations from an unaffected bucket", () => {
    const limitation = {
      ...BUCKET,
      executionKey: "limited-a",
      reason: "CONTEXT_MODE_MISMATCH",
      expected: "PAPER",
      observed: "SHADOW",
    } as const;
    const evidence = {
      ...completeSnapshot(),
      contextLimitations: [limitation],
    };
    const bucketB = { ...BUCKET, followerWallet: "follower-b" };
    const limitedA = evaluateHistoricalEvaluation(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const availableB = evaluateHistoricalEvaluation(
      evidence,
      bucketB,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const baselineB = evaluateHistoricalEvaluation(
      { ...evidence, contextLimitations: [] },
      bucketB,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(limitedA).toMatchObject({
      availability: "LIMITED",
      limitations: [limitation],
    });
    expect(availableB).toMatchObject({
      availability: "AVAILABLE",
      limitations: [],
    });
    expect(availableB.strategyMetrics).toEqual(baselineB.strategyMetrics);
    expect(availableB.executionQuality).toEqual(baselineB.executionQuality);
    expect(availableB.failureClassification).toEqual(
      baselineB.failureClassification,
    );
    expect(availableB.copyability).toEqual(baselineB.copyability);
  });

  it("keeps observation-only evidence outside the per-bucket result", () => {
    const evidence = completeSnapshot();
    const observation = {
      id: "observation-only",
      signature: "signature-only",
      eventIndex: 0,
      leaderWallet: BUCKET.leaderWallet,
      systemClassification: "UNSUPPORTED",
      groundTruthClassification: "BUY",
      structuredReasonCode: "NO_SWAP_EVIDENCE",
      isDuplicate: false,
    } as const;
    const baseline = evaluateHistoricalEvaluation(
      evidence,
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );
    const withObservationOnly = evaluateHistoricalEvaluation(
      {
        ...evidence,
        observationExclusions: [observation],
        observationLimitations: [
          { ...observation, limitationReason: "WINDOW_MEMBERSHIP_UNPROVEN" },
        ],
      },
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(withObservationOnly).toEqual(baseline);
    expect(withObservationOnly).not.toHaveProperty("observationExclusions");
    expect(withObservationOnly).not.toHaveProperty("observationLimitations");
  });

  it("preserves source-unavailable evidence as a lifecycle limitation", () => {
    const evidence = completeSnapshot();
    const result = evaluateHistoricalEvaluation(
      {
        ...evidence,
        roundTripApplicationSources: evidence.roundTripApplicationSources.slice(
          0,
          1,
        ),
      },
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result).toMatchObject({
      availability: "LIMITED",
      sample: {
        fullyContainedCount: 0,
        sourceUnavailableCount: 1,
        sampleStatus: "INSUFFICIENT_SAMPLE",
      },
      limitations: [
        {
          reason: "SOURCE_UNAVAILABLE",
          lifecycleStatus: "COMPLETED",
          openFillId: "open-a",
          unavailableFillIds: ["close-a"],
        },
      ],
    });
    expect(result.failureClassification.summary.terminalFailureCount).toBe(0);
    expect(result.copyability.endToEndApplication.terminalFailureCount).toBe(0);
  });

  it("is deterministic when every evidence and provenance array is reversed", () => {
    const evidence = completeSnapshot();
    const migrations = [
      { version: "0002_fixture", checksum: "sha256:second" },
      ...evidence.provenance.observedSchemaMigrations,
    ];
    const canonical = {
      ...evidence,
      provenance: {
        ...evidence.provenance,
        observedSchemaMigrations: migrations,
      },
    };
    const reversed = {
      ...canonical,
      provenance: {
        ...canonical.provenance,
        observedSchemaMigrations: [...migrations].reverse(),
      },
      roundTripApplications: [...canonical.roundTripApplications].reverse(),
      roundTripApplicationSources: [
        ...canonical.roundTripApplicationSources,
      ].reverse(),
      paperFills: [...canonical.paperFills].reverse(),
      paperFillApplications: [...canonical.paperFillApplications].reverse(),
      jupiterAttempts: [...canonical.jupiterAttempts].reverse(),
      riskDecisions: [...canonical.riskDecisions].reverse(),
      opportunities: [...canonical.opportunities].reverse(),
      observationExclusions: [...canonical.observationExclusions].reverse(),
      observationLimitations: [...canonical.observationLimitations].reverse(),
      contextLimitations: [...canonical.contextLimitations].reverse(),
    };

    expect(
      evaluateHistoricalEvaluation(
        reversed,
        BUCKET,
        STRATEGY_METRICS_POLICY,
        FAILURE_TAXONOMY_POLICY,
      ),
    ).toEqual(
      evaluateHistoricalEvaluation(
        canonical,
        BUCKET,
        STRATEGY_METRICS_POLICY,
        FAILURE_TAXONOMY_POLICY,
      ),
    );
  });

  it("defensively copies bucket, window, context, provenance, migrations, and limitations", () => {
    const mutableBucket: {
      followerWallet: string;
      leaderWallet: string;
      quoteMint: string;
    } = { ...BUCKET };
    const limitation = {
      ...BUCKET,
      executionKey: "limited-a",
      reason: "CONTEXT_COPY_RATIO_MISMATCH",
      expected: 10_000,
      observed: 5_000,
    } as const;
    const evidence = {
      ...completeSnapshot(),
      contextLimitations: [limitation],
    };
    const result = evaluateHistoricalEvaluation(
      evidence,
      mutableBucket,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    mutableBucket.followerWallet = "mutated-follower";
    (
      evidence.provenance.requestedWindow as {
        windowStartMs: number;
      }
    ).windowStartMs = 99_999;
    (
      evidence.provenance.expectedContext as {
        source: string;
      }
    ).source = "mutated-source";
    (
      evidence.provenance.expectedContext.window as {
        fromMs: number;
      }
    ).fromMs = 99_999;
    (
      evidence.provenance.observedSchemaMigrations as Array<{
        version: string;
        checksum: string;
      }>
    )[0]!.version = "mutated-migration";
    (
      evidence.contextLimitations[0] as {
        expected: number;
      }
    ).expected = 1;
    (
      evidence.contextLimitations as BucketScopedStrategyEvaluationReadLimitation[]
    ).push({ ...limitation, executionKey: "late-mutation" });

    expect(result.bucket).toEqual(BUCKET);
    expect(result.window).toEqual(WINDOW);
    expect(result.evaluationContext).toEqual(EVALUATION_CONTEXT);
    expect(result.provenance).toEqual({
      resolvedDatabasePath: "/fixture/historical.sqlite",
      observedSchemaMigrations: [
        { version: "0001_fixture", checksum: "sha256:fixture" },
      ],
      requestedWindow: WINDOW,
      expectedContext: EVALUATION_CONTEXT,
    });
    expect(result.limitations).toEqual([
      {
        ...BUCKET,
        executionKey: "limited-a",
        reason: "CONTEXT_COPY_RATIO_MISMATCH",
        expected: 10_000,
        observed: 5_000,
      },
    ]);
  });

  it("preserves bigint economics without lossy aggregate conversion", () => {
    const result = evaluateHistoricalEvaluation(
      completeSnapshot(),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_TAXONOMY_POLICY,
    );

    expect(result.includedRoundTrips[0]!.realizedPnlQuoteRaw).toBe(25n);
    expect(result.copyability.buyCapacity.requestedQuoteRawTotal).toBe(0n);
    expect(result.copyability.buyCapacity.requestedQuoteRawTotal).toBeTypeOf(
      "bigint",
    );
  });
});
