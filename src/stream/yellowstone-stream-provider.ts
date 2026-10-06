import {
  GapRecovery,
  recoveryFailureEvidence,
} from "../recovery/gap-recovery.js";
import { createHash } from "node:crypto";
import Client, { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import type { Logger } from "pino";
import PQueue from "p-queue";
import type {
  RpcProvider,
  StreamProvider,
  StreamSubscription,
  StreamTransactionEnvelope,
} from "../domain/ports.js";
import type { Clock } from "../domain/time.js";
import type { StreamDeliveryStore } from "./checkpoint-store.js";
import { SignatureDeduplicator } from "./signature-deduplicator.js";
import { mapYellowstoneTransaction } from "./yellowstone-mapper.js";
import type {
  FaultInjectableSubscription,
  StreamHealthObserver,
} from "./stream-health.js";

export interface YellowstoneOptions {
  readonly providerName?: string;
  readonly endpoint: string;
  readonly token?: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly checkpoints: StreamDeliveryStore;
  readonly rpc: RpcProvider;
  readonly healthObserver?: StreamHealthObserver;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

interface WritableStream {
  on(event: string, listener: (...args: unknown[]) => void): this;
  write(value: unknown, callback?: (error?: Error | null) => void): boolean;
  end(): void;
  cancel?: () => void;
}

export class YellowstoneStreamProvider implements StreamProvider {
  constructor(private readonly options: YellowstoneOptions) {}

  async subscribe(
    initialWallets: readonly string[],
    onTransaction: (envelope: StreamTransactionEnvelope) => unknown,
  ): Promise<StreamSubscription> {
    const session = new YellowstoneSession(
      this.options,
      initialWallets,
      onTransaction,
    );
    await session.start();
    return session;
  }
}

class YellowstoneSession
  implements StreamSubscription, FaultInjectableSubscription
{
  private wallets: readonly string[];
  private stream?: WritableStream;
  private stopped = false;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private disconnectedAt: { wallMs: number; monotonicNs: bigint } | undefined;
  private faultResumeAtMs = 0;
  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly dedup = new SignatureDeduplicator();
  private recoveryInProgress = false;
  private recoveryGeneration = 0;
  private readonly bufferedLive: StreamTransactionEnvelope[] = [];
  private subscriptionKey: string;

  constructor(
    private readonly options: YellowstoneOptions,
    wallets: readonly string[],
    private readonly onTransaction: (
      envelope: StreamTransactionEnvelope,
    ) => unknown,
  ) {
    this.wallets = [...new Set(wallets)].sort();
    this.subscriptionKey = this.keyFor(this.wallets);
  }

  async start(): Promise<void> {
    if (
      !this.options.checkpoints.getCheckpoint(
        this.providerName,
        this.subscriptionKey,
      ) &&
      this.options.rpc.getCurrentSlot
    )
      await this.options.checkpoints.saveCheckpoint(
        this.providerName,
        this.subscriptionKey,
        await this.options.rpc.getCurrentSlot(),
      );
    try {
      await this.connect();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async updateTargets(wallets: readonly string[]): Promise<void> {
    this.wallets = [...new Set(wallets)].sort();
    this.subscriptionKey = this.keyFor(this.wallets);
    await this.writeSubscription();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stream?.cancel?.();
    this.stream?.end();
    await this.queue.onIdle();
  }

  async injectDisconnect(durationMs: number): Promise<void> {
    if (!Number.isFinite(durationMs) || durationMs <= 0)
      throw new Error("durationMs must be positive");
    this.faultResumeAtMs = Date.now() + durationMs;
    this.stream?.cancel?.();
    this.stream?.end();
    this.scheduleReconnect(new Error("FAULT_INJECTION_DISCONNECT"));
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const ClientConstructor = Client as unknown as new (
      endpoint: string,
      token: string | undefined,
      options: Record<string, number>,
    ) => { subscribe(): Promise<unknown> };
    const client = new ClientConstructor(
      this.options.endpoint,
      this.options.token,
      {
        "grpc.keepalive_time_ms": 10_000,
        "grpc.keepalive_timeout_ms": 5_000,
        "grpc.keepalive_permit_without_calls": 1,
      },
    );
    const stream = (await client.subscribe()) as unknown as WritableStream;
    if (this.stopped) {
      stream.end();
      return;
    }
    this.recoveryInProgress = true;
    const previousStream = this.stream;
    this.stream = stream;
    this.connected = true;
    previousStream?.cancel?.();
    previousStream?.end();
    stream.on("data", (update: unknown) => {
      if (this.stream !== stream || this.stopped) return;
      const received = this.options.clock.now();
      void this.queue
        .add(async () => {
          const envelope = mapYellowstoneTransaction(update, received);
          if (!envelope) return;
          await this.options.checkpoints.savePendingDelivery(
            this.providerName,
            this.subscriptionKey,
            envelope.slot,
            envelope.signature,
          );
          if (this.recoveryInProgress) {
            if (this.bufferedLive.length >= 10_000)
              throw new Error("RECOVERY_BUFFER_LIMIT_EXCEEDED");
            this.bufferedLive.push(envelope);
            return;
          }
          await this.deliver(envelope, "LIVE");
        })
        .catch((error: unknown) => this.scheduleReconnect(error));
    });
    stream.on("error", (error: unknown) => {
      if (this.stream === stream) this.scheduleReconnect(error);
    });
    stream.on(
      "end",
      () =>
        this.stream === stream &&
        this.scheduleReconnect(new Error("Yellowstone stream ended")),
    );
    stream.on(
      "close",
      () =>
        this.stream === stream &&
        this.scheduleReconnect(new Error("Yellowstone stream closed")),
    );
    await this.writeSubscription();
    if (!this.connected || this.stopped || this.stream !== stream) return;
    const connected = this.options.clock.now();
    if (this.disconnectedAt) {
      this.options.healthObserver?.notify({
        provider: this.providerName,
        type: "RECONNECTED",
        wallTimestampMs: connected.wallMs,
        monotonicTimestampNs: connected.monotonicNs,
        durationMs:
          Number(connected.monotonicNs - this.disconnectedAt.monotonicNs) /
          1_000_000,
      });
      this.disconnectedAt = undefined;
    } else {
      this.options.healthObserver?.notify({
        provider: this.providerName,
        type: "CONNECTED",
        wallTimestampMs: connected.wallMs,
        monotonicTimestampNs: connected.monotonicNs,
      });
    }
    await this.recoverGap();
  }

  private async writeSubscription(): Promise<void> {
    const stream = this.stream;
    if (!stream) throw new Error("Yellowstone stream is not connected");
    const request = {
      accounts: {},
      slots: {},
      transactions: {
        copyTargets: {
          vote: false,
          failed: false,
          signature: undefined,
          accountInclude: this.wallets,
          accountExclude: [],
          accountRequired: [],
        },
      },
      transactionsStatus: {},
      entry: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED,
      ping: undefined,
    };
    await new Promise<void>((resolve, reject) => {
      stream.write(request, (error?: Error | null) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  private scheduleReconnect(error: unknown): void {
    if (this.stopped || this.reconnectTimer) return;
    this.recoveryGeneration += 1;
    this.connected = false;
    this.recoveryInProgress = true;
    const disconnected = this.options.clock.now();
    this.disconnectedAt ??= disconnected;
    this.options.healthObserver?.notify({
      provider: this.providerName,
      type: "DISCONNECTED",
      wallTimestampMs: disconnected.wallMs,
      monotonicTimestampNs: disconnected.monotonicNs,
      details: {
        ...recoveryFailureEvidence(error),
      },
    });
    const min = this.options.minBackoffMs ?? 250;
    const max = this.options.maxBackoffMs ?? 30_000;
    const backoffDelay =
      Math.min(max, min * 2 ** this.reconnectAttempt) +
      Math.floor(Math.random() * min);
    const delay = Math.max(backoffDelay, this.faultResumeAtMs - Date.now());
    this.reconnectAttempt += 1;
    this.options.logger.warn(
      { error, delay, attempt: this.reconnectAttempt },
      "yellowstone_reconnect_scheduled",
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((connectError: unknown) =>
        this.scheduleReconnect(connectError),
      );
    }, delay);
  }

  private async recoverGap(): Promise<void> {
    const generation = this.recoveryGeneration;
    const recoveryStream = this.stream;
    let checkpoint = this.options.checkpoints.getCheckpoint(
      this.providerName,
      this.subscriptionKey,
    );
    for (const item of this.options.checkpoints.listPendingDeliveries(
      this.providerName,
      this.subscriptionKey,
    )) {
      if (!checkpoint || item.slot < checkpoint.slot) {
        await this.options.checkpoints.saveCheckpoint(
          this.providerName,
          this.subscriptionKey,
          item.slot,
        );
        checkpoint = { slot: item.slot };
      }
    }
    if (!checkpoint) {
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
    try {
      const recovered = await new GapRecovery(
        this.options.rpc,
        this.options.checkpoints,
      ).collect(this.providerName, this.subscriptionKey, this.wallets);
      if (this.stopped || recoveryStream !== this.stream) return;
      if (!(await this.flushRecovery(recovered, generation))) return;
      this.reconnectAttempt = 0;
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
      this.recoveryInProgress = true;
      this.scheduleReconnect(error);
      this.options.logger.error(
        { error, checkpointSlot: checkpoint.slot.toString() },
        "gap_recovery_failed",
      );
      const failed = this.options.clock.now();
      this.options.healthObserver?.notify({
        provider: this.providerName,
        type: "REPLAY_FAILED",
        wallTimestampMs: failed.wallMs,
        monotonicTimestampNs: failed.monotonicNs,
        durationMs:
          Number(failed.monotonicNs - started.monotonicNs) / 1_000_000,
        details: {
          ...recoveryFailureEvidence(error),
        },
      });
    }
  }

  private async flushRecovery(
    recovered: readonly StreamTransactionEnvelope[],
    generation: number,
  ): Promise<boolean> {
    return (
      (await this.queue.add(async () => {
        const current = () =>
          !this.stopped &&
          this.connected &&
          generation === this.recoveryGeneration;
        if (!current()) return false;
        const deliveries = [
          ...recovered.map((envelope) => ({
            envelope,
            type: "REPLAY" as const,
          })),
          ...this.bufferedLive.map((envelope) => ({
            envelope,
            type: "LIVE" as const,
          })),
        ].sort((left, right) =>
          left.envelope.slot < right.envelope.slot
            ? -1
            : left.envelope.slot > right.envelope.slot
              ? 1
              : 0,
        );
        for (const delivery of deliveries) {
          if (!current()) return false;
          await this.deliver(delivery.envelope, delivery.type);
        }
        if (!current()) return false;
        const last = deliveries.at(-1)?.envelope;
        if (last)
          await this.options.checkpoints.saveCheckpoint(
            this.providerName,
            this.subscriptionKey,
            last.slot,
            last.signature,
          );
        if (!current()) return false;
        this.bufferedLive.length = 0;
        this.recoveryInProgress = false;
        return true;
      })) === true
    );
  }

  private async deliver(
    envelope: StreamTransactionEnvelope,
    type: "LIVE" | "REPLAY",
  ): Promise<void> {
    if (this.stopped) return;
    if (this.dedup.has(envelope.signature)) {
      await this.options.checkpoints.deletePendingDelivery(
        this.providerName,
        this.subscriptionKey,
        envelope.signature,
      );
      return;
    }
    await this.onTransaction({ ...envelope, deliveryType: type });
    await this.options.checkpoints.deletePendingDelivery(
      this.providerName,
      this.subscriptionKey,
      envelope.signature,
    );
    this.dedup.accept(envelope.signature);
    if (!this.recoveryInProgress)
      await this.options.checkpoints.saveCheckpoint(
        this.providerName,
        this.subscriptionKey,
        envelope.slot,
        envelope.signature,
      );
  }

  private keyFor(wallets: readonly string[]): string {
    return createHash("sha256")
      .update(wallets.join(","))
      .digest("hex")
      .slice(0, 24);
  }

  private get providerName(): string {
    return this.options.providerName ?? "yellowstone";
  }
}
