import pino from "pino";
import { describe, expect, it } from "vitest";
import type {
  RpcProvider,
  StreamTransactionEnvelope,
} from "../../src/domain/ports.js";
import type { StreamCheckpointStore } from "../../src/stream/checkpoint-store.js";
import {
  SolanaWebSocketStreamProvider,
  type WebSocketClient,
} from "../../src/stream/solana-websocket-stream-provider.js";
import type { StreamHealthNotification } from "../../src/stream/stream-health.js";
import {
  LEADER_A,
  LEADER_B,
  MAINNET_FIXTURES,
} from "../fixtures/mainnet-fixtures.js";
import { envelope } from "../helpers/envelope.js";
import { TestClock } from "../helpers/test-clock.js";
import { RpcHydrationError } from "../../src/rpc/rpc-hydration-error.js";
import type { StreamDeliveryStore } from "../../src/stream/checkpoint-store.js";
import { StreamDeliveryDeferredError } from "../../src/stream/delivery-deferred-error.js";
import { testStore } from "../helpers/database.js";
import { SqliteDatabase } from "../../src/persistence/database.js";
import { StateStore } from "../../src/persistence/state-store.js";
import { createHash } from "node:crypto";

type Listener = (event: { readonly data?: unknown }) => void;

class FakeWebSocket implements WebSocketClient {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Listener[]>();
  private nextSubscription = 10;

  constructor(
    private readonly failSubscription = false,
    open = true,
  ) {
    if (!open) return;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    const request = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(request);
    queueMicrotask(() => {
      if (request.method === "logsSubscribe" && this.failSubscription) {
        this.message({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32_000, message: "not authorized" },
        });
        return;
      }
      this.message({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "logsSubscribe" ? this.nextSubscription++ : true,
      });
    });
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", {});
  }

  disconnect(): void {
    this.close();
  }

  notification(signature: string, slot: number, err: unknown = null): void {
    this.message({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        subscription: 10,
        result: {
          context: { slot },
          value: { signature, err, logs: ["Program log: swap"] },
        },
      },
    });
  }

  malformed(data: string): void {
    this.emit("message", { data });
  }

  private message(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  private emit(type: string, event: { readonly data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class MemoryCheckpoints implements StreamCheckpointStore {
  private pending = new Map<string, { slot: bigint; signature: string }>();
  async savePendingDelivery(
    provider: string,
    key: string,
    slot: bigint,
    signature: string,
  ) {
    this.pending.set(`${provider}:${key}:${signature}`, { slot, signature });
  }
  async deletePendingDelivery(
    provider: string,
    key: string,
    signature: string,
  ) {
    this.pending.delete(`${provider}:${key}:${signature}`);
  }
  listPendingDeliveries(provider: string, key: string) {
    return [...this.pending]
      .filter(([id]) => id.startsWith(`${provider}:${key}:`))
      .map(([, value]) => value);
  }

  private readonly values = new Map<
    string,
    { slot: bigint; signature?: string }
  >();

  async saveCheckpoint(
    provider: string,
    key: string,
    slot: bigint,
    signature?: string,
  ): Promise<void> {
    this.values.set(`${provider}:${key}`, {
      slot,
      ...(signature === undefined ? {} : { signature }),
    });
  }

  getCheckpoint(
    provider: string,
    key: string,
  ): { slot: bigint; signature?: string } | undefined {
    return this.values.get(`${provider}:${key}`);
  }

  get size(): number {
    return this.values.size;
  }
}

function rpcProvider(options?: {
  readonly live?: ReadonlyMap<string, StreamTransactionEnvelope>;
  readonly recovered?: () => readonly StreamTransactionEnvelope[];
  readonly hangGetTransaction?: boolean;
  readonly throwRecovery?: boolean;
}): RpcProvider {
  return {
    getTransaction: async (signature) => {
      if (options?.hangGetTransaction)
        return new Promise<StreamTransactionEnvelope | undefined>(
          () => undefined,
        );
      return options?.live?.get(signature);
    },
    getTransactionsForAddress: async () => {
      if (options?.throwRecovery) throw new Error("RPC_TIMEOUT");
      return options?.recovered?.() ?? [];
    },
    resolveAddressLookupTable: async () => [],
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function setup(options?: {
  readonly rpc?: RpcProvider;
  readonly checkpoints?: StreamDeliveryStore;
  readonly failSubscription?: boolean;
  readonly clock?: { now(): { wallMs: number; monotonicNs: bigint } };
  readonly hostCheckIntervalMs?: number;
  readonly transactionFetchDelaysMs?: readonly number[];
  readonly hangReconnectOpen?: boolean;
}) {
  const sockets: FakeWebSocket[] = [];
  const health: StreamHealthNotification[] = [];
  const provider = new SolanaWebSocketStreamProvider({
    providerName: "quicknode-websocket",
    url: "wss://redacted.invalid/redacted",
    clock: options?.clock ?? new TestClock(),
    ...(options?.hostCheckIntervalMs === undefined
      ? {}
      : { hostCheckIntervalMs: options.hostCheckIntervalMs }),
    logger: pino({ enabled: false }),
    checkpoints: options?.checkpoints ?? new MemoryCheckpoints(),
    rpc: options?.rpc ?? rpcProvider(),
    healthObserver: { notify: (event) => health.push(event) },
    minBackoffMs: 1,
    maxBackoffMs: 1,
    subscriptionTimeoutMs: 50,
    transactionFetchTimeoutMs: 5,
    ...(options?.transactionFetchDelaysMs === undefined
      ? { transactionFetchAttempts: 1, transactionFetchBackoffMs: 0 }
      : {
          transactionFetchDelaysMs: options.transactionFetchDelaysMs,
          transactionFetchSleep: async () => undefined,
        }),
    gapRecovery: {
      timeoutMs: 5,
      maxAttempts: 1,
      baseBackoffMs: 0,
      sleep: async () => undefined,
    },
    webSocketFactory: () => {
      const socket = new FakeWebSocket(
        options?.failSubscription,
        !(options?.hangReconnectOpen && sockets.length > 0),
      );
      sockets.push(socket);
      return socket;
    },
  });
  return { provider, sockets, health };
}

describe("SolanaWebSocketStreamProvider", () => {
  it("does not hydrate a notification that already proves on-chain failure", async () => {
    let calls = 0;
    const { provider, sockets, health } = setup({
      rpc: {
        ...rpcProvider(),
        getTransaction: async () => {
          calls++;
          return undefined;
        },
      },
    });
    const subscription = await provider.subscribe([LEADER_A], () => {
      throw new Error("must not deliver");
    });
    sockets[0]!.notification("failed-notification", 100, {
      InstructionError: [0, { Custom: 1 }],
    });
    await subscription.close();
    expect(calls).toBe(0);
    expect(health.some((event) => event.type === "DEGRADED")).toBe(false);
  });
  it("can close while a reconnect is waiting for the socket to open", async () => {
    const { provider, sockets } = setup({ hangReconnectOpen: true });
    const subscription = await provider.subscribe([LEADER_A], () => {});
    sockets[0]!.disconnect();
    await waitFor(() => sockets.length === 2);
    const result = await Promise.race([
      subscription.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 30)),
    ]);
    expect(result).toBe("closed");
  });
  it("does not report a clean close when pending delivery persistence fails", async () => {
    class FailingCheckpoints extends MemoryCheckpoints {
      override async savePendingDelivery(): Promise<void> {
        throw new Error("SQLITE_FULL");
      }
    }
    const { provider, sockets } = setup({
      checkpoints: new FailingCheckpoints(),
    });
    const subscription = await provider.subscribe([LEADER_A], () => {});
    sockets[0]!.notification("not-durable", 100);
    await expect(subscription.close()).rejects.toThrow(
      "STREAM_PENDING_PERSISTENCE_FAILED",
    );
  });
  it("persists a shutdown-deferred delivery across database reopen and acknowledges it once on replay", async () => {
    const { database, store, path } = testStore("ws-shutdown-");
    const transaction = envelope(MAINNET_FIXTURES.jupiterBuy);
    const rpc = rpcProvider({
      live: new Map([[transaction.signature, transaction]]),
    });
    const key = createHash("sha256")
      .update(LEADER_A)
      .digest("hex")
      .slice(0, 24);
    const first = setup({ checkpoints: store, rpc });
    const subscription = await first.provider.subscribe([LEADER_A], () => {
      throw new StreamDeliveryDeferredError();
    });
    first.sockets[0]!.notification(
      transaction.signature,
      Number(transaction.slot),
    );
    await subscription.close();
    expect(first.health.some((event) => event.type === "DEGRADED")).toBe(false);
    database.close();
    const reopened = new SqliteDatabase({
      path,
      migrationsDirectory: "migrations",
    });
    try {
      const restored = new StateStore(
        reopened,
        new TestClock(),
        store.riskPolicy,
      );
      expect(
        restored.listPendingDeliveries("quicknode-websocket", key),
      ).toEqual([{ signature: transaction.signature, slot: transaction.slot }]);
      const second = setup({ checkpoints: restored, rpc });
      const delivered: string[] = [];
      const restarted = await second.provider.subscribe([LEADER_A], (item) =>
        delivered.push(item.signature),
      );
      second.sockets[0]!.notification(
        transaction.signature,
        Number(transaction.slot),
      );
      await restarted.close();
      expect(delivered).toEqual([transaction.signature]);
      expect(
        restored.listPendingDeliveries("quicknode-websocket", key),
      ).toEqual([]);
    } finally {
      reopened.close();
    }
  });
  it("drains notifications received before close through business acknowledgement", async () => {
    const transaction = envelope(MAINNET_FIXTURES.jupiterBuy);
    const { provider, sockets } = setup({
      rpc: rpcProvider({
        live: new Map([[transaction.signature, transaction]]),
      }),
    });
    const delivered: string[] = [];
    const subscription = await provider.subscribe([LEADER_A], (item) =>
      delivered.push(item.signature),
    );
    sockets[0]!.notification(transaction.signature, Number(transaction.slot));
    await subscription.close();
    expect(delivered).toEqual([transaction.signature]);
  });
  it("treats a failed on-chain transaction as terminal without degrading the provider", async () => {
    let calls = 0;
    const { provider, sockets, health } = setup({
      transactionFetchDelaysMs: [0, 100, 250],
      rpc: {
        ...rpcProvider(),
        getTransaction: async () => {
          calls += 1;
          throw new RpcHydrationError("TRANSACTION_FAILED", "chain failure");
        },
      },
    });
    const delivered: string[] = [];
    const subscription = await provider.subscribe([LEADER_A], (item) =>
      delivered.push(item.signature),
    );
    sockets[0]!.notification("failed-chain", 100);
    await subscription.close();
    expect(health.filter((event) => event.type === "DEGRADED")).toEqual([]);
    expect(calls).toBe(1);
    expect(delivered).toEqual([]);
  });
  it("does not complete an obsolete replay after disconnect during acknowledgement", async () => {
    const transaction = {
      ...envelope(MAINNET_FIXTURES.jupiterBuy),
      slot: 101n,
    };
    const checkpoints = new MemoryCheckpoints();
    let acknowledge!: () => void;
    let delivered = false;
    const pending = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const { provider, sockets, health } = setup({
      checkpoints,
      rpc: {
        ...rpcProvider({ recovered: () => [transaction] }),
        getCurrentSlot: async () => 100n,
      },
    });
    const started = provider.subscribe([LEADER_A], async () => {
      delivered = true;
      await pending;
    });
    await waitFor(() => delivered);
    sockets[0]!.disconnect();
    acknowledge();
    const subscription = await started;
    try {
      expect(
        health.filter((event) => event.type === "REPLAY_COMPLETED"),
      ).toHaveLength(0);
    } finally {
      await subscription.close();
    }
  });

  it("seeds a recovery boundary before the first live notification", async () => {
    const transaction = {
      ...envelope(MAINNET_FIXTURES.jupiterBuy),
      slot: 101n,
    };
    const { provider } = setup({
      rpc: {
        ...rpcProvider({ recovered: () => [transaction] }),
        getCurrentSlot: async () => 100n,
      },
    });
    const delivered: string[] = [];
    const subscription = await provider.subscribe([LEADER_A], (item) => {
      delivered.push(item.signature);
    });
    try {
      expect(delivered).toEqual([transaction.signature]);
    } finally {
      await subscription.close();
    }
  });
  it("detects host scheduling gaps even without a WebSocket close event", async () => {
    let wallMs = 1000;
    const { provider, health } = setup({
      clock: {
        now: () => ({ wallMs, monotonicNs: BigInt(wallMs) * 1_000_000n }),
      },
      hostCheckIntervalMs: 5,
    });
    const subscription = await provider.subscribe([LEADER_A], () => undefined);
    try {
      wallMs += 61_000;
      await waitFor(() =>
        health.some((event) => event.details?.reason === "HOST_SCHEDULING_GAP"),
      );
    } finally {
      await subscription.close();
    }
  });

  it("retries an unacknowledged callback without losing it to delivery dedup", async () => {
    const transaction = envelope(MAINNET_FIXTURES.jupiterBuy);
    let attempts = 0;
    let acknowledged = 0;
    const checkpoints = new MemoryCheckpoints();
    const { provider, sockets, health } = setup({
      checkpoints,
      rpc: rpcProvider({
        live: new Map([[transaction.signature, transaction]]),
      }),
    });
    const subscription = await provider.subscribe([LEADER_A], async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("BUSINESS_WRITE_FAILED");
      acknowledged += 1;
    });
    try {
      sockets[0]!.notification(transaction.signature, Number(transaction.slot));
      await waitFor(() => acknowledged === 1);
      expect(attempts).toBe(2);
      expect(health.some((event) => event.type === "REPLAY_COMPLETED")).toBe(
        true,
      );
    } finally {
      await subscription.close();
    }
  });

  it("keeps a persisted missing notification blocked across restart and retries it", async () => {
    const checkpoints = new MemoryCheckpoints();
    const transaction = envelope(MAINNET_FIXTURES.jupiterBuy);
    const first = setup({ checkpoints, rpc: rpcProvider() });
    const subscription = await first.provider.subscribe(
      [LEADER_A],
      () => undefined,
    );
    first.sockets[0]!.notification(
      transaction.signature,
      Number(transaction.slot),
    );
    await waitFor(() =>
      first.health.some((event) => event.type === "REPLAY_FAILED"),
    );
    expect(
      first.health.some((event) => event.type === "REPLAY_COMPLETED"),
    ).toBe(false);
    await subscription.close();
    const second = setup({
      checkpoints,
      rpc: rpcProvider({
        live: new Map([[transaction.signature, transaction]]),
      }),
    });
    const delivered: string[] = [];
    const restarted = await second.provider.subscribe([LEADER_A], (item) => {
      delivered.push(item.signature);
    });
    try {
      expect(delivered).toEqual([transaction.signature]);
    } finally {
      await restarted.close();
    }
  });
  it("waits for the business acknowledgement before checkpointing live delivery", async () => {
    const checkpoints = new MemoryCheckpoints();
    const transaction = envelope(MAINNET_FIXTURES.jupiterBuy);
    let acknowledge!: () => void;
    const pending = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    let received = false;
    const { provider, sockets } = setup({
      checkpoints,
      rpc: rpcProvider({
        live: new Map([[transaction.signature, transaction]]),
      }),
    });
    const subscription = await provider.subscribe([LEADER_A], async () => {
      received = true;
      await pending;
    });
    try {
      sockets[0]!.notification(transaction.signature, Number(transaction.slot));
      await waitFor(() => received);
      expect(checkpoints.size).toBe(0);
    } finally {
      acknowledge();
      await subscription.close();
    }
    expect(checkpoints.size).toBe(1);
  });
  it("uses one confirmed logsSubscribe mentions filter per target wallet", async () => {
    const { provider, sockets } = setup();
    const subscription = await provider.subscribe(
      [LEADER_A, LEADER_B],
      () => undefined,
    );
    const requests = sockets[0]!.sent.filter(
      (request) => request.method === "logsSubscribe",
    );
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const params = request.params as [
        { mentions: string[] },
        { commitment: string },
      ];
      expect(params[0].mentions).toHaveLength(1);
      expect(params[1].commitment).toBe("confirmed");
    }
    await subscription.close();
  });

  it("hydrates and deduplicates duplicate log notifications", async () => {
    const transaction = envelope(MAINNET_FIXTURES.jupiterBuy);
    let calls = 0;
    const rpc = rpcProvider({
      live: new Map([[transaction.signature, transaction]]),
    });
    const countedRpc: RpcProvider = {
      ...rpc,
      getTransaction: async (signature) => {
        calls += 1;
        return rpc.getTransaction(signature);
      },
    };
    const { provider, sockets } = setup({ rpc: countedRpc });
    const delivered: StreamTransactionEnvelope[] = [];
    const subscription = await provider.subscribe([LEADER_A], (item) =>
      delivered.push(item),
    );
    sockets[0]!.notification(transaction.signature, Number(transaction.slot));
    sockets[0]!.notification(transaction.signature, Number(transaction.slot));
    await waitFor(() => delivered.length === 1);
    expect(calls).toBe(1);
    expect(delivered[0]?.deliveryType).toBe("LIVE");
    await subscription.close();
  });

  it("retries getTransaction result=null until success", async () => {
    const transaction = envelope(MAINNET_FIXTURES.jupiterBuy);
    let calls = 0;
    const rpc: RpcProvider = {
      ...rpcProvider(),
      getTransaction: async () => {
        calls += 1;
        return calls < 3 ? undefined : transaction;
      },
    };
    const { provider, sockets } = setup({
      rpc,
      transactionFetchDelaysMs: [0, 100, 250],
    });
    const delivered: StreamTransactionEnvelope[] = [];
    const subscription = await provider.subscribe([LEADER_A], (item) =>
      delivered.push(item),
    );
    sockets[0]!.notification(transaction.signature, Number(transaction.slot));
    await waitFor(() => delivered.length === 1);
    expect(calls).toBe(3);
    await subscription.close();
  });

  it("exhausts repeated null results with a classified failure", async () => {
    const transaction = envelope(MAINNET_FIXTURES.jupiterBuy);
    let calls = 0;
    const rpc: RpcProvider = {
      ...rpcProvider(),
      getTransaction: async () => {
        calls += 1;
        return undefined;
      },
    };
    const { provider, sockets, health } = setup({
      rpc,
      transactionFetchDelaysMs: [0, 100, 250],
    });
    const subscription = await provider.subscribe([LEADER_A], () => undefined);
    sockets[0]!.notification(transaction.signature, Number(transaction.slot));
    await waitFor(() =>
      health.some(
        (event) =>
          event.type === "DEGRADED" &&
          event.details?.reason === "TRANSACTION_NOT_YET_AVAILABLE",
      ),
    );
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(
      health.find(
        (event) =>
          event.type === "DEGRADED" &&
          event.details?.reason === "TRANSACTION_NOT_YET_AVAILABLE",
      )?.details,
    ).toMatchObject({
      signature: transaction.signature,
      attempt: 3,
      delay_ms: 250,
    });
    await subscription.close();
  });

  it("deduplicates a signature while its hydration is pending", async () => {
    const transaction = envelope(MAINNET_FIXTURES.jupiterBuy);
    let resolveTransaction:
      ((value: StreamTransactionEnvelope) => void) | undefined;
    let calls = 0;
    const pending = new Promise<StreamTransactionEnvelope>((resolve) => {
      resolveTransaction = resolve;
    });
    const rpc: RpcProvider = {
      ...rpcProvider(),
      getTransaction: async () => {
        calls += 1;
        return pending;
      },
    };
    const { provider, sockets } = setup({ rpc });
    const delivered: StreamTransactionEnvelope[] = [];
    const subscription = await provider.subscribe([LEADER_A], (item) =>
      delivered.push(item),
    );
    sockets[0]!.notification(transaction.signature, Number(transaction.slot));
    sockets[0]!.notification(transaction.signature, Number(transaction.slot));
    resolveTransaction?.(transaction);
    await waitFor(() => delivered.length === 1);
    expect(calls).toBe(1);
    await subscription.close();
  });

  it("reconnects and performs ascending RPC gap recovery", async () => {
    const live = envelope(MAINNET_FIXTURES.jupiterBuy);
    const recovered: StreamTransactionEnvelope = {
      ...envelope(MAINNET_FIXTURES.raydiumBuy),
      slot: live.slot + 1n,
    };
    let recoveryEnabled = false;
    const { provider, sockets, health } = setup({
      rpc: rpcProvider({
        live: new Map([[live.signature, live]]),
        recovered: () => (recoveryEnabled ? [recovered, live] : []),
      }),
    });
    const delivered: StreamTransactionEnvelope[] = [];
    const subscription = await provider.subscribe([LEADER_A], (item) =>
      delivered.push(item),
    );
    sockets[0]!.notification(live.signature, Number(live.slot));
    await waitFor(() => delivered.length === 1);
    recoveryEnabled = true;
    sockets[0]!.disconnect();
    await waitFor(() => sockets.length === 2);
    await waitFor(() => delivered.length === 2);
    expect(delivered.map((item) => item.signature)).toEqual([
      live.signature,
      recovered.signature,
    ]);
    expect(delivered[1]?.deliveryType).toBe("REPLAY");
    expect(health.some((event) => event.type === "RECONNECTED")).toBe(true);
    expect(health.some((event) => event.type === "REPLAY_COMPLETED")).toBe(
      true,
    );
    await subscription.close();
  });

  it("recovers from a persisted checkpoint after service restart", async () => {
    const checkpoints = new MemoryCheckpoints();
    const live = envelope(MAINNET_FIXTURES.jupiterBuy);
    const missed: StreamTransactionEnvelope = {
      ...envelope(MAINNET_FIXTURES.raydiumBuy),
      slot: live.slot + 1n,
    };
    const first = setup({
      checkpoints,
      rpc: rpcProvider({ live: new Map([[live.signature, live]]) }),
    });
    const firstSubscription = await first.provider.subscribe(
      [LEADER_A],
      () => undefined,
    );
    first.sockets[0]!.notification(live.signature, Number(live.slot));
    await waitFor(() => checkpoints.size === 1);
    await firstSubscription.close();

    const second = setup({
      checkpoints,
      rpc: rpcProvider({ recovered: () => [missed] }),
    });
    const replayed: StreamTransactionEnvelope[] = [];
    const secondSubscription = await second.provider.subscribe(
      [LEADER_A],
      (item) => replayed.push(item),
    );
    expect(replayed.map((item) => item.signature)).toContain(missed.signature);
    expect(replayed[0]?.deliveryType).toBe("REPLAY");
    await secondSubscription.close();
  });

  it("degrades safely on malformed events", async () => {
    const { provider, sockets, health } = setup();
    const subscription = await provider.subscribe([LEADER_A], () => undefined);
    sockets[0]!.malformed("{not-json");
    expect(health).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "DEGRADED",
          details: { reason: "INVALID_JSON" },
        }),
      ]),
    );
    await subscription.close();
  });

  it("times out transaction hydration without delivering an event", async () => {
    const transaction = envelope(MAINNET_FIXTURES.jupiterBuy);
    const { provider, sockets, health } = setup({
      rpc: rpcProvider({ hangGetTransaction: true }),
    });
    const delivered: StreamTransactionEnvelope[] = [];
    const subscription = await provider.subscribe([LEADER_A], (item) =>
      delivered.push(item),
    );
    sockets[0]!.notification(transaction.signature, Number(transaction.slot));
    await waitFor(() =>
      health.some(
        (event) =>
          event.type === "DEGRADED" && event.details?.reason === "RPC_TIMEOUT",
      ),
    );
    expect(delivered).toHaveLength(0);
    await subscription.close();
  });

  it("rejects a failed logsSubscribe request", async () => {
    const { provider } = setup({ failSubscription: true });
    await expect(
      provider.subscribe([LEADER_A], () => undefined),
    ).rejects.toThrow("WEBSOCKET_RPC_ERROR");
  });

  it("marks failed RPC gap recovery without inventing replay events", async () => {
    const checkpoints = new MemoryCheckpoints();
    const live = envelope(MAINNET_FIXTURES.jupiterBuy);
    const first = setup({
      checkpoints,
      rpc: rpcProvider({ live: new Map([[live.signature, live]]) }),
    });
    const firstSubscription = await first.provider.subscribe(
      [LEADER_A],
      () => undefined,
    );
    first.sockets[0]!.notification(live.signature, Number(live.slot));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await firstSubscription.close();

    const restarted = setup({
      checkpoints,
      rpc: rpcProvider({ throwRecovery: true }),
    });
    const delivered: StreamTransactionEnvelope[] = [];
    const subscription = await restarted.provider.subscribe(
      [LEADER_A],
      (item) => delivered.push(item),
    );
    expect(delivered).toHaveLength(0);
    expect(
      restarted.health.some((event) => event.type === "REPLAY_FAILED"),
    ).toBe(true);
    await subscription.close();
  });
});
