import { describe, expect, it } from "vitest";
import { parseRiskPolicy } from "../../src/risk/risk-policy.js";

const VALID_POLICY = {
  policyVersion: "PAPER_RISK_V1",
  maxSingleTradeRawByQuoteMint: { SOL_NATIVE: "100" },
  maxTokenExposureRawByQuoteMint: { SOL_NATIVE: "1000" },
  maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: "2000" },
  dailyRealizedLossLimitRawByQuoteMint: { SOL_NATIVE: "500" },
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

describe("RiskPolicy", () => {
  it("parses raw limits as bigint and price impact as percentage points", () => {
    const policy = parseRiskPolicy(VALID_POLICY);
    expect(policy.maxSingleTradeRawByQuoteMint.SOL_NATIVE).toBe(100n);
    expect(policy.maxBuyPriceImpactPctByQuoteMint.SOL_NATIVE).toBe("1.25");
    expect(policy.maxSellPriceImpactPctByQuoteMint.SOL_NATIVE).toBe("2.50");
  });

  it("fails closed when a mandatory quote policy bucket is empty", () => {
    expect(() =>
      parseRiskPolicy({
        ...VALID_POLICY,
        maxSingleTradeRawByQuoteMint: {},
      }),
    ).toThrow();
  });
});
