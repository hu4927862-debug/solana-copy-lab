import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RawTransactionSchema } from "../../src/decoder/raw-transaction.js";
import { readFollowerExitStatuses } from "../../src/persistence/follower-exit-status.js";
import { testStore, TEST_RISK_POLICY } from "../helpers/database.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { CopyEngine } from "../../src/copy/copy-engine.js";
import { ExecutionCoordinator } from "../../src/execution/execution-coordinator.js";
import { PaperTransactionSender } from "../../src/execution/paper-transaction-sender.js";
import { JupiterOrderAdapter } from "../../src/execution/jupiter-order-adapter.js";
import { MockJupiterOrderProvider } from "../../src/execution/mock-jupiter-order-provider.js";
import {
  MAINNET_FIXTURES,
  LEADER_A,
  FOLLOWER,
  TOKEN_MINT,
} from "../fixtures/mainnet-fixtures.js";
import { envelope } from "../helpers/envelope.js";
import { TestClock } from "../helpers/test-clock.js";

describe("follower exitability", () => {
  it("takes a captured Jupiter full SELL through proportional sizing and exactly-once Paper close", async () => {
    const raw = RawTransactionSchema.parse(
      JSON.parse(
        readFileSync(
          new URL(
            "../fixtures/v5-jupiter-full-sell-with-output-fee.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
    // Only freshness and bootstrap inventory are synthetic. The captured route,
    // balances, return value and nested instructions remain unchanged.
    raw.sourceTimestampMs = 1_730_000_000_000;
    const classified = new SwapClassifier().classify(
      new TransactionNormalizer(new TestClock()).normalize(envelope(raw)),
      raw.feePayer,
    );
    if (!classified.accepted) throw new Error(classified.code);
    const sell = classified.event;
    expect(sell.token.raw).toBe(sell.leaderPreTokenRaw);
    const { store, database } = testStore("captured-exit-v6-");
    try {
      await store.upsertWallet(sell.leaderWallet, "LEADER", 1000);
      await store.upsertWallet(FOLLOWER, "FOLLOWER");
      const buy = {
        ...sell,
        id: "synthetic-bootstrap-buy",
        signature: "synthetic-bootstrap-buy",
        side: "BUY" as const,
        token: { ...sell.token, raw: 1_000_000_000n },
        quote: { ...sell.quote, raw: 5_000_000n },
        leaderPreTokenRaw: 0n,
      };
      const coordinator = new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider()),
      );
      const policy = {
        followerWallet: FOLLOWER,
        copyRatioBps: 1000,
        mode: "PAPER" as const,
      };
      await store.saveLeaderTrade(buy);
      await coordinator.execute(new CopyEngine().decide(buy, policy));
      const position = store.getFollowerPosition(
        FOLLOWER,
        sell.leaderWallet,
        sell.token.mint,
        "SOL_NATIVE",
      );
      expect(position?.rawAmount).toBe(500_000n);
      await store.saveLeaderTrade(sell);
      const intent = new CopyEngine().decide(sell, policy, position);
      expect(intent.skipReason).toBeUndefined();
      expect(intent.theoreticalTokenRaw).toBe(500_000n);
      expect((await coordinator.execute(intent))?.state).toBe("PAPER_EXECUTED");
      await coordinator.execute(intent);
      expect(
        store.getFollowerPosition(
          FOLLOWER,
          sell.leaderWallet,
          sell.token.mint,
          "SOL_NATIVE",
        )?.rawAmount,
      ).toBe(0n);
      expect(readFollowerExitStatuses(database)).toEqual([]);
    } finally {
      database.close();
    }
  });
  it.each(["-0.01", "0.02"])(
    "applies raw Jupiter impact %s through risk and the durable ledger",
    async (impact) => {
      const { store, database } = testStore("impact-ledger-v6-", {
        ...TEST_RISK_POLICY,
        maxBuyPriceImpactPctByQuoteMint: {
          ...TEST_RISK_POLICY.maxBuyPriceImpactPctByQuoteMint,
          SOL_NATIVE: "1.25",
        },
      });
      try {
        await store.upsertWallet(LEADER_A, "LEADER", 1000);
        await store.upsertWallet(FOLLOWER, "FOLLOWER");
        const sender = new PaperTransactionSender(
          new JupiterOrderAdapter("test-key", async (url) => {
            const query = new URL(String(url)).searchParams;
            return new Response(
              JSON.stringify({
                transaction: null,
                requestId: "impact-integration",
                router: "metis",
                mode: "ultra",
                inputMint: query.get("inputMint"),
                outputMint: query.get("outputMint"),
                inAmount: query.get("amount"),
                outAmount: "100000000",
                feeBps: 10,
                feeMint: query.get("inputMint"),
                priceImpactPct: impact,
                routePlan: [{ swapInfo: { label: "fixture" } }],
              }),
            );
          }),
        );
        const classified = new SwapClassifier().classify(
          new TransactionNormalizer(new TestClock()).normalize(
            envelope(MAINNET_FIXTURES.jupiterBuy),
          ),
          LEADER_A,
        );
        if (!classified.accepted) throw new Error(classified.code);
        await store.saveLeaderTrade(classified.event);
        const intent = new CopyEngine().decide(classified.event, {
          followerWallet: FOLLOWER,
          copyRatioBps: 1000,
          mode: "PAPER",
        });
        const result = await new ExecutionCoordinator(store, sender).execute(
          intent,
        );
        expect(result?.state).toBe(
          impact === "-0.01" ? "PAPER_EXECUTED" : "FAILED",
        );
        expect(
          store.getFollowerPosition(
            FOLLOWER,
            LEADER_A,
            TOKEN_MINT,
            "SOL_NATIVE",
          )?.rawAmount,
        ).toBe(impact === "-0.01" ? 100000000n : 0n);
        expect(result?.paperQuoteEvidence?.priceImpactEvidence?.raw).toEqual({
          priceImpactPct: impact,
        });
        expect(
          store.getRiskDecisionForIntent("POST_QUOTE", intent.executionKey)
            ?.relevantEvidence?.priceImpactPct,
        ).toBe(impact === "-0.01" ? "-1" : "2");
      } finally {
        database.close();
      }
    },
  );

  it.each(["-0.1", "-3"])(
    "keeps proportional full exit safe for impact %s",
    async (impact) => {
      const { store, database } = testStore("exit-v6-", {
        ...TEST_RISK_POLICY,
        maxSellPriceImpactPctByQuoteMint: {
          ...TEST_RISK_POLICY.maxSellPriceImpactPctByQuoteMint,
          SOL_NATIVE: "2.50",
        },
      });
      try {
        await store.upsertWallet(LEADER_A, "LEADER", 1000);
        await store.upsertWallet(FOLLOWER, "FOLLOWER");
        const provider = new MockJupiterOrderProvider();
        const sender = new PaperTransactionSender({
          getOrder: async (request) => ({
            ...(await provider.getOrder(request)),
            priceImpactPct: request.inputMint === TOKEN_MINT ? impact : "0",
          }),
        });
        const coordinator = new ExecutionCoordinator(store, sender);
        for (const raw of [
          MAINNET_FIXTURES.jupiterBuy,
          MAINNET_FIXTURES.fullSell,
        ]) {
          const result = new SwapClassifier().classify(
            new TransactionNormalizer(new TestClock()).normalize(envelope(raw)),
            LEADER_A,
          );
          if (!result.accepted) throw new Error(result.code);
          await store.saveLeaderTrade(result.event);
          await coordinator.execute(
            new CopyEngine().decide(
              result.event,
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
        if (impact === "-0.1") {
          expect(
            store.getFollowerPosition(
              FOLLOWER,
              LEADER_A,
              TOKEN_MINT,
              "SOL_NATIVE",
            )?.rawAmount,
          ).toBe(0n);
          expect(readFollowerExitStatuses(database)).toEqual([]);
        } else {
          expect(readFollowerExitStatuses(database)).toMatchObject([
            {
              status: "SOURCE_FULL_EXIT_WITH_FOLLOWER_REMAINDER",
              lastExitReason: "PRICE_IMPACT_TOO_HIGH",
              remainingTokenRaw: 100_000_000n,
            },
          ]);
          expect(
            store.getFollowerPosition(
              FOLLOWER,
              LEADER_A,
              TOKEN_MINT,
              "SOL_NATIVE",
            )?.reservedRawAmount,
          ).toBe(0n);
        }
      } finally {
        database.close();
      }
    },
  );
});
