import type {
  RpcProvider,
  StreamTransactionEnvelope,
} from "../domain/ports.js";
import { hydrationFailure } from "../rpc/rpc-hydration-error.js";
import type {
  StreamDeliveryStore,
  StreamCheckpointStore,
} from "../stream/checkpoint-store.js";
import { SignatureDeduplicator } from "../stream/signature-deduplicator.js";
import { abortable } from "./abortable.js";

export class RpcTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`RPC recovery request exceeded ${timeoutMs}ms`);
  }
}

export function recoveryFailureEvidence(
  error: unknown,
): Readonly<Record<string, string | number>> {
  const message = error instanceof Error ? error.message : "";
  const context =
    error !== null &&
    typeof error === "object" &&
    "context" in error &&
    error.context !== null &&
    typeof error.context === "object"
      ? error.context
      : {};
  const code =
    "__code" in context && typeof context.__code === "number"
      ? context.__code
      : undefined;
  return {
    failureCategory: /429|rate.limit/i.test(message)
      ? "RPC_RATE_LIMITED"
      : /timeout|timed.out|exceeded.*ms/i.test(message)
        ? "RPC_TIMEOUT"
        : /method.not.found|not.supported/i.test(message)
          ? "RPC_METHOD_UNAVAILABLE"
          : "RPC_OR_DOWNSTREAM_FAILURE",
    ...(code === undefined ? {} : { rpcErrorCode: code }),
    errorCode: /^[A-Z_]+$/.test(message)
      ? message
      : "UNCLASSIFIED_RECOVERY_ERROR",
  };
}

export interface GapRecoveryOptions {
  readonly signal?: AbortSignal;
  readonly beforeSlot?: bigint;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class GapRecovery {
  constructor(
    private readonly rpc: RpcProvider,
    private readonly checkpoints: StreamCheckpointStore,
    private readonly options: GapRecoveryOptions = {},
  ) {}

  async recover(
    provider: string,
    subscriptionKey: string,
    wallets: readonly string[],
    emit: (envelope: StreamTransactionEnvelope) => unknown,
  ): Promise<number> {
    const recovered = await this.collect(provider, subscriptionKey, wallets);
    for (const envelope of recovered) await emit(envelope);
    // Commit the scan only after the whole batch is acknowledged. Partial
    // failure can safely replay every signature through business idempotency.
    const last = recovered.at(-1);
    if (last)
      await this.checkpoints.saveCheckpoint(
        provider,
        subscriptionKey,
        last.slot,
        last.signature,
      );
    return recovered.length;
  }

  async collect(
    provider: string,
    subscriptionKey: string,
    wallets: readonly string[],
  ): Promise<readonly StreamTransactionEnvelope[]> {
    this.options.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = this.options.signal
      ? AbortSignal.any([controller.signal, this.options.signal])
      : controller.signal;
    try {
      const durable =
        "listPendingDeliveries" in this.checkpoints
          ? (this.checkpoints as StreamDeliveryStore)
          : undefined;
      const pending =
        durable?.listPendingDeliveries(provider, subscriptionKey) ?? [];
      let checkpoint = this.checkpoints.getCheckpoint(
        provider,
        subscriptionKey,
      );
      for (const item of pending)
        if (!checkpoint || item.slot < checkpoint.slot)
          checkpoint = { slot: item.slot };
      if (!checkpoint) return [];
      const lowerSlot = checkpoint.slot;
      const recovered = (
        await Promise.all(
          wallets.map((wallet) =>
            this.retry(
              (requestSignal) =>
                this.rpc.getTransactionsForAddress(wallet, {
                  // The cursor is a slot watermark, not a proof the whole slot was seen.
                  afterSlot: lowerSlot - 1n,
                  ...(this.options.beforeSlot === undefined
                    ? {}
                    : { beforeSlot: this.options.beforeSlot }),
                  signal: requestSignal,
                }),
              signal,
            ),
          ),
        )
      )
        .flat()
        .sort((left, right) =>
          left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0,
        );
      for (const item of pending) {
        if (recovered.some((entry) => entry.signature === item.signature))
          continue;
        try {
          const hydrated = await this.retry(async (requestSignal) => {
            const result = await this.rpc.getTransaction(item.signature, {
              signal: requestSignal,
            });
            if (!result || result.signature !== item.signature)
              throw new Error("PENDING_DELIVERY_UNRESOLVED");
            return result;
          }, signal);
          recovered.push(hydrated);
        } catch (error) {
          signal.throwIfAborted();
          if (hydrationFailure(error).reason !== "TRANSACTION_FAILED")
            throw error;
          try {
            await durable?.deletePendingDelivery(
              provider,
              subscriptionKey,
              item.signature,
            );
          } catch {
            throw new Error("STREAM_EVIDENCE_WRITE_FAILED");
          }
        }
      }
      recovered.sort((left, right) =>
        left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0,
      );
      const dedup = new SignatureDeduplicator(recovered.length + 1);
      signal.throwIfAborted();
      return recovered.filter((item) => dedup.accept(item.signature));
    } finally {
      controller.abort(new Error("RECOVERY_SCAN_FINISHED"));
    }
  }

  private async retry<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const sleep =
      this.options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      signal.throwIfAborted();
      const controller = new AbortController();
      const requestSignal = AbortSignal.any([signal, controller.signal]);
      let timer: NodeJS.Timeout | undefined;
      try {
        timer = setTimeout(
          () => controller.abort(new RpcTimeoutError(timeoutMs)),
          timeoutMs,
        );
        return await abortable(operation(requestSignal), requestSignal);
      } catch (error) {
        signal.throwIfAborted();
        lastError = error;
        if (attempt + 1 < maxAttempts)
          await abortable(
            sleep((this.options.baseBackoffMs ?? 100) * 2 ** attempt),
            signal,
          );
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort(new Error("RECOVERY_ATTEMPT_FINISHED"));
      }
    }
    throw lastError;
  }
}
