import { describe, expect, it, vi } from "vitest";
import { RpcHydrationError } from "../../src/rpc/rpc-hydration-error.js";
import { SolanaKitRpcProvider } from "../../src/rpc/solana-kit-rpc-provider.js";
import { TestClock } from "../helpers/test-clock.js";

const SIGNATURE = "3".repeat(64);

function providerWith(
  response: Response | (() => Promise<Response>),
): SolanaKitRpcProvider {
  const fetchFn =
    typeof response === "function" ? response : async () => response;
  return new SolanaKitRpcProvider(
    "https://rpc.invalid/redacted",
    new TestClock(),
    fetchFn as typeof fetch,
  );
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SolanaKitRpcProvider getTransaction", () => {
  it("uses the confirmed raw-json object config", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new SolanaKitRpcProvider(
      "https://rpc.invalid/redacted",
      new TestClock(),
      (async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: null });
      }) as typeof fetch,
    );
    await expect(provider.getTransaction(SIGNATURE)).resolves.toBeUndefined();
    expect(requestBody?.method).toBe("getTransaction");
    expect(requestBody?.params).toEqual([
      SIGNATURE,
      {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
        encoding: "json",
      },
    ]);
  });

  it("classifies HTTP 429", async () => {
    await expect(
      providerWith(jsonResponse({ error: "rate limited" }, 429)).getTransaction(
        SIGNATURE,
      ),
    ).rejects.toMatchObject({
      reason: "RPC_RATE_LIMITED",
      rpcStatus: 429,
    });
  });

  it("classifies timeout", async () => {
    await expect(
      providerWith(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }).getTransaction(SIGNATURE),
    ).rejects.toMatchObject({ reason: "RPC_TIMEOUT" });
  });

  it("classifies JSON-RPC errors", async () => {
    await expect(
      providerWith(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32_001, message: "node unavailable" },
        }),
      ).getTransaction(SIGNATURE),
    ).rejects.toMatchObject({
      reason: "RPC_JSONRPC_ERROR",
      rpcErrorCode: -32_001,
    });
  });

  it("classifies unsupported transaction versions", async () => {
    await expect(
      providerWith(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32_015,
            message: "Transaction version (1) is not supported",
          },
        }),
      ).getTransaction(SIGNATURE),
    ).rejects.toMatchObject({
      reason: "UNSUPPORTED_TRANSACTION_VERSION",
      rpcErrorCode: -32_015,
    });
  });

  it("maps a versioned raw-json transaction", async () => {
    const provider = providerWith(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          slot: 42,
          blockTime: 1_700_000_000,
          version: 0,
          transaction: {
            signatures: [SIGNATURE],
            message: {
              header: {
                numRequiredSignatures: 1,
                numReadonlySignedAccounts: 0,
                numReadonlyUnsignedAccounts: 1,
              },
              accountKeys: [
                "11111111111111111111111111111111",
                "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
              ],
              addressTableLookups: [],
              instructions: [{ programIdIndex: 1, accounts: [0], data: "3" }],
            },
          },
          meta: {
            err: null,
            fee: 5_000,
            preBalances: [1_000_000, 0],
            postBalances: [995_000, 0],
            preTokenBalances: [],
            postTokenBalances: [],
            innerInstructions: [],
            loadedAddresses: { writable: [], readonly: [] },
            logMessages: [],
          },
        },
      }),
    );
    const result = await provider.getTransaction(SIGNATURE);
    expect(result).toMatchObject({ signature: SIGNATURE, slot: 42n });
    expect(result?.payload).toMatchObject({
      version: 0,
      outerInstructions: [
        expect.objectContaining({
          programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        }),
      ],
      accountKeys: [
        expect.objectContaining({ signer: true, writable: true }),
        expect.objectContaining({ signer: false, writable: false }),
      ],
    });
  });
});

describe("SolanaKitRpcProvider getTransactionsForAddress", () => {
  it("collects more than 100 transactions without truncating a busy recovery", async () => {
    let page = 0;
    vi.stubGlobal("fetch", async () => {
      const current = page++;
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          data: Array.from({ length: current === 0 ? 100 : 1 }, (_, index) => ({
            slot: 100 + current * 100 + index,
            blockTime: 1700000000,
            version: "legacy",
            transaction: {
              signatures: [`signature-${current}-${index}`],
              message: { accountKeys: [], instructions: [] },
            },
            meta: {
              err: null,
              fee: 5000,
              preBalances: [],
              postBalances: [],
              preTokenBalances: [],
              postTokenBalances: [],
              innerInstructions: [],
            },
          })),
          paginationToken: current === 0 ? "200:0" : null,
        },
      });
    });
    try {
      const result = await new SolanaKitRpcProvider(
        "https://rpc.invalid",
        new TestClock(),
      ).getTransactionsForAddress("1".repeat(32), { afterSlot: 42n });
      expect(result).toHaveLength(101);
      expect(result.at(-1)?.slot).toBe(200n);
      expect(page).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed when the provider repeats a recovery cursor", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { data: [], paginationToken: "100:1" },
      }),
    );
    try {
      await expect(
        new SolanaKitRpcProvider(
          "https://rpc.invalid",
          new TestClock(),
        ).getTransactionsForAddress("1".repeat(32), { afterSlot: 42n }),
      ).rejects.toThrow("RPC_RECOVERY_PAGINATION_INVALID");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("follows pagination tokens even across an empty filtered page", async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          data: [],
          paginationToken: requests.length === 1 ? "100:99" : null,
        },
      });
    });
    try {
      await new SolanaKitRpcProvider(
        "https://rpc.invalid",
        new TestClock(),
      ).getTransactionsForAddress("1".repeat(32), { afterSlot: 42n });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.params).toEqual([
        "1".repeat(32),
        expect.objectContaining({ paginationToken: "100:99" }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("serializes gap recovery slot filters as JSON numbers", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { data: [] } });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = new SolanaKitRpcProvider(
        "https://rpc.invalid/redacted",
        new TestClock(),
      );
      await expect(
        provider.getTransactionsForAddress("1".repeat(32), {
          afterSlot: 42n,
          beforeSlot: 84n,
        }),
      ).resolves.toEqual([]);
      expect(requestBody).toMatchObject({
        method: "getTransactionsForAddress",
        params: ["1".repeat(32), { filters: { slot: { gt: 42, lte: 84 } } }],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("propagates caller cancellation to the production transaction fetch", async () => {
  const stop = new AbortController();
  let received: AbortSignal | undefined;
  const provider = new SolanaKitRpcProvider(
    "https://rpc.invalid/redacted",
    new TestClock(),
    (async (_url, init) => {
      received = init?.signal ?? undefined;
      return new Promise((_r, reject) =>
        received?.addEventListener("abort", () => reject(received!.reason), {
          once: true,
        }),
      );
    }) as typeof fetch,
  );
  const work = provider.getTransaction(SIGNATURE, { signal: stop.signal });
  const checked = expect(work).rejects.toThrow("FIXTURE_STOP");
  stop.abort(new Error("FIXTURE_STOP"));
  await checked;
  expect(received?.aborted).toBe(true);
});

it("does not fetch a further historical page after cancellation", async () => {
  const stop = new AbortController();
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      calls++;
      stop.abort(new Error("FIXTURE_STOP"));
      return jsonResponse({
        jsonrpc: "2.0",
        id: JSON.parse(String(init?.body)).id,
        result: { data: [], paginationToken: "next" },
      });
    }),
  );
  try {
    const provider = new SolanaKitRpcProvider(
      "https://rpc.invalid/redacted",
      new TestClock(),
    );
    await expect(
      provider.getTransactionsForAddress("11111111111111111111111111111111", {
        afterSlot: 0n,
        beforeSlot: 100n,
        signal: stop.signal,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps a noncooperative cancelled RPC visible until its actual settlement", async () => {
  const controller = new AbortController();
  let finish!: (r: Response) => void;
  const provider = new SolanaKitRpcProvider(
    "https://rpc.invalid/redacted",
    new TestClock(),
    (() =>
      new Promise((r) => {
        finish = r;
      })) as typeof fetch,
  );
  const work = provider.getTransaction(SIGNATURE, {
    signal: controller.signal,
  });
  expect(provider.pendingCount()).toBe(1);
  controller.abort();
  expect(provider.pendingCount()).toBe(1);
  finish(jsonResponse({ jsonrpc: "2.0", id: 1, result: null }));
  await work;
  expect(provider.pendingCount()).toBe(0);
});
