import { createHash } from "node:crypto";
import type { Logger } from "pino";
import PQueue from "p-queue";
import type {
  RpcProvider,
  StreamProvider,
  StreamSubscription,
  StreamTransactionEnvelope,
} from "../domain/ports.js";
import type { Clock, ClockReading } from "../domain/time.js";
import {
  GapRecovery,
  recoveryFailureEvidence,
} from "../recovery/gap-recovery.js";
import {
  hydrationFailure,
  type HydrationFailureReason,
} from "../rpc/rpc-hydration-error.js";
import type { StreamDeliveryStore } from "./checkpoint-store.js";
import { SignatureDeduplicator } from "./signature-deduplicator.js";
import { StreamDeliveryDeferredError } from "./delivery-deferred-error.js";
import { abortable } from "../recovery/abortable.js";
import type { BoundedRecoveryPolicy } from "./bounded-recovery-policy.js";
import type {
  FaultInjectableSubscription,
  StreamHealthObserver,
} from "./stream-health.js";

interface WebSocketEventLike {
  readonly data?: unknown;
  readonly code?: number;
  readonly wasClean?: boolean;
  readonly error?: unknown;
}

export interface WebSocketClient {
  readonly readyState: number;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: WebSocketEventLike) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SolanaWebSocketOptions {
  readonly recoveryPolicy?: BoundedRecoveryPolicy;
  readonly signal?: AbortSignal;
  readonly onRecoveryExhausted?: () => void;
  readonly openingTimeoutMs?: number;
  readonly providerName?: string;
  readonly url: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly checkpoints: StreamDeliveryStore;
  readonly rpc: RpcProvider;
  readonly healthObserver?: StreamHealthObserver;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly subscriptionTimeoutMs?: number;
  readonly hostCheckIntervalMs?: number;
  readonly transactionFetchTimeoutMs?: number;
  readonly transactionFetchAttempts?: number;
  readonly transactionFetchBackoffMs?: number;
  readonly transactionFetchDelaysMs?: readonly number[];
  readonly transactionFetchSleep?: (milliseconds: number) => Promise<void>;
  readonly webSocketFactory?: (url: string) => WebSocketClient;
  readonly gapRecovery?: {
    readonly timeoutMs?: number;
    readonly maxAttempts?: number;
    readonly baseBackoffMs?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  };
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface LogNotification {
  readonly signature: string;
  readonly slot: bigint;
  readonly received: ClockReading;
  readonly transactionFailed: boolean;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : undefined;
}

function messageText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer)
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  if (ArrayBuffer.isView(data))
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  return undefined;
}

function defaultWebSocketFactory(url: string): WebSocketClient {
  return new WebSocket(url) as unknown as WebSocketClient;
}

export class SolanaWebSocketStreamProvider implements StreamProvider {
  constructor(private readonly options: SolanaWebSocketOptions) {}

  async subscribe(
    wallets: readonly string[],
    onTransaction: (envelope: StreamTransactionEnvelope) => unknown,
  ): Promise<StreamSubscription> {
    const session = new SolanaWebSocketSession(
      this.options,
      wallets,
      onTransaction,
    );
    const stop = () => {
      void session
        .close()
        .catch(() => this.options.logger.error("websocket_close_failed"));
    };
    this.options.signal?.addEventListener("abort", stop, { once: true });
    try {
      this.options.signal?.throwIfAborted();
      await session.start();
    } catch (error) {
      this.options.signal?.removeEventListener("abort", stop);
      throw error;
    }
    return session;
  }
}

class SolanaWebSocketSession
  implements StreamSubscription, FaultInjectableSubscription
{
  private wallets: readonly string[];
  private socket: WebSocketClient | undefined;
  private stopped = false;
  private closing: Promise<void> | undefined;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private hostCheckTimer: NodeJS.Timeout | undefined;
  private disconnectedAt: ClockReading | undefined;
  private faultResumeAtMs = 0;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly subscriptionIds = new Set<number>();
  private readonly notificationDedup = new SignatureDeduplicator();
  private readonly deliveryDedup = new SignatureDeduplicator();
  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly unpersisted = new Map<string, LogNotification>();
  private reconnectWork: Promise<void> | undefined;
  private cancelOpening: (() => void) | undefined;
  private recoveryInProgress = false;
  private recoveryGeneration = 0;
  private readonly bufferedLive: StreamTransactionEnvelope[] = [];
  private subscriptionKey: string;
  private recoveryAbort = new AbortController();
  private episodeTimer: NodeJS.Timeout | undefined;
  private episodeAttempts = 0;
  private recoveryFailed = false;

  constructor(
    private readonly options: SolanaWebSocketOptions,
    wallets: readonly string[],
    private readonly onTransaction: (
      envelope: StreamTransactionEnvelope,
    ) => unknown,
  ) {
    this.wallets = [...new Set(wallets)].sort();
    this.subscriptionKey = this.keyFor(this.wallets);
  }

  async start(): Promise<void> {
    this.enterHold("STARTUP");
    try {
      if (
        !this.options.checkpoints.getCheckpoint(
          this.providerName,
          this.subscriptionKey,
        ) &&
        this.options.rpc.getCurrentSlot
      ) {
        const slot = await abortable(
          this.options.rpc.getCurrentSlot({
            signal: this.recoveryAbort.signal,
          }),
          this.recoveryAbort.signal,
        );
        await this.persist(
          this.options.checkpoints.saveCheckpoint(
            this.providerName,
            this.subscriptionKey,
            slot,
          ),
        );
      }
      await this.connect();
    } catch (error) {
      if (!this.stopped) this.failRecovery("STREAM_START_FAILED");
      await this.close();
      throw error;
    }
    if (this.stopped) return;
    const interval = this.options.hostCheckIntervalMs ?? 30_000;
    let previousWallMs = this.options.clock.now().wallMs;
    this.hostCheckTimer = setInterval(() => {
      const nowMs = this.options.clock.now().wallMs;
      if (nowMs - previousWallMs > interval * 2) {
        this.scheduleReconnect("HOST_SCHEDULING_GAP");
        this.recordDegraded("HOST_SCHEDULING_GAP", {
          fromMs: previousWallMs,
          toMs: nowMs,
          elapsedMs: nowMs - previousWallMs,
        });
        this.socket?.close(1011, "host-scheduling-gap");
      }
      previousWallMs = nowMs;
    }, interval);
    this.hostCheckTimer.unref();
  }

  async updateTargets(wallets: readonly string[]): Promise<void> {
    const next = [...new Set(wallets)].sort();
    if (next.join(",") === this.wallets.join(",")) return;
    await this.unsubscribeAll();
    this.wallets = next;
    this.subscriptionKey = this.keyFor(next);
    this.recoveryInProgress = true;
    await this.subscribeAll();
    await this.recoverGap();
  }

  close(): Promise<void> {
    return (this.closing ??= this.closeSession());
  }

  private async closeSession(): Promise<void> {
    const recoveryComplete = !this.recoveryInProgress && !this.recoveryFailed;
    this.stopped = true;
    if (this.episodeTimer) clearTimeout(this.episodeTimer);
    this.episodeTimer = undefined;
    this.recoveryAbort.abort(new Error("STREAM_CLOSED"));
    this.cancelOpening?.();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.hostCheckTimer) clearInterval(this.hostCheckTimer);
    this.rejectPending("STREAM_CLOSED");
    this.socket?.close(1000, "shutdown");
    this.socket = undefined;
    this.connected = false;
    await this.reconnectWork;
    await this.queue.onIdle();
    const pending = this.options.checkpoints.listPendingDeliveries(
      this.providerName,
      this.subscriptionKey,
    );
    this.recoveryState("STOPPED", "STREAM_CLOSED", { recoveryComplete });
    this.options.logger.info(
      {
        provider: this.providerName,
        subscriptionKey: this.subscriptionKey,
        rpcPending: this.options.rpc.pendingCount?.() ?? null,
        streamPending: pending.length,
        pendingDeliveries: pending.map((item) => ({
          signature: item.signature,
          slot: item.slot.toString(),
        })),
        unpersistedDeliveries: [...this.unpersisted.values()].map((item) => ({
          signature: item.signature,
          slot: item.slot.toString(),
        })),
        disposition: this.unpersisted.size
          ? "PERSISTENCE_FAILED"
          : pending.length
            ? "PERSISTED_FOR_REPLAY"
            : "DRAINED",
      },
      "websocket_stream_closed",
    );
    if (this.unpersisted.size)
      throw new Error("STREAM_PENDING_PERSISTENCE_FAILED");
  }

  async injectDisconnect(durationMs: number): Promise<void> {
    if (!Number.isFinite(durationMs) || durationMs <= 0)
      throw new Error("durationMs must be positive");
    this.faultResumeAtMs = Date.now() + durationMs;
    this.socket?.close(4000, "fault-injection");
    this.scheduleReconnect("FAULT_INJECTION_DISCONNECT");
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const policy = this.options.recoveryPolicy;
    if (policy && ++this.episodeAttempts > policy.maxAttempts) {
      this.failRecovery("RECONNECT_ATTEMPTS_EXHAUSTED");
      return;
    }
    this.recoveryAbort = new AbortController();
    this.recoveryState("SUBSCRIBING", "CONNECT_ATTEMPT");
    const factory = this.options.webSocketFactory ?? defaultWebSocketFactory;
    const socket = factory(this.options.url);
    const previousSocket = this.socket;
    this.socket = socket;
    previousSocket?.close(1000, "replaced");
    this.connected = false;
    this.recoveryInProgress = true;

    let reconnectEnabled = true;
    let openingTimer: NodeJS.Timeout | undefined;
    await new Promise<void>((resolve, reject) => {
      this.cancelOpening = () => reject(new Error("STREAM_CLOSED"));
      openingTimer = setTimeout(
        () => reject(new Error("WEBSOCKET_OPEN_TIMEOUT")),
        this.options.openingTimeoutMs ?? 5_000,
      );
      let opened = false;
      socket.addEventListener("open", () => {
        if (this.socket !== socket || this.stopped || this.reconnectTimer)
          return;
        opened = true;
        this.connected = true;
        resolve();
      });
      socket.addEventListener("message", (event) => {
        if (this.socket === socket && !this.stopped)
          this.handleMessage(event.data);
      });
      socket.addEventListener("error", (event) => {
        if (this.socket !== socket || this.stopped) return;
        this.socketDiagnostic("ERROR", event);
        if (!opened) reject(new Error("WEBSOCKET_CONNECTION_FAILED"));
        else if (reconnectEnabled) this.scheduleReconnect("WEBSOCKET_ERROR");
      });
      socket.addEventListener("close", (event) => {
        if (this.socket !== socket || this.stopped) return;
        this.socketDiagnostic("CLOSE", event);
        this.connected = false;
        if (!opened) reject(new Error("WEBSOCKET_CLOSED_BEFORE_OPEN"));
        else if (reconnectEnabled) this.scheduleReconnect("WEBSOCKET_CLOSED");
      });
    }).finally(() => {
      if (openingTimer) clearTimeout(openingTimer);
      this.cancelOpening = undefined;
    });

    if (this.stopped) {
      socket.close(1000, "shutdown");
      return;
    }
    try {
      await this.subscribeAll();
    } catch (error) {
      reconnectEnabled = false;
      this.connected = false;
      this.rejectPending("SUBSCRIPTION_FAILED");
      socket.close(1011, "subscription-failed");
      throw error;
    }
    if (!this.connected || this.stopped || this.socket !== socket) return;
    const now = this.options.clock.now();
    if (this.disconnectedAt) {
      this.options.healthObserver?.notify({
        provider: this.providerName,
        type: "RECONNECTED",
        wallTimestampMs: now.wallMs,
        monotonicTimestampNs: now.monotonicNs,
        durationMs:
          Number(now.monotonicNs - this.disconnectedAt.monotonicNs) / 1_000_000,
      });
      this.disconnectedAt = undefined;
    } else {
      this.options.healthObserver?.notify({
        provider: this.providerName,
        type: "CONNECTED",
        wallTimestampMs: now.wallMs,
        monotonicTimestampNs: now.monotonicNs,
      });
    }
    await this.recoverGap();
  }

  private async subscribeAll(): Promise<void> {
    this.subscriptionIds.clear();
    for (const wallet of this.wallets) {
      const result = await this.sendRequest("logsSubscribe", [
        { mentions: [wallet] },
        { commitment: "confirmed" },
      ]);
      if (!Number.isSafeInteger(result))
        throw new Error("INVALID_SUBSCRIPTION_RESPONSE");
      this.subscriptionIds.add(Number(result));
    }
  }

  private async unsubscribeAll(): Promise<void> {
    if (!this.connected) {
      this.subscriptionIds.clear();
      return;
    }
    const ids = [...this.subscriptionIds];
    this.subscriptionIds.clear();
    await Promise.all(
      ids.map((id) =>
        this.sendRequest("logsUnsubscribe", [id]).catch(() => undefined),
      ),
    );
  }

  private sendRequest(
    method: string,
    params: readonly unknown[],
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket || !this.connected)
      return Promise.reject(new Error("WEBSOCKET_NOT_CONNECTED"));
    const id = ++this.requestId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("WEBSOCKET_REQUEST_TIMEOUT"));
      }, this.options.subscriptionTimeoutMs ?? 5_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("WEBSOCKET_SEND_FAILED"));
      }
    });
  }

  private handleMessage(data: unknown): void {
    if (this.options.recoveryPolicy && (!this.connected || this.stopped))
      return;
    const text = messageText(data);
    if (!text) {
      this.recordMalformed("NON_TEXT_MESSAGE");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      this.recordMalformed("INVALID_JSON");
      return;
    }
    const root = record(value);
    if (!root) {
      this.recordMalformed("INVALID_ENVELOPE");
      return;
    }
    if (typeof root.id === "number") {
      const pending = this.pending.get(root.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(root.id);
      if (root.error !== undefined)
        pending.reject(new Error("WEBSOCKET_RPC_ERROR"));
      else pending.resolve(root.result);
      return;
    }
    const notification = this.parseNotification(root);
    if (!notification) {
      this.recordMalformed("INVALID_LOGS_NOTIFICATION");
      return;
    }
    if (!this.notificationDedup.accept(notification.signature)) return;
    if (
      this.options.recoveryPolicy &&
      this.unpersisted.size + this.bufferedLive.length >=
        this.options.recoveryPolicy.maxBuffered
    ) {
      this.failRecovery("STREAM_INTAKE_LIMIT_EXCEEDED");
      return;
    }
    this.unpersisted.set(notification.signature, notification);
    void this.queue
      .add(async () => {
        const hydrationSignal = this.options.recoveryPolicy
          ? this.recoveryAbort.signal
          : undefined;
        try {
          await this.persist(
            this.options.checkpoints.savePendingDelivery(
              this.providerName,
              this.subscriptionKey,
              notification.slot,
              notification.signature,
            ),
          );
          this.unpersisted.delete(notification.signature);
          await this.hydrateNotification(notification);
        } catch (error) {
          this.notificationDedup.forget(notification.signature);
          if (
            hydrationSignal?.aborted &&
            !this.unpersisted.has(notification.signature)
          )
            return; // Durable pending is replayed; never authorize from a cancelled generation.
          if (error instanceof StreamDeliveryDeferredError) return;
          try {
            await this.holdGap(notification.slot);
          } catch {
            // Persistence failure must not leave the stream running or produce an unhandled rejection.
            this.scheduleReconnect("STREAM_CHECKPOINT_WRITE_FAILED");
            this.socket?.close(1011, "checkpoint-write-failed");
          }
          const failure = hydrationFailure(error);
          this.recordDegraded(failure.reason, {
            signature: notification.signature,
            slot: notification.slot.toString(),
            rpc_status: failure.rpcStatus ?? null,
            rpc_error_code: failure.rpcErrorCode ?? null,
          });
        }
      })
      .catch(() => {
        this.recordDegraded("STREAM_DELIVERY_TASK_FAILED");
      });
  }

  private parseNotification(root: UnknownRecord): LogNotification | undefined {
    if (root.method !== "logsNotification") return undefined;
    const params = record(root.params);
    const result = record(params?.result);
    const context = record(result?.context);
    const value = record(result?.value);
    if (
      typeof context?.slot !== "number" ||
      !Number.isSafeInteger(context.slot) ||
      context.slot < 0 ||
      typeof value?.signature !== "string" ||
      value.signature.length === 0 ||
      !Array.isArray(value.logs)
    )
      return undefined;
    return {
      signature: value.signature,
      slot: BigInt(context.slot),
      received: this.options.clock.now(),
      transactionFailed: value.err !== null && value.err !== undefined,
    };
  }

  private async hydrateNotification(
    notification: LogNotification,
  ): Promise<void> {
    if (notification.transactionFailed) {
      this.options.logger.info(
        {
          signature: notification.signature,
          slot: notification.slot.toString(),
          outcome: "TRANSACTION_FAILED",
          source: "LOGS_NOTIFICATION",
        },
        "transaction_chain_failed",
      );
      await this.persist(
        this.options.checkpoints.deletePendingDelivery(
          this.providerName,
          this.subscriptionKey,
          notification.signature,
        ),
      );
      return;
    }
    const generationSignal = this.options.recoveryPolicy
      ? this.recoveryAbort.signal
      : undefined;
    let transaction: StreamTransactionEnvelope | undefined;
    let lastError: unknown;
    let lastReason: HydrationFailureReason = "TRANSACTION_NOT_YET_AVAILABLE";
    let lastRpcStatus: number | undefined;
    let lastRpcErrorCode: number | undefined;
    const delays =
      this.options.transactionFetchDelaysMs ??
      (this.options.transactionFetchAttempts === undefined
        ? [0, 100, 250, 500, 1_000, 2_000]
        : Array.from(
            { length: this.options.transactionFetchAttempts },
            (_value, index) =>
              index === 0
                ? 0
                : (this.options.transactionFetchBackoffMs ?? 100) *
                  2 ** (index - 1),
          ));
    const sleep =
      this.options.transactionFetchSleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const maxAttempts = delays.length;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const delayMs = delays[attempt] ?? 0;
      generationSignal?.throwIfAborted();
      if (delayMs > 0)
        await (generationSignal
          ? abortable(sleep(delayMs), generationSignal)
          : sleep(delayMs));
      let outcome: "SUCCESS" | HydrationFailureReason;
      try {
        transaction = await this.fetchNotification(
          notification.signature,
          generationSignal,
        );
        if (transaction) {
          outcome = "SUCCESS";
          this.logHydrationAttempt(notification, attempt + 1, delayMs, outcome);
          break;
        }
        outcome = "TRANSACTION_NOT_YET_AVAILABLE";
        lastReason = outcome;
      } catch (error) {
        generationSignal?.throwIfAborted();
        lastError = error;
        const failure = hydrationFailure(error);
        outcome = failure.reason;
        lastReason = failure.reason;
        lastRpcStatus = failure.rpcStatus;
        lastRpcErrorCode = failure.rpcErrorCode;
      }
      this.logHydrationAttempt(
        notification,
        attempt + 1,
        delayMs,
        outcome,
        lastRpcStatus,
        lastRpcErrorCode,
      );
      if (outcome === "TRANSACTION_FAILED") {
        await this.persist(
          this.options.checkpoints.deletePendingDelivery(
            this.providerName,
            this.subscriptionKey,
            notification.signature,
          ),
        );
        return; // Confirmed chain failure is terminal, not provider degradation.
      }
    }
    if (!transaction) {
      this.notificationDedup.forget(notification.signature);
      await this.holdGap(notification.slot);
      this.recordDegraded(lastReason, {
        signature: notification.signature,
        slot: notification.slot.toString(),
        attempt: maxAttempts,
        delay_ms: delays[maxAttempts - 1] ?? 0,
        rpc_status: lastRpcStatus ?? null,
        rpc_error_code: lastRpcErrorCode ?? null,
      });
      return;
    }
    if (transaction.signature !== notification.signature)
      throw new Error("TRANSACTION_SIGNATURE_MISMATCH");
    const envelope: StreamTransactionEnvelope = {
      ...transaction,
      streamReceivedTimestampMs: notification.received.wallMs,
      streamReceivedMonotonicNs: notification.received.monotonicNs,
    };
    if (this.recoveryInProgress) {
      if (this.bufferedLive.length >= 10_000)
        throw new Error("RECOVERY_BUFFER_LIMIT_EXCEEDED");
      this.bufferedLive.push(envelope);
    } else await this.deliver(envelope, "LIVE");
  }

  private logHydrationAttempt(
    notification: LogNotification,
    attempt: number,
    delayMs: number,
    outcome: "SUCCESS" | HydrationFailureReason,
    rpcStatus?: number,
    rpcErrorCode?: number,
  ): void {
    this.options.logger.info(
      {
        signature: notification.signature,
        slot: notification.slot.toString(),
        attempt,
        delay_ms: delayMs,
        rpc_status: rpcStatus ?? null,
        rpc_error_code: rpcErrorCode ?? null,
        outcome,
      },
      "transaction_hydration_attempt",
    );
  }

  private async fetchNotification(
    signature: string,
    parent?: AbortSignal,
  ): Promise<StreamTransactionEnvelope | undefined> {
    if (!parent)
      return this.withTimeout(
        this.options.rpc.getTransaction(signature),
        this.options.transactionFetchTimeoutMs ?? 3_000,
      );
    parent.throwIfAborted();
    const controller = new AbortController();
    const signal = AbortSignal.any([parent, controller.signal]);
    const timer = setTimeout(
      () => controller.abort(new Error("RPC_TRANSACTION_FETCH_TIMEOUT")),
      this.options.transactionFetchTimeoutMs ?? 3_000,
    );
    try {
      return await abortable(
        this.options.rpc.getTransaction(signature, { signal }),
        signal,
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("RPC_TRANSACTION_FETCH_TIMEOUT")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async recoverGap(): Promise<void> {
    const generation = this.recoveryGeneration;
    const recoverySocket = this.socket;
    const signal = this.recoveryAbort.signal;
    this.recoveryState("REPLAYING", "SUBSCRIPTIONS_ACKNOWLEDGED");
    const pending = this.options.checkpoints.listPendingDeliveries(
      this.providerName,
      this.subscriptionKey,
    );
    let checkpoint = this.options.checkpoints.getCheckpoint(
      this.providerName,
      this.subscriptionKey,
    );
    for (const item of pending) {
      if (!checkpoint || item.slot < checkpoint.slot) {
        await this.persist(
          this.options.checkpoints.saveCheckpoint(
            this.providerName,
            this.subscriptionKey,
            item.slot,
          ),
        );
        checkpoint = { slot: item.slot };
      }
    }
    if (!checkpoint) {
      if (this.options.recoveryPolicy) {
        this.failRecovery("RECOVERY_CHECKPOINT_UNAVAILABLE");
        return;
      }
      await this.flushRecovery([], generation);
      return;
    }
    const started = this.options.clock.now();
    this.options.healthObserver?.notify({
      provider: this.providerName,
      type: "REPLAY_STARTED",
      wallTimestampMs: started.wallMs,
      monotonicTimestampNs: started.monotonicNs,
      details: { checkpointSlot: checkpoint.slot.toString() },
    });
    const recovered: StreamTransactionEnvelope[] = [];
    try {
      let beforeSlot: bigint | undefined;
      if (this.options.recoveryPolicy) {
        if (!this.options.rpc.getCurrentSlot)
          throw new Error("RECOVERY_FENCE_UNAVAILABLE");
        beforeSlot = await abortable(
          this.options.rpc.getCurrentSlot({ signal }),
          signal,
        );
        if (beforeSlot < checkpoint.slot)
          throw new Error("RECOVERY_FENCE_REGRESSED");
      }
      const batch = await new GapRecovery(
        this.options.rpc,
        this.options.checkpoints,
        {
          ...this.options.gapRecovery,
          signal,
          ...(beforeSlot === undefined ? {} : { beforeSlot }),
        },
      ).collect(this.providerName, this.subscriptionKey, this.wallets);
      recovered.push(...batch);
      if (this.stopped || this.socket !== recoverySocket) return;
      if (!(await this.flushRecovery(recovered, generation))) return;
      this.reconnectAttempt = 0;
      this.episodeAttempts = 0;
      if (this.episodeTimer) clearTimeout(this.episodeTimer);
      this.episodeTimer = undefined;
      this.recoveryState("READY", "REPLAY_AND_ACK_COMPLETE", {
        scanComplete: true,
        subscriptionsAcknowledged: this.subscriptionIds.size,
        targetCount: this.wallets.length,
        checkpointCommitted: true,
        replayFromSlot: checkpoint.slot.toString(),
        replayThroughSlot: beforeSlot?.toString(),
        replayCount: recovered.length,
      });
      const completed = this.options.clock.now();
      this.options.healthObserver?.notify({
        provider: this.providerName,
        type: "REPLAY_COMPLETED",
        wallTimestampMs: completed.wallMs,
        monotonicTimestampNs: completed.monotonicNs,
        durationMs:
          Number(completed.monotonicNs - started.monotonicNs) / 1_000_000,
        details: { replayCount: recovered.length },
      });
    } catch (error) {
      if (this.stopped || generation !== this.recoveryGeneration) return;
      if (
        this.options.recoveryPolicy &&
        error instanceof Error &&
        error.message === "STREAM_EVIDENCE_WRITE_FAILED"
      ) {
        this.failRecovery("STREAM_EVIDENCE_WRITE_FAILED");
        return;
      }
      this.recoveryInProgress = true;
      const failed = this.options.clock.now();
      this.options.healthObserver?.notify({
        provider: this.providerName,
        type: "REPLAY_FAILED",
        wallTimestampMs: failed.wallMs,
        monotonicTimestampNs: failed.monotonicNs,
        durationMs:
          Number(failed.monotonicNs - started.monotonicNs) / 1_000_000,
        details: {
          reason: "RPC_GAP_RECOVERY_FAILED",
          ...recoveryFailureEvidence(error),
        },
      });
      this.options.logger.error(
        { provider: this.providerName },
        "websocket_gap_recovery_failed",
      );
      this.scheduleReconnect("GAP_RECOVERY_RETRY_REQUIRED");
      this.socket?.close(1011, "gap-recovery-failed");
    }
  }

  private async flushRecovery(
    recovered: readonly StreamTransactionEnvelope[],
    generation: number,
  ): Promise<boolean> {
    let batch = recovered;
    // Yield back to the same intake queue between batches. Notifications accepted
    // while downstream acknowledges replay must persist/hydrate before READY.
    for (;;) {
      const result = await this.queue.add(async () => {
        const current = () =>
          !this.stopped &&
          this.connected &&
          generation === this.recoveryGeneration;
        if (!current()) return "OBSOLETE";
        this.recoveryState("DRAINING", "REPLAY_COLLECTED");
        const bufferedCount = this.bufferedLive.length;
        const deliveries = [
          ...batch.map((envelope) => ({ envelope, type: "REPLAY" as const })),
          ...this.bufferedLive.map((envelope) => ({
            envelope,
            type: "LIVE" as const,
          })),
        ].sort((a, b) =>
          a.envelope.slot < b.envelope.slot
            ? -1
            : a.envelope.slot > b.envelope.slot
              ? 1
              : 0,
        );
        for (const delivery of deliveries) {
          if (!current()) return "OBSOLETE";
          await this.deliver(delivery.envelope, delivery.type);
        }
        if (!current()) return "OBSOLETE";
        this.bufferedLive.splice(0, bufferedCount);
        batch = [];
        if (this.options.recoveryPolicy && this.unpersisted.size) return "MORE";
        if (
          this.options.recoveryPolicy &&
          (this.options.rpc.pendingCount?.() ?? 0) > 0
        )
          throw new Error("RECOVERY_RPC_NOT_DRAINED");
        if (
          this.options.recoveryPolicy &&
          this.options.checkpoints.listPendingDeliveries(
            this.providerName,
            this.subscriptionKey,
          ).length
        )
          throw new Error("RECOVERY_PENDING_UNRESOLVED");
        const last = deliveries.at(-1)?.envelope;
        if (last)
          await this.persist(
            this.options.checkpoints.saveCheckpoint(
              this.providerName,
              this.subscriptionKey,
              last.slot,
              last.signature,
            ),
          );
        if (!current()) return "OBSOLETE";
        if (this.options.recoveryPolicy && this.unpersisted.size) return "MORE";
        this.recoveryInProgress = false;
        return "READY";
      });
      if (result !== "MORE") return result === "READY";
    }
  }

  private async persist<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      if (this.options.recoveryPolicy)
        this.failRecovery("STREAM_EVIDENCE_WRITE_FAILED");
      throw error;
    }
  }

  private async deliver(
    envelope: StreamTransactionEnvelope,
    deliveryType: "LIVE" | "REPLAY",
  ): Promise<void> {
    if (this.deliveryDedup.has(envelope.signature)) {
      await this.persist(
        this.options.checkpoints.deletePendingDelivery(
          this.providerName,
          this.subscriptionKey,
          envelope.signature,
        ),
      );
      return;
    }
    await this.onTransaction({ ...envelope, deliveryType });
    await this.persist(
      this.options.checkpoints.deletePendingDelivery(
        this.providerName,
        this.subscriptionKey,
        envelope.signature,
      ),
    );
    this.deliveryDedup.accept(envelope.signature);
    if (!this.recoveryInProgress)
      await this.persist(
        this.options.checkpoints.saveCheckpoint(
          this.providerName,
          this.subscriptionKey,
          envelope.slot,
          envelope.signature,
        ),
      );
  }

  private async holdGap(slot: bigint): Promise<void> {
    this.recoveryInProgress = true;
    const checkpoint = this.options.checkpoints.getCheckpoint(
      this.providerName,
      this.subscriptionKey,
    );
    if (!checkpoint || checkpoint.slot > slot)
      await this.persist(
        this.options.checkpoints.saveCheckpoint(
          this.providerName,
          this.subscriptionKey,
          slot,
        ),
      );
    this.scheduleReconnect("DELIVERY_GAP_RETRY_REQUIRED");
    this.socket?.close(1011, "delivery-gap");
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.recoveryGeneration += 1;
    this.recoveryAbort.abort(new Error("STREAM_GENERATION_SUPERSEDED"));
    this.connected = false;
    this.recoveryInProgress = true;
    this.enterHold(reason);
    this.rejectPending("STREAM_DISCONNECTED");
    const disconnected = this.options.clock.now();
    this.disconnectedAt ??= disconnected;
    this.options.healthObserver?.notify({
      provider: this.providerName,
      type: "DISCONNECTED",
      wallTimestampMs: disconnected.wallMs,
      monotonicTimestampNs: disconnected.monotonicNs,
      details: { reason },
    });
    const min = this.options.minBackoffMs ?? 250;
    const max = this.options.maxBackoffMs ?? 30_000;
    const backoff =
      Math.min(max, min * 2 ** this.reconnectAttempt) +
      Math.floor(Math.random() * min);
    const delay = Math.max(backoff, this.faultResumeAtMs - Date.now());
    this.reconnectAttempt += 1;
    this.options.logger.warn(
      { provider: this.providerName, delay, attempt: this.reconnectAttempt },
      "websocket_reconnect_scheduled",
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnectWork = this.connect().catch(() =>
        this.scheduleReconnect("WEBSOCKET_RECONNECT_FAILED"),
      );
    }, delay);
  }

  private rejectPending(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private recordMalformed(reason: string): void {
    this.recordDegraded(reason);
  }

  private recordDegraded(
    reason: string,
    details: Readonly<Record<string, unknown>> = {},
  ): void {
    const now = this.options.clock.now();
    this.options.healthObserver?.notify({
      provider: this.providerName,
      type: "DEGRADED",
      wallTimestampMs: now.wallMs,
      monotonicTimestampNs: now.monotonicNs,
      details: { reason, ...details },
    });
    this.options.logger.warn(
      { provider: this.providerName, reason, ...details },
      "websocket_stream_degraded",
    );
  }

  private keyFor(wallets: readonly string[]): string {
    return createHash("sha256")
      .update(wallets.join(","))
      .digest("hex")
      .slice(0, 24);
  }

  private get providerName(): string {
    return this.options.providerName ?? "solana-websocket";
  }

  private enterHold(reason: string): void {
    if (!this.options.recoveryPolicy) return;
    this.recoveryInProgress = true;
    if (!this.episodeTimer) {
      this.episodeTimer = setTimeout(
        () => this.failRecovery("RECOVERY_DEADLINE_EXCEEDED"),
        this.options.recoveryPolicy.maxEpisodeMs,
      );
    }
    this.recoveryState("HOLD", reason);
  }

  private recoveryState(
    state: string,
    reason: string,
    extra: Record<string, unknown> = {},
  ): void {
    if (!this.options.recoveryPolicy) return;
    const checkpoint = this.options.checkpoints.getCheckpoint(
      this.providerName,
      this.subscriptionKey,
    );
    this.options.logger.info(
      {
        checkpointSlot: checkpoint?.slot.toString() ?? null,
        checkpointSignature: checkpoint?.signature ?? null,
        policyVersion: this.options.recoveryPolicy.version,
        provider: this.providerName,
        subscriptionKey: this.subscriptionKey,
        generation: this.recoveryGeneration,
        state,
        reason,
        buffered: this.bufferedLive.length,
        unpersisted: this.unpersisted.size,
        pendingDeliveries: this.options.checkpoints.listPendingDeliveries(
          this.providerName,
          this.subscriptionKey,
        ).length,
        ...extra,
      },
      "websocket_recovery_state",
    );
  }

  private failRecovery(reason: string): void {
    if (this.stopped || this.recoveryFailed) return;
    this.recoveryFailed = true;
    this.recoveryState("FAILED", reason);
    this.options.onRecoveryExhausted?.();
    void this.close().catch(() =>
      this.options.logger.error("websocket_close_failed"),
    );
  }

  private socketDiagnostic(
    kind: "ERROR" | "CLOSE",
    event: WebSocketEventLike,
  ): void {
    const error = event.error as
      { code?: unknown; cause?: { code?: unknown } } | undefined;
    const rawCode = error?.code ?? error?.cause?.code;
    const code =
      typeof rawCode === "string" &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT_TIMEOUT",
      ].includes(rawCode)
        ? rawCode
        : "UNKNOWN";
    this.options.logger.warn(
      {
        provider: this.providerName,
        kind,
        generation: this.recoveryGeneration,
        readyState: this.socket?.readyState,
        closeCode: Number.isInteger(event.code) ? event.code : null,
        wasClean: typeof event.wasClean === "boolean" ? event.wasClean : null,
        errorCode: code,
      },
      "websocket_transport_diagnostic",
    );
  }
}
