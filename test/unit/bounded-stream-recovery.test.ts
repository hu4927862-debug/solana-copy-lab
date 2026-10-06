import { expect, it } from "vitest";
import pino from "pino";
import { SolanaWebSocketStreamProvider } from "../../src/stream/solana-websocket-stream-provider.js";
import { GapRecovery } from "../../src/recovery/gap-recovery.js";
import { testStore } from "../helpers/database.js";
import { TestClock } from "../helpers/test-clock.js";
import { FaultWebSocket } from "../helpers/fault-websocket.js";
import type { RpcProvider } from "../../src/domain/ports.js";

it("aborts the active recovery request when its caller stops, without retry or checkpoint advance", async () => {
  const { database, store } = testStore("gap-cancel-");
  const controller = new AbortController();
  let calls = 0;
  let aborted = false;
  const rpc: RpcProvider = {
    getTransaction: async () => undefined,
    resolveAddressLookupTable: async () => [],
    getTransactionsForAddress: async (_wallet, options) => {
      calls++;
      return new Promise((_resolve, reject) =>
        options.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("CANCELLED"));
          },
          { once: true },
        ),
      );
    },
  };
  try {
    await store.saveCheckpoint("ws", "key", 100n);
    const result = new GapRecovery(rpc, store, {
      timeoutMs: 1000,
      signal: controller.signal,
    }).collect("ws", "key", ["leader"]);
    const checked = result.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await new Promise((r) => setTimeout(r, 5));
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
    await checked;
    expect(store.getCheckpoint("ws", "key")?.slot).toBe(100n);
  } finally {
    controller.abort();
    database.close();
  }
});

it("bounds a socket that never opens and records a terminal recovery state", async () => {
  const { database, store } = testStore("ws-open-timeout-");
  const logs: any[] = [];
  const logger = pino(
    { level: "info" },
    { write: (line) => logs.push(JSON.parse(line)) },
  );
  const rpc: RpcProvider = {
    getCurrentSlot: async () => 100n,
    getTransaction: async () => undefined,
    getTransactionsForAddress: async () => [],
    resolveAddressLookupTable: async () => [],
  };
  const provider = new SolanaWebSocketStreamProvider({
    url: "wss://fixture.invalid",
    clock: new TestClock(),
    logger,
    checkpoints: store,
    rpc,
    webSocketFactory: () => new FaultWebSocket(false),
    openingTimeoutMs: 10,
    recoveryPolicy: {
      version: "BOUNDED_REPLAY_V1",
      maxEpisodeMs: 30,
      maxAttempts: 2,
      maxBuffered: 10,
    },
  });
  try {
    const result = await Promise.race([
      provider
        .subscribe(["leader"], () => {})
        .then((s) => s.close().then(() => "opened"))
        .catch(() => "bounded"),
      new Promise((r) => setTimeout(() => r("hung"), 100)),
    ]);
    expect(result).toBe("bounded");
  } finally {
    database.close();
  }
});

it("drains notifications arriving during replay acknowledgement without an unnecessary reconnect", async () => {
  const { database, store } = testStore("ws-drain-arrival-");
  const logs: any[] = [];
  let socket!: FaultWebSocket;
  const seen: string[] = [];
  let scans = 0;
  const tx = (signature: string, slot: bigint) =>
    ({
      signature,
      slot,
      sourceTimestampMs: 1,
      sourceTimestampProvenance: "RPC_BLOCK_TIME",
      streamReceivedTimestampMs: 2,
      streamReceivedMonotonicNs: 2n,
      payload: {},
    }) as any;
  const rpc: RpcProvider = {
    getCurrentSlot: async () => 100n,
    getTransaction: async (signature) => tx(signature, 101n),
    resolveAddressLookupTable: async () => [],
    getTransactionsForAddress: async () => {
      scans++;
      return [tx("replayed", 100n)];
    },
  };
  const provider = new SolanaWebSocketStreamProvider({
    url: "wss://fixture.invalid",
    clock: new TestClock(),
    logger: pino(
      { level: "info" },
      { write: (line) => logs.push(JSON.parse(line)) },
    ),
    checkpoints: store,
    rpc,
    webSocketFactory: () => (socket = new FaultWebSocket()),
    minBackoffMs: 1,
    maxBackoffMs: 1,
    recoveryPolicy: {
      version: "BOUNDED_REPLAY_V1",
      maxEpisodeMs: 500,
      maxAttempts: 3,
      maxBuffered: 10,
    },
  });
  const sub = await provider.subscribe(["leader"], async (e) => {
    seen.push(e.signature);
    if (e.signature === "replayed") socket.notification("arriving", 101);
  });
  try {
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual(["replayed", "arriving"]);
    expect(scans).toBe(1);
    expect(logs.filter((e) => e.state === "READY")).toHaveLength(1);
  } finally {
    await sub.close();
    database.close();
  }
});

it("does not accept late scan completion from an obsolete generation", async () => {
  const { database, store } = testStore("ws-obsolete-");
  const logs: any[] = [];
  const sockets: FaultWebSocket[] = [];
  let scans = 0;
  let release!: (v: any[]) => void;
  const delivered: string[] = [];
  const provider = new SolanaWebSocketStreamProvider({
    url: "wss://fixture.invalid",
    clock: new TestClock(),
    logger: pino(
      { level: "info" },
      { write: (line) => logs.push(JSON.parse(line)) },
    ),
    checkpoints: store,
    minBackoffMs: 1,
    maxBackoffMs: 1,
    recoveryPolicy: {
      version: "BOUNDED_REPLAY_V1",
      maxEpisodeMs: 500,
      maxAttempts: 3,
      maxBuffered: 10,
    },
    webSocketFactory: () => {
      const s = new FaultWebSocket();
      sockets.push(s);
      return s;
    },
    rpc: {
      getCurrentSlot: async () => 100n,
      getTransaction: async () => undefined,
      resolveAddressLookupTable: async () => [],
      getTransactionsForAddress: async () => {
        if (++scans === 2) return new Promise((r) => (release = r));
        return [];
      },
    },
  });
  const sub = await provider.subscribe(["leader"], (e) =>
    delivered.push(e.signature),
  );
  try {
    sockets[0]!.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(scans).toBe(2);
    sockets[1]!.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(scans).toBe(3);
    release([{ signature: "obsolete", slot: 100n }]);
    await new Promise((r) => setTimeout(r, 5));
    expect(delivered).toEqual([]);
    expect(
      logs.filter((e) => e.state === "READY").map((e) => e.generation),
    ).toEqual([0, 2]);
  } finally {
    await sub.close();
    database.close();
  }
});

it("intake overflow stops and preserves previously accepted pending identities", async () => {
  const { database, store } = testStore("ws-overflow-");
  const logs: any[] = [];
  let socket!: FaultWebSocket;
  const provider = new SolanaWebSocketStreamProvider({
    url: "wss://fixture.invalid",
    clock: new TestClock(),
    logger: pino(
      { level: "info" },
      { write: (line) => logs.push(JSON.parse(line)) },
    ),
    checkpoints: store,
    recoveryPolicy: {
      version: "BOUNDED_REPLAY_V1",
      maxEpisodeMs: 500,
      maxAttempts: 3,
      maxBuffered: 2,
    },
    webSocketFactory: () => (socket = new FaultWebSocket()),
    rpc: {
      getCurrentSlot: async () => 100n,
      getTransaction: async () => new Promise(() => {}),
      resolveAddressLookupTable: async () => [],
      getTransactionsForAddress: async () => [],
    },
  });
  const sub = await provider.subscribe(["leader"], () => {});
  try {
    for (let i = 0; i < 5; i++) socket.notification("queued-" + i, 101 + i);
    await sub.close();
    expect(
      logs.some(
        (e) =>
          e.state === "FAILED" && e.reason === "STREAM_INTAKE_LIMIT_EXCEEDED",
      ),
    ).toBe(true);
    expect(
      logs.findLast((e) => e.msg === "websocket_stream_closed").streamPending,
    ).toBe(2);
  } finally {
    await sub.close();
    database.close();
  }
});

it("stops immediately on replay checkpoint persistence failure rather than retrying it as RPC", async () => {
  const { database, store } = testStore("ws-evidence-failure-");
  const logs: any[] = [];
  const sockets: FaultWebSocket[] = [];
  let scans = 0,
    failWrite = false;
  const checkpoints = new Proxy(store, {
    get(target, key) {
      if (key === "saveCheckpoint")
        return (...args: Parameters<typeof store.saveCheckpoint>) =>
          failWrite
            ? Promise.reject(Error("PRIVATE_STORAGE_ERROR"))
            : store.saveCheckpoint(...args);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const provider = new SolanaWebSocketStreamProvider({
    url: "wss://fixture.invalid",
    clock: new TestClock(),
    logger: pino(
      { level: "info" },
      { write: (line) => logs.push(JSON.parse(line)) },
    ),
    checkpoints,
    minBackoffMs: 1,
    maxBackoffMs: 1,
    recoveryPolicy: {
      version: "BOUNDED_REPLAY_V1",
      maxEpisodeMs: 500,
      maxAttempts: 3,
      maxBuffered: 10,
    },
    webSocketFactory: () => {
      const s = new FaultWebSocket();
      sockets.push(s);
      return s;
    },
    rpc: {
      getCurrentSlot: async () => 100n,
      getTransaction: async () => undefined,
      resolveAddressLookupTable: async () => [],
      getTransactionsForAddress: async () =>
        ++scans === 1 ? [] : [{ signature: "replay", slot: 100n } as any],
    },
  });
  const sub = await provider.subscribe(["leader"], () => {});
  try {
    failWrite = true;
    sockets[0]!.close();
    await new Promise((r) => setTimeout(r, 25));
    expect(logs.find((e) => e.state === "FAILED")?.reason).toBe(
      "STREAM_EVIDENCE_WRITE_FAILED",
    );
    expect(scans).toBe(2);
    expect(JSON.stringify(logs)).not.toContain("PRIVATE_STORAGE_ERROR");
  } finally {
    await sub.close();
    database.close();
  }
});
