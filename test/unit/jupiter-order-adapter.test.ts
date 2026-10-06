import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JupiterOrderAdapter,
  JupiterSchemaError,
} from "../../src/execution/jupiter-order-adapter.js";
import { PaperTransactionSender } from "../../src/execution/paper-transaction-sender.js";
import type { ExecutionIntent } from "../../src/domain/execution.js";
import {
  FOLLOWER,
  LEADER_A,
  TOKEN_MINT,
} from "../fixtures/mainnet-fixtures.js";
import { NATIVE_SOL, USDC_MINT, WSOL_MINT } from "../../src/domain/assets.js";

function fixtureAdapter(
  apiKey: string,
  fetchImpl: typeof fetch,
): JupiterOrderAdapter {
  return new JupiterOrderAdapter(apiKey, async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!response.ok) return response;
    const query = new URL(String(url)).searchParams;
    const payload = (await response.json()) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        inputMint: query.get("inputMint"),
        outputMint: query.get("outputMint"),
        inAmount: query.get("amount"),
        ...payload,
      }),
      { status: response.status },
    );
  });
}

const intent: ExecutionIntent = {
  executionKey: "exec_test",
  leaderTradeId: "leader_test",
  leaderWallet: LEADER_A,
  followerWallet: FOLLOWER,
  mode: "SHADOW",
  side: "BUY",
  tokenMint: TOKEN_MINT,
  quoteMint: USDC_MINT,
  theoreticalTokenRaw: 2_000_000n,
  theoreticalQuoteRaw: 1_000_000n,
  copyRatioBps: 1000,
  createdAtMs: 1_730_000_000_000,
  createdMonotonicNs: 1_000_000_000n,
};

const originalPaperOnly = process.env.PAPER_ONLY;
const originalLiveFundsEnabled = process.env.LIVE_FUNDS_ENABLED;

beforeEach(() => {
  process.env.PAPER_ONLY = "true";
  process.env.LIVE_FUNDS_ENABLED = "false";
});

afterEach(() => {
  if (originalPaperOnly === undefined) delete process.env.PAPER_ONLY;
  else process.env.PAPER_ONLY = originalPaperOnly;
  if (originalLiveFundsEnabled === undefined)
    delete process.env.LIVE_FUNDS_ENABLED;
  else process.env.LIVE_FUNDS_ENABLED = originalLiveFundsEnabled;
});

describe("Jupiter Swap V2 order-only adapter", () => {
  it("classifies missing platform fee without persisting provider payloads", async () => {
    const adapter = fixtureAdapter(
      "test-api-key",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              transaction: null,
              requestId: "missing",
              outAmount: "1",
              router: "metis",
              mode: "ultra",
              feeBps: 0,
              feeMint: WSOL_MINT,
            }),
            { status: 200 },
          ),
      ) as typeof fetch,
    );
    const order = await adapter.getOrder({
      inputMint: NATIVE_SOL,
      outputMint: TOKEN_MINT,
      amount: 1n,
    });
    expect(order.platformFee).toBeUndefined();
    expect(order.platformFeeDiagnostic).toBe("PLATFORM_FEE_MISSING");
    expect(order.requestId).not.toContain("api-key");
  });
  it("returns exact Jupiter platform-fee evidence without local reconstruction", async () => {
    const amount = "922337203685477580712345678901234567890";
    const adapter = fixtureAdapter(
      "test-api-key",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              transaction: null,
              requestId: "request-platform-fee",
              outAmount: "1990000",
              router: "metis",
              mode: "ultra",
              feeBps: 5,
              feeMint: WSOL_MINT,
              platformFee: {
                amount,
                feeBps: 5,
                feeMint: WSOL_MINT,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ) as typeof fetch,
    );

    const order = await adapter.getOrder({
      inputMint: NATIVE_SOL,
      outputMint: TOKEN_MINT,
      amount: 20_564_457n,
    });

    expect(order.platformFee).toEqual({
      amountRaw: 922337203685477580712345678901234567890n,
      feeBps: 5,
      feeMint: NATIVE_SOL,
    });
    expect(order.feeBps).toBe(5);
    expect(order.feeMint).toBe(NATIVE_SOL);
  });

  it("propagates an available quote-denominated platform fee without changing fill economics", async () => {
    const adapter = fixtureAdapter(
      "test-api-key",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              transaction: null,
              requestId: "request-available-platform-fee",
              outAmount: "1990000",
              router: "metis",
              mode: "ultra",
              feeBps: 5,
              feeMint: USDC_MINT,
              platformFee: {
                amount: "500",
                feeBps: 5,
                feeMint: USDC_MINT,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ) as typeof fetch,
    );

    const result = await new PaperTransactionSender(adapter).send(intent);

    expect(result).toMatchObject({
      state: "PAPER_EXECUTED",
      executedTokenRaw: 1_990_000n,
      executedQuoteRaw: 1_000_000n,
      paperQuoteEvidence: {
        inputAmountRaw: 1_000_000n,
        outputAmountRaw: 1_990_000n,
        feeEvidence: {
          status: "AVAILABLE",
          contractVersion: "FEE_EVIDENCE_CONTRACT_V1",
          sourceType: "JUPITER_SWAP_V2_ORDER_RESPONSE",
          sourceVersion: "JUPITER_SWAP_API_V2_OPENAPI_2_0_0",
          feeType: "JUPITER_PLATFORM_FEE",
          feeAmountRaw: 500n,
          feeBps: 5,
          feeMint: USDC_MINT,
          totalFeeBps: 5,
          totalFeeMint: USDC_MINT,
          amountBasis: "PROVIDER_REPORTED_FEE_MINT_AMOUNT",
          roundingMode: "PROVIDER_FINAL_INTEGER_NO_LOCAL_ROUNDING",
          includedInQuotedAmount: true,
        },
      },
    });
  });

  it.each(["-1", "1.5", "1e3", "", "not-an-amount"])(
    "keeps the quote executable but fee evidence unavailable for platform amount %j",
    async (amount) => {
      const adapter = fixtureAdapter(
        "test-api-key",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                transaction: null,
                requestId: `request-invalid-${amount}`,
                outAmount: "1990000",
                router: "metis",
                mode: "ultra",
                feeBps: 5,
                feeMint: USDC_MINT,
                platformFee: { amount, feeBps: 5, feeMint: USDC_MINT },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            ),
        ) as typeof fetch,
      );

      const result = await new PaperTransactionSender(adapter).send({
        ...intent,
        executionKey: `exec-invalid-${amount}`,
      });

      expect(result).toMatchObject({
        state: "PAPER_EXECUTED",
        executedTokenRaw: 1_990_000n,
        executedQuoteRaw: 1_000_000n,
        paperQuoteEvidence: {
          feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
        },
      });
    },
  );

  it.each([
    ["absent", undefined, 5, USDC_MINT],
    [
      "platform component exceeds total fee",
      { amount: "500", feeBps: 5, feeMint: USDC_MINT },
      4,
      USDC_MINT,
    ],
    [
      "top-level mint conflict",
      { amount: "500", feeBps: 5, feeMint: TOKEN_MINT },
      5,
      USDC_MINT,
    ],
    [
      "non-quote fee mint",
      { amount: "500", feeBps: 5, feeMint: TOKEN_MINT },
      5,
      TOKEN_MINT,
    ],
  ])(
    "marks fee evidence unavailable when platform evidence is %s",
    async (_case, platformFee, feeBps, feeMint) => {
      const adapter = fixtureAdapter(
        "test-api-key",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                transaction: null,
                requestId: `request-${_case}`,
                outAmount: "1990000",
                router: "metis",
                mode: "ultra",
                feeBps,
                feeMint,
                ...(platformFee === undefined ? {} : { platformFee }),
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            ),
        ) as typeof fetch,
      );

      const result = await new PaperTransactionSender(adapter).send({
        ...intent,
        executionKey: `exec-${_case}`,
      });

      expect(result).toMatchObject({
        state: "PAPER_EXECUTED",
        executedTokenRaw: 1_990_000n,
        executedQuoteRaw: 1_000_000n,
        paperQuoteEvidence: {
          feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
        },
      });
    },
  );

  it("accepts a zero platform fee and canonicalizes its WSOL mint", async () => {
    const adapter = fixtureAdapter(
      "test-api-key",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              transaction: null,
              requestId: "request-zero-wsol-fee",
              outAmount: "1990000",
              router: "metis",
              mode: "ultra",
              feeBps: 0,
              feeMint: WSOL_MINT,
              platformFee: { amount: "0", feeBps: 0, feeMint: WSOL_MINT },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ) as typeof fetch,
    );

    const result = await new PaperTransactionSender(adapter).send({
      ...intent,
      executionKey: "exec-zero-wsol-fee",
      quoteMint: NATIVE_SOL,
    });

    expect(result.paperQuoteEvidence?.feeEvidence).toMatchObject({
      status: "AVAILABLE",
      feeAmountRaw: 0n,
      feeBps: 0,
      feeMint: NATIVE_SOL,
    });
  });

  it("does not expose a platform component with a malformed Solana mint", async () => {
    const adapter = fixtureAdapter(
      "test-api-key",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              transaction: null,
              requestId: "request-malformed-platform-mint",
              outAmount: "1990000",
              router: "metis",
              mode: "ultra",
              feeBps: 5,
              feeMint: USDC_MINT,
              platformFee: {
                amount: "500",
                feeBps: 5,
                feeMint: "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ) as typeof fetch,
    );

    const order = await adapter.getOrder({
      inputMint: USDC_MINT,
      outputMint: TOKEN_MINT,
      amount: 1_000_000n,
    });

    expect(order.platformFee).toBeUndefined();
  });

  describe("Jupiter mint serialization", () => {
    function successfulOrderFetch(feeMint: string = USDC_MINT) {
      return vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              transaction: null,
              requestId: "request-mint-serialization",
              outAmount: "1990000",
              router: "metis",
              mode: "ultra",
              feeBps: 5,
              feeMint,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
    }

    function capturedRequest(
      fetchMock: ReturnType<typeof successfulOrderFetch>,
    ) {
      const [url, options] = fetchMock.mock.calls[0] as unknown as [
        URL | string,
        RequestInit | undefined,
      ];
      return { url: new URL(String(url)), options };
    }

    it("normalizes native SOL input at the Jupiter HTTP boundary", async () => {
      const fetchMock = successfulOrderFetch();
      const adapter = fixtureAdapter("test-api-key", fetchMock as typeof fetch);

      await adapter.getOrder({
        inputMint: NATIVE_SOL,
        outputMint: TOKEN_MINT,
        amount: 20_564_457n,
      });

      const { url, options } = capturedRequest(fetchMock);
      expect(options?.method).toBe("GET");
      expect(url.pathname).toBe("/swap/v2/order");
      expect(url.pathname).not.toContain("/execute");
      expect(url.searchParams.get("inputMint")).toBe(WSOL_MINT);
      expect(url.searchParams.get("outputMint")).toBe(TOKEN_MINT);
      expect(url.searchParams.get("amount")).toBe("20564457");
      expect(url.searchParams.has("taker")).toBe(false);
    });

    it("normalizes native SOL output at the Jupiter HTTP boundary", async () => {
      const fetchMock = successfulOrderFetch();
      const adapter = fixtureAdapter("test-api-key", fetchMock as typeof fetch);

      await adapter.getOrder({
        inputMint: TOKEN_MINT,
        outputMint: NATIVE_SOL,
        amount: 2_000_000n,
      });

      const { url, options } = capturedRequest(fetchMock);
      expect(options?.method).toBe("GET");
      expect(url.pathname).toBe("/swap/v2/order");
      expect(url.pathname).not.toContain("/execute");
      expect(url.searchParams.get("inputMint")).toBe(TOKEN_MINT);
      expect(url.searchParams.get("outputMint")).toBe(WSOL_MINT);
      expect(url.searchParams.get("amount")).toBe("2000000");
      expect(url.searchParams.has("taker")).toBe(false);
    });

    it("canonicalizes a WSOL response fee mint before returning to the domain", async () => {
      const fetchMock = successfulOrderFetch(WSOL_MINT);
      const adapter = fixtureAdapter("test-api-key", fetchMock as typeof fetch);

      const order = await adapter.getOrder({
        inputMint: NATIVE_SOL,
        outputMint: TOKEN_MINT,
        amount: 20_564_457n,
      });

      expect(order.inputMint).toBe(NATIVE_SOL);
      expect(order.feeMint).toBe(NATIVE_SOL);
      expect(capturedRequest(fetchMock).url.searchParams.get("inputMint")).toBe(
        WSOL_MINT,
      );
    });

    it("preserves SPL-to-SPL mints and taker at the Jupiter HTTP boundary", async () => {
      const fetchMock = successfulOrderFetch();
      const adapter = fixtureAdapter("test-api-key", fetchMock as typeof fetch);

      await adapter.getOrder({
        inputMint: USDC_MINT,
        outputMint: TOKEN_MINT,
        amount: 1_000_000n,
        taker: FOLLOWER,
      });

      const { url, options } = capturedRequest(fetchMock);
      expect(options?.method).toBe("GET");
      expect(url.pathname).toBe("/swap/v2/order");
      expect(url.pathname).not.toContain("/execute");
      expect(url.searchParams.get("inputMint")).toBe(USDC_MINT);
      expect(url.searchParams.get("outputMint")).toBe(TOKEN_MINT);
      expect(url.searchParams.get("amount")).toBe("1000000");
      expect(url.searchParams.get("taker")).toBe(FOLLOWER);
    });
  });

  it("calls only GET /swap/v2/order and discards the transaction payload", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            transaction: "base64-unsigned-transaction-that-is-never-returned",
            requestId: "request-1",
            outAmount: "1990000",
            router: "metis",
            mode: "manual",
            feeBps: 5,
            feeMint: USDC_MINT,
            priceImpactPct: "0.12",
            routePlan: [{ swapInfo: { label: "Raydium" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const adapter = fixtureAdapter("test-api-key", fetchMock as typeof fetch);
    const order = await adapter.getOrder({
      inputMint: USDC_MINT,
      outputMint: TOKEN_MINT,
      amount: 1_000_000n,
    });
    const [url, options] = fetchMock.mock.calls[0] as unknown as [
      URL | string,
      RequestInit | undefined,
    ];
    expect(String(url)).toContain("/swap/v2/order?");
    expect(String(url)).not.toContain("/execute");
    expect(options?.method).toBe("GET");
    expect(order.expectedOutputRaw).toBe(1_990_000n);
    expect(order.route).toHaveLength(1);
    expect(order.hasAssembledTransaction).toBe(true);
    expect(order).not.toHaveProperty("transaction");
    const paperResult = await new PaperTransactionSender(adapter).send(intent);
    expect(paperResult.state).toBe("PAPER_EXECUTED");
    expect(paperResult.metadata).toMatchObject({
      provider: "JUPITER_SWAP_V2_ORDER",
      expectedOutputRaw: "1990000",
      priceImpactPct: "12",
      hasAssembledTransaction: true,
    });
    expect(paperResult.metadata).not.toHaveProperty("transaction");
  });

  it("fails closed on an unknown response schema", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ requestId: "request-2", unexpectedAmount: 123 }),
          { status: 200 },
        ),
    );
    const adapter = fixtureAdapter("test-api-key", fetchMock as typeof fetch);
    await expect(
      adapter.getOrder({
        inputMint: USDC_MINT,
        outputMint: TOKEN_MINT,
        amount: 1n,
      }),
    ).rejects.toBeInstanceOf(JupiterSchemaError);
    const result = await new PaperTransactionSender(adapter).send(intent);
    expect(result.state).toBe("FAILED");
    expect(result.reason).toBe("JUPITER_SCHEMA_INVALID");
    expect(result.executedTokenRaw).toBe(0n);
    expect(result.executedQuoteRaw).toBe(0n);
  });
});
