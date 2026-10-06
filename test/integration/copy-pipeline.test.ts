import { describe, expect, it } from "vitest";
import { CopyEngine } from "../../src/copy/copy-engine.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import type { SwapEvent } from "../../src/domain/trades.js";
import { ExecutionCoordinator } from "../../src/execution/execution-coordinator.js";
import { PaperTransactionSender } from "../../src/execution/paper-transaction-sender.js";
import { MockJupiterOrderProvider } from "../../src/execution/mock-jupiter-order-provider.js";
import { envelope } from "../helpers/envelope.js";
import { TestClock } from "../helpers/test-clock.js";
import { testStore } from "../helpers/database.js";
import {
  FOLLOWER,
  LEADER_A,
  LEADER_B,
  MAINNET_FIXTURES,
  TOKEN_MINT,
  swapFixture,
} from "../fixtures/mainnet-fixtures.js";
import { PROGRAM_IDS } from "../../src/decoder/program-registry.js";
import { NATIVE_SOL } from "../../src/domain/assets.js";

function classify(
  raw: ReturnType<typeof swapFixture>,
  leader: string,
): SwapEvent {
  const result = new SwapClassifier().classify(
    new TransactionNormalizer(new TestClock()).normalize(envelope(raw)),
    leader,
  );
  if (!result.accepted) throw new Error(`${result.code}: ${result.details}`);
  return result.event;
}

async function configure(
  store: ReturnType<typeof testStore>["store"],
  leaders = [LEADER_A],
): Promise<void> {
  for (const leader of leaders)
    await store.upsertWallet(leader, "LEADER", 1000);
  await store.upsertWallet(FOLLOWER, "FOLLOWER");
}

describe("paper copy pipeline", () => {
  it("persists Jupiter order metadata without persisting a transaction blob", async () => {
    const { database, store } = testStore("jupiter-metadata-");
    try {
      await configure(store);
      const event = classify(MAINNET_FIXTURES.jupiterBuy, LEADER_A);
      await store.saveLeaderTrade(event);
      const intent = new CopyEngine().decide(event, {
        followerWallet: FOLLOWER,
        copyRatioBps: 1000,
        mode: "SHADOW",
      });
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider()),
      ).execute(intent);
      const row = database.sqlite
        .prepare(
          "SELECT details_json FROM execution_events WHERE execution_key = ? AND type = 'EXECUTION_RESULT'",
        )
        .get(intent.executionKey) as { details_json: string };
      const details = JSON.parse(row.details_json) as {
        metadata: Record<string, unknown>;
      };
      expect(details.metadata.provider).toBe("JUPITER_SWAP_V2_ORDER");
      expect(details.metadata).toHaveProperty("route");
      expect(details.metadata).not.toHaveProperty("transaction");
    } finally {
      database.close();
    }
  });

  it("deduplicates a replayed leader transaction and execution intent", async () => {
    const { database, store } = testStore("duplicate-");
    try {
      await configure(store);
      const event = classify(MAINNET_FIXTURES.jupiterBuy, LEADER_A);
      expect(await store.saveLeaderTrade(event)).toBe(true);
      const intent = new CopyEngine().decide(event, {
        followerWallet: FOLLOWER,
        copyRatioBps: 1000,
        mode: "SHADOW",
      });
      const coordinator = new ExecutionCoordinator(
        store,
        new PaperTransactionSender(),
      );
      await coordinator.execute(intent);
      expect(await store.saveLeaderTrade(event)).toBe(false);
      expect(await coordinator.execute(intent)).toBeUndefined();
      expect(store.count("leader_trades")).toBe(1);
      expect(store.count("follower_trades")).toBe(1);
    } finally {
      database.close();
    }
  });

  it("handles partial sell then full sell against only the mapped logical position", async () => {
    const { database, store } = testStore("sell-state-");
    try {
      await configure(store);
      const engine = new CopyEngine();
      const policy = {
        followerWallet: FOLLOWER,
        copyRatioBps: 1000,
        mode: "SHADOW" as const,
      };
      const buy = classify(MAINNET_FIXTURES.jupiterBuy, LEADER_A);
      await store.saveLeaderTrade(buy);
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider(1n, 500n)),
      ).execute(engine.decide(buy, policy));
      expect(
        store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          buy.quote.mint,
        )?.rawAmount,
      ).toBe(200_000n);

      const partial = classify(MAINNET_FIXTURES.partialSell, LEADER_A);
      await store.saveLeaderTrade(partial);
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider()),
      ).execute(
        engine.decide(
          partial,
          policy,
          store.getFollowerPosition(
            FOLLOWER,
            LEADER_A,
            TOKEN_MINT,
            partial.quote.mint,
          ),
        ),
      );
      expect(
        store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          partial.quote.mint,
        )?.rawAmount,
      ).toBe(150_000n);

      const full = classify(MAINNET_FIXTURES.fullSell, LEADER_A);
      await store.saveLeaderTrade(full);
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider()),
      ).execute(
        engine.decide(
          full,
          policy,
          store.getFollowerPosition(
            FOLLOWER,
            LEADER_A,
            TOKEN_MINT,
            full.quote.mint,
          ),
        ),
      );
      const closed = store.getFollowerPosition(
        FOLLOWER,
        LEADER_A,
        TOKEN_MINT,
        full.quote.mint,
      );
      expect(closed?.rawAmount).toBe(0n);
      expect(closed?.state).toBe("CLOSED");
    } finally {
      database.close();
    }
  });

  it("keeps separate logical positions for two leaders buying the same token", async () => {
    const { database, store } = testStore("multi-leader-");
    try {
      await configure(store, [LEADER_A, LEADER_B]);
      const engine = new CopyEngine();
      const rawA = MAINNET_FIXTURES.jupiterBuy;
      const rawB = swapFixture({
        name: "leader-b-buy",
        programId: PROGRAM_IDS.JUPITER_V6,
        parsedType: "route",
        side: "BUY",
        leader: LEADER_B,
        tokenRaw: 4_000_000n,
      });
      for (const [raw, leader] of [
        [rawA, LEADER_A],
        [rawB, LEADER_B],
      ] as const) {
        const event = classify(raw, leader);
        await store.saveLeaderTrade(event);
        await new ExecutionCoordinator(
          store,
          new PaperTransactionSender(
            new MockJupiterOrderProvider(
              leader === LEADER_A ? 1n : 1n,
              leader === LEADER_A ? 500n : 250n,
            ),
          ),
        ).execute(
          engine.decide(event, {
            followerWallet: FOLLOWER,
            copyRatioBps: 1000,
            mode: "SHADOW",
          }),
        );
      }
      expect(
        store.getFollowerPosition(FOLLOWER, LEADER_A, TOKEN_MINT, NATIVE_SOL)
          ?.rawAmount,
      ).toBe(200_000n);
      expect(
        store.getFollowerPosition(FOLLOWER, LEADER_B, TOKEN_MINT, NATIVE_SOL)
          ?.rawAmount,
      ).toBe(400_000n);
    } finally {
      database.close();
    }
  });
});
