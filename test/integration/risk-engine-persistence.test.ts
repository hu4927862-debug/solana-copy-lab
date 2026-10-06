import { describe, expect, it } from "vitest";
import { RiskEngine, type RiskPolicy } from "../../src/risk/risk-engine.js";
import type { ExecutionIntent } from "../../src/domain/execution.js";
import { USDC_MINT } from "../../src/domain/assets.js";
import { stableId } from "../../src/domain/ids.js";
import { testStore } from "../helpers/database.js";
import { StateStore } from "../../src/persistence/state-store.js";
import { TestClock } from "../helpers/test-clock.js";
import { CopyEngine } from "../../src/copy/copy-engine.js";
import { ExecutionCoordinator } from "../../src/execution/execution-coordinator.js";
import { InjectedCrashError } from "../../src/execution/execution-coordinator.js";
import { RecoveryManager } from "../../src/recovery/recovery-manager.js";
import { PaperTransactionSender } from "../../src/execution/paper-transaction-sender.js";
import { MockJupiterOrderProvider } from "../../src/execution/mock-jupiter-order-provider.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import { envelope } from "../helpers/envelope.js";
import {
  FOLLOWER,
  LEADER_A,
  LEADER_B,
  MAINNET_FIXTURES,
} from "../fixtures/mainnet-fixtures.js";
import { SqliteDatabase } from "../../src/persistence/database.js";
import { resolve } from "node:path";

const POLICY: RiskPolicy = {
  policyVersion: "PAPER_RISK_V1",
  maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 100n, [USDC_MINT]: 100n },
  maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 1_000n, [USDC_MINT]: 1_000n },
  maxPortfolioExposureRawByQuoteMint: {
    SOL_NATIVE: 100n,
    [USDC_MINT]: 100n,
  },
  dailyRealizedLossLimitRawByQuoteMint: {
    SOL_NATIVE: 500n,
    [USDC_MINT]: 500n,
  },
  maxIntentAgeMs: 60_000,
  maxQuoteAgeMs: 5_000,
  maxBuyPriceImpactPctByQuoteMint: {
    SOL_NATIVE: "1.25",
    [USDC_MINT]: "1.25",
  },
  maxSellPriceImpactPctByQuoteMint: {
    SOL_NATIVE: "2.50",
    [USDC_MINT]: "2.50",
  },
  requireRouteEvidence: true,
  provider429BurstThreshold: 3,
  providerBurstWindowMs: 60_000,
  providerCooldownMs: 30_000,
  halfOpenProbe: 1,
};

const EXECUTION_POLICY: RiskPolicy = {
  ...POLICY,
  maxSingleTradeRawByQuoteMint: {
    SOL_NATIVE: 1_000_000_000n,
    [USDC_MINT]: 1_000_000_000n,
  },
  maxTokenExposureRawByQuoteMint: {
    SOL_NATIVE: 10_000_000_000n,
    [USDC_MINT]: 10_000_000_000n,
  },
  maxPortfolioExposureRawByQuoteMint: {
    SOL_NATIVE: 10_000_000_000n,
    [USDC_MINT]: 10_000_000_000n,
  },
};

function buyRiskIntent(
  executionKey: string,
  quoteMint: string,
  createdAtMs: number,
): ExecutionIntent {
  return {
    executionKey,
    leaderTradeId: `leader-${executionKey}`,
    leaderWallet: LEADER_A,
    followerWallet: FOLLOWER,
    mode: "SHADOW",
    side: "BUY",
    tokenMint: `token-${executionKey}`,
    quoteMint,
    theoreticalTokenRaw: 50n,
    theoreticalQuoteRaw: 50n,
    copyRatioBps: 1_000,
    authoritativeSourceTimestamp: {
      valueMs: createdAtMs,
      provenance: "CHAIN_BLOCK_TIME",
      precision: "MILLISECOND",
    },
    createdAtMs,
    createdMonotonicNs: 1n,
  };
}

describe("Risk Engine persistence", () => {
  it("rejects a historical replay by its original chain timestamp", async () => {
    const fixture = testStore("risk-authoritative-intent-time-");
    try {
      await fixture.store.upsertWallet(LEADER_A, "LEADER", 1_000);
      await fixture.store.upsertWallet(FOLLOWER, "FOLLOWER");
      const classified = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.jupiterBuy),
        ),
        LEADER_A,
      );
      if (!classified.accepted) throw new Error(classified.code);
      const replayed = {
        ...classified.event,
        timestamps: {
          ...classified.event.timestamps,
          sourceTimestampMs: 1_729_999_000_000,
          sourceTimestampPrecision: "SECOND" as const,
          decodedTimestampMs: 1_730_000_000_200,
        },
      };
      await fixture.store.saveLeaderTrade(replayed);
      const intent = new CopyEngine().decide(replayed, {
        followerWallet: FOLLOWER,
        copyRatioBps: 1_000,
        mode: "SHADOW",
      });
      const provider = new MockJupiterOrderProvider(1n, 500n);
      const result = await new ExecutionCoordinator(
        fixture.store,
        new PaperTransactionSender(provider),
      ).execute(intent);

      expect(result).toMatchObject({
        state: "SKIPPED",
        reason: "STALE_INTENT",
      });
      expect(provider.requests).toHaveLength(0);
      expect(
        fixture.store.getRiskDecisionForIntent(
          "PRE_QUOTE",
          intent.executionKey,
        ),
      ).toMatchObject({ decision: "REJECT", reasonCode: "STALE_INTENT" });
    } finally {
      fixture.database.close();
    }
  });

  it("aggregates token cost exposure across every leader for one follower", async () => {
    const exposurePolicy: RiskPolicy = {
      ...EXECUTION_POLICY,
      maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 1_000n },
      maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 100n },
      maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: 1_000n },
    };
    const fixture = testStore("risk-cross-leader-token-", exposurePolicy);
    try {
      await fixture.store.upsertWallet(LEADER_A, "LEADER", 10_000);
      await fixture.store.upsertWallet(LEADER_B, "LEADER", 10_000);
      await fixture.store.upsertWallet(FOLLOWER, "FOLLOWER");
      const classified = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.jupiterBuy),
        ),
        LEADER_A,
      );
      if (!classified.accepted) throw new Error(classified.code);
      const buy = async (
        id: string,
        leaderWallet: string,
        quoteRaw: bigint,
      ) => {
        const event = {
          ...classified.event,
          id,
          signature: `${id}-signature`,
          leaderWallet,
          token: { ...classified.event.token, raw: quoteRaw },
          quote: { ...classified.event.quote, raw: quoteRaw },
        };
        await fixture.store.saveLeaderTrade(event);
        const intent = new CopyEngine().decide(event, {
          followerWallet: FOLLOWER,
          copyRatioBps: 10_000,
          mode: "SHADOW",
        });
        const provider = new MockJupiterOrderProvider(1n, 1n);
        const result = await new ExecutionCoordinator(
          fixture.store,
          new PaperTransactionSender(provider),
        ).execute(intent);
        return { intent, provider, result };
      };

      await buy("leader-a-open", LEADER_A, 60n);
      await buy("leader-b-open", LEADER_B, 30n);
      const constrained = await buy("leader-a-add", LEADER_A, 20n);

      expect(constrained.result?.state).toBe("PAPER_EXECUTED");
      expect(constrained.provider.requests[0]?.amount).toBe(10n);
      expect(
        fixture.store.getRiskDecisionForIntent(
          "PRE_QUOTE",
          constrained.intent.executionKey,
        ),
      ).toMatchObject({
        decision: "RESIZE",
        approvedQuoteRaw: 10n,
        reasonCode: "TOKEN_COST_EXPOSURE_LIMIT",
      });
    } finally {
      fixture.database.close();
    }
  });

  it("isolates pending cost exposure by follower while aggregating leaders", async () => {
    const exposurePolicy: RiskPolicy = {
      ...EXECUTION_POLICY,
      maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 100n },
      maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 100n },
      maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: 100n },
    };
    const fixture = testStore("risk-pending-follower-scope-", exposurePolicy);
    try {
      const engine = new RiskEngine(exposurePolicy);
      const first = await fixture.store.evaluateAndReserveExecutionIntent(
        {
          ...buyRiskIntent(
            "follower-one-leader-a",
            "SOL_NATIVE",
            1_730_000_000_200,
          ),
          leaderWallet: LEADER_A,
          followerWallet: FOLLOWER,
          tokenMint: "shared-token",
          theoreticalTokenRaw: 60n,
          theoreticalQuoteRaw: 60n,
        },
        engine,
      );
      const sameFollowerOtherLeader =
        await fixture.store.evaluateAndReserveExecutionIntent(
          {
            ...buyRiskIntent(
              "follower-one-leader-b",
              "SOL_NATIVE",
              1_730_000_000_200,
            ),
            leaderWallet: LEADER_B,
            followerWallet: FOLLOWER,
            tokenMint: "shared-token",
            theoreticalTokenRaw: 60n,
            theoreticalQuoteRaw: 60n,
          },
          engine,
        );
      const differentFollower =
        await fixture.store.evaluateAndReserveExecutionIntent(
          {
            ...buyRiskIntent(
              "follower-two-leader-a",
              "SOL_NATIVE",
              1_730_000_000_200,
            ),
            leaderWallet: LEADER_A,
            followerWallet: LEADER_B,
            tokenMint: "shared-token",
            theoreticalTokenRaw: 60n,
            theoreticalQuoteRaw: 60n,
          },
          engine,
        );

      expect(first.approvedQuoteRaw).toBe(60n);
      expect(sameFollowerOtherLeader).toMatchObject({
        decision: "RESIZE",
        approvedQuoteRaw: 40n,
        reasonCode: "TOKEN_COST_EXPOSURE_LIMIT",
      });
      expect(differentFollower).toMatchObject({
        decision: "ALLOW",
        approvedQuoteRaw: 60n,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("creates no request, Fill, or active commitment at zero capacity", async () => {
    const exposurePolicy: RiskPolicy = {
      ...EXECUTION_POLICY,
      maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 100_000_000n },
      maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 100_000_000n },
      maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: 100_000_000n },
    };
    const fixture = testStore("risk-zero-capacity-", exposurePolicy);
    try {
      await fixture.store.upsertWallet(LEADER_A, "LEADER", 1_000);
      await fixture.store.upsertWallet(FOLLOWER, "FOLLOWER");
      const classified = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.jupiterBuy),
        ),
        LEADER_A,
      );
      if (!classified.accepted) throw new Error(classified.code);
      const intent = new CopyEngine().decide(classified.event, {
        followerWallet: FOLLOWER,
        copyRatioBps: 1_000,
        mode: "SHADOW",
      });
      await fixture.store.evaluateAndReserveExecutionIntent(
        {
          ...intent,
          executionKey: "capacity-holder",
          leaderTradeId: "capacity-holder-leader-trade",
          theoreticalQuoteRaw: 100_000_000n,
        },
        new RiskEngine(exposurePolicy),
      );
      await fixture.store.saveLeaderTrade(classified.event);
      const provider = new MockJupiterOrderProvider(1n, 500n);
      const result = await new ExecutionCoordinator(
        fixture.store,
        new PaperTransactionSender(provider),
      ).execute(intent);

      expect(result).toMatchObject({
        state: "SKIPPED",
        reason: "TOKEN_COST_EXPOSURE_LIMIT",
      });
      expect(provider.requests).toHaveLength(0);
      expect(
        fixture.database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fills")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        fixture.database.sqlite
          .prepare(
            "SELECT state FROM risk_buy_reservations WHERE intent_id = ?",
          )
          .get(intent.executionKey),
      ).toEqual({ state: "RELEASED" });
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed when the Paper execution boundary has no Risk runtime", () => {
    const fixture = testStore("risk-boundary-required-");
    try {
      expect(
        () =>
          new ExecutionCoordinator(
            { riskPolicy: undefined } as never,
            new PaperTransactionSender(),
          ),
      ).toThrow("RISK_BOUNDARY_REQUIRED");
    } finally {
      fixture.database.close();
    }
  });

  it("fails startup closed when durable Risk policy state is unavailable", () => {
    const fixture = testStore("risk-policy-state-required-");
    try {
      expect(
        () =>
          new StateStore(fixture.database, new TestClock(), undefined as never),
      ).toThrow("RISK_POLICY_REQUIRED");
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed when recovery has no required Risk Engine", () => {
    const fixture = testStore("risk-recovery-boundary-required-");
    try {
      expect(
        () =>
          new RecoveryManager(
            { riskPolicy: undefined } as never,
            new PaperTransactionSender(),
          ),
      ).toThrow("RISK_ENGINE_REQUIRED_FOR_RECOVERY");
    } finally {
      fixture.database.close();
    }
  });

  it("serializes concurrent BUY commitments so approved exposure never crosses the cap", async () => {
    const { database, store } = testStore("risk-concurrency-");
    try {
      const position = {
        followerWallet: "follower",
        leaderWallet: "leader",
        tokenMint: "token",
        quoteMint: "SOL_NATIVE",
        tokenDecimals: 0,
        quoteDecimals: 0,
        quantityRaw: 40n,
        reservedRaw: 0n,
        totalCostQuoteRaw: 40n,
        realizedPnlQuoteRaw: 0n,
        averageEntry: "1",
        openedAtMs: 1,
        updatedAtMs: 1,
        closedAtMs: null,
        status: "OPEN" as const,
        accountingPolicyVersion: "WEIGHTED_AVERAGE_V1" as const,
        version: 1,
      };
      const context = (intentId: string) => ({
        phase: "PRE_QUOTE" as const,
        nowMs: 10_000,
        intent: {
          intentId,
          leaderTradeId: `leader-${intentId}`,
          leaderWallet: LEADER_A,
          followerWallet: FOLLOWER,
          side: "BUY" as const,
          tokenMint: "token",
          quoteMint: "SOL_NATIVE",
          requestedTokenRaw: 50n,
          requestedQuoteRaw: 50n,
          createdAtMs: 9_000,
          authoritativeSourceTimestamp: {
            valueMs: 9_000,
            provenance: "CHAIN_BLOCK_TIME" as const,
            precision: "MILLISECOND" as const,
          },
        },
        currentPosition: position,
        portfolioPositions: [position],
        pendingApprovedBuyQuoteRawByQuoteMint: { SOL_NATIVE: 0n },
        pendingApprovedBuyQuoteRawForToken: 0n,
        dailyRealizedPnlRawByQuoteMint: { SOL_NATIVE: 0n },
        quoteState: "RUNNING" as const,
        globalState: "RUNNING" as const,
        providerHealth: "HEALTHY" as const,
      });
      const engine = new RiskEngine(POLICY);
      const [first, second] = await Promise.all([
        store.evaluateAndReservePreQuote(context("intent-a"), engine),
        store.evaluateAndReservePreQuote(context("intent-b"), engine),
      ]);
      expect(
        first.approvedQuoteRaw + second.approvedQuoteRaw,
      ).toBeLessThanOrEqual(60n);
      const rows = database.sqlite
        .prepare(
          "SELECT approved_quote_raw FROM risk_buy_reservations WHERE state = 'ACTIVE'",
        )
        .all() as { approved_quote_raw: string }[];
      expect(
        rows.reduce((total, row) => total + BigInt(row.approved_quote_raw), 0n),
      ).toBe(first.approvedQuoteRaw + second.approvedQuoteRaw);
      const resized =
        first.approvedQuoteRaw < second.approvedQuoteRaw ? first : second;
      const duplicate = await store.evaluateAndReservePreQuote(
        context(resized.intentId),
        engine,
      );
      expect(duplicate).toEqual(resized);
      expect(
        database.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM risk_decisions WHERE phase = 'PRE_QUOTE' AND intent_id = ?",
          )
          .get(resized.intentId),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("persists immutable PRE and POST decisions with their evidence link", async () => {
    const { database, store } = testStore("risk-decisions-");
    try {
      const intent = {
        intentId: "intent-persist",
        leaderTradeId: "leader-1",
        leaderWallet: LEADER_A,
        followerWallet: FOLLOWER,
        side: "BUY" as const,
        tokenMint: "token-1",
        quoteMint: "SOL_NATIVE",
        requestedTokenRaw: 50n,
        requestedQuoteRaw: 50n,
        createdAtMs: 9_000,
        authoritativeSourceTimestamp: {
          valueMs: 9_000,
          provenance: "CHAIN_BLOCK_TIME" as const,
          precision: "MILLISECOND" as const,
        },
      };
      const preDecision = new RiskEngine(POLICY).evaluatePreQuote({
        phase: "PRE_QUOTE",
        nowMs: 10_000,
        intent,
        portfolioPositions: [],
        pendingApprovedBuyQuoteRawByQuoteMint: { SOL_NATIVE: 0n },
        pendingApprovedBuyQuoteRawForToken: 0n,
        dailyRealizedPnlRawByQuoteMint: { SOL_NATIVE: 0n },
        quoteState: "RUNNING",
        globalState: "RUNNING",
        providerHealth: "HEALTHY",
      });
      expect(await store.saveRiskDecision(preDecision)).toBe(true);
      expect(await store.saveRiskDecision(preDecision)).toBe(false);
      expect(
        store.getRiskDecision(preDecision.decisionId)?.approvedAmountRaw,
      ).toBe(50n);
    } finally {
      database.close();
    }
  });

  it("durably enters HALT_NEW_RISK immediately when a fill application reaches daily loss", async () => {
    const fixture = testStore("risk-daily-loss-");
    const store = new StateStore(
      fixture.database,
      new TestClock(),
      EXECUTION_POLICY,
    );
    try {
      await store.upsertWallet(LEADER_A, "LEADER", 1_000);
      await store.upsertWallet(FOLLOWER, "FOLLOWER");
      const classify = (raw: (typeof MAINNET_FIXTURES)["jupiterBuy"]) => {
        const result = new SwapClassifier().classify(
          new TransactionNormalizer(new TestClock()).normalize(envelope(raw)),
          LEADER_A,
        );
        if (!result.accepted) throw new Error(result.code);
        return result.event;
      };
      const copy = new CopyEngine();
      const copyPolicy = {
        followerWallet: FOLLOWER,
        copyRatioBps: 1_000,
        mode: "SHADOW" as const,
      };
      const buy = classify(MAINNET_FIXTURES.jupiterBuy);
      await store.saveLeaderTrade(buy);
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider(1n, 500n)),
      ).execute(copy.decide(buy, copyPolicy));
      const sell = classify(MAINNET_FIXTURES.fullSell);
      await store.saveLeaderTrade(sell);
      const sellIntent = copy.decide(
        sell,
        copyPolicy,
        store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          sell.token.mint,
          sell.quote.mint,
        ),
      );
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider(1n, 4n)),
      ).execute(sellIntent);
      expect(store.getQuoteRiskState(sell.quote.mint)).toMatchObject({
        quoteState: "HALT_NEW_RISK",
        dailyRealizedPnlRaw: expect.any(BigInt),
      });
      expect(store.getGlobalRiskState()).toBe("RUNNING");
      const engine = new RiskEngine(EXECUTION_POLICY);
      const solDecision = await store.evaluateAndReserveExecutionIntent(
        buyRiskIntent("day-1-sol", sell.quote.mint, 1_730_000_000_200),
        engine,
      );
      const usdcDecision = await store.evaluateAndReserveExecutionIntent(
        buyRiskIntent("day-1-usdc", USDC_MINT, 1_730_000_000_200),
        engine,
      );
      expect({
        sol: [solDecision.decision, solDecision.reasonCode],
        usdc: usdcDecision.decision,
      }).toEqual({
        sol: ["HALT", "DAILY_REALIZED_LOSS_LIMIT"],
        usdc: "ALLOW",
      });

      const sellFillId = stableId(
        "paper_fill",
        sellIntent.executionKey,
        "JUPITER_ORDER_QUOTE_AS_FILL_V1",
      );
      const dailyBeforeDuplicate = store.getQuoteRiskState(sell.quote.mint);
      expect(await store.applyPaperFill(sellFillId)).toBe("ALREADY_APPLIED");
      expect(store.getQuoteRiskState(sell.quote.mint)).toEqual(
        dailyBeforeDuplicate,
      );

      expect(
        store.getQuoteRiskState(sell.quote.mint, 1_730_073_600_000),
      ).toMatchObject({
        quoteState: "RUNNING",
        utcDay: "2024-10-28",
        dailyRealizedPnlRaw: 0n,
      });
      const nextDayStore = new StateStore(
        fixture.database,
        new TestClock(1_730_073_600_000),
        EXECUTION_POLICY,
      );
      const nextDaySol = await nextDayStore.evaluateAndReserveExecutionIntent(
        buyRiskIntent("day-2-sol", sell.quote.mint, 1_730_073_600_000),
        engine,
      );
      expect(nextDaySol.decision).toBe("ALLOW");
    } finally {
      fixture.database.close();
    }
  });

  it("restores quote daily halt independently while explicit global halt survives UTC rollover", async () => {
    const fixture = testStore("risk-state-restart-");
    let database = fixture.database;
    try {
      const dayOneStore = new StateStore(
        database,
        new TestClock(),
        EXECUTION_POLICY,
      );
      await dayOneStore.upsertWallet(LEADER_A, "LEADER", 1_000);
      await dayOneStore.upsertWallet(FOLLOWER, "FOLLOWER");
      const classify = (raw: (typeof MAINNET_FIXTURES)["jupiterBuy"]) => {
        const result = new SwapClassifier().classify(
          new TransactionNormalizer(new TestClock()).normalize(envelope(raw)),
          LEADER_A,
        );
        if (!result.accepted) throw new Error(result.code);
        return result.event;
      };
      const copy = new CopyEngine();
      const copyPolicy = {
        followerWallet: FOLLOWER,
        copyRatioBps: 1_000,
        mode: "SHADOW" as const,
      };
      const buy = classify(MAINNET_FIXTURES.jupiterBuy);
      await dayOneStore.saveLeaderTrade(buy);
      await new ExecutionCoordinator(
        dayOneStore,
        new PaperTransactionSender(new MockJupiterOrderProvider(1n, 500n)),
      ).execute(copy.decide(buy, copyPolicy));
      const sell = classify(MAINNET_FIXTURES.fullSell);
      await dayOneStore.saveLeaderTrade(sell);
      await new ExecutionCoordinator(
        dayOneStore,
        new PaperTransactionSender(new MockJupiterOrderProvider(1n, 4n)),
      ).execute(
        copy.decide(
          sell,
          copyPolicy,
          dayOneStore.getFollowerPosition(
            FOLLOWER,
            LEADER_A,
            sell.token.mint,
            sell.quote.mint,
          ),
        ),
      );

      database.close();
      database = new SqliteDatabase({
        path: fixture.path,
        migrationsDirectory: resolve("migrations"),
      });
      const reopenedDayOne = new StateStore(
        database,
        new TestClock(),
        EXECUTION_POLICY,
      );
      expect(reopenedDayOne.getQuoteRiskState("SOL_NATIVE")).toMatchObject({
        quoteState: "HALT_NEW_RISK",
      });
      expect(reopenedDayOne.getQuoteRiskState(USDC_MINT)).toBeUndefined();
      const engine = new RiskEngine(EXECUTION_POLICY);
      const sol = await reopenedDayOne.evaluateAndReserveExecutionIntent(
        buyRiskIntent("restart-day-1-sol", "SOL_NATIVE", 1_730_000_000_200),
        engine,
      );
      const usdc = await reopenedDayOne.evaluateAndReserveExecutionIntent(
        buyRiskIntent("restart-day-1-usdc", USDC_MINT, 1_730_000_000_200),
        engine,
      );
      expect({ sol: sol.reasonCode, usdc: usdc.decision }).toEqual({
        sol: "DAILY_REALIZED_LOSS_LIMIT",
        usdc: "ALLOW",
      });

      await reopenedDayOne.setGlobalRiskState(
        "HALT_NEW_RISK",
        "GLOBAL_HALT_NEW_RISK",
      );
      database.close();
      database = new SqliteDatabase({
        path: fixture.path,
        migrationsDirectory: resolve("migrations"),
      });
      const dayTwoStore = new StateStore(
        database,
        new TestClock(1_730_073_600_000),
        EXECUTION_POLICY,
      );
      expect(dayTwoStore.getQuoteRiskState("SOL_NATIVE")).toMatchObject({
        quoteState: "RUNNING",
        utcDay: "2024-10-28",
        dailyRealizedPnlRaw: 0n,
      });
      expect(dayTwoStore.getGlobalRiskState()).toBe("HALT_NEW_RISK");
      const globallyHalted =
        await dayTwoStore.evaluateAndReserveExecutionIntent(
          buyRiskIntent(
            "restart-day-2-global",
            "SOL_NATIVE",
            1_730_073_600_000,
          ),
          engine,
        );
      expect(globallyHalted.reasonCode).toBe("GLOBAL_HALT_NEW_RISK");
      await dayTwoStore.setGlobalRiskState("RUNNING", "EXPLICIT_RESUME");
      const explicitlyResumed =
        await dayTwoStore.evaluateAndReserveExecutionIntent(
          buyRiskIntent(
            "restart-day-2-resumed",
            "SOL_NATIVE",
            1_730_073_600_000,
          ),
          engine,
        );
      expect(explicitlyResumed.decision).toBe("ALLOW");
    } finally {
      database.close();
    }
  });

  it("keeps the PRE approved BUY amount through reservation, quote, POST, and PaperFill", async () => {
    const integrityPolicy: RiskPolicy = {
      ...POLICY,
      maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 30_000_000n },
      maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 1_000_000_000n },
      maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: 1_000_000_000n },
    };
    const fixture = testStore("risk-amount-integrity-");
    const store = new StateStore(
      fixture.database,
      new TestClock(),
      integrityPolicy,
    );
    try {
      await store.upsertWallet(LEADER_A, "LEADER", 1_000);
      await store.upsertWallet(FOLLOWER, "FOLLOWER");
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
        copyRatioBps: 1_000,
        mode: "SHADOW",
      });
      expect(intent.theoreticalQuoteRaw).toBe(100_000_000n);
      const provider = new MockJupiterOrderProvider(1n, 500n);
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(provider),
      ).execute(intent);
      expect(provider.requests[0]?.amount).toBe(30_000_000n);
      const reservation = fixture.database.sqlite
        .prepare(
          "SELECT approved_quote_raw, state FROM risk_buy_reservations WHERE intent_id = ?",
        )
        .get(intent.executionKey) as {
        approved_quote_raw: string;
        state: string;
      };
      expect(reservation).toEqual({
        approved_quote_raw: "30000000",
        state: "APPLIED",
      });
      const fill = fixture.database.sqlite
        .prepare("SELECT input_amount_raw FROM paper_fills WHERE intent_id = ?")
        .get(intent.executionKey) as { input_amount_raw: string };
      expect(fill.input_amount_raw).toBe("30000000");
      const post = fixture.database.sqlite
        .prepare(
          "SELECT pre_decision_id, quote_request_id FROM risk_decisions WHERE phase = 'POST_QUOTE' AND intent_id = ?",
        )
        .get(intent.executionKey) as {
        pre_decision_id: string;
        quote_request_id: string;
      };
      expect(post.pre_decision_id).toMatch(/^risk_decision_/);
      expect(post.quote_request_id).toBe("mock-1");
    } finally {
      fixture.database.close();
    }
  });

  it("releases both reservations when POST quote risk rejects the evidence", async () => {
    const fixture = testStore("risk-post-reject-");
    const store = new StateStore(
      fixture.database,
      new TestClock(),
      EXECUTION_POLICY,
    );
    try {
      await store.upsertWallet(LEADER_A, "LEADER", 1_000);
      await store.upsertWallet(FOLLOWER, "FOLLOWER");
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
        copyRatioBps: 1,
        mode: "SHADOW",
      });
      const base = new MockJupiterOrderProvider(1n, 500n);
      const provider = {
        async getOrder(request: Parameters<typeof base.getOrder>[0]) {
          return { ...(await base.getOrder(request)), priceImpactPct: "9" };
        },
      };
      const result = await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(provider),
      ).execute(intent);
      expect(result).toMatchObject({
        state: "FAILED",
        reason: "PRICE_IMPACT_TOO_HIGH",
      });
      expect(
        store.getPaperFill(`paper_fill_${intent.executionKey}`),
      ).toBeUndefined();
      expect(
        store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          intent.tokenMint,
          intent.quoteMint,
        )?.reservedRawAmount,
      ).toBe(0n);
      expect(
        fixture.database.sqlite
          .prepare(
            "SELECT state FROM risk_buy_reservations WHERE intent_id = ?",
          )
          .get(intent.executionKey),
      ).toEqual({ state: "RELEASED" });
    } finally {
      fixture.database.close();
    }
  });

  it("recovers the persisted approved amount and POST decision after a PRE reservation crash", async () => {
    const riskPolicy: RiskPolicy = {
      ...POLICY,
      maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 30_000_000n },
      maxTokenExposureRawByQuoteMint: { SOL_NATIVE: 1_000_000_000n },
      maxPortfolioExposureRawByQuoteMint: { SOL_NATIVE: 1_000_000_000n },
    };
    const fixture = testStore("risk-recovery-");
    const store = new StateStore(fixture.database, new TestClock(), riskPolicy);
    try {
      await store.upsertWallet(LEADER_A, "LEADER", 1_000);
      await store.upsertWallet(FOLLOWER, "FOLLOWER");
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
        copyRatioBps: 1_000,
        mode: "SHADOW",
      });
      const provider = new MockJupiterOrderProvider(1n, 500n);
      const sender = new PaperTransactionSender(provider);
      await expect(
        new ExecutionCoordinator(store, sender, "AFTER_RESERVE").execute(
          intent,
        ),
      ).rejects.toBeInstanceOf(InjectedCrashError);
      await new RecoveryManager(store, sender).recover();
      expect(provider.requests[0]?.amount).toBe(30_000_000n);
      expect(
        fixture.database.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM risk_decisions WHERE phase = 'POST_QUOTE' AND intent_id = ?",
          )
          .get(intent.executionKey),
      ).toEqual({ count: 1 });
      expect(
        fixture.database.sqlite
          .prepare(
            "SELECT input_amount_raw FROM paper_fills WHERE intent_id = ?",
          )
          .get(intent.executionKey),
      ).toEqual({ input_amount_raw: "30000000" });
    } finally {
      fixture.database.close();
    }
  });

  it("releases an orphan BUY commitment after a crash before execution reservation", async () => {
    const fixture = testStore("risk-orphan-recovery-");
    try {
      const decision = await fixture.store.evaluateAndReservePreQuote(
        {
          phase: "PRE_QUOTE",
          nowMs: 10_000,
          intent: {
            intentId: "orphan-intent",
            leaderTradeId: "leader-orphan",
            leaderWallet: LEADER_A,
            followerWallet: FOLLOWER,
            side: "BUY",
            tokenMint: "token",
            quoteMint: "SOL_NATIVE",
            requestedTokenRaw: 50n,
            requestedQuoteRaw: 50n,
            createdAtMs: 9_000,
            authoritativeSourceTimestamp: {
              valueMs: 9_000,
              provenance: "CHAIN_BLOCK_TIME",
              precision: "MILLISECOND",
            },
          },
          portfolioPositions: [],
          pendingApprovedBuyQuoteRawByQuoteMint: { SOL_NATIVE: 0n },
          pendingApprovedBuyQuoteRawForToken: 0n,
          dailyRealizedPnlRawByQuoteMint: { SOL_NATIVE: 0n },
          quoteState: "RUNNING",
          globalState: "RUNNING",
          providerHealth: "HEALTHY",
        },
        new RiskEngine(POLICY),
      );
      expect(decision.decision).toBe("ALLOW");
      await new RecoveryManager(
        fixture.store,
        new PaperTransactionSender(),
      ).recover();
      expect(
        fixture.database.sqlite
          .prepare(
            "SELECT state FROM risk_buy_reservations WHERE intent_id = 'orphan-intent'",
          )
          .get(),
      ).toEqual({ state: "RELEASED" });
    } finally {
      fixture.database.close();
    }
  });
});
