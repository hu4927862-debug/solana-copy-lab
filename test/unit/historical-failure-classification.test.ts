import { describe, expect, it } from "vitest";
import type {
  FailureTaxonomyPolicy,
  NormalizedOpportunityEvidence,
} from "../../src/strategy-evaluation/failure-taxonomy.js";
import { classifyOpportunityFailure } from "../../src/strategy-evaluation/failure-taxonomy.js";
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
const FAILURE_POLICY: FailureTaxonomyPolicy = {
  definitionVersion: "OPPORTUNITY_FAILURE_V1",
};

function opportunity(
  executionKey: string,
  normalizedEvidence: NormalizedOpportunityEvidence,
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

function snapshot(
  opportunities: readonly StrategyEvaluationOpportunityProjection[],
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
    opportunities,
    observationExclusions: [],
    observationLimitations: [],
    contextLimitations: [],
    ...overrides,
  };
}

function canonicalFailureFixture(): readonly StrategyEvaluationOpportunityProjection[] {
  return [
    opportunity("a-paper-success", {
      executionKey: "a-paper-success",
      paperFill: { id: "fill-a", intentId: "a-paper-success" },
      paperFillApplication: { fillId: "fill-a" },
    }),
    opportunity("b-jupiter-failure", {
      executionKey: "b-jupiter-failure",
      jupiterAttempts: [
        {
          executionKey: "b-jupiter-failure",
          httpStatus: 503,
          schemaValid: false,
        },
      ],
    }),
    opportunity("c-stale-quote", {
      executionKey: "c-stale-quote",
      riskDecisions: [
        {
          intentId: "c-stale-quote",
          phase: "POST_QUOTE",
          decision: "REJECT",
          reasonCode: "STALE_QUOTE",
        },
      ],
    }),
    opportunity("d-price-impact", {
      executionKey: "d-price-impact",
      riskDecisions: [
        {
          intentId: "d-price-impact",
          phase: "POST_QUOTE",
          decision: "REJECT",
          reasonCode: "PRICE_IMPACT_TOO_HIGH",
        },
      ],
    }),
    opportunity("e-pre-risk", {
      executionKey: "e-pre-risk",
      riskDecisions: [
        {
          intentId: "e-pre-risk",
          phase: "PRE_QUOTE",
          decision: "REJECT",
          reasonCode: "STALE_INTENT",
        },
      ],
    }),
    opportunity("f-data-limitation", {
      executionKey: "f-data-limitation",
      followerTrade: {
        executionKey: "f-data-limitation",
        state: "SKIPPED",
        structuredReasonCode: "LEADER_PRE_BALANCE_ZERO",
      },
    }),
    opportunity("g-policy-exclusion", {
      executionKey: "g-policy-exclusion",
      policyExclusionReasonCode: "QUOTE_ASSET_NOT_ALLOWED",
    }),
    opportunity("h-unavailable", { executionKey: "h-unavailable" }),
    opportunity("i-intermediate", {
      executionKey: "i-intermediate",
      jupiterAttempts: [
        {
          executionKey: "i-intermediate",
          httpStatus: 200,
          schemaValid: true,
          expectedOutputRaw: 1n,
          route: [{ provider: "JUPITER" }],
        },
      ],
      riskDecisions: [
        {
          intentId: "i-intermediate",
          phase: "POST_QUOTE",
          decision: "ALLOW",
          reasonCode: "ALLOW",
        },
      ],
    }),
  ];
}

describe("Historical Failure Classification", () => {
  it("classifies and transparently summarizes the canonical A-I cohort", () => {
    const result = evaluateHistoricalEvaluation(
      snapshot(canonicalFailureFixture()),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_POLICY,
    );

    expect(result).toMatchObject({
      failureClassification: {
        summary: {
          totalCanonicalOpportunityCount: 9,
          terminalFailureCount: 4,
          categoryCounts: {
            EXECUTION_FAILURE: 1,
            MARKET_FAILURE: 1,
            RISK_REJECTION: 1,
            COPYABILITY_FAILURE: 1,
            DATA_LIMITATION: 1,
            POLICY_EXCLUSION: 1,
          },
          paperApplicationSuccessCount: 1,
          intermediateNotAFailureCount: 1,
          dataLimitationCount: 1,
          policyExclusionCount: 1,
          unavailableCount: 1,
        },
      },
    });
    expect(
      result.failureClassification.classifiedOpportunities.map(
        ({ executionKey, classification }) => ({
          executionKey,
          classificationStatus: classification.classificationStatus,
          primaryCategory: classification.primaryCategory,
          stage: classification.stage,
          reasonCode: classification.reasonCode,
        }),
      ),
    ).toEqual([
      {
        executionKey: "a-paper-success",
        classificationStatus: "NOT_A_FAILURE",
        primaryCategory: null,
        stage: "PAPER_APPLICATION",
        reasonCode: null,
      },
      {
        executionKey: "b-jupiter-failure",
        classificationStatus: "CLASSIFIED",
        primaryCategory: "EXECUTION_FAILURE",
        stage: "JUPITER_ORDER",
        reasonCode: "JUPITER_HTTP_5XX",
      },
      {
        executionKey: "c-stale-quote",
        classificationStatus: "CLASSIFIED",
        primaryCategory: "COPYABILITY_FAILURE",
        stage: "POST_QUOTE_RISK",
        reasonCode: "STALE_QUOTE",
      },
      {
        executionKey: "d-price-impact",
        classificationStatus: "CLASSIFIED",
        primaryCategory: "MARKET_FAILURE",
        stage: "POST_QUOTE_RISK",
        reasonCode: "PRICE_IMPACT_TOO_HIGH",
      },
      {
        executionKey: "e-pre-risk",
        classificationStatus: "CLASSIFIED",
        primaryCategory: "RISK_REJECTION",
        stage: "PRE_QUOTE_RISK",
        reasonCode: "STALE_INTENT",
      },
      {
        executionKey: "f-data-limitation",
        classificationStatus: "CLASSIFIED",
        primaryCategory: "DATA_LIMITATION",
        stage: "COPY_DECISION",
        reasonCode: "LEADER_PRE_BALANCE_ZERO",
      },
      {
        executionKey: "g-policy-exclusion",
        classificationStatus: "CLASSIFIED",
        primaryCategory: "POLICY_EXCLUSION",
        stage: "OBSERVATION_POLICY",
        reasonCode: "QUOTE_ASSET_NOT_ALLOWED",
      },
      {
        executionKey: "h-unavailable",
        classificationStatus: "UNAVAILABLE",
        primaryCategory: null,
        stage: null,
        reasonCode: null,
      },
      {
        executionKey: "i-intermediate",
        classificationStatus: "NOT_A_FAILURE",
        primaryCategory: null,
        stage: "JUPITER_ORDER",
        reasonCode: null,
      },
    ]);
  });

  it("is a direct composition of the existing classifier", () => {
    const opportunities = canonicalFailureFixture();
    const result = evaluateHistoricalEvaluation(
      snapshot(opportunities),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_POLICY,
    );

    expect(result.failureClassification.classifiedOpportunities).toEqual(
      opportunities.map(({ executionKey, normalizedEvidence }) => ({
        executionKey,
        classification: classifyOpportunityFailure(
          normalizedEvidence,
          FAILURE_POLICY,
        ),
      })),
    );
  });

  it("returns transparent zero counts without a synthetic pass or rate", () => {
    const failureClassification = evaluateHistoricalEvaluation(
      snapshot([]),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_POLICY,
    ).failureClassification;

    expect(failureClassification).toEqual({
      definitionVersion: FAILURE_POLICY.definitionVersion,
      classifiedOpportunities: [],
      summary: {
        totalCanonicalOpportunityCount: 0,
        terminalFailureCount: 0,
        categoryCounts: {
          EXECUTION_FAILURE: 0,
          MARKET_FAILURE: 0,
          RISK_REJECTION: 0,
          COPYABILITY_FAILURE: 0,
          DATA_LIMITATION: 0,
          POLICY_EXCLUSION: 0,
        },
        paperApplicationSuccessCount: 0,
        intermediateNotAFailureCount: 0,
        dataLimitationCount: 0,
        policyExclusionCount: 0,
        unavailableCount: 0,
      },
    });
    expect(failureClassification).not.toHaveProperty("failureRate");
    expect(failureClassification).not.toHaveProperty("overallFailureRate");
    expect(failureClassification).not.toHaveProperty("successRate");
  });

  it("isolates follower, leader, and quote before classification", () => {
    const result = evaluateHistoricalEvaluation(
      snapshot([
        opportunity("a", { executionKey: "a" }),
        opportunity(
          "b",
          { executionKey: "b" },
          { followerWallet: "follower-b" },
        ),
        opportunity("c", { executionKey: "c" }, { leaderWallet: "leader-y" }),
        opportunity("d", { executionKey: "d" }, { quoteMint: "USDC" }),
      ]),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_POLICY,
    ).failureClassification;

    expect(result.summary.totalCanonicalOpportunityCount).toBe(1);
    expect(
      result.classifiedOpportunities.map(({ executionKey }) => executionKey),
    ).toEqual(["a"]);
  });

  it("does not turn context or observation-only evidence into failures", () => {
    const accepted = opportunity("accepted", {
      executionKey: "accepted",
      jupiterAttempts: [
        {
          executionKey: "accepted",
          httpStatus: 200,
          schemaValid: true,
          expectedOutputRaw: 1n,
          route: [{ provider: "JUPITER" }],
        },
      ],
    });
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
    const contextLimitation = {
      ...BUCKET,
      executionKey: "context-limited-not-accepted",
      reason: "CONTEXT_MODE_MISMATCH",
      expected: "PAPER",
      observed: "SHADOW",
    } as const;
    const result = evaluateHistoricalEvaluation(
      snapshot([accepted], {
        contextLimitations: [contextLimitation],
        observationExclusions: [observation],
        observationLimitations: [
          { ...observation, limitationReason: "WINDOW_MEMBERSHIP_UNPROVEN" },
        ],
      }),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_POLICY,
    );

    expect(result).toMatchObject({
      availability: "LIMITED",
      limitations: [contextLimitation],
      failureClassification: {
        summary: { totalCanonicalOpportunityCount: 1 },
      },
    });
    expect(
      result.failureClassification.classifiedOpportunities.map(
        ({ executionKey }) => executionKey,
      ),
    ).toEqual(["accepted"]);
  });

  it("fails closed for a duplicate canonical executionKey", () => {
    const duplicate = opportunity("duplicate", { executionKey: "duplicate" });

    expect(() =>
      evaluateHistoricalEvaluation(
        snapshot([duplicate, { ...duplicate }]),
        BUCKET,
        STRATEGY_METRICS_POLICY,
        FAILURE_POLICY,
      ),
    ).toThrowError("DUPLICATE_CANONICAL_OPPORTUNITY:duplicate");
  });

  it("sorts classifications deterministically by executionKey", () => {
    const opportunities = canonicalFailureFixture();
    const first = evaluateHistoricalEvaluation(
      snapshot(opportunities),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_POLICY,
    ).failureClassification;
    const second = evaluateHistoricalEvaluation(
      snapshot([...opportunities].reverse()),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_POLICY,
    ).failureClassification;

    expect(second).toEqual(first);
    expect(
      first.classifiedOpportunities.map(({ executionKey }) => executionKey),
    ).toEqual(
      [...opportunities].map(({ executionKey }) => executionKey).sort(),
    );
  });

  it("leaves the Strategy and Execution Quality seams unchanged", () => {
    const before = evaluateHistoricalEvaluation(
      snapshot([]),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_POLICY,
    );
    const after = evaluateHistoricalEvaluation(
      snapshot(canonicalFailureFixture()),
      BUCKET,
      STRATEGY_METRICS_POLICY,
      FAILURE_POLICY,
    );

    expect(after.sample).toEqual(before.sample);
    expect(after.includedRoundTrips).toEqual(before.includedRoundTrips);
    expect(after.strategyMetrics).toEqual(before.strategyMetrics);
    expect(after.executionQuality).toEqual(before.executionQuality);
  });
});
