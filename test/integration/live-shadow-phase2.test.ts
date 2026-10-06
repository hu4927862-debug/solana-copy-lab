import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CopyEngine } from "../../src/copy/copy-engine.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { ExecutionCoordinator } from "../../src/execution/execution-coordinator.js";
import { MockJupiterOrderProvider } from "../../src/execution/mock-jupiter-order-provider.js";
import { PaperTransactionSender } from "../../src/execution/paper-transaction-sender.js";
import { DualStreamCoordinator } from "../../src/stream/dual-stream-coordinator.js";
import { MockStreamProvider } from "../../src/stream/mock-stream-provider.js";
import { createLogger } from "../../src/telemetry/logger.js";
import { CaptureArchive } from "../../src/validation/capture-archive.js";
import { LiveEvaluator } from "../../src/validation/evaluator.js";
import { GroundTruthClassifier } from "../../src/validation/ground-truth.js";
import { LiveReportGenerator } from "../../src/validation/report-generator.js";
import { ShadowQuoteRecorder } from "../../src/validation/shadow-quote-recorder.js";
import { LiveShadowService } from "../../src/validation/live-shadow-service.js";
import { ValidationStore } from "../../src/validation/validation-store.js";
import {
  MAINNET_FIXTURES,
  FOLLOWER,
  LEADER_A,
} from "../fixtures/mainnet-fixtures.js";
import { envelope } from "../helpers/envelope.js";
import { TestClock } from "../helpers/test-clock.js";
import { testStore } from "../helpers/database.js";
import type { StreamTransactionEnvelope } from "../../src/domain/ports.js";

describe("Phase 2 live shadow pipeline", () => {
  it("does not acknowledge delivery after the intake deadline", async () => {
    const { database, store } = testStore("shutdown-cutoff-");
    const clock = new TestClock();
    const validation = new ValidationStore(database, clock, {
      primary: "primary",
    });
    let deliver!: (item: StreamTransactionEnvelope) => unknown;
    const streams = new DualStreamCoordinator({
      primary: {
        name: "primary",
        provider: {
          subscribe: async (_wallets, callback) => {
            deliver = callback;
            return { close: async () => {}, updateTargets: async () => {} };
          },
        },
      },
      receipts: validation,
    });
    const quotes = new ShadowQuoteRecorder(validation);
    const service = new LiveShadowService(
      streams,
      new TransactionNormalizer(clock),
      new SwapClassifier(),
      new GroundTruthClassifier(),
      new CopyEngine(),
      new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider()),
      ),
      store,
      validation,
      new CaptureArchive(mkdtempSync(resolve(tmpdir(), "shutdown-capture-"))),
      quotes,
      clock,
      createLogger("silent"),
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
    try {
      await service.start();
      service.setIntakeDeadline(0);
      await expect(
        Promise.resolve().then(() =>
          deliver(envelope(MAINNET_FIXTURES.jupiterBuy)),
        ),
      ).rejects.toThrow("STREAM_DELIVERY_DEFERRED");
      expect(store.count("follower_trades")).toBe(0);
    } finally {
      await service.stop();
      database.close();
    }
  });
  it("keeps the passive provider out of execution and persists one shadow copy", async () => {
    const { database, store } = testStore("live-shadow-");
    const clock = new TestClock();
    const validation = new ValidationStore(
      database,
      clock,
      { primary: "primary", secondary: "secondary" },
      createLogger("error"),
    );
    const primary = new MockStreamProvider();
    const secondary = new MockStreamProvider();
    const streams = new DualStreamCoordinator({
      primary: { name: "primary", provider: primary },
      secondary: { name: "secondary", provider: secondary },
      receipts: validation,
    });
    const recorder = new ShadowQuoteRecorder(validation);
    const sender = new PaperTransactionSender(
      new MockJupiterOrderProvider(),
      { results: new Map() },
      recorder,
    );
    const captureDirectory = mkdtempSync(resolve(tmpdir(), "capture-"));
    let accountingCompleteWhenResearchDispatched = false;
    const service = new LiveShadowService(
      streams,
      new TransactionNormalizer(clock),
      new SwapClassifier(),
      new GroundTruthClassifier(),
      new CopyEngine(),
      new ExecutionCoordinator(store, sender),
      store,
      validation,
      new CaptureArchive(captureDirectory),
      recorder,
      clock,
      createLogger("error"),
      "primary",
      [
        {
          leaderWallet: LEADER_A,
          followerWallet: FOLLOWER,
          copyRatioBps: 2_500,
          mode: "SHADOW",
        },
      ],
      {
        append: async () => {
          throw new Error("EVIDENCE_WRITE_FAILED");
        },
      },
      {
        enqueue: () => {
          accountingCompleteWhenResearchDispatched =
            (
              database.sqlite
                .prepare(
                  "SELECT COUNT(*) AS count FROM paper_fill_applications",
                )
                .get() as { count: number }
            ).count === 1;
          throw new Error("DELAYED_RESEARCH_DISPATCH_FAILED");
        },
        drain: async () => undefined,
      },
    );
    await service.start();
    const transaction = envelope(MAINNET_FIXTURES.jupiterBuy);
    secondary.emit(
      { ...transaction, streamReceivedMonotonicNs: 800_000_000n },
      [LEADER_A],
    );
    primary.emit({ ...transaction, streamReceivedMonotonicNs: 900_000_000n }, [
      LEADER_A,
    ]);
    await service.stop();
    expect(store.count("leader_trades")).toBe(1);
    expect(store.count("follower_trades")).toBe(1);
    expect(accountingCompleteWhenResearchDispatched).toBe(true);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM paper_fills")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM paper_fill_applications")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database.sqlite
        .prepare(
          `SELECT f.output_amount_raw AS output_raw,
                  f.fill_policy_version AS fill_policy,
                  a.quantity_after_raw AS applied_quantity,
                  a.realized_pnl_delta_raw AS realized_delta
           FROM paper_fills f
           JOIN paper_fill_applications a ON a.fill_id = f.id`,
        )
        .get(),
    ).toEqual({
      output_raw: "250000000",
      fill_policy: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
      applied_quantity: "250000000",
      realized_delta: "0",
    });
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM risk_decisions")
        .get(),
    ).toEqual({ count: 2 });
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM provider_receipts")
        .get(),
    ).toEqual({ count: 2 });
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM provider_event_comparisons WHERE status='MATCHED'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM jupiter_shadow_quotes")
        .get(),
    ).toEqual({ count: 1 });
    const capture = database.sqlite
      .prepare("SELECT capture_path AS path FROM live_validation_events")
      .get() as { path: string };
    expect(existsSync(capture.path)).toBe(true);
    database.close();
  });

  it.each(["none", "source-persisted"])(
    "resumes %s and deduplicates primary delivery",
    async (partial) => {
      const { database, store } = testStore("live-duplicate-");
      const clock = new TestClock();
      const validation = new ValidationStore(database, clock, {
        primary: "primary",
      });
      const primary = new MockStreamProvider();
      const streams = new DualStreamCoordinator({
        primary: { name: "primary", provider: primary },
        receipts: validation,
      });
      const recorder = new ShadowQuoteRecorder(validation);
      const sender = new PaperTransactionSender(
        new MockJupiterOrderProvider(),
        { results: new Map() },
        recorder,
      );
      const service = new LiveShadowService(
        streams,
        new TransactionNormalizer(clock),
        new SwapClassifier(),
        new GroundTruthClassifier(),
        new CopyEngine(),
        new ExecutionCoordinator(store, sender),
        store,
        validation,
        new CaptureArchive(
          mkdtempSync(resolve(tmpdir(), "duplicate-capture-")),
        ),
        recorder,
        clock,
        createLogger("error"),
        "primary",
        [
          {
            leaderWallet: LEADER_A,
            followerWallet: FOLLOWER,
            copyRatioBps: 10_000,
            mode: "SHADOW",
          },
        ],
      );
      await service.start();
      const transaction = envelope(MAINNET_FIXTURES.jupiterBuy);
      if (partial === "source-persisted") {
        const classified = new SwapClassifier().classify(
          new TransactionNormalizer(clock).normalize(transaction),
          LEADER_A,
        );
        if (!classified.accepted) throw new Error(classified.code);
        await store.saveLeaderTrade(classified.event);
      }
      primary.emit(transaction, [LEADER_A]);
      primary.emit({ ...transaction, deliveryType: "REPLAY" }, [LEADER_A]);
      await service.stop();
      expect(store.count("follower_trades")).toBe(1);
      expect(
        database.sqlite
          .prepare(
            "SELECT is_duplicate AS duplicate FROM live_validation_events",
          )
          .get(),
      ).toEqual({ duplicate: 1 });
      database.close();
    },
  );
});

describe("Phase 2 reports", () => {
  it("generates all required reports and queues unsupported observations", async () => {
    const { database } = testStore("live-reports-");
    const clock = new TestClock();
    const validation = new ValidationStore(database, clock, {
      primary: "primary",
    });
    await validation.saveValidation({
      id: "validation-unsupported",
      signature: "signature-unsupported-111111111111111111111111111111111111",
      eventIndex: 0,
      slot: 1n,
      leader: LEADER_A,
      primaryProvider: "primary",
      programIds: ["Unknown111111111111111111111111111111111"],
      systemClassification: "UNSUPPORTED",
      groundTruth: {
        classification: "UNSUPPORTED",
        source: "AUTO_RULE",
        reviewReason: "UNSUPPORTED",
      },
      balanceDeltas: [],
      classifierEvidence: [],
      skipReason: "UNSUPPORTED_TOKEN_2022",
      capturePath: "/tmp/evidence.json.gz",
      isDuplicate: false,
      createdAtMs: clock.now().wallMs,
    });
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM review_queue")
        .get(),
    ).toEqual({ count: 1 });
    const directory = mkdtempSync(resolve(tmpdir(), "reports-"));
    await new LiveReportGenerator(new LiveEvaluator(database), directory, {
      streamProvider: "QUICKNODE_WEBSOCKET",
    }).generate();
    for (const name of [
      "live-shadow-summary.json",
      "live-shadow-summary.md",
      "provider-latency.json",
      "dex-accuracy.json",
      "false-positives.json",
      "false-negatives.json",
      "jupiter-latency.json",
      "recovery-tests.json",
    ])
      expect(existsSync(resolve(directory, name))).toBe(true);
    expect(
      JSON.parse(
        readFileSync(resolve(directory, "live-shadow-summary.json"), "utf8"),
      ),
    ).toEqual(
      expect.objectContaining({ stream_provider: "QUICKNODE_WEBSOCKET" }),
    );
    expect(
      JSON.parse(
        readFileSync(resolve(directory, "provider-latency.json"), "utf8"),
      ),
    ).toEqual(
      expect.objectContaining({ status: "NOT_AVAILABLE_SINGLE_PROVIDER" }),
    );
    database.close();
  });
});
