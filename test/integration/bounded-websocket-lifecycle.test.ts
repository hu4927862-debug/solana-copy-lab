// @ts-expect-error Production supervisor is a native ESM script without a declaration.
import { createRecoveryMonitor } from "../../scripts/lib/bounded-recovery-supervision.mjs";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { it, expect, vi } from "vitest";
import pino from "pino";
import { SolanaWebSocketStreamProvider } from "../../src/stream/solana-websocket-stream-provider.js";
import { DualStreamCoordinator } from "../../src/stream/dual-stream-coordinator.js";
import { StateStore } from "../../src/persistence/state-store.js";
import { CopyEngine } from "../../src/copy/copy-engine.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { ExecutionCoordinator } from "../../src/execution/execution-coordinator.js";
import { MockJupiterOrderProvider } from "../../src/execution/mock-jupiter-order-provider.js";
import { PaperTransactionSender } from "../../src/execution/paper-transaction-sender.js";
import { CaptureArchive } from "../../src/validation/capture-archive.js";
import { GroundTruthClassifier } from "../../src/validation/ground-truth.js";
import { ShadowQuoteRecorder } from "../../src/validation/shadow-quote-recorder.js";
import { LiveShadowService } from "../../src/validation/live-shadow-service.js";
import { ValidationStore } from "../../src/validation/validation-store.js";
import { RuntimeStopController } from "../../src/app/runtime-stop.js";
import { EventEmitter } from "node:events";
import {
  MAINNET_FIXTURES,
  LEADER_A,
  FOLLOWER,
  TOKEN_MINT,
} from "../fixtures/mainnet-fixtures.js";
import { envelope } from "../helpers/envelope.js";
import { TestClock } from "../helpers/test-clock.js";
import { testStore, TEST_RISK_POLICY } from "../helpers/database.js";
import { FaultWebSocket } from "../helpers/fault-websocket.js";
import type { StreamTransactionEnvelope } from "../../src/domain/ports.js";

// All wire events, RPC results and quotes are isolated fixtures. Real provider,
// service, risk, sender, accounting, persistent delivery and drain interfaces.
it.each(["fresh", "stale", "scan-failure", "SIGTERM", "deadline"] as const)(
  "preserves a nonempty lifecycle during %s recovery",
  async (scenario) => {
    const policy = {
      ...TEST_RISK_POLICY,
      maxBuyPriceImpactPctByQuoteMint: { SOL_NATIVE: "1.25" },
      maxSellPriceImpactPctByQuoteMint: { SOL_NATIVE: "2.50" },
    };
    const { database } = testStore("bounded-lifecycle-", policy);
    let now = 1_730_000_000_500;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = new StateStore(
      database,
      { now: () => ({ wallMs: now, monotonicNs: process.hrtime.bigint() }) },
      policy,
    );
    const clock = new TestClock();
    const logs: any[] = [];
    const supervision = createRecoveryMonitor({
      version: "BOUNDED_REPLAY_V1",
      provider: "solana-websocket",
      targetCount: 1,
      subscriptionKey: createHash("sha256")
        .update(LEADER_A)
        .digest("hex")
        .slice(0, 24),
      maxEpisodeMs: 1500,
      maxEpisodes: 4,
      maxTotalRecoveryMs: 3000,
    });
    const logger = pino(
      { level: "info" },
      {
        write: (line) => {
          const e = JSON.parse(line);
          logs.push(e);
          supervision.observe(e);
        },
      },
    );
    const events = new EventEmitter();
    const stop = new RuntimeStopController(events);
    const buy = envelope(MAINNET_FIXTURES.jupiterBuy),
      sell = envelope(MAINNET_FIXTURES.fullSell);
    let scans = 0,
      release!: (items: readonly StreamTransactionEnvelope[]) => void,
      scanSignal: AbortSignal | undefined;
    const sockets: FaultWebSocket[] = [];
    const provider = new SolanaWebSocketStreamProvider({
      url: "wss://fixture.invalid",
      clock,
      logger,
      checkpoints: store,
      signal: stop.signal,
      recoveryPolicy: {
        version: "BOUNDED_REPLAY_V1",
        maxEpisodeMs: 1000,
        maxAttempts: 3,
        maxBuffered: 100,
      },
      minBackoffMs: 1,
      maxBackoffMs: 1,
      gapRecovery: { maxAttempts: 1 },
      webSocketFactory: () => {
        const s = new FaultWebSocket();
        sockets.push(s);
        return s;
      },
      rpc: {
        getCurrentSlot: async () => sell.slot + 1n,
        resolveAddressLookupTable: async () => [],
        getTransaction: async (signature) =>
          signature === buy.signature ? buy : sell,
        getTransactionsForAddress: async (_wallet, options) => {
          scans++;
          if (scans === 1) return [];
          scanSignal = options.signal;
          if (scenario === "scan-failure") throw Error("ISOLATED_SCAN_FAILURE");
          return new Promise((r) => {
            release = r;
          });
        },
      },
    });
    const validation = new ValidationStore(
      database,
      clock,
      { primary: "primary" },
      logger,
    );
    const streams = new DualStreamCoordinator({
      primary: { name: "primary", provider },
      receipts: validation,
    });
    const recorder = new ShadowQuoteRecorder(validation),
      quotes = new MockJupiterOrderProvider();
    const service = new LiveShadowService(
      streams,
      new TransactionNormalizer(clock),
      new SwapClassifier(),
      new GroundTruthClassifier(),
      new CopyEngine(),
      new ExecutionCoordinator(
        store,
        new PaperTransactionSender(quotes, { results: new Map() }, recorder),
      ),
      store,
      validation,
      new CaptureArchive(mkdtempSync(resolve(tmpdir(), "bounded-capture-"))),
      recorder,
      clock,
      logger,
      "primary",
      [
        {
          leaderWallet: LEADER_A,
          followerWallet: FOLLOWER,
          copyRatioBps: 1000,
          mode: "SHADOW",
        },
      ],
    );
    const position = () =>
      store.getFollowerPosition(FOLLOWER, LEADER_A, TOKEN_MINT, "SOL_NATIVE");
    try {
      await service.start();
      sockets[0]!.notification(buy.signature, Number(buy.slot));
      await vi.waitFor(() => expect(position()?.rawAmount).toBe(100_000_000n));
      const checkpoint = store.getCheckpoint(
        "solana-websocket",
        logs.find((e) => e.state === "READY").subscriptionKey,
      );
      sockets[0]!.close(
        1006,
        "fixture disconnect https://secret.invalid/?api-key=DO_NOT_LOG",
      );
      await vi.waitFor(() => expect(scans).toBeGreaterThan(1));
      expect(position()?.rawAmount).toBe(100_000_000n);
      expect(quotes.requests).toHaveLength(1);
      expect(logs.filter((e) => e.state === "READY")).toHaveLength(1); // CONNECTED and subscription ACK do not release HOLD.
      if (scenario === "scan-failure") {
        await vi.waitFor(() =>
          expect(logs.some((e) => e.state === "FAILED")).toBe(true),
        );
        expect(
          store.getCheckpoint("solana-websocket", logs[0].subscriptionKey),
        ).toEqual(checkpoint);
        expect(position()?.rawAmount).toBe(100_000_000n);
        expect(quotes.requests).toHaveLength(1);
      } else if (scenario === "SIGTERM" || scenario === "deadline") {
        // Durable live SELL arrives while the independent historical scan is blocked.
        sockets.at(-1)!.notification(sell.signature, Number(sell.slot));
        await vi.waitFor(() =>
          expect(
            store.listPendingDeliveries(
              "solana-websocket",
              logs.find((e) => e.state === "READY").subscriptionKey,
            ),
          ).toHaveLength(1),
        );
        if (scenario === "SIGTERM") events.emit("SIGTERM");
        else stop.setDeadline(now + 5);
        await stop.wait();
        await service.stop();
        expect(scanSignal?.aborted).toBe(true);
        release([buy, sell]);
        await new Promise((r) => setTimeout(r, 5));
        expect(position()?.rawAmount).toBe(100_000_000n);
        expect(quotes.requests).toHaveLength(1);
        expect(logs.filter((e) => e.state === "READY")).toHaveLength(1);
        expect(
          logs.findLast((e) => e.msg === "websocket_stream_closed"),
        ).toMatchObject({
          streamPending: 1,
          disposition: "PERSISTED_FOR_REPLAY",
        });
      } else {
        if (scenario === "stale") now += 61_000;
        release([buy, buy, sell, sell]);
        await vi.waitFor(() =>
          expect(logs.filter((e) => e.state === "READY")).toHaveLength(2),
        );
        sockets.at(-1)!.notification(sell.signature, Number(sell.slot));
        await new Promise((r) => setTimeout(r, 5));
        expect(quotes.requests).toHaveLength(scenario === "fresh" ? 2 : 1);
        expect(position()?.rawAmount).toBe(
          scenario === "fresh" ? 0n : 100_000_000n,
        );
        expect(store.count("leader_trades")).toBe(2);
        const source = database.sqlite
          .prepare(
            "SELECT source_timestamp_ms AS source FROM leader_trades WHERE signature=?",
          )
          .get(sell.signature) as { source: number };
        expect(source.source).toBe(sell.sourceTimestampMs);
      }
      expect(JSON.stringify(logs)).not.toContain("DO_NOT_LOG");
      expect(supervision.recovered()).toBe(
        scenario === "fresh" || scenario === "stale",
      );
      if (scenario === "fresh" || scenario === "stale")
        expect(supervision.snapshot().failure).toBeNull();
    } finally {
      stop.request("TEST_FINISHED");
      await service.stop();
      stop.dispose();
      const output = process.env.V6_OFFLINE_RECOVERY_EVIDENCE_DIR;
      if (output) {
        const allowed =
          resolve("reports/v6-websocket-recovery-2026-09-11/evidence") + "/";
        if (!resolve(output).startsWith(allowed))
          throw Error("INVALID_OFFLINE_EVIDENCE_DIRECTORY");
        mkdirSync(output, { recursive: true });
        writeFileSync(
          resolve(output, scenario + ".json"),
          JSON.stringify(
            {
              scenario,
              fixtureOnly: true,
              networkCalls: false,
              sourceTimestampMs: sell.sourceTimestampMs,
              nowMs: now,
              quoteRequestCount: quotes.requests.length,
              position: position(),
              supervision: supervision.snapshot(),
              logs,
            },
            (_k, v) => (typeof v === "bigint" ? v.toString() : v),
            2,
          ) + "\n",
        );
      }
      database.close();
      vi.restoreAllMocks();
    }
  },
);
