import {
  address,
  createSolanaRpc,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type Slot,
} from "@solana/kit";
import { configuredRpcBudget } from "../network/rpc-request-budget.js";
import type {
  RpcProvider,
  StreamTransactionEnvelope,
} from "../domain/ports.js";
import type { Clock } from "../domain/time.js";
import { RpcHydrationError } from "./rpc-hydration-error.js";
import { mapRpcTransaction } from "./rpc-transaction-mapper.js";

function jsonRpcSlot(slot: bigint): Slot {
  const value = Number(slot);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("RPC_SLOT_OUT_OF_SAFE_INTEGER_RANGE");
  return value as unknown as Slot;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(3_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class SolanaKitRpcProvider implements RpcProvider {
  private readonly active = new Set<Promise<unknown>>();

  pendingCount(): number {
    return this.active.size;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.active.add(operation);
    void operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation),
    );
    return operation;
  }

  private readonly rpc: ReturnType<typeof createSolanaRpc>;

  constructor(
    private readonly url: string,
    private readonly clock: Clock,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    const budget = configuredRpcBudget();
    if (budget) {
      const transport = createDefaultRpcTransport({
        url: url as Parameters<typeof createSolanaRpc>[0],
      });
      this.rpc = createSolanaRpcFromTransport(async (request) =>
        budget.run(async () => {
          try {
            return await transport(request);
          } catch (error) {
            if (
              (error as { context?: { statusCode?: number } })?.context
                ?.statusCode === 429
            )
              budget.trip();
            throw error;
          }
        }, request.signal),
      );
      this.fetchFn = (input, init) =>
        budget.run(async () => {
          const response = await fetchFn(input, init);
          if (response.status === 429) budget.trip();
          // Hold the lease through body completion, not just response headers.
          const bytes = await response.arrayBuffer();
          return new Response(bytes, {
            status: response.status,
            headers: response.headers,
          });
        }, init?.signal ?? undefined);
    } else {
      this.rpc = createSolanaRpc(url as Parameters<typeof createSolanaRpc>[0]);
    }
  }

  async getCurrentSlot(options?: {
    readonly signal?: AbortSignal;
  }): Promise<bigint> {
    return this.track(
      this.rpc
        .getSlot({ commitment: "confirmed" })
        .send({ abortSignal: requestSignal(options?.signal) }),
    );
  }

  async getTransaction(
    transactionSignature: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<StreamTransactionEnvelope | undefined> {
    return this.track(this.fetchTransaction(transactionSignature, options));
  }

  private async fetchTransaction(
    transactionSignature: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<StreamTransactionEnvelope | undefined> {
    // Keep this request explicit: logsSubscribe and hydration both use
    // confirmed, and the raw JSON mapper resolves index-based instructions.
    let httpResponse: Response;
    try {
      httpResponse = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [
            transactionSignature,
            {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
              encoding: "json",
            },
          ],
        }),
        signal: requestSignal(options?.signal),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError")
        throw new RpcHydrationError("RPC_TIMEOUT", "RPC request timed out");
      throw error;
    }
    if (httpResponse.status === 429)
      throw new RpcHydrationError(
        "RPC_RATE_LIMITED",
        "RPC rate limited",
        httpResponse.status,
      );
    if (!httpResponse.ok)
      throw new RpcHydrationError(
        "RPC_HTTP_ERROR",
        `RPC HTTP ${httpResponse.status}`,
        httpResponse.status,
      );
    let payload: unknown;
    try {
      payload = await httpResponse.json();
    } catch {
      throw new RpcHydrationError(
        "INVALID_RESPONSE",
        "RPC response was not JSON",
        httpResponse.status,
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new RpcHydrationError(
        "INVALID_RESPONSE",
        "RPC response envelope was invalid",
        httpResponse.status,
      );
    const envelope = payload as Record<string, unknown>;
    if (envelope.error !== undefined) {
      const rpcError =
        envelope.error && typeof envelope.error === "object"
          ? (envelope.error as Record<string, unknown>)
          : {};
      const code =
        typeof rpcError.code === "number" ? rpcError.code : undefined;
      const message = String(rpcError.message ?? "RPC JSON-RPC error");
      if (
        /unsupported transaction version|transaction version.*not supported|maxSupportedTransactionVersion/i.test(
          message,
        )
      )
        throw new RpcHydrationError(
          "UNSUPPORTED_TRANSACTION_VERSION",
          message,
          httpResponse.status,
          code,
        );
      throw new RpcHydrationError(
        "RPC_JSONRPC_ERROR",
        message,
        httpResponse.status,
        code,
      );
    }
    if (!("result" in envelope))
      throw new RpcHydrationError(
        "INVALID_RESPONSE",
        "RPC response omitted result",
        httpResponse.status,
      );
    if (envelope.result === null) return undefined;
    try {
      const result = envelope.result as {
        readonly meta?: { readonly err?: unknown };
      };
      if (result.meta?.err !== null && result.meta?.err !== undefined)
        throw new RpcHydrationError(
          "TRANSACTION_FAILED",
          "Transaction execution failed",
          httpResponse.status,
        );
      return mapRpcTransaction(envelope.result, this.clock.now());
    } catch (error) {
      if (error instanceof RpcHydrationError) throw error;
      throw new RpcHydrationError(
        "INVALID_RESPONSE",
        "RPC transaction could not be mapped",
        httpResponse.status,
      );
    }
  }

  async getTransactionsForAddress(
    wallet: string,
    options: {
      readonly afterSlot: bigint;
      readonly beforeSlot?: bigint;
      readonly signal?: AbortSignal;
    },
  ): Promise<readonly StreamTransactionEnvelope[]> {
    return this.track(this.scanTransactions(wallet, options));
  }

  private async scanTransactions(
    wallet: string,
    options: {
      readonly afterSlot: bigint;
      readonly beforeSlot?: bigint;
      readonly signal?: AbortSignal;
    },
  ): Promise<readonly StreamTransactionEnvelope[]> {
    const recovered: StreamTransactionEnvelope[] = [];
    const seenCursors = new Set<string>();
    const seenSignatures = new Set<string>();
    let paginationToken: string | undefined;
    for (let page = 0; page < 1_000; page += 1) {
      options.signal?.throwIfAborted();
      const response = await this.rpc
        .getTransactionsForAddress(address(wallet), {
          commitment: "confirmed",
          encoding: "json",
          filters: {
            slot: {
              ...(options.afterSlot < 0n
                ? { gte: jsonRpcSlot(0n) }
                : { gt: jsonRpcSlot(options.afterSlot) }),
              ...(options.beforeSlot === undefined
                ? {}
                : { lte: jsonRpcSlot(options.beforeSlot) }),
            },
            status: "any",
            tokenAccounts: "balanceChanged",
          },
          ...(paginationToken === undefined ? {} : { paginationToken }),
          limit: 100,
          maxSupportedTransactionVersion: 0,
          sortOrder: "asc",
          transactionDetails: "full",
        })
        .send({ abortSignal: requestSignal(options.signal) });
      options.signal?.throwIfAborted();
      if (!Array.isArray(response.data))
        throw new Error("RPC_RECOVERY_INVALID_PAGE");
      for (const item of response.data) {
        const envelope = mapRpcTransaction(item, this.clock.now());
        if (
          envelope.slot <= options.afterSlot ||
          (options.beforeSlot !== undefined &&
            envelope.slot > options.beforeSlot)
        )
          throw new Error("RPC_RECOVERY_SLOT_OUT_OF_RANGE");
        if (!seenSignatures.has(envelope.signature)) {
          recovered.push(envelope);
          seenSignatures.add(envelope.signature);
        }
      }
      const next = response.paginationToken;
      if (next === null) return recovered;
      // Older servers omit the terminal cursor. A full page without one is
      // ambiguous, so never report it as a complete recovery.
      if (next === undefined && response.data.length < 100) return recovered;
      if (typeof next !== "string" || !next || seenCursors.has(next))
        throw new Error("RPC_RECOVERY_PAGINATION_INVALID");
      seenCursors.add(next);
      paginationToken = next;
    }
    throw new Error("RPC_RECOVERY_PAGE_LIMIT_EXCEEDED");
  }

  async resolveAddressLookupTable(
    _lookupTableAddress: string,
  ): Promise<readonly string[]> {
    throw new Error(
      "ALT resolution is supplied by Yellowstone loaded-address fields or jsonParsed RPC metadata",
    );
  }
}
