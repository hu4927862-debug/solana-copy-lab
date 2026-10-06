import { describe, expect, it } from "vitest";
import {
  calculateJupiterSuccessRate,
  calculatePaperFillOutcome,
  calculatePostRiskDistribution,
  calculatePriceImpactRejectRate,
  calculateProvider429Rate,
  calculateProvider5xxRate,
  type JupiterAttemptEvidence,
  type FollowerScopedJupiterSuccessRateResult,
  type PaperFillApplicationOutcomeEvidence,
  type PaperFillOutcomeEvidence,
  type PostRiskExecutionQualityBucket,
  type RiskDecisionEvidence,
} from "../../src/strategy-evaluation/execution-quality.js";

const postRiskBucket: PostRiskExecutionQualityBucket = {
  followerWallet: "follower-wallet",
  leaderWallet: "leader-wallet",
  quoteMint: "SOL_NATIVE",
};

function attempt(
  executionKey: string,
  overrides: Partial<JupiterAttemptEvidence> = {},
): JupiterAttemptEvidence {
  return {
    executionKey,
    leaderWallet: "leader-wallet",
    quoteMint: "SOL_NATIVE",
    httpStatus: 200,
    schemaValid: true,
    expectedOutputRaw: 1n,
    route: [{ swapInfo: { label: "Raydium" } }],
    ...overrides,
  };
}

function riskDecision(
  intentId: string,
  decision: RiskDecisionEvidence["decision"],
  overrides: Partial<RiskDecisionEvidence> = {},
): RiskDecisionEvidence {
  const reasonCodeByDecision = {
    ALLOW: "ALLOW",
    RESIZE: "SINGLE_TRADE_LIMIT",
    REJECT: "QUOTE_AMOUNT_MISMATCH",
    HALT: "GLOBAL_HALT_NEW_RISK",
  } as const;

  return {
    phase: "POST_QUOTE",
    intentId,
    decision,
    reasonCode: reasonCodeByDecision[decision],
    followerWallet: "follower-wallet",
    leaderWallet: "leader-wallet",
    quoteMint: "SOL_NATIVE",
    ...overrides,
  };
}

function paperFill(
  id: string,
  overrides: Partial<PaperFillOutcomeEvidence> = {},
): PaperFillOutcomeEvidence {
  return {
    id,
    intentId: `intent-${id}`,
    leaderWallet: "leader-wallet",
    followerWallet: "follower-wallet",
    side: "BUY",
    inputMint: "SOL_NATIVE",
    outputMint: "token-mint",
    feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
    provider: "JUPITER_SWAP_V2_ORDER",
    fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
    ...overrides,
  };
}

function paperFillApplication(
  fillId: string,
  overrides: Partial<PaperFillApplicationOutcomeEvidence> = {},
): PaperFillApplicationOutcomeEvidence {
  return {
    fillId,
    positionId: 1,
    transition: "OPEN",
    positionVersionAfter: 1,
    appliedAtMs: 2_000,
    ...overrides,
  };
}

describe("calculateJupiterSuccessRate", () => {
  it("reports two successes from three stable Jupiter attempts", () => {
    const firstSuccess = attempt("attempt-1");
    const evidence = [
      firstSuccess,
      attempt("attempt-2"),
      attempt("attempt-3", {
        httpStatus: 429,
        schemaValid: false,
        expectedOutputRaw: null,
        route: [],
      }),
      { ...firstSuccess },
    ];

    expect(
      calculateJupiterSuccessRate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        evidence,
      ),
    ).toEqual({
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      attemptCount: 3,
      successCount: 2,
      successRate: "0.666666666666666666",
      status: "AVAILABLE",
    });
  });

  it("reports no rate when the bucket has no Jupiter attempts", () => {
    expect(
      calculateJupiterSuccessRate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [],
      ),
    ).toEqual({
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      attemptCount: 0,
      successCount: 0,
      successRate: null,
      status: "NO_ATTEMPTS",
    });
  });

  it("adds follower bucket metadata without changing Jupiter success semantics", () => {
    const result: FollowerScopedJupiterSuccessRateResult =
      calculateJupiterSuccessRate(postRiskBucket, [
        attempt("attempt-1"),
        attempt("attempt-2", {
          httpStatus: 429,
          schemaValid: false,
          expectedOutputRaw: null,
          route: [],
        }),
      ]);

    expect(result).toEqual({
      followerWallet: "follower-wallet",
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      attemptCount: 2,
      successCount: 1,
      successRate: "0.5",
      status: "AVAILABLE",
    });
  });
});

describe("calculateProvider429Rate", () => {
  it("reports two HTTP 429 responses from four stable Jupiter attempts", () => {
    const rateLimited = attempt("attempt-b", {
      httpStatus: 429,
      schemaValid: false,
      expectedOutputRaw: null,
      route: [],
    });
    const evidence = [
      attempt("attempt-a"),
      rateLimited,
      attempt("attempt-c", {
        httpStatus: 429,
        schemaValid: false,
        expectedOutputRaw: null,
        route: [],
      }),
      attempt("attempt-d", {
        httpStatus: 500,
        schemaValid: false,
        expectedOutputRaw: null,
        route: [],
      }),
      { ...rateLimited },
    ];

    expect(
      calculateProvider429Rate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        evidence,
      ),
    ).toEqual({
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      attemptCount: 4,
      provider429Count: 2,
      provider429Rate: "0.5",
      status: "AVAILABLE",
    });
  });

  it("reports a zero rate when attempts contain no HTTP 429", () => {
    expect(
      calculateProvider429Rate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [
          attempt("attempt-1"),
          attempt("attempt-2", {
            httpStatus: 500,
            schemaValid: false,
            expectedOutputRaw: null,
            route: [],
          }),
        ],
      ),
    ).toMatchObject({
      attemptCount: 2,
      provider429Count: 0,
      provider429Rate: "0",
      status: "AVAILABLE",
    });
  });

  it("reports a rate of one when every attempt returned HTTP 429", () => {
    expect(
      calculateProvider429Rate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [
          attempt("attempt-1", { httpStatus: 429 }),
          attempt("attempt-2", { httpStatus: 429 }),
        ],
      ),
    ).toMatchObject({
      attemptCount: 2,
      provider429Count: 2,
      provider429Rate: "1",
      status: "AVAILABLE",
    });
  });

  it("reports no rate when the bucket has no Jupiter attempts", () => {
    expect(
      calculateProvider429Rate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [],
      ),
    ).toEqual({
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      attemptCount: 0,
      provider429Count: 0,
      provider429Rate: null,
      status: "NO_ATTEMPTS",
    });
  });

  it("does not count duplicate evidence for the same execution key", () => {
    const rateLimited = attempt("attempt-1", { httpStatus: 429 });

    expect(
      calculateProvider429Rate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [rateLimited, { ...rateLimited }],
      ),
    ).toMatchObject({
      attemptCount: 1,
      provider429Count: 1,
      provider429Rate: "1",
    });
  });

  it("fails closed for conflicting evidence with the same execution key", () => {
    expect(() =>
      calculateProvider429Rate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [
          attempt("attempt-1", { httpStatus: 429 }),
          attempt("attempt-1", { httpStatus: 200 }),
        ],
      ),
    ).toThrowError("CONFLICTING_JUPITER_ATTEMPT_EVIDENCE");
  });

  it("formats a non-divisible rate to 18 decimal places toward zero", () => {
    expect(
      calculateProvider429Rate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [
          attempt("attempt-1", { httpStatus: 429 }),
          attempt("attempt-2"),
          attempt("attempt-3", { httpStatus: 500 }),
        ],
      ).provider429Rate,
    ).toBe("0.333333333333333333");
  });

  it("does not depend on input order", () => {
    const evidence = [
      attempt("attempt-1", { httpStatus: 429 }),
      attempt("attempt-2"),
      attempt("attempt-3", { httpStatus: 500 }),
    ];
    const bucket = {
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
    } as const;

    expect(calculateProvider429Rate(bucket, evidence)).toEqual(
      calculateProvider429Rate(bucket, [...evidence].reverse()),
    );
  });

  it("fails closed when evidence crosses the requested bucket", () => {
    const bucket = {
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
    } as const;

    expect(() =>
      calculateProvider429Rate(bucket, [
        attempt("attempt-1", { leaderWallet: "other-leader" }),
      ]),
    ).toThrowError("CROSS_LEADER_EXECUTION_QUALITY_BUCKET");
    expect(() =>
      calculateProvider429Rate(bucket, [
        attempt("attempt-1", { quoteMint: "USDC" }),
      ]),
    ).toThrowError("CROSS_QUOTE_EXECUTION_QUALITY_BUCKET");
  });
});

describe("calculateProvider5xxRate", () => {
  it("reports three HTTP 5xx responses from five stable Jupiter attempts", () => {
    const badGateway = attempt("attempt-c", { httpStatus: 502 });
    const evidence = [
      attempt("attempt-a", { httpStatus: 200 }),
      attempt("attempt-b", { httpStatus: 500 }),
      badGateway,
      attempt("attempt-d", { httpStatus: 429 }),
      attempt("attempt-e", { httpStatus: 503 }),
      { ...badGateway },
    ];

    expect(
      calculateProvider5xxRate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        evidence,
      ),
    ).toEqual({
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      attemptCount: 5,
      provider5xxCount: 3,
      provider5xxRate: "0.6",
      status: "AVAILABLE",
    });
  });

  it("reports a zero rate when attempts contain no HTTP 5xx", () => {
    expect(
      calculateProvider5xxRate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [
          attempt("attempt-1", { httpStatus: 200 }),
          attempt("attempt-2", { httpStatus: 400 }),
          attempt("attempt-3", { httpStatus: 429 }),
        ],
      ),
    ).toMatchObject({
      attemptCount: 3,
      provider5xxCount: 0,
      provider5xxRate: "0",
      status: "AVAILABLE",
    });
  });

  it("reports a rate of one when every attempt returned HTTP 5xx", () => {
    expect(
      calculateProvider5xxRate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [
          attempt("attempt-1", { httpStatus: 500 }),
          attempt("attempt-2", { httpStatus: 502 }),
          attempt("attempt-3", { httpStatus: 503 }),
        ],
      ),
    ).toMatchObject({
      attemptCount: 3,
      provider5xxCount: 3,
      provider5xxRate: "1",
      status: "AVAILABLE",
    });
  });

  it("includes only HTTP 500 through 599 in the numerator", () => {
    expect(
      calculateProvider5xxRate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [
          attempt("attempt-499", { httpStatus: 499 }),
          attempt("attempt-500", { httpStatus: 500 }),
          attempt("attempt-599", { httpStatus: 599 }),
          attempt("attempt-600", { httpStatus: 600 }),
          attempt("attempt-no-response", { httpStatus: null }),
        ],
      ),
    ).toMatchObject({
      attemptCount: 5,
      provider5xxCount: 2,
      provider5xxRate: "0.4",
      status: "AVAILABLE",
    });
  });

  it("reports no rate when the bucket has no Jupiter attempts", () => {
    expect(
      calculateProvider5xxRate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [],
      ),
    ).toEqual({
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      attemptCount: 0,
      provider5xxCount: 0,
      provider5xxRate: null,
      status: "NO_ATTEMPTS",
    });
  });

  it("formats a non-divisible rate to 18 decimal places toward zero", () => {
    expect(
      calculateProvider5xxRate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [
          attempt("attempt-1", { httpStatus: 500 }),
          attempt("attempt-2", { httpStatus: 200 }),
          attempt("attempt-3", { httpStatus: 429 }),
        ],
      ).provider5xxRate,
    ).toBe("0.333333333333333333");
  });

  it("does not count duplicate evidence for the same execution key", () => {
    const unavailable = attempt("attempt-1", { httpStatus: 503 });

    expect(
      calculateProvider5xxRate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [unavailable, { ...unavailable }],
      ),
    ).toMatchObject({
      attemptCount: 1,
      provider5xxCount: 1,
      provider5xxRate: "1",
    });
  });

  it("fails closed for conflicting evidence with the same execution key", () => {
    expect(() =>
      calculateProvider5xxRate(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [
          attempt("attempt-1", { httpStatus: 500 }),
          attempt("attempt-1", { httpStatus: 200 }),
        ],
      ),
    ).toThrowError("CONFLICTING_JUPITER_ATTEMPT_EVIDENCE");
  });

  it("does not depend on input order", () => {
    const evidence = [
      attempt("attempt-1", { httpStatus: 500 }),
      attempt("attempt-2", { httpStatus: 200 }),
      attempt("attempt-3", { httpStatus: 429 }),
    ];
    const bucket = {
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
    } as const;

    expect(calculateProvider5xxRate(bucket, evidence)).toEqual(
      calculateProvider5xxRate(bucket, [...evidence].reverse()),
    );
  });

  it("fails closed when evidence crosses the requested bucket", () => {
    const bucket = {
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
    } as const;

    expect(() =>
      calculateProvider5xxRate(bucket, [
        attempt("attempt-1", { leaderWallet: "other-leader" }),
      ]),
    ).toThrowError("CROSS_LEADER_EXECUTION_QUALITY_BUCKET");
    expect(() =>
      calculateProvider5xxRate(bucket, [
        attempt("attempt-1", { quoteMint: "USDC" }),
      ]),
    ).toThrowError("CROSS_QUOTE_EXECUTION_QUALITY_BUCKET");
  });
});

describe("calculatePostRiskDistribution", () => {
  it("reports the POST decision distribution and ignores PRE decisions", () => {
    const evidence = [
      riskDecision("intent-a", "ALLOW"),
      riskDecision("intent-b", "ALLOW"),
      riskDecision("intent-c", "REJECT"),
      riskDecision("intent-d", "HALT"),
      riskDecision("intent-a", "REJECT", { phase: "PRE_QUOTE" }),
    ];

    expect(calculatePostRiskDistribution(postRiskBucket, evidence)).toEqual({
      followerWallet: "follower-wallet",
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      postRiskDecisionCount: 4,
      postRiskAllowCount: 2,
      postRiskResizeCount: 0,
      postRiskRejectCount: 1,
      postRiskHaltCount: 1,
      allowRate: "0.5",
      resizeRate: "0",
      rejectRate: "0.25",
      haltRate: "0.25",
      status: "AVAILABLE",
    });
  });

  it("counts RESIZE independently from every other decision kind", () => {
    expect(
      calculatePostRiskDistribution(postRiskBucket, [
        riskDecision("intent-1", "RESIZE"),
        riskDecision("intent-2", "ALLOW"),
      ]),
    ).toMatchObject({
      postRiskDecisionCount: 2,
      postRiskAllowCount: 1,
      postRiskResizeCount: 1,
      postRiskRejectCount: 0,
      postRiskHaltCount: 0,
      allowRate: "0.5",
      resizeRate: "0.5",
      rejectRate: "0",
      haltRate: "0",
      status: "AVAILABLE",
    });
  });

  it("reports an allow rate of one when every POST decision allows", () => {
    expect(
      calculatePostRiskDistribution(postRiskBucket, [
        riskDecision("intent-1", "ALLOW"),
        riskDecision("intent-2", "ALLOW"),
      ]),
    ).toMatchObject({
      postRiskDecisionCount: 2,
      postRiskAllowCount: 2,
      allowRate: "1",
      resizeRate: "0",
      rejectRate: "0",
      haltRate: "0",
      status: "AVAILABLE",
    });
  });

  it("reports zero for a decision category absent from a non-empty sample", () => {
    expect(
      calculatePostRiskDistribution(postRiskBucket, [
        riskDecision("intent-1", "ALLOW"),
        riskDecision("intent-2", "REJECT"),
      ]),
    ).toMatchObject({
      postRiskDecisionCount: 2,
      postRiskHaltCount: 0,
      haltRate: "0",
      status: "AVAILABLE",
    });
  });

  it("reports no rates when there are no POST decisions", () => {
    expect(calculatePostRiskDistribution(postRiskBucket, [])).toEqual({
      followerWallet: "follower-wallet",
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      postRiskDecisionCount: 0,
      postRiskAllowCount: 0,
      postRiskResizeCount: 0,
      postRiskRejectCount: 0,
      postRiskHaltCount: 0,
      allowRate: null,
      resizeRate: null,
      rejectRate: null,
      haltRate: null,
      status: "NO_POST_RISK_DECISIONS",
    });
  });

  it("treats a PRE-only sample as no POST risk decisions", () => {
    expect(
      calculatePostRiskDistribution(postRiskBucket, [
        riskDecision("intent-pre", "REJECT", {
          phase: "PRE_QUOTE",
          leaderWallet: "other-leader",
          quoteMint: "USDC",
        }),
      ]),
    ).toMatchObject({
      postRiskDecisionCount: 0,
      allowRate: null,
      resizeRate: null,
      rejectRate: null,
      haltRate: null,
      status: "NO_POST_RISK_DECISIONS",
    });
  });

  it("formats a non-divisible POST decision rate to 18 decimal places", () => {
    expect(
      calculatePostRiskDistribution(postRiskBucket, [
        riskDecision("intent-1", "REJECT"),
        riskDecision("intent-2", "ALLOW"),
        riskDecision("intent-3", "ALLOW"),
      ]).rejectRate,
    ).toBe("0.333333333333333333");
  });

  it("does not count duplicate evidence for the same phase and intent", () => {
    const allowed = riskDecision("intent-1", "ALLOW");

    expect(
      calculatePostRiskDistribution(postRiskBucket, [allowed, { ...allowed }]),
    ).toMatchObject({
      postRiskDecisionCount: 1,
      postRiskAllowCount: 1,
      allowRate: "1",
    });
  });

  it("fails closed for conflicting evidence with the same identity", () => {
    expect(() =>
      calculatePostRiskDistribution(postRiskBucket, [
        riskDecision("intent-1", "ALLOW"),
        riskDecision("intent-1", "REJECT"),
      ]),
    ).toThrowError("CONFLICTING_RISK_DECISION_EVIDENCE");
  });

  it("fails closed for a malformed persisted decision kind", () => {
    const malformed = {
      ...riskDecision("intent-1", "ALLOW"),
      decision: "UNKNOWN",
    } as unknown as RiskDecisionEvidence;

    expect(() =>
      calculatePostRiskDistribution(postRiskBucket, [malformed]),
    ).toThrowError("INVALID_RISK_DECISION_KIND");
  });

  it("does not depend on input order", () => {
    const evidence = [
      riskDecision("intent-1", "ALLOW"),
      riskDecision("intent-2", "RESIZE"),
      riskDecision("intent-3", "REJECT"),
    ];
    const bucket = {
      followerWallet: "follower-wallet",
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
    } as const;

    expect(calculatePostRiskDistribution(bucket, evidence)).toEqual(
      calculatePostRiskDistribution(bucket, [...evidence].reverse()),
    );
  });

  it("fails closed when POST evidence crosses the requested bucket", () => {
    const bucket = {
      followerWallet: "follower-wallet",
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
    } as const;

    expect(() =>
      calculatePostRiskDistribution(bucket, [
        riskDecision("intent-1", "ALLOW", {
          followerWallet: "other-follower",
        }),
      ]),
    ).toThrowError("CROSS_FOLLOWER_EXECUTION_QUALITY_BUCKET");
    expect(() =>
      calculatePostRiskDistribution(bucket, [
        riskDecision("intent-1", "ALLOW", {
          leaderWallet: "other-leader",
        }),
      ]),
    ).toThrowError("CROSS_LEADER_EXECUTION_QUALITY_BUCKET");
    expect(() =>
      calculatePostRiskDistribution(bucket, [
        riskDecision("intent-1", "ALLOW", { quoteMint: "USDC" }),
      ]),
    ).toThrowError("CROSS_QUOTE_EXECUTION_QUALITY_BUCKET");
  });
});

describe("calculatePriceImpactRejectRate", () => {
  it("reports price-impact rejects over all POST risk decisions", () => {
    const evidence = [
      riskDecision("intent-a", "ALLOW"),
      riskDecision("intent-b", "REJECT", {
        reasonCode: "PRICE_IMPACT_TOO_HIGH",
      }),
      riskDecision("intent-c", "REJECT", {
        reasonCode: "QUOTE_AMOUNT_MISMATCH",
      }),
      riskDecision("intent-d", "REJECT", {
        reasonCode: "PRICE_IMPACT_TOO_HIGH",
      }),
      riskDecision("intent-a", "REJECT", {
        phase: "PRE_QUOTE",
        reasonCode: "PRICE_IMPACT_TOO_HIGH",
      }),
    ];

    expect(calculatePriceImpactRejectRate(postRiskBucket, evidence)).toEqual({
      followerWallet: "follower-wallet",
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      postRiskDecisionCount: 4,
      priceImpactRejectCount: 2,
      priceImpactRejectRate: "0.5",
      status: "AVAILABLE",
    });
  });

  it("reports zero when a non-empty POST sample has no price-impact reject", () => {
    expect(
      calculatePriceImpactRejectRate(postRiskBucket, [
        riskDecision("intent-1", "ALLOW"),
        riskDecision("intent-2", "REJECT", {
          reasonCode: "QUOTE_AMOUNT_MISMATCH",
        }),
      ]),
    ).toMatchObject({
      postRiskDecisionCount: 2,
      priceImpactRejectCount: 0,
      priceImpactRejectRate: "0",
      status: "AVAILABLE",
    });
  });

  it("reports a rate of one when every POST decision is a price-impact reject", () => {
    expect(
      calculatePriceImpactRejectRate(postRiskBucket, [
        riskDecision("intent-1", "REJECT", {
          reasonCode: "PRICE_IMPACT_TOO_HIGH",
        }),
        riskDecision("intent-2", "REJECT", {
          reasonCode: "PRICE_IMPACT_TOO_HIGH",
        }),
      ]),
    ).toMatchObject({
      postRiskDecisionCount: 2,
      priceImpactRejectCount: 2,
      priceImpactRejectRate: "1",
      status: "AVAILABLE",
    });
  });

  it("reports no rate when there are no POST risk decisions", () => {
    expect(calculatePriceImpactRejectRate(postRiskBucket, [])).toEqual({
      followerWallet: "follower-wallet",
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      postRiskDecisionCount: 0,
      priceImpactRejectCount: 0,
      priceImpactRejectRate: null,
      status: "NO_POST_RISK_DECISIONS",
    });
  });

  it("treats a PRE-only sample as no POST risk decisions", () => {
    expect(
      calculatePriceImpactRejectRate(postRiskBucket, [
        riskDecision("intent-pre", "REJECT", {
          phase: "PRE_QUOTE",
          reasonCode: "PRICE_IMPACT_TOO_HIGH",
          leaderWallet: "other-leader",
          quoteMint: "USDC",
        }),
      ]),
    ).toMatchObject({
      postRiskDecisionCount: 0,
      priceImpactRejectCount: 0,
      priceImpactRejectRate: null,
      status: "NO_POST_RISK_DECISIONS",
    });
  });

  it("does not count POST rejects with other reason codes", () => {
    expect(
      calculatePriceImpactRejectRate(postRiskBucket, [
        riskDecision("intent-1", "REJECT", { reasonCode: "STALE_QUOTE" }),
        riskDecision("intent-2", "REJECT", { reasonCode: "ROUTE_INVALID" }),
      ]),
    ).toMatchObject({
      postRiskDecisionCount: 2,
      priceImpactRejectCount: 0,
      priceImpactRejectRate: "0",
    });
  });

  it("does not count unavailable price-impact evidence as too high", () => {
    expect(
      calculatePriceImpactRejectRate(postRiskBucket, [
        riskDecision("intent-1", "REJECT", {
          reasonCode: "PRICE_IMPACT_UNAVAILABLE",
        }),
      ]),
    ).toMatchObject({
      postRiskDecisionCount: 1,
      priceImpactRejectCount: 0,
      priceImpactRejectRate: "0",
      status: "AVAILABLE",
    });
  });

  it("formats a non-divisible reject rate to 18 decimal places", () => {
    expect(
      calculatePriceImpactRejectRate(postRiskBucket, [
        riskDecision("intent-1", "REJECT", {
          reasonCode: "PRICE_IMPACT_TOO_HIGH",
        }),
        riskDecision("intent-2", "ALLOW"),
        riskDecision("intent-3", "REJECT", {
          reasonCode: "QUOTE_AMOUNT_MISMATCH",
        }),
      ]).priceImpactRejectRate,
    ).toBe("0.333333333333333333");
  });

  it("does not count duplicate evidence for the same phase and intent", () => {
    const rejected = riskDecision("intent-1", "REJECT", {
      reasonCode: "PRICE_IMPACT_TOO_HIGH",
    });

    expect(
      calculatePriceImpactRejectRate(postRiskBucket, [
        rejected,
        { ...rejected },
      ]),
    ).toMatchObject({
      postRiskDecisionCount: 1,
      priceImpactRejectCount: 1,
      priceImpactRejectRate: "1",
    });
  });

  it("fails closed for conflicting evidence with the same identity", () => {
    expect(() =>
      calculatePriceImpactRejectRate(postRiskBucket, [
        riskDecision("intent-1", "REJECT", {
          reasonCode: "PRICE_IMPACT_TOO_HIGH",
        }),
        riskDecision("intent-1", "REJECT", {
          reasonCode: "PRICE_IMPACT_UNAVAILABLE",
        }),
      ]),
    ).toThrowError("CONFLICTING_RISK_DECISION_EVIDENCE");
  });

  it("fails closed when price impact is too high without a REJECT decision", () => {
    expect(() =>
      calculatePriceImpactRejectRate(postRiskBucket, [
        riskDecision("intent-1", "ALLOW", {
          reasonCode: "PRICE_IMPACT_TOO_HIGH",
        }),
      ]),
    ).toThrowError("INCONSISTENT_PRICE_IMPACT_RISK_DECISION");
  });

  it("does not depend on input order", () => {
    const evidence = [
      riskDecision("intent-1", "REJECT", {
        reasonCode: "PRICE_IMPACT_TOO_HIGH",
      }),
      riskDecision("intent-2", "ALLOW"),
      riskDecision("intent-3", "REJECT", {
        reasonCode: "QUOTE_AMOUNT_MISMATCH",
      }),
    ];
    const bucket = {
      followerWallet: "follower-wallet",
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
    } as const;

    expect(calculatePriceImpactRejectRate(bucket, evidence)).toEqual(
      calculatePriceImpactRejectRate(bucket, [...evidence].reverse()),
    );
  });

  it("fails closed when POST evidence crosses the requested bucket", () => {
    const bucket = {
      followerWallet: "follower-wallet",
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
    } as const;

    expect(() =>
      calculatePriceImpactRejectRate(bucket, [
        riskDecision("intent-1", "REJECT", {
          reasonCode: "PRICE_IMPACT_TOO_HIGH",
          followerWallet: "other-follower",
        }),
      ]),
    ).toThrowError("CROSS_FOLLOWER_EXECUTION_QUALITY_BUCKET");
    expect(() =>
      calculatePriceImpactRejectRate(bucket, [
        riskDecision("intent-1", "REJECT", {
          reasonCode: "PRICE_IMPACT_TOO_HIGH",
          leaderWallet: "other-leader",
        }),
      ]),
    ).toThrowError("CROSS_LEADER_EXECUTION_QUALITY_BUCKET");
    expect(() =>
      calculatePriceImpactRejectRate(bucket, [
        riskDecision("intent-1", "REJECT", {
          reasonCode: "PRICE_IMPACT_TOO_HIGH",
          quoteMint: "USDC",
        }),
      ]),
    ).toThrowError("CROSS_QUOTE_EXECUTION_QUALITY_BUCKET");
  });
});

describe("calculatePaperFillOutcome", () => {
  it("reports applications for two of three persisted PaperFills", () => {
    expect(
      calculatePaperFillOutcome(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [paperFill("fill-a"), paperFill("fill-b"), paperFill("fill-c")],
        [paperFillApplication("fill-a"), paperFillApplication("fill-b")],
      ),
    ).toEqual({
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      paperFillCount: 3,
      paperFillApplicationCount: 2,
      paperFillApplicationRate: "0.666666666666666666",
      status: "AVAILABLE",
    });
  });

  it("reports a rate of one when every persisted fill has an application", () => {
    expect(
      calculatePaperFillOutcome(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [paperFill("fill-a"), paperFill("fill-b"), paperFill("fill-c")],
        [
          paperFillApplication("fill-a"),
          paperFillApplication("fill-b"),
          paperFillApplication("fill-c"),
        ],
      ),
    ).toMatchObject({
      paperFillCount: 3,
      paperFillApplicationCount: 3,
      paperFillApplicationRate: "1",
      status: "AVAILABLE",
    });
  });

  it("reports zero when persisted fills have no applications", () => {
    expect(
      calculatePaperFillOutcome(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [paperFill("fill-a"), paperFill("fill-b"), paperFill("fill-c")],
        [],
      ),
    ).toMatchObject({
      paperFillCount: 3,
      paperFillApplicationCount: 0,
      paperFillApplicationRate: "0",
      status: "AVAILABLE",
    });
  });

  it("reports no rate when the bucket has no persisted PaperFills", () => {
    expect(
      calculatePaperFillOutcome(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [],
        [],
      ),
    ).toEqual({
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      paperFillCount: 0,
      paperFillApplicationCount: 0,
      paperFillApplicationRate: null,
      status: "NO_PAPER_FILLS",
    });
  });

  it("formats a non-divisible application rate to 18 decimal places", () => {
    expect(
      calculatePaperFillOutcome(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [paperFill("fill-a"), paperFill("fill-b"), paperFill("fill-c")],
        [paperFillApplication("fill-a")],
      ).paperFillApplicationRate,
    ).toBe("0.333333333333333333");
  });

  it("does not count duplicate PaperFill evidence", () => {
    const fill = paperFill("fill-a");

    expect(
      calculatePaperFillOutcome(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [fill, { ...fill }],
        [],
      ),
    ).toMatchObject({
      paperFillCount: 1,
      paperFillApplicationCount: 0,
    });
  });

  it("does not count duplicate PaperFillApplication evidence", () => {
    const application = paperFillApplication("fill-a");

    expect(
      calculatePaperFillOutcome(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [paperFill("fill-a")],
        [application, { ...application }],
      ),
    ).toMatchObject({
      paperFillCount: 1,
      paperFillApplicationCount: 1,
      paperFillApplicationRate: "1",
    });
  });

  it("fails closed for conflicting evidence with the same PaperFill id", () => {
    expect(() =>
      calculatePaperFillOutcome(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [
          paperFill("fill-a"),
          paperFill("fill-a", { intentId: "different-intent" }),
        ],
        [],
      ),
    ).toThrowError("CONFLICTING_PAPER_FILL_EVIDENCE");
  });

  it("fails closed when different fill ids violate intentId uniqueness", () => {
    expect(() =>
      calculatePaperFillOutcome(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [
          paperFill("fill-a", { intentId: "same-intent" }),
          paperFill("fill-b", { intentId: "same-intent" }),
        ],
        [],
      ),
    ).toThrowError("CONFLICTING_PAPER_FILL_EVIDENCE");
  });

  it("fails closed for conflicting application evidence with the same fillId", () => {
    expect(() =>
      calculatePaperFillOutcome(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [paperFill("fill-a")],
        [
          paperFillApplication("fill-a", { positionId: 1 }),
          paperFillApplication("fill-a", { positionId: 2 }),
        ],
      ),
    ).toThrowError("CONFLICTING_PAPER_FILL_APPLICATION_EVIDENCE");
  });

  it("fails closed for an application without its referenced PaperFill", () => {
    expect(() =>
      calculatePaperFillOutcome(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        [],
        [paperFillApplication("missing-fill")],
      ),
    ).toThrowError("ORPHAN_PAPER_FILL_APPLICATION_EVIDENCE");
  });

  it("does not depend on fill or application input order", () => {
    const fills = [
      paperFill("fill-a"),
      paperFill("fill-b"),
      paperFill("fill-c"),
    ];
    const applications = [
      paperFillApplication("fill-a"),
      paperFillApplication("fill-b"),
    ];
    const bucket = {
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
    } as const;

    expect(calculatePaperFillOutcome(bucket, fills, applications)).toEqual(
      calculatePaperFillOutcome(
        bucket,
        [...fills].reverse(),
        [...applications].reverse(),
      ),
    );
  });

  it("derives bucket identity from each PaperFill and its trade direction", () => {
    const fills = [
      paperFill("target-buy"),
      paperFill("target-sell", {
        side: "SELL",
        inputMint: "token-mint",
        outputMint: "SOL_NATIVE",
      }),
      paperFill("other-leader", { leaderWallet: "other-leader" }),
      paperFill("other-quote", { inputMint: "USDC" }),
    ];

    expect(
      calculatePaperFillOutcome(
        { leaderWallet: "leader-wallet", quoteMint: "SOL_NATIVE" },
        fills,
        [
          paperFillApplication("target-buy"),
          paperFillApplication("other-leader"),
          paperFillApplication("other-quote"),
        ],
      ),
    ).toEqual({
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
      paperFillCount: 2,
      paperFillApplicationCount: 1,
      paperFillApplicationRate: "0.5",
      status: "AVAILABLE",
    });
  });
});

describe("Execution Quality result determinism", () => {
  it("does not serialize results according to bucket property insertion order", () => {
    const canonicalBucket = {
      followerWallet: "follower-wallet",
      leaderWallet: "leader-wallet",
      quoteMint: "SOL_NATIVE",
    } as const;
    const reversedBucket = {
      quoteMint: "SOL_NATIVE",
      leaderWallet: "leader-wallet",
      followerWallet: "follower-wallet",
    } as const;
    const serializeResults = (bucket: typeof canonicalBucket) =>
      [
        calculateJupiterSuccessRate(bucket, []),
        calculateProvider429Rate(bucket, []),
        calculateProvider5xxRate(bucket, []),
        calculatePostRiskDistribution(bucket, []),
        calculatePriceImpactRejectRate(bucket, []),
        calculatePaperFillOutcome(bucket, [], []),
      ].map((result) => JSON.stringify(result));

    expect(serializeResults(reversedBucket)).toEqual(
      serializeResults(canonicalBucket),
    );
  });
});
