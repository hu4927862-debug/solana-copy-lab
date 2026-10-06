import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionIntent } from "../../src/domain/execution.js";
import { PaperTransactionSender } from "../../src/execution/paper-transaction-sender.js";
import { MockJupiterOrderProvider } from "../../src/execution/mock-jupiter-order-provider.js";
import { JupiterOrderAdapter } from "../../src/execution/jupiter-order-adapter.js";
import {
  FOLLOWER,
  LEADER_A,
  TOKEN_MINT,
} from "../fixtures/mainnet-fixtures.js";
import { NATIVE_SOL } from "../../src/domain/assets.js";
import { JupiterRequestPacer } from "../../src/network/jupiter-request-pacer.js";

const buyIntent: ExecutionIntent = {
  executionKey: "exec_no_provider",
  leaderTradeId: "leader_no_provider",
  leaderWallet: LEADER_A,
  followerWallet: FOLLOWER,
  mode: "SHADOW",
  side: "BUY",
  tokenMint: TOKEN_MINT,
  quoteMint: NATIVE_SOL,
  theoreticalTokenRaw: 2_000_000n,
  theoreticalQuoteRaw: 100_000_000n,
  copyRatioBps: 1_000,
  createdAtMs: 1_730_000_000_000,
  createdMonotonicNs: 1_000_000_000n,
};

const safePaperOnly = process.env.PAPER_ONLY;
const safeLiveFunds = process.env.LIVE_FUNDS_ENABLED;

afterEach(() => {
  if (safePaperOnly === undefined) delete process.env.PAPER_ONLY;
  else process.env.PAPER_ONLY = safePaperOnly;
  if (safeLiveFunds === undefined) delete process.env.LIVE_FUNDS_ENABLED;
  else process.env.LIVE_FUNDS_ENABLED = safeLiveFunds;
});

describe("PaperTransactionSender", () => {
  it("classifies local pacing rejection separately from network and provider failures", async () => {
    const pacer = new JupiterRequestPacer(() => 0);
    const adapter = new JupiterOrderAdapter("test-key", async () => {
      pacer.acquire();
      throw new Error("must not reach HTTP");
    });
    const result = await new PaperTransactionSender(adapter).send(buyIntent);
    expect(result).toMatchObject({
      state: "FAILED",
      executedTokenRaw: 0n,
      reason: "JUPITER_ORDER_FAILED",
      metadata: {
        failureCategory: "LOCAL_PACING_REJECT",
        localRejectReason: "JUPITER_LOCAL_RATE_LIMIT",
      },
    });
    expect(result.metadata).not.toHaveProperty("transportPhase");
    expect(result.metadata).not.toHaveProperty("httpStatus");
  });
  it("preserves fetch connection failure evidence through the Paper result", async () => {
    const adapter = new JupiterOrderAdapter("test-key", async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connection failed"), {
          code: "ECONNRESET",
        }),
      });
    });
    const result = await new PaperTransactionSender(adapter).send(buyIntent);
    expect(result).toMatchObject({
      state: "FAILED",
      executedTokenRaw: 0n,
      metadata: {
        failureCategory: "TIMEOUT_NETWORK",
        transportPhase: "FETCH_HEADERS",
        transportErrorCode: "ECONNRESET",
      },
    });
    expect(result).not.toHaveProperty("paperQuoteEvidence");
  });
  it("reports an interrupted response body as transport failure, not malformed JSON", async () => {
    const adapter = new JupiterOrderAdapter(
      "test-key",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new DOMException("body deadline", "TimeoutError"),
              );
            },
          }),
          { status: 200 },
        ),
    );
    const result = await new PaperTransactionSender(adapter).send(buyIntent);
    expect(result).toMatchObject({
      state: "FAILED",
      reason: "JUPITER_ORDER_FAILED",
      metadata: {
        failureCategory: "TIMEOUT_NETWORK",
        httpStatus: 200,
        transportPhase: "READ_BODY",
        transportErrorCode: "TIMEOUT",
      },
    });
    expect(result).not.toHaveProperty("paperQuoteEvidence");
  });
  it("retains DNS error codes without copying sensitive cause text", async () => {
    let description = "";
    const adapter = new JupiterOrderAdapter("test-key", async () => {
      throw new TypeError("fetch failed: sensitive-url", {
        cause: Object.assign(new Error("sensitive-key"), { code: "ENOTFOUND" }),
      });
    });
    const result = await new PaperTransactionSender(adapter, undefined, {
      observe: (_intent, outcome) => {
        if (!outcome.ok && outcome.error instanceof Error)
          description = outcome.error.message;
      },
    }).send(buyIntent);
    expect(result.metadata).toMatchObject({
      failureCategory: "TIMEOUT_NETWORK",
      transportErrorCode: "ENOTFOUND",
    });
    expect(description).toBe(
      "Jupiter transport failed: FETCH_HEADERS:ENOTFOUND",
    );
    expect(description).not.toContain("sensitive");
  });
  it("does not synthesize a paper execution without a Jupiter provider", async () => {
    const result = await new PaperTransactionSender().send(buyIntent);

    expect(result).toMatchObject({
      state: "FAILED",
      reason: "PAPER_FILL_QUOTE_REQUIRED",
      executedTokenRaw: 0n,
      executedQuoteRaw: 0n,
    });
    expect(result).not.toHaveProperty("paperQuoteEvidence");
  });

  it("uses a neutral diagnostic for an untyped provider error", async () => {
    const result = await new PaperTransactionSender({
      async getOrder() {
        throw new Error("quote unavailable");
      },
    }).send(buyIntent);

    expect(result).toMatchObject({
      state: "FAILED",
      reason: "JUPITER_ORDER_FAILED",
      executedTokenRaw: 0n,
      executedQuoteRaw: 0n,
    });
    expect(result).not.toHaveProperty("paperQuoteEvidence");
    expect(result.metadata).toMatchObject({
      failureCategory: "UNKNOWN_PROVIDER_ERROR",
    });
  });

  it("classifies explicit network evidence as timeout or network failure", async () => {
    const result = await new PaperTransactionSender({
      async getOrder() {
        throw new Error("ETIMEDOUT while requesting Jupiter");
      },
    }).send({ ...buyIntent, executionKey: "exec_timeout" });
    expect(result.metadata).toMatchObject({
      failureCategory: "TIMEOUT_NETWORK",
    });
  });

  it("returns typed quote evidence only after a complete Jupiter order", async () => {
    const result = await new PaperTransactionSender(
      new MockJupiterOrderProvider(2n, 1n),
    ).send(buyIntent);

    expect(result.paperQuoteEvidence).toMatchObject({
      provider: "JUPITER_SWAP_V2_ORDER",
      inputMint: NATIVE_SOL,
      outputMint: TOKEN_MINT,
      inputAmountRaw: 100_000_000n,
      outputAmountRaw: 200_000_000n,
      httpStatus: 200,
      schemaValid: true,
      feeEvidence: {
        status: "AMOUNT_UNAVAILABLE",
        unavailableReason: "PLATFORM_FEE_MISSING",
      },
    });
  });

  it("rejects provider evidence that is not explicitly schema-valid", async () => {
    const validProvider = new MockJupiterOrderProvider();
    const result = await new PaperTransactionSender({
      async getOrder(request) {
        return {
          ...(await validProvider.getOrder(request)),
          schemaValid: false,
        } as never;
      },
    }).send(buyIntent);

    expect(result).toMatchObject({
      state: "FAILED",
      reason: "JUPITER_SCHEMA_INVALID",
      executedTokenRaw: 0n,
      executedQuoteRaw: 0n,
    });
    expect(result).not.toHaveProperty("paperQuoteEvidence");
  });

  it.each([
    [undefined, "false"],
    ["false", "false"],
    ["TRUE", "false"],
    ["true", undefined],
    ["true", "true"],
    ["true", "FALSE"],
    ["true", "0"],
  ])(
    "fails closed before the provider when PAPER_ONLY=%s and LIVE_FUNDS_ENABLED=%s",
    async (paperOnly, liveFundsEnabled) => {
      if (paperOnly === undefined) delete process.env.PAPER_ONLY;
      else process.env.PAPER_ONLY = paperOnly;
      if (liveFundsEnabled === undefined) delete process.env.LIVE_FUNDS_ENABLED;
      else process.env.LIVE_FUNDS_ENABLED = liveFundsEnabled;
      const provider = new MockJupiterOrderProvider();

      const result = await new PaperTransactionSender(provider).send(buyIntent);

      expect(result).toMatchObject({
        state: "FAILED",
        reason: "PAPER_TRADING_SAFETY_CONFIG_INVALID",
        executedTokenRaw: 0n,
        executedQuoteRaw: 0n,
      });
      expect(result).not.toHaveProperty("paperQuoteEvidence");
      expect(provider.requests).toHaveLength(0);
    },
  );
});
