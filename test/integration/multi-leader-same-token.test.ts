import { describe, expect, it } from "vitest";
import { CopyEngine } from "../../src/copy/copy-engine.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import type { SwapEvent } from "../../src/domain/trades.js";
import { ExecutionCoordinator } from "../../src/execution/execution-coordinator.js";
import { MockJupiterOrderProvider } from "../../src/execution/mock-jupiter-order-provider.js";
import { PaperTransactionSender } from "../../src/execution/paper-transaction-sender.js";
import { PROGRAM_IDS } from "../../src/decoder/program-registry.js";
import { NATIVE_SOL } from "../../src/domain/assets.js";
import { envelope } from "../helpers/envelope.js";
import { testStore } from "../helpers/database.js";
import { TestClock } from "../helpers/test-clock.js";
import {
  FOLLOWER,
  LEADER_A,
  LEADER_B,
  TOKEN_MINT,
  swapFixture,
} from "../fixtures/mainnet-fixtures.js";

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

describe("multi-Leader same-token integration", () => {
  it("keeps another Leader's same-token position unchanged after a full SELL", async () => {
    const { database, store } = testStore("multi-leader-sell-isolation-");
    try {
      for (const leader of [LEADER_A, LEADER_B]) {
        await store.upsertWallet(leader, "LEADER", 1_000);
      }
      await store.upsertWallet(FOLLOWER, "FOLLOWER");

      const policy = {
        followerWallet: FOLLOWER,
        copyRatioBps: 1_000,
        mode: "SHADOW" as const,
      };
      const engine = new CopyEngine();

      for (const [leader, name, tokenRaw] of [
        [LEADER_A, "leader-a-buy", 2_000_000n],
        [LEADER_B, "leader-b-buy", 4_000_000n],
      ] as const) {
        const buy = classify(
          swapFixture({
            name,
            programId: PROGRAM_IDS.JUPITER_V6,
            parsedType: "route",
            side: "BUY",
            leader,
            tokenRaw,
          }),
          leader,
        );
        await store.saveLeaderTrade(buy);
        await new ExecutionCoordinator(
          store,
          new PaperTransactionSender(new MockJupiterOrderProvider(1n, 500n)),
        ).execute(engine.decide(buy, policy));
      }

      const leaderBBefore = store.getPaperPosition(
        FOLLOWER,
        LEADER_B,
        TOKEN_MINT,
        NATIVE_SOL,
      );
      expect(leaderBBefore?.quantityRaw).toBe(200_000n);

      const sell = classify(
        swapFixture({
          name: "leader-a-full-sell",
          programId: PROGRAM_IDS.JUPITER_V6,
          parsedType: "route",
          side: "SELL",
          leader: LEADER_A,
          tokenRaw: 2_000_000n,
          preTokenRaw: 2_000_000n,
        }),
        LEADER_A,
      );
      await store.saveLeaderTrade(sell);
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider()),
      ).execute(
        engine.decide(
          sell,
          policy,
          store.getFollowerPosition(FOLLOWER, LEADER_A, TOKEN_MINT, NATIVE_SOL),
        ),
      );

      expect(
        store.getPaperPosition(FOLLOWER, LEADER_A, TOKEN_MINT, NATIVE_SOL),
      ).toMatchObject({ quantityRaw: 0n, status: "CLOSED" });
      expect(
        store.getPaperPosition(FOLLOWER, LEADER_B, TOKEN_MINT, NATIVE_SOL),
      ).toEqual(leaderBBefore);
    } finally {
      database.close();
    }
  });
});
