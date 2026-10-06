import { describe, it, expect, vi } from "vitest";
import { testStore, TEST_RISK_POLICY } from "../helpers/database.js";
import { TestClock } from "../helpers/test-clock.js";
import { envelope } from "../helpers/envelope.js";
import {
  MAINNET_FIXTURES,
  LEADER_A,
  FOLLOWER,
  TOKEN_MINT,
} from "../fixtures/mainnet-fixtures.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import { CopyEngine } from "../../src/copy/copy-engine.js";
import { ExecutionCoordinator } from "../../src/execution/execution-coordinator.js";
import { PaperTransactionSender } from "../../src/execution/paper-transaction-sender.js";
import { MockJupiterOrderProvider } from "../../src/execution/mock-jupiter-order-provider.js";
import { AutomaticExitRecovery } from "../../src/recovery/automatic-exit-recovery.js";
import { SqliteDatabase } from "../../src/persistence/database.js";
import { StateStore } from "../../src/persistence/state-store.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { startAutomaticExitRecovery } from "../../src/recovery/automatic-exit-scheduler.js";
import { JupiterOrderAdapter } from "../../src/execution/jupiter-order-adapter.js";
import { createIsolatedJupiterFetch } from "../../src/network/isolated-jupiter-fetch.js";
import { createIsolatedResolver } from "../../src/network/v6-isolated-dns.js";

async function scenario() {
  const policy = {
    ...TEST_RISK_POLICY,
    maxSellPriceImpactPctByQuoteMint: { SOL_NATIVE: "2.50" },
  };
  const fixture = testStore("exit-fault-", policy);
  const control = { now: 1_730_000_000_500, impact: "-3", fail: false };
  vi.spyOn(Date, "now").mockImplementation(() => control.now);
  const provider = new MockJupiterOrderProvider();
  const sender = new PaperTransactionSender({
    getOrder: async (request) => {
      if (control.fail) throw Error("network timeout");
      return {
        ...(await provider.getOrder(request)),
        priceImpactPct: request.inputMint === TOKEN_MINT ? control.impact : "0",
      };
    },
  });
  const recovery = new AutomaticExitRecovery(
    fixture.store,
    sender,
    () => control.now,
  );
  recovery.enableFresh();
  await fixture.store.upsertWallet(LEADER_A, "LEADER", 1000);
  await fixture.store.upsertWallet(FOLLOWER, "FOLLOWER");
  const coordinator = new ExecutionCoordinator(fixture.store, sender);
  const classify = (raw: typeof MAINNET_FIXTURES.jupiterBuy) => {
    const c = new SwapClassifier().classify(
      new TransactionNormalizer(new TestClock()).normalize(envelope(raw)),
      LEADER_A,
    );
    if (!c.accepted) throw Error(c.code);
    return c.event;
  };
  const buy = classify(MAINNET_FIXTURES.jupiterBuy),
    sell = classify(MAINNET_FIXTURES.fullSell);
  const execute = async (event: typeof buy) => {
    await fixture.store.saveLeaderTrade(event);
    const intent = new CopyEngine().decide(
      event,
      { followerWallet: FOLLOWER, copyRatioBps: 1000, mode: "PAPER" },
      fixture.store.getFollowerPosition(
        FOLLOWER,
        LEADER_A,
        TOKEN_MINT,
        "SOL_NATIVE",
      ),
    );
    await coordinator.execute(intent);
    return intent;
  };
  await execute(buy);
  const intent = await execute(sell);
  return {
    ...fixture,
    policy,
    control,
    provider,
    sender,
    recovery,
    execute,
    buy,
    sell,
    intent,
    close: () => {
      fixture.database.close();
      vi.restoreAllMocks();
    },
  };
}

describe("automatic exit recovery", () => {
  it("production scheduled recovery stop cancels DNS work through sender and drains", async () => {
    const s = await scenario();
    const signals: AbortSignal[] = [];
    let began!: () => void;
    const started = new Promise<void>((r) => {
      began = r;
    });
    const resolver = createIsolatedResolver({
      query: async (_host, _type, signal) => {
        signals.push(signal);
        began();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    });
    const transport = createIsolatedJupiterFetch({ resolver });
    const sender = new PaperTransactionSender(
      new JupiterOrderAdapter("DUMMY", transport),
    );
    let scheduler: ReturnType<typeof startAutomaticExitRecovery> | undefined;
    try {
      s.control.now += 5000;
      scheduler = startAutomaticExitRecovery(s.store, sender, () => {
        throw Error("scheduler-error");
      });
      await started;
      await scheduler.stop();
      expect(signals.length).toBe(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(s.recovery.statuses()[0]?.state).not.toBe("COMMITTING");
      expect(
        s.store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          "SOL_NATIVE",
        ),
      ).toMatchObject({ rawAmount: 100_000_000n, reservedRawAmount: 0n });
    } finally {
      await scheduler?.stop();
      await transport.close();
      s.close();
    }
  });
  it("tracks a timed-out non-cooperative provider until settlement and refuses clean drain", async () => {
    const s = await scenario();
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let finish!: () => void;
      const sender = {
        mode: "PAPER" as const,
        lookup: async () => undefined,
        send: () =>
          new Promise<Awaited<ReturnType<PaperTransactionSender["send"]>>>(
            (r) => {
              finish = () =>
                r({
                  executionKey: s.intent.executionKey,
                  state: "FAILED",
                  executedTokenRaw: 0n,
                  executedQuoteRaw: 0n,
                });
            },
          ),
      };
      const recovery = new AutomaticExitRecovery(
        s.store,
        sender,
        () => s.control.now,
      );
      s.control.now += 5000;
      const tick = recovery.tick();
      await vi.advanceTimersByTimeAsync(3001);
      await tick;
      expect(recovery.pendingQuoteCount).toBe(1);
      const drain = expect(recovery.stop(50)).rejects.toThrow(
        "EXIT_QUOTE_DRAIN_TIMEOUT",
      );
      await vi.advanceTimersByTimeAsync(51);
      await drain;
      const events = recovery.events();
      finish();
      await vi.advanceTimersByTimeAsync(0);
      await recovery.stop();
      expect(recovery.pendingQuoteCount).toBe(0);
      expect(recovery.events()).toEqual(events);
    } finally {
      vi.useRealTimers();
      s.close();
    }
  });
  it("late COMMITTING finalization cannot overwrite completion after a new OPEN", async () => {
    const s = await scenario();
    let second: SqliteDatabase | undefined;
    try {
      s.control.impact = "-1";
      s.control.now += 5000;
      await expect(
        new AutomaticExitRecovery(
          s.store,
          s.sender,
          () => s.control.now,
          (p) => {
            if (p === "AFTER_ACCEPT") throw Error("persisted");
          },
        ).tick(),
      ).rejects.toThrow("persisted");
      let release!: () => void, arrived!: () => void;
      const paused = new Promise<void>((r) => {
        arrived = r;
      });
      const resume = new Promise<void>((r) => {
        release = r;
      });
      const late = new AutomaticExitRecovery(
        s.store,
        s.sender,
        () => s.control.now,
        async (p) => {
          if (p === "AFTER_APPLY") {
            arrived();
            await resume;
          }
        },
      ).tick();
      await paused;
      second = new SqliteDatabase({
        path: s.path,
        migrationsDirectory: resolve("migrations"),
      });
      const other = new AutomaticExitRecovery(
        new StateStore(second, new TestClock(), s.policy),
        s.sender,
        () => s.control.now,
      );
      await other.tick();
      await s.execute({ ...s.buy, id: "reopened", signature: "reopened" });
      const before = other.events();
      release();
      await late;
      expect(other.statuses()).toMatchObject([
        { state: "COMPLETED", reason: "PAPER_CLOSE_APPLIED" },
      ]);
      expect(other.events()).toEqual(before);
      expect(
        s.store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          "SOL_NATIVE",
        )?.rawAmount,
      ).toBe(100_000_000n);
    } finally {
      second?.close();
      s.close();
    }
  });
  it("times out a hanging quote and discards its late result", async () => {
    const s = await scenario();
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let finish:
        | ((r: Awaited<ReturnType<PaperTransactionSender["send"]>>) => void)
        | undefined;
      const hanging = {
        mode: "PAPER" as const,
        lookup: async () => undefined,
        send: () =>
          new Promise<Awaited<ReturnType<PaperTransactionSender["send"]>>>(
            (r) => {
              finish = r;
            },
          ),
      };
      const recovery = new AutomaticExitRecovery(
        s.store,
        hanging,
        () => s.control.now,
      );
      s.control.now += 5000;
      const ticking = recovery.tick();
      await vi.advanceTimersByTimeAsync(3001);
      await ticking;
      expect(recovery.statuses()).toMatchObject([
        { state: "WAITING", reason: "QUOTE_TIMEOUT" },
      ]);
      finish?.({
        executionKey: s.intent.executionKey,
        state: "FAILED",
        executedTokenRaw: 0n,
        executedQuoteRaw: 0n,
      });
      await Promise.resolve();
      expect(
        s.store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          "SOL_NATIVE",
        ),
      ).toMatchObject({ rawAmount: 100_000_000n, reservedRawAmount: 0n });
    } finally {
      vi.useRealTimers();
      s.close();
    }
  });
  it("does not duplicate the goal on repeated source delivery", async () => {
    const s = await scenario();
    try {
      await s.execute(s.sell);
      await s.execute(s.sell);
      expect(s.recovery.statuses()).toHaveLength(1);
      expect(
        s.provider.requests.filter((x) => x.inputMint === TOKEN_MINT),
      ).toHaveLength(1);
    } finally {
      s.close();
    }
  });
  it("does not block another leader buying the same token", async () => {
    const s = await scenario();
    try {
      const other = "another-test-leader";
      await s.store.upsertWallet(other, "LEADER", 1000);
      const event = {
        ...s.buy,
        id: "other-buy",
        signature: "other-buy",
        leaderWallet: other,
      };
      await s.store.saveLeaderTrade(event);
      const intent = new CopyEngine().decide(event, {
        followerWallet: FOLLOWER,
        copyRatioBps: 1000,
        mode: "PAPER",
      });
      await new ExecutionCoordinator(s.store, s.sender).execute(intent);
      expect(
        s.store.getFollowerPosition(FOLLOWER, other, TOKEN_MINT, "SOL_NATIVE")
          ?.rawAmount,
      ).toBe(100_000_000n);
      expect(
        s.store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          "SOL_NATIVE",
        )?.rawAmount,
      ).toBe(100_000_000n);
    } finally {
      s.close();
    }
  });
  it("uses SQLite claims across independent connections", async () => {
    const s = await scenario();
    let db: SqliteDatabase | undefined;
    try {
      db = new SqliteDatabase({
        path: s.path,
        migrationsDirectory: resolve("migrations"),
      });
      const other = new AutomaticExitRecovery(
        new StateStore(db, new TestClock(), s.policy),
        s.sender,
        () => s.control.now,
      );
      s.control.impact = "-1";
      s.control.now += 5000;
      await Promise.all([s.recovery.tick(), other.tick()]);
      expect(s.recovery.statuses()).toMatchObject([
        { state: "COMPLETED", attempts: 1 },
      ]);
      expect(
        s.provider.requests.filter((x) => x.inputMint === TOKEN_MINT),
      ).toHaveLength(2);
    } finally {
      db?.close();
      s.close();
    }
  });
  it("bounds persistent impact rejection to three attempts and preserves remainder", async () => {
    const s = await scenario();
    try {
      for (const advance of [5000, 10000, 20000, 40000]) {
        s.control.now += advance;
        await s.recovery.tick();
      }
      expect(s.recovery.statuses()).toMatchObject([
        { state: "ATTENTION", attempts: 3, reason: "PRICE_IMPACT_TOO_HIGH" },
      ]);
      expect(
        s.store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          "SOL_NATIVE",
        ),
      ).toMatchObject({ rawAmount: 100_000_000n, reservedRawAmount: 0n });
      expect(s.recovery.events().length).toBe(7);
    } finally {
      s.close();
    }
  });
  it("rejects stale authorization without making a quote request", async () => {
    const s = await scenario();
    try {
      const count = s.provider.requests.length;
      s.control.now += 61000;
      await s.recovery.tick();
      expect(s.recovery.statuses()).toMatchObject([
        {
          state: "ATTENTION",
          attempts: 0,
          reason: "SOURCE_AUTHORIZATION_EXPIRED",
        },
      ]);
      expect(s.provider.requests.length).toBe(count);
    } finally {
      s.close();
    }
  });
  it("blocks additional BUY exposure while an exit needs attention", async () => {
    const s = await scenario();
    try {
      s.control.now += 61000;
      await s.recovery.tick();
      const buy = await s.execute({
        ...s.buy,
        id: "another-buy",
        signature: "another-buy",
      });
      expect(s.store.followerTradeState(buy.executionKey)).toBe("SKIPPED");
      expect(
        s.store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          "SOL_NATIVE",
        ),
      ).toMatchObject({ rawAmount: 100_000_000n, reservedRawAmount: 0n });
    } finally {
      s.close();
    }
  });
  it("preserves a partial exit and escalates changed remainder without overselling", async () => {
    const s = await scenario();
    try {
      s.control.impact = "-1";
      await s.execute({
        ...s.sell,
        id: "partial-sell",
        signature: "partial-sell",
        token: { ...s.sell.token, raw: s.sell.token.raw / 2n },
      });
      s.control.now += 5000;
      await s.recovery.tick();
      expect(s.recovery.statuses()).toMatchObject([
        {
          state: "ATTENTION",
          reason: "POSITION_CHANGED_REMAINDER_REQUIRES_ATTENTION",
        },
      ]);
      expect(
        s.store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          "SOL_NATIVE",
        ),
      ).toMatchObject({ rawAmount: 50_000_000n, reservedRawAmount: 0n });
    } finally {
      s.close();
    }
  });
  it("records quote failure then obtains a new quote on the next attempt", async () => {
    const s = await scenario();
    try {
      s.control.fail = true;
      s.control.now += 5000;
      await s.recovery.tick();
      expect(s.recovery.statuses()).toMatchObject([
        { state: "WAITING", reason: "JUPITER_ORDER_FAILED" },
      ]);
      s.control.fail = false;
      s.control.impact = "-1";
      s.control.now += 10000;
      await s.recovery.tick();
      expect(s.recovery.statuses()).toMatchObject([
        { state: "COMPLETED", attempts: 2 },
      ]);
    } finally {
      s.close();
    }
  });
  it.each([
    "AFTER_CLAIM",
    "AFTER_ACCEPT",
    "AFTER_FILL",
    "AFTER_APPLY",
  ] as const)(
    "recovers a process restart at %s without a second fill",
    async (point) => {
      const s = await scenario();
      let reopened: SqliteDatabase | undefined;
      try {
        s.control.impact = "-1";
        s.control.now += 5000;
        const failing = new AutomaticExitRecovery(
          s.store,
          s.sender,
          () => s.control.now,
          (p) => {
            if (p === point) throw Error("injected-process-crash");
          },
        );
        await expect(failing.tick()).rejects.toThrow("injected-process-crash");
        s.database.close();
        reopened = new SqliteDatabase({
          path: s.path,
          migrationsDirectory: resolve("migrations"),
        });
        const store = new StateStore(reopened, new TestClock(), s.policy);
        const recovery = new AutomaticExitRecovery(
          store,
          new PaperTransactionSender(new MockJupiterOrderProvider()),
          () => s.control.now,
        );
        s.control.now += 6000;
        await Promise.all([recovery.tick(), recovery.tick()]);
        await recovery.tick();
        expect(recovery.statuses()).toMatchObject([
          {
            state: point === "AFTER_CLAIM" ? "ATTENTION" : "COMPLETED",
            attempts: 1,
          },
        ]);
        expect(
          store.getFollowerPosition(
            FOLLOWER,
            LEADER_A,
            TOKEN_MINT,
            "SOL_NATIVE",
          ),
        ).toMatchObject({
          rawAmount: point === "AFTER_CLAIM" ? 100_000_000n : 0n,
          reservedRawAmount: 0n,
        });
      } finally {
        reopened?.close();
        if (s.database.sqlite.open) s.database.close();
        vi.restoreAllMocks();
      }
    },
  );
  it("refuses retroactive enablement on a database with source evidence", async () => {
    const s = await scenario();
    try {
      s.database.sqlite.prepare("DELETE FROM automatic_exit_policy").run();
      expect(() => s.recovery.enableFresh()).toThrow(
        "EXIT_RECOVERY_REQUIRES_FRESH_DATABASE",
      );
    } finally {
      s.close();
    }
  });
  it("rejects revoked immutable PRE authorization before any provider call", async () => {
    const s = await scenario();
    try {
      s.database.sqlite
        .prepare(
          "UPDATE risk_decisions SET policy_version='OTHER' WHERE intent_id=? AND phase='PRE_QUOTE'",
        )
        .run(s.intent.executionKey);
      const count = s.provider.requests.length;
      s.control.now += 5000;
      await s.recovery.tick();
      expect(s.recovery.statuses()).toMatchObject([
        { state: "ATTENTION", reason: "IMMUTABLE_PRE_INVALID" },
      ]);
      expect(s.provider.requests.length).toBe(count);
    } finally {
      s.close();
    }
  });
  it("persists a blocked full exit and closes exactly once after a fresh safe quote", async () => {
    const { store, database } = testStore("automatic-exit-", {
      ...TEST_RISK_POLICY,
      maxSellPriceImpactPctByQuoteMint: { SOL_NATIVE: "2.50" },
    });
    try {
      let now = 1_730_000_000_500;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      let impact = "-3";
      const provider = new MockJupiterOrderProvider();
      const sender = new PaperTransactionSender({
        getOrder: async (request) => ({
          ...(await provider.getOrder(request)),
          priceImpactPct: request.inputMint === TOKEN_MINT ? impact : "0",
        }),
      });
      const recovery = new AutomaticExitRecovery(store, sender, () => now);
      recovery.enableFresh();
      await store.upsertWallet(LEADER_A, "LEADER", 1000);
      await store.upsertWallet(FOLLOWER, "FOLLOWER");
      const coordinator = new ExecutionCoordinator(store, sender);
      for (const raw of [
        MAINNET_FIXTURES.jupiterBuy,
        MAINNET_FIXTURES.fullSell,
      ]) {
        const c = new SwapClassifier().classify(
          new TransactionNormalizer(new TestClock()).normalize(envelope(raw)),
          LEADER_A,
        );
        if (!c.accepted) throw Error(c.code);
        await store.saveLeaderTrade(c.event);
        await coordinator.execute(
          new CopyEngine().decide(
            c.event,
            { followerWallet: FOLLOWER, copyRatioBps: 1000, mode: "PAPER" },
            store.getFollowerPosition(
              FOLLOWER,
              LEADER_A,
              TOKEN_MINT,
              "SOL_NATIVE",
            ),
          ),
        );
      }
      expect(recovery.statuses()).toHaveLength(1);
      expect(
        store.getFollowerPosition(FOLLOWER, LEADER_A, TOKEN_MINT, "SOL_NATIVE")
          ?.rawAmount,
      ).toBe(100_000_000n);
      impact = "-1";
      now += 5_000;
      await Promise.all([
        recovery.tick(),
        new AutomaticExitRecovery(store, sender, () => now).tick(),
      ]);
      await recovery.tick();
      expect(recovery.statuses()).toMatchObject([
        { state: "COMPLETED", attempts: 1 },
      ]);
      expect(
        store.getFollowerPosition(FOLLOWER, LEADER_A, TOKEN_MINT, "SOL_NATIVE")
          ?.rawAmount,
      ).toBe(0n);
      expect(
        provider.requests.filter((r) => r.inputMint === TOKEN_MINT),
      ).toHaveLength(2);
      if (process.env.V6_EXIT_EVIDENCE_DIR) {
        const path = resolve(
          process.env.V6_EXIT_EVIDENCE_DIR,
          "isolated-recovery-proof.sqlite",
        );
        if (
          !path.startsWith(
            resolve("reports/v6-exit-recovery-2026-09-11") + "/",
          ) ||
          existsSync(path)
        )
          throw Error("REFUSE_EVIDENCE_OVERWRITE");
        await database.sqlite.backup(path);
      }
    } finally {
      vi.restoreAllMocks();
      database.close();
    }
  });
});
