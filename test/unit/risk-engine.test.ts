import { describe, expect, it } from "vitest";
import {
  RiskEngine,
  type PreQuoteRiskContext,
  type PostQuoteRiskContext,
  type RiskPolicy,
} from "../../src/risk/risk-engine.js";
import { USDC_MINT } from "../../src/domain/assets.js";

const POLICY: RiskPolicy = {
  policyVersion: "PAPER_RISK_V1",
  maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 100n },
  maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 1_000n },
  maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: 2_000n },
  dailyRealizedLossLimitRawByQuoteMint: { SOL_NATIVE: 500n },
  maxIntentAgeMs: 60_000,
  maxQuoteAgeMs: 5_000,
  maxBuyPriceImpactPctByQuoteMint: { SOL_NATIVE: "1.25" },
  maxSellPriceImpactPctByQuoteMint: { SOL_NATIVE: "2.50" },
  requireRouteEvidence: true,
  provider429BurstThreshold: 3,
  providerBurstWindowMs: 60_000,
  providerCooldownMs: 30_000,
  halfOpenProbe: 1,
};

const MULTI_QUOTE_POLICY: RiskPolicy = {
  ...POLICY,
  maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 100n, [USDC_MINT]: 100n },
  maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 1_000n, [USDC_MINT]: 1_000n },
  maxPortfolioExposureRawByQuoteMint: {
    SOL_NATIVE: 2_000n,
    [USDC_MINT]: 2_000n,
  },
  dailyRealizedLossLimitRawByQuoteMint: {
    SOL_NATIVE: 500n,
    [USDC_MINT]: 500n,
  },
  maxBuyPriceImpactPctByQuoteMint: {
    SOL_NATIVE: "1.25",
    [USDC_MINT]: "1.25",
  },
  maxSellPriceImpactPctByQuoteMint: {
    SOL_NATIVE: "2.50",
    [USDC_MINT]: "2.50",
  },
};

function pre(
  overrides: Partial<PreQuoteRiskContext> = {},
): PreQuoteRiskContext {
  return {
    phase: "PRE_QUOTE",
    nowMs: 10_000,
    intent: {
      intentId: "intent-1",
      leaderTradeId: "leader-1",
      leaderWallet: "leader-wallet",
      followerWallet: "follower-wallet",
      side: "BUY",
      tokenMint: "token-1",
      quoteMint: "SOL_NATIVE",
      requestedTokenRaw: 50n,
      requestedQuoteRaw: 50n,
      createdAtMs: 9_000,
      authoritativeSourceTimestamp: {
        valueMs: 9_000,
        provenance: "CHAIN_BLOCK_TIME",
        precision: "MILLISECOND",
      },
    },
    portfolioPositions: [],
    pendingApprovedBuyQuoteRawByQuoteMint: { SOL_NATIVE: 0n },
    pendingApprovedBuyQuoteRawForToken: 0n,
    dailyRealizedPnlRawByQuoteMint: { SOL_NATIVE: 0n },
    quoteState: "RUNNING",
    globalState: "RUNNING",
    providerHealth: "HEALTHY",
    ...overrides,
  };
}

function post(
  overrides: Partial<PostQuoteRiskContext> = {},
): PostQuoteRiskContext {
  const intent = pre().intent;
  const preDecision = new RiskEngine(POLICY).evaluatePreQuote(pre());
  return {
    phase: "POST_QUOTE",
    nowMs: 10_000,
    intent,
    preDecision,
    quoteEvidence: {
      provider: "JUPITER_SWAP_V2_ORDER",
      requestId: "quote-1",
      inputMint: intent.quoteMint,
      outputMint: intent.tokenMint,
      inputAmountRaw: 50n,
      outputAmountRaw: 100n,
      requestTimestampMs: 9_500,
      responseTimestampMs: 9_600,
      requestMonotonicNs: 1n,
      responseMonotonicNs: 2n,
      httpStatus: 200,
      schemaValid: true,
      feeBps: 0,
      feeMint: intent.quoteMint,
      router: "router",
      mode: "EXACT_INPUT",
      priceImpactPct: "0.50",
      route: [{ venue: "venue" }],
    },
    ...overrides,
  };
}

describe("RiskEngine PRE_QUOTE", () => {
  it.each([29, 985, 1000])(
    "accepts SECOND source clock lead of %i ms",
    (lead) => {
      const context = pre();
      const decision = new RiskEngine(POLICY).evaluatePreQuote({
        ...context,
        nowMs: 11_000 - lead,
        intent: {
          ...context.intent,
          authoritativeSourceTimestamp: {
            valueMs: 11_000,
            provenance: "CHAIN_BLOCK_TIME",
            precision: "SECOND",
          },
        },
      });
      expect(decision.decision).toBe("ALLOW");
    },
  );

  it("distinguishes excessive future source time from old intent", () => {
    const context = pre();
    expect(
      new RiskEngine(POLICY).evaluatePreQuote({
        ...context,
        nowMs: 9_999,
        intent: {
          ...context.intent,
          authoritativeSourceTimestamp: {
            valueMs: 11_000,
            provenance: "CHAIN_BLOCK_TIME",
            precision: "SECOND",
          },
        },
      }).reasonCode,
    ).toBe("FUTURE_SOURCE_TIMESTAMP");
  });
  it("rejects a bare source timestamp without authoritative provenance", () => {
    const {
      authoritativeSourceTimestamp: _authoritativeSourceTimestamp,
      ...intentWithoutProvenance
    } = pre().intent;
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({
        intent: {
          ...intentWithoutProvenance,
          sourceTimestampMs: 9_000,
        } as never,
      }),
    );

    expect(decision).toMatchObject({
      decision: "REJECT",
      approvedAmountRaw: 0n,
      reasonCode: "INTENT_TIMESTAMP_UNAVAILABLE",
    });
  });

  it("rejects an intent whose authoritative source timestamp is unavailable", () => {
    const {
      authoritativeSourceTimestamp: _authoritativeSourceTimestamp,
      ...intentWithoutSource
    } = pre().intent;
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({ intent: intentWithoutSource }),
    );

    expect(decision).toMatchObject({
      decision: "REJECT",
      approvedAmountRaw: 0n,
      reasonCode: "INTENT_TIMESTAMP_UNAVAILABLE",
    });
  });

  it("rejects timestamp provenance that is not chain-derived", () => {
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({
        intent: {
          ...pre().intent,
          authoritativeSourceTimestamp: {
            valueMs: 9_000,
            provenance: "PROCESSING_TIME",
            precision: "MILLISECOND",
          },
        } as never,
      }),
    );

    expect(decision).toMatchObject({
      decision: "REJECT",
      reasonCode: "INTENT_TIMESTAMP_PROVENANCE_INVALID",
    });
  });

  it("allows freshness evaluation for a valid chain-derived timestamp", () => {
    const decision = new RiskEngine(POLICY).evaluatePreQuote(pre());

    expect(decision).toMatchObject({ decision: "ALLOW", reasonCode: "ALLOW" });
  });

  it("applies the strictest of all BUY hard ceilings", () => {
    const decision = new RiskEngine({
      ...POLICY,
      maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 30n },
      maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 80n },
      maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: 90n },
    }).evaluatePreQuote(
      pre({
        intent: {
          ...pre().intent,
          requestedTokenRaw: 100n,
          requestedQuoteRaw: 100n,
        },
      }),
    );

    expect(decision).toMatchObject({
      decision: "RESIZE",
      approvedQuoteRaw: 30n,
      reasonCode: "SINGLE_TRADE_LIMIT",
    });
  });

  it("reports the token cost exposure ceiling when it is strictest", () => {
    const decision = new RiskEngine({
      ...POLICY,
      maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 80n },
      maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 30n },
      maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: 90n },
    }).evaluatePreQuote(
      pre({
        intent: {
          ...pre().intent,
          requestedTokenRaw: 100n,
          requestedQuoteRaw: 100n,
        },
      }),
    );

    expect(decision).toMatchObject({
      decision: "RESIZE",
      approvedQuoteRaw: 30n,
      reasonCode: "TOKEN_COST_EXPOSURE_LIMIT",
    });
  });

  it("reports the portfolio cost exposure ceiling when it is strictest", () => {
    const decision = new RiskEngine({
      ...POLICY,
      maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 80n },
      maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 70n },
      maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: 20n },
    }).evaluatePreQuote(
      pre({
        intent: {
          ...pre().intent,
          requestedTokenRaw: 100n,
          requestedQuoteRaw: 100n,
        },
      }),
    );

    expect(decision).toMatchObject({
      decision: "RESIZE",
      approvedQuoteRaw: 20n,
      reasonCode: "PORTFOLIO_COST_EXPOSURE_LIMIT",
    });
  });

  it("uses deterministic precedence for tied ceilings and audits every trigger", () => {
    const decision = new RiskEngine({
      ...POLICY,
      maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 30n },
      maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 30n },
      maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: 90n },
    }).evaluatePreQuote(
      pre({
        intent: {
          ...pre().intent,
          requestedTokenRaw: 100n,
          requestedQuoteRaw: 100n,
        },
      }),
    );

    expect(decision).toMatchObject({
      decision: "RESIZE",
      approvedQuoteRaw: 30n,
      reasonCode: "SINGLE_TRADE_LIMIT",
      relevantEvidence: {
        singleTradeRemainingCapacityRaw: "30",
        tokenCostExposureRemainingCapacityRaw: "30",
        portfolioCostExposureRemainingCapacityRaw: "90",
        triggeredHardCeilings:
          "SINGLE_TRADE_LIMIT,TOKEN_COST_EXPOSURE_LIMIT,PORTFOLIO_COST_EXPOSURE_LIMIT",
      },
    });
  });

  it("rejects a BUY when any binding remaining capacity is non-positive", () => {
    const decision = new RiskEngine({
      ...POLICY,
      maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 80n },
      maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 30n },
      maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: 90n },
    }).evaluatePreQuote(
      pre({
        pendingApprovedBuyQuoteRawForToken: 30n,
        intent: {
          ...pre().intent,
          requestedTokenRaw: 100n,
          requestedQuoteRaw: 100n,
        },
      }),
    );

    expect(decision).toMatchObject({
      decision: "REJECT",
      approvedAmountRaw: 0n,
      approvedQuoteRaw: 0n,
      reasonCode: "TOKEN_COST_EXPOSURE_LIMIT",
    });
  });

  it("allows a requested BUY within the single-trade limit", () => {
    const decision = new RiskEngine(POLICY).evaluatePreQuote(pre());
    expect(decision.decision).toBe("ALLOW");
    expect(decision.approvedAmountRaw).toBe(50n);
    expect(decision.reasonCode).toBe("ALLOW");
    expect(decision.policyVersion).toBe("PAPER_RISK_V1");
  });

  it("resizes a BUY above the single-trade limit without Number conversion", () => {
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({
        intent: {
          ...pre().intent,
          requestedTokenRaw: 100n,
          requestedQuoteRaw: 150n,
        },
      }),
    );
    expect(decision.decision).toBe("RESIZE");
    expect(decision.approvedAmountRaw).toBe(100n);
    expect(decision.approvedQuoteRaw).toBe(100n);
    expect(decision.approvedTokenRaw).toBe(66n);
    expect(decision.relevantLimitRaw).toBe(100n);
  });

  it("rejects a runtime quote mint without a policy bucket", () => {
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({ intent: { ...pre().intent, quoteMint: "USDC" } }),
    );
    expect(decision.decision).toBe("REJECT");
    expect(decision.reasonCode).toBe("RISK_POLICY_FOR_QUOTE_UNAVAILABLE");
    expect(decision.approvedAmountRaw).toBe(0n);
  });

  it("halts new BUY risk when global state is HALT_NEW_RISK", () => {
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({ globalState: "HALT_NEW_RISK" }),
    );
    expect(decision.decision).toBe("HALT");
    expect(decision.reasonCode).toBe("GLOBAL_HALT_NEW_RISK");
    expect(decision.approvedAmountRaw).toBe(0n);
  });

  it("applies the explicit global kill switch before quote policy lookup", () => {
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({
        globalState: "HALT_NEW_RISK",
        intent: { ...pre().intent, quoteMint: "USDC" },
      }),
    );
    expect(decision.decision).toBe("HALT");
    expect(decision.reasonCode).toBe("GLOBAL_HALT_NEW_RISK");
  });

  it("allows a mapped risk-reducing SELL through HALT_NEW_RISK", () => {
    const position = {
      followerWallet: "follower",
      leaderWallet: "leader",
      tokenMint: "token-1",
      quoteMint: "SOL_NATIVE",
      tokenDecimals: 0,
      quoteDecimals: 0,
      quantityRaw: 100n,
      reservedRaw: 0n,
      totalCostQuoteRaw: 100n,
      realizedPnlQuoteRaw: 0n,
      averageEntry: "1",
      openedAtMs: 1,
      updatedAtMs: 1,
      closedAtMs: null,
      status: "OPEN" as const,
      accountingPolicyVersion: "WEIGHTED_AVERAGE_V1" as const,
      version: 1,
    };
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({
        globalState: "HALT_NEW_RISK",
        currentPosition: position,
        intent: { ...pre().intent, side: "SELL", requestedTokenRaw: 40n },
      }),
    );
    expect(decision.decision).toBe("ALLOW");
    expect(decision.approvedTokenRaw).toBe(40n);
  });

  it("rejects a SELL that is not a valid mapped risk-reducing action", () => {
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({
        globalState: "HALT_NEW_RISK",
        intent: { ...pre().intent, side: "SELL", requestedTokenRaw: 40n },
      }),
    );
    expect(decision.decision).toBe("REJECT");
    expect(decision.reasonCode).toBe("SELL_NOT_RISK_REDUCING");
  });

  it("rejects a stale intent", () => {
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({ nowMs: 100_000 }),
    );
    expect(decision.reasonCode).toBe("STALE_INTENT");
    expect(decision.decision).toBe("REJECT");
  });

  it("halts a new BUY when the quote bucket reached its daily realized loss limit", () => {
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({ dailyRealizedPnlRawByQuoteMint: { SOL_NATIVE: -500n } }),
    );
    expect(decision.decision).toBe("HALT");
    expect(decision.reasonCode).toBe("DAILY_REALIZED_LOSS_LIMIT");
    expect(decision.approvedAmountRaw).toBe(0n);
  });

  it("keeps a persisted quote halt latched for the UTC day", () => {
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({
        quoteState: "HALT_NEW_RISK",
        dailyRealizedPnlRawByQuoteMint: { SOL_NATIVE: -400n },
      }),
    );
    expect(decision.decision).toBe("HALT");
    expect(decision.reasonCode).toBe("DAILY_REALIZED_LOSS_LIMIT");
  });

  it("keeps daily-loss halts isolated by quote mint", () => {
    const engine = new RiskEngine(MULTI_QUOTE_POLICY);
    const dailyPnl = { SOL_NATIVE: -500n, [USDC_MINT]: 0n };
    const sol = engine.evaluatePreQuote(
      pre({ dailyRealizedPnlRawByQuoteMint: dailyPnl }),
    );
    const usdc = engine.evaluatePreQuote(
      pre({
        intent: {
          ...pre().intent,
          intentId: "intent-usdc",
          quoteMint: USDC_MINT,
        },
        dailyRealizedPnlRawByQuoteMint: dailyPnl,
      }),
    );
    expect({
      sol: [sol.decision, sol.reasonCode],
      usdc: usdc.decision,
    }).toEqual({
      sol: ["HALT", "DAILY_REALIZED_LOSS_LIMIT"],
      usdc: "ALLOW",
    });
  });

  it("halts each quote bucket only after that bucket reaches its limit", () => {
    const engine = new RiskEngine(MULTI_QUOTE_POLICY);
    const dailyPnl = { SOL_NATIVE: -500n, [USDC_MINT]: -500n };
    const sol = engine.evaluatePreQuote(
      pre({ dailyRealizedPnlRawByQuoteMint: dailyPnl }),
    );
    const usdc = engine.evaluatePreQuote(
      pre({
        intent: {
          ...pre().intent,
          intentId: "intent-usdc",
          quoteMint: USDC_MINT,
        },
        dailyRealizedPnlRawByQuoteMint: dailyPnl,
      }),
    );
    expect([sol.reasonCode, usdc.reasonCode]).toEqual([
      "DAILY_REALIZED_LOSS_LIMIT",
      "DAILY_REALIZED_LOSS_LIMIT",
    ]);
  });

  it("allows a mapped risk-reducing SELL through a quote daily-loss halt", () => {
    const position = {
      followerWallet: "follower",
      leaderWallet: "leader",
      tokenMint: "token-1",
      quoteMint: "SOL_NATIVE",
      tokenDecimals: 0,
      quoteDecimals: 0,
      quantityRaw: 100n,
      reservedRaw: 0n,
      totalCostQuoteRaw: 100n,
      realizedPnlQuoteRaw: 0n,
      averageEntry: "1",
      openedAtMs: 1,
      updatedAtMs: 1,
      closedAtMs: null,
      status: "OPEN" as const,
      accountingPolicyVersion: "WEIGHTED_AVERAGE_V1" as const,
      version: 1,
    };
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({
        currentPosition: position,
        quoteState: "HALT_NEW_RISK",
        dailyRealizedPnlRawByQuoteMint: { SOL_NATIVE: -500n },
        intent: { ...pre().intent, side: "SELL", requestedTokenRaw: 40n },
      }),
    );
    expect(decision.decision).toBe("ALLOW");
  });

  it("rejects new BUY risk while provider health is degraded", () => {
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({ providerHealth: "DEGRADED" }),
    );
    expect(decision.decision).toBe("REJECT");
    expect(decision.reasonCode).toBe("PROVIDER_DEGRADED");
  });

  it("uses token and portfolio cost exposure plus pending BUY commitments", () => {
    const position = {
      followerWallet: "follower",
      leaderWallet: "leader",
      tokenMint: "token-1",
      quoteMint: "SOL_NATIVE",
      tokenDecimals: 0,
      quoteDecimals: 0,
      quantityRaw: 40n,
      reservedRaw: 0n,
      totalCostQuoteRaw: 40n,
      realizedPnlQuoteRaw: 0n,
      averageEntry: "1",
      openedAtMs: 1,
      updatedAtMs: 1,
      closedAtMs: null,
      status: "OPEN" as const,
      accountingPolicyVersion: "WEIGHTED_AVERAGE_V1" as const,
      version: 1,
    };
    const decision = new RiskEngine({
      ...POLICY,
      maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 100n },
    }).evaluatePreQuote(
      pre({
        currentPosition: position,
        portfolioPositions: [position],
        pendingApprovedBuyQuoteRawByQuoteMint: { SOL_NATIVE: 50n },
        pendingApprovedBuyQuoteRawForToken: 50n,
        intent: {
          ...pre().intent,
          requestedQuoteRaw: 50n,
          requestedTokenRaw: 50n,
        },
      }),
    );
    expect(decision.decision).toBe("RESIZE");
    expect(decision.reasonCode).toBe("TOKEN_COST_EXPOSURE_LIMIT");
    expect(decision.approvedQuoteRaw).toBe(10n);
  });

  it("resizes against the portfolio cost exposure cap", () => {
    const decision = new RiskEngine({
      ...POLICY,
      maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: 100n },
    }).evaluatePreQuote(
      pre({
        pendingApprovedBuyQuoteRawByQuoteMint: { SOL_NATIVE: 90n },
      }),
    );
    expect(decision.decision).toBe("RESIZE");
    expect(decision.reasonCode).toBe("PORTFOLIO_COST_EXPOSURE_LIMIT");
    expect(decision.approvedQuoteRaw).toBe(10n);
  });

  it("never sums cost exposure across different quote mints", () => {
    const foreignPosition = {
      followerWallet: "follower",
      leaderWallet: "leader",
      tokenMint: "token-foreign",
      quoteMint: "USDC",
      tokenDecimals: 0,
      quoteDecimals: 6,
      quantityRaw: 1n,
      reservedRaw: 0n,
      totalCostQuoteRaw: 9_999_999n,
      realizedPnlQuoteRaw: 0n,
      averageEntry: "9999999",
      openedAtMs: 1,
      updatedAtMs: 1,
      closedAtMs: null,
      status: "OPEN" as const,
      accountingPolicyVersion: "WEIGHTED_AVERAGE_V1" as const,
      version: 1,
    };
    const decision = new RiskEngine(POLICY).evaluatePreQuote(
      pre({ portfolioPositions: [foreignPosition] }),
    );
    expect(decision.decision).toBe("ALLOW");
  });

  it("preserves bigint precision above Number.MAX_SAFE_INTEGER", () => {
    const limit = 9_007_199_254_740_993n;
    const decision = new RiskEngine({
      ...POLICY,
      maxSingleTradeRawByQuoteMint: { SOL_NATIVE: limit },
      maxTokenExposureRawByQuoteMint: { SOL_NATIVE: limit * 10n },
      maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: limit * 10n },
    }).evaluatePreQuote(
      pre({
        intent: {
          ...pre().intent,
          requestedTokenRaw: limit + 1n,
          requestedQuoteRaw: limit + 1n,
        },
      }),
    );
    expect(decision.approvedQuoteRaw).toBe(limit);
    expect(decision.approvedTokenRaw).toBe(limit);
  });
});

describe("RiskEngine POST_QUOTE", () => {
  it.each(["-0.01", "-1.25"])(
    "allows bounded signed price impact %s",
    (priceImpactPct) => {
      expect(
        new RiskEngine(POLICY).evaluatePostQuote(
          post({
            quoteEvidence: { ...post().quoteEvidence, priceImpactPct },
          }),
        ).decision,
      ).toBe("ALLOW");
    },
  );
  it.each(["-1.26", "-100", "100"])(
    "rejects excessive impact magnitude %s",
    (priceImpactPct) => {
      expect(
        new RiskEngine(POLICY).evaluatePostQuote(
          post({
            quoteEvidence: { ...post().quoteEvidence, priceImpactPct },
          }),
        ).reasonCode,
      ).toBe("PRICE_IMPACT_TOO_HIGH");
    },
  );
  it("does not authorize a quote using a rejected PRE decision", () => {
    expect(
      new RiskEngine(POLICY).evaluatePostQuote(
        post({
          preDecision: { ...post().preDecision, decision: "REJECT" },
        }),
      ).decision,
    ).toBe("REJECT");
  });
  it("accepts only the PRE approved amount and actual quote evidence", () => {
    const decision = new RiskEngine(POLICY).evaluatePostQuote(post());
    expect(decision.decision).toBe("ALLOW");
    expect(decision.approvedAmountRaw).toBe(50n);
    expect(decision.preDecisionId).toBe(post().preDecision.decisionId);
    expect(decision.quoteRequestId).toBe("quote-1");
  });

  it("rejects quote evidence whose input amount is not the PRE approved amount", () => {
    const context = post({
      quoteEvidence: { ...post().quoteEvidence, inputAmountRaw: 100n },
    });
    const decision = new RiskEngine(POLICY).evaluatePostQuote(context);
    expect(decision.decision).toBe("REJECT");
    expect(decision.reasonCode).toBe("QUOTE_AMOUNT_MISMATCH");
  });

  it("rejects excessive or unavailable price impact", () => {
    const tooHigh = new RiskEngine(POLICY).evaluatePostQuote(
      post({
        quoteEvidence: { ...post().quoteEvidence, priceImpactPct: "1.26" },
      }),
    );
    expect(tooHigh.reasonCode).toBe("PRICE_IMPACT_TOO_HIGH");
    const { priceImpactPct: _priceImpactPct, ...withoutPriceImpact } =
      post().quoteEvidence;
    const unavailable = new RiskEngine(POLICY).evaluatePostQuote(
      post({ quoteEvidence: withoutPriceImpact }),
    );
    expect(unavailable.reasonCode).toBe("PRICE_IMPACT_UNAVAILABLE");
    const malformed = new RiskEngine(POLICY).evaluatePostQuote(
      post({
        quoteEvidence: {
          ...post().quoteEvidence,
          priceImpactPct: "not-a-decimal",
        },
      }),
    );
    expect(malformed.reasonCode).toBe("PRICE_IMPACT_UNAVAILABLE");
  });

  it("rejects stale quote or invalid route evidence", () => {
    const stale = new RiskEngine(POLICY).evaluatePostQuote(
      post({
        nowMs: 20_000,
        quoteEvidence: { ...post().quoteEvidence, responseTimestampMs: 9_000 },
      }),
    );
    expect(stale.reasonCode).toBe("STALE_QUOTE");
    const invalidRoute = new RiskEngine(POLICY).evaluatePostQuote(
      post({ quoteEvidence: { ...post().quoteEvidence, route: [] } }),
    );
    expect(invalidRoute.reasonCode).toBe("ROUTE_INVALID");
  });

  it("uses the independent SELL price-impact percentage-point limit", () => {
    const position = {
      followerWallet: "follower",
      leaderWallet: "leader",
      tokenMint: "token-1",
      quoteMint: "SOL_NATIVE",
      tokenDecimals: 0,
      quoteDecimals: 0,
      quantityRaw: 100n,
      reservedRaw: 0n,
      totalCostQuoteRaw: 100n,
      realizedPnlQuoteRaw: 0n,
      averageEntry: "1",
      openedAtMs: 1,
      updatedAtMs: 1,
      closedAtMs: null,
      status: "OPEN" as const,
      accountingPolicyVersion: "WEIGHTED_AVERAGE_V1" as const,
      version: 1,
    };
    const sellIntent = {
      ...pre().intent,
      side: "SELL" as const,
      requestedTokenRaw: 40n,
      requestedQuoteRaw: 20n,
    };
    const engine = new RiskEngine(POLICY);
    const preDecision = engine.evaluatePreQuote(
      pre({ intent: sellIntent, currentPosition: position }),
    );
    const context = post({
      intent: sellIntent,
      preDecision,
      quoteEvidence: {
        ...post().quoteEvidence,
        inputMint: sellIntent.tokenMint,
        outputMint: sellIntent.quoteMint,
        inputAmountRaw: 40n,
        outputAmountRaw: 20n,
        priceImpactPct: "2.00",
      },
    });
    expect(engine.evaluatePostQuote(context).decision).toBe("ALLOW");
    expect(
      engine.evaluatePostQuote({
        ...context,
        quoteEvidence: { ...context.quoteEvidence, priceImpactPct: "2.51" },
      }).reasonCode,
    ).toBe("PRICE_IMPACT_TOO_HIGH");
  });
});
