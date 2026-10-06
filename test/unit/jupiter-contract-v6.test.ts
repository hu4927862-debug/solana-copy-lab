import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { JupiterOrderAdapter } from "../../src/execution/jupiter-order-adapter.js";
import { PaperTransactionSender } from "../../src/execution/paper-transaction-sender.js";
import { NATIVE_SOL, WSOL_MINT } from "../../src/domain/assets.js";
import {
  FOLLOWER,
  LEADER_A,
  TOKEN_MINT,
} from "../fixtures/mainnet-fixtures.js";

const intent = {
  executionKey: "contract-v6",
  leaderTradeId: "source",
  leaderWallet: LEADER_A,
  followerWallet: FOLLOWER,
  mode: "PAPER" as const,
  side: "BUY" as const,
  tokenMint: TOKEN_MINT,
  quoteMint: NATIVE_SOL,
  theoreticalTokenRaw: 10n,
  theoreticalQuoteRaw: 100_000n,
  copyRatioBps: 1000,
  createdAtMs: Date.now(),
  createdMonotonicNs: 1n,
};
function sender(fields: Record<string, unknown>) {
  return new PaperTransactionSender(
    new JupiterOrderAdapter(
      "test-key",
      async () =>
        new Response(
          JSON.stringify({
            transaction: null,
            requestId: "v6",
            router: "metis",
            mode: "ultra",
            inputMint: WSOL_MINT,
            outputMint: TOKEN_MINT,
            inAmount: "100000",
            outAmount: "20",
            feeBps: 10,
            feeMint: WSOL_MINT,
            ...fields,
          }),
        ),
    ),
  );
}
beforeEach(() => {
  vi.stubEnv("PAPER_ONLY", "true");
  vi.stubEnv("LIVE_FUNDS_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("Jupiter V6 contract at adapter → Paper sender boundary", () => {
  it.each([
    [{ priceImpact: 1, priceImpactPct: "0.5" }, "CONFLICT"],
    [{ priceImpactPct: "NaN" }, "INVALID"],
    [{ priceImpactPct: "Infinity" }, "INVALID"],
    [{ priceImpactPct: null }, "INVALID"],
  ])("withholds unusable impact evidence %j", async (fields, status) => {
    const result = await sender(fields).send(intent);
    expect(result.paperQuoteEvidence?.priceImpactPct).toBeUndefined();
    expect(result.metadata?.priceImpactEvidence).toMatchObject({ status });
  });
  it("preserves missing fee fields and cost payer estimates as evidence without inventing a fee amount", async () => {
    const result = await sender({
      platformFee: { amount: "50", feeBps: 10 },
      signatureFeeLamports: 5000,
      signatureFeePayer: FOLLOWER,
      prioritizationFeeLamports: 100,
      rentFeeLamports: 2039280,
    }).send(intent);
    expect(result.paperQuoteEvidence?.feeEvidence).toMatchObject({
      status: "AMOUNT_UNAVAILABLE",
      unavailableReason: "PLATFORM_FEE_SCHEMA_INVALID",
    });
    expect(result.metadata?.providerEvidence).toMatchObject({
      platformFee: { amount: "50", feeBps: 10 },
      signatureFeePayer: FOLLOWER,
      rentFeeLamports: 2039280,
    });
    expect(result.executedQuoteRaw).toBe(100_000n);
  });
  it.each([
    { inAmount: "99999" },
    { inputMint: TOKEN_MINT },
    { outputMint: WSOL_MINT },
    { inAmount: undefined },
    { inputMint: undefined },
  ])(
    "rejects a response that cannot bind to requested input: %j",
    async (fields) => {
      const result = await sender(fields).send(intent);
      expect(result.state).toBe("FAILED");
      expect(result.reason).toBe("JUPITER_SCHEMA_INVALID");
    },
  );
  it("accepts a platform component below total fee without deducting it twice", async () => {
    const result = await sender({
      platformFee: { amount: "50", feeBps: 5, feeMint: WSOL_MINT },
    }).send(intent);
    expect(result.paperQuoteEvidence?.feeEvidence).toMatchObject({
      status: "AVAILABLE",
      feeAmountRaw: 50n,
      feeBps: 5,
      totalFeeBps: 10,
    });
    expect(result.executedQuoteRaw).toBe(100_000n);
  });
  it.each([
    [{ priceImpactPct: "-0.0001311599520149334" }, "-0.01311599520149334"],
    [{ priceImpact: -0.1 }, "-0.1"],
    [{ priceImpactPct: "0.0126" }, "1.26"],
    [{ priceImpactPct: "-1" }, "-100"],
  ])(
    "normalizes signed impact to percentage points: %j",
    async (fields, normalized) => {
      const result = await sender(fields).send(intent);
      expect(result.paperQuoteEvidence?.priceImpactPct).toBe(normalized);
      expect(result.metadata?.priceImpactEvidence).toMatchObject({
        contractVersion: "JUPITER_SWAP_V2_IMPACT_V1",
        unit: "PERCENTAGE_POINTS",
        raw: fields,
        status: "AVAILABLE",
      });
    },
  );
});
