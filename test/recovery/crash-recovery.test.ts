import { describe, expect, it } from "vitest";
import { CopyEngine } from "../../src/copy/copy-engine.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import {
  ExecutionCoordinator,
  InjectedCrashError,
  type CrashPoint,
} from "../../src/execution/execution-coordinator.js";
import {
  PaperTransactionSender,
  type PaperLedger,
} from "../../src/execution/paper-transaction-sender.js";
import { RecoveryManager } from "../../src/recovery/recovery-manager.js";
import { MockJupiterOrderProvider } from "../../src/execution/mock-jupiter-order-provider.js";
import type { JupiterOrderProvider } from "../../src/execution/jupiter-order-adapter.js";
import { RiskEngine } from "../../src/risk/risk-engine.js";
import { NATIVE_SOL } from "../../src/domain/assets.js";
import { envelope } from "../helpers/envelope.js";
import { TEST_RISK_POLICY, testStore } from "../helpers/database.js";
import { TestClock } from "../helpers/test-clock.js";
import { StateStore } from "../../src/persistence/state-store.js";
import {
  FOLLOWER,
  LEADER_A,
  MAINNET_FIXTURES,
  TOKEN_MINT,
} from "../fixtures/mainnet-fixtures.js";

async function setup(
  crashPoint: CrashPoint,
  ledger: PaperLedger = { results: new Map() },
  orderProvider: JupiterOrderProvider = new MockJupiterOrderProvider(1n, 500n),
) {
  const resources = testStore(`recovery-${crashPoint}-`);
  await resources.store.upsertWallet(LEADER_A, "LEADER", 1000);
  await resources.store.upsertWallet(FOLLOWER, "FOLLOWER");
  const classification = new SwapClassifier().classify(
    new TransactionNormalizer(new TestClock()).normalize(
      envelope(MAINNET_FIXTURES.jupiterBuy),
    ),
    LEADER_A,
  );
  if (!classification.accepted) throw new Error(classification.code);
  await resources.store.saveLeaderTrade(classification.event);
  const intent = new CopyEngine().decide(classification.event, {
    followerWallet: FOLLOWER,
    copyRatioBps: 1000,
    mode: "SHADOW",
  });
  const sender = new PaperTransactionSender(orderProvider, ledger);
  const coordinator = new ExecutionCoordinator(
    resources.store,
    sender,
    crashPoint,
  );
  await expect(coordinator.execute(intent)).rejects.toBeInstanceOf(
    InjectedCrashError,
  );
  return { ...resources, intent, sender, ledger };
}

describe("crash recovery", () => {
  it("does not re-quote a stale source after restart", async () => {
    const resources = await setup("AFTER_RESERVE");
    try {
      const restarted = new StateStore(
        resources.database,
        new TestClock(1_730_000_120_000),
        resources.store.riskPolicy,
      );
      const provider = new MockJupiterOrderProvider();
      await new RecoveryManager(
        restarted,
        new PaperTransactionSender(provider),
      ).recover();
      expect(provider.requests).toHaveLength(0);
      expect(restarted.followerTradeState(resources.intent.executionKey)).toBe(
        "FAILED",
      );
    } finally {
      resources.database.close();
    }
  });
  it("does not request a new quote when a reserved BUY is now globally halted", async () => {
    const resources = await setup("AFTER_RESERVE");
    try {
      await resources.store.setGlobalRiskState(
        "HALT_NEW_RISK",
        "OPERATOR_HALT",
      );
      const provider = new MockJupiterOrderProvider();
      await new RecoveryManager(
        resources.store,
        new PaperTransactionSender(provider),
      ).recover();
      expect(provider.requests).toHaveLength(0);
      expect(
        resources.store.followerTradeState(resources.intent.executionKey),
      ).toBe("FAILED");
    } finally {
      resources.database.close();
    }
  });
  it("refuses a Live sender before any recovery work", () => {
    const { store, database } = testStore();
    try {
      expect(
        () =>
          new RecoveryManager(store, {
            mode: "LIVE",
            send: async () => {
              throw new Error("forbidden");
            },
            lookup: async () => undefined,
          } as never),
      ).toThrow("PAPER_RECOVERY_ONLY");
    } finally {
      database.close();
    }
  });
  it("fails closed before Jupiter when a recoverable intent has no PRE authorization", async () => {
    const resources = testStore("recovery-missing-pre-");
    try {
      await resources.store.upsertWallet(LEADER_A, "LEADER", 1000);
      await resources.store.upsertWallet(FOLLOWER, "FOLLOWER");
      const classification = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.jupiterBuy),
        ),
        LEADER_A,
      );
      if (!classification.accepted) throw new Error(classification.code);
      await resources.store.saveLeaderTrade(classification.event);
      const intent = new CopyEngine().decide(classification.event, {
        followerWallet: FOLLOWER,
        copyRatioBps: 1000,
        mode: "SHADOW",
      });
      await resources.store.reserveIntent(intent);
      const provider = new MockJupiterOrderProvider(1n, 500n);

      const report = await new RecoveryManager(
        resources.store,
        new PaperTransactionSender(provider),
      ).recover();

      expect(report).toEqual({ committed: 0, safelyRetried: 0, uncertain: 1 });
      expect(provider.requests).toHaveLength(0);
      expect(resources.store.followerTradeState(intent.executionKey)).toBe(
        "FAILED",
      );
      expect(
        resources.store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          NATIVE_SOL,
        )?.reservedRawAmount,
      ).toBe(0n);
      expect(
        resources.database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fills")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      resources.database.close();
    }
  });

  it("fails closed before Jupiter when persisted PRE rejected the intent", async () => {
    const resources = testStore("recovery-rejected-pre-");
    try {
      await resources.store.upsertWallet(LEADER_A, "LEADER", 1000);
      await resources.store.upsertWallet(FOLLOWER, "FOLLOWER");
      const classification = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.jupiterBuy),
        ),
        LEADER_A,
      );
      if (!classification.accepted) throw new Error(classification.code);
      await resources.store.saveLeaderTrade(classification.event);
      const validIntent = new CopyEngine().decide(classification.event, {
        followerWallet: FOLLOWER,
        copyRatioBps: 1000,
        mode: "SHADOW",
      });
      const {
        authoritativeSourceTimestamp: _authoritativeSourceTimestamp,
        ...intent
      } = validIntent;
      await resources.store.evaluateAndReserveExecutionIntent(
        intent,
        new RiskEngine(resources.store.riskPolicy),
      );
      await resources.store.reserveIntent(intent);
      const provider = new MockJupiterOrderProvider(1n, 500n);

      const report = await new RecoveryManager(
        resources.store,
        new PaperTransactionSender(provider),
      ).recover();

      expect(report).toEqual({ committed: 0, safelyRetried: 0, uncertain: 1 });
      expect(provider.requests).toHaveLength(0);
      expect(
        resources.database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fills")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      resources.database.close();
    }
  });

  it("fails closed before Jupiter when recoverable identity mismatches PRE", async () => {
    const resources = testStore("recovery-pre-identity-");
    const otherFollower = "4Nd1mismatchFollower11111111111111111111111111";
    try {
      await resources.store.upsertWallet(LEADER_A, "LEADER", 1000);
      await resources.store.upsertWallet(FOLLOWER, "FOLLOWER");
      await resources.store.upsertWallet(otherFollower, "FOLLOWER");
      const classification = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.jupiterBuy),
        ),
        LEADER_A,
      );
      if (!classification.accepted) throw new Error(classification.code);
      await resources.store.saveLeaderTrade(classification.event);
      const intent = new CopyEngine().decide(classification.event, {
        followerWallet: FOLLOWER,
        copyRatioBps: 1000,
        mode: "SHADOW",
      });
      await resources.store.evaluateAndReserveExecutionIntent(
        intent,
        new RiskEngine(resources.store.riskPolicy),
      );
      await resources.store.reserveIntent({
        ...intent,
        followerWallet: otherFollower,
      });
      const provider = new MockJupiterOrderProvider(1n, 500n);

      const report = await new RecoveryManager(
        resources.store,
        new PaperTransactionSender(provider),
      ).recover();

      expect(report).toEqual({ committed: 0, safelyRetried: 0, uncertain: 1 });
      expect(provider.requests).toHaveLength(0);
      expect(
        resources.database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fills")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      resources.database.close();
    }
  });

  it("uses the immutable PRE resized amount instead of persisted theoretical amount", async () => {
    const resources = testStore("recovery-pre-resize-", {
      ...TEST_RISK_POLICY,
      maxSingleTradeRawByQuoteMint: { SOL_NATIVE: 30_000_000n },
    });
    try {
      await resources.store.upsertWallet(LEADER_A, "LEADER", 1000);
      await resources.store.upsertWallet(FOLLOWER, "FOLLOWER");
      const classification = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.jupiterBuy),
        ),
        LEADER_A,
      );
      if (!classification.accepted) throw new Error(classification.code);
      await resources.store.saveLeaderTrade(classification.event);
      const intent = new CopyEngine().decide(classification.event, {
        followerWallet: FOLLOWER,
        copyRatioBps: 1000,
        mode: "SHADOW",
      });
      await expect(
        new ExecutionCoordinator(
          resources.store,
          new PaperTransactionSender(new MockJupiterOrderProvider(1n, 500n)),
          "AFTER_RESERVE",
        ).execute(intent),
      ).rejects.toBeInstanceOf(InjectedCrashError);
      resources.database.sqlite
        .prepare(
          `UPDATE follower_trades
           SET theoretical_token_raw = ?, theoretical_quote_raw = ?
           WHERE execution_key = ?`,
        )
        .run(
          intent.theoreticalTokenRaw.toString(),
          intent.theoreticalQuoteRaw.toString(),
          intent.executionKey,
        );
      const provider = new MockJupiterOrderProvider(0n, 1n);

      const report = await new RecoveryManager(
        resources.store,
        new PaperTransactionSender(provider),
      ).recover();

      expect(report).toEqual({ committed: 0, safelyRetried: 1, uncertain: 0 });
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.amount).toBe(30_000_000n);
    } finally {
      resources.database.close();
    }
  });

  it("fails closed before Jupiter when persisted PRE is unreadable", async () => {
    const context = await setup("AFTER_RESERVE");
    try {
      context.database.sqlite
        .prepare(
          `UPDATE risk_decisions
           SET approved_amount_raw = 'not-a-bigint'
           WHERE phase = 'PRE_QUOTE' AND intent_id = ?`,
        )
        .run(context.intent.executionKey);
      const provider = new MockJupiterOrderProvider(1n, 500n);

      const report = await new RecoveryManager(
        context.store,
        new PaperTransactionSender(provider),
      ).recover();

      expect(report).toEqual({ committed: 0, safelyRetried: 0, uncertain: 1 });
      expect(provider.requests).toHaveLength(0);
    } finally {
      context.database.close();
    }
  });

  it("fails closed before Jupiter when persisted PRE halted the intent", async () => {
    const context = await setup("AFTER_RESERVE");
    try {
      context.database.sqlite
        .prepare(
          `UPDATE risk_decisions
           SET decision = 'HALT', approved_amount_raw = '0',
               approved_token_raw = '0', approved_quote_raw = '0',
               reason_code = 'GLOBAL_HALT_NEW_RISK'
           WHERE phase = 'PRE_QUOTE' AND intent_id = ?`,
        )
        .run(context.intent.executionKey);
      const provider = new MockJupiterOrderProvider(1n, 500n);

      const report = await new RecoveryManager(
        context.store,
        new PaperTransactionSender(provider),
      ).recover();

      expect(report).toEqual({ committed: 0, safelyRetried: 0, uncertain: 1 });
      expect(provider.requests).toHaveLength(0);
      expect(
        context.store.followerTradeState(context.intent.executionKey),
      ).toBe("FAILED");
    } finally {
      context.database.close();
    }
  });

  it("fails closed before Jupiter when persisted PRE approved zero", async () => {
    const context = await setup("AFTER_RESERVE");
    try {
      context.database.sqlite
        .prepare(
          `UPDATE risk_decisions
           SET approved_amount_raw = '0', approved_token_raw = '0',
               approved_quote_raw = '0'
           WHERE phase = 'PRE_QUOTE' AND intent_id = ?`,
        )
        .run(context.intent.executionKey);
      const provider = new MockJupiterOrderProvider(1n, 500n);

      const report = await new RecoveryManager(
        context.store,
        new PaperTransactionSender(provider),
      ).recover();

      expect(report).toEqual({ committed: 0, safelyRetried: 0, uncertain: 1 });
      expect(provider.requests).toHaveLength(0);
    } finally {
      context.database.close();
    }
  });

  it("restores the authoritative source timestamp after restart", async () => {
    const context = await setup("AFTER_RESERVE");
    try {
      expect(context.store.listRecoverable()[0]?.intent).toMatchObject({
        authoritativeSourceTimestamp: {
          valueMs: MAINNET_FIXTURES.jupiterBuy.sourceTimestampMs,
          provenance: "CHAIN_BLOCK_TIME",
          precision: "MILLISECOND",
        },
      });
    } finally {
      context.database.close();
    }
  });

  it("safely retries a crash before execution", async () => {
    const context = await setup("AFTER_RESERVE");
    try {
      const report = await new RecoveryManager(
        context.store,
        context.sender,
      ).recover();
      expect(report).toEqual({ committed: 0, safelyRetried: 1, uncertain: 0 });
      expect(
        context.store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          NATIVE_SOL,
        )?.rawAmount,
      ).toBe(200_000n);
      expect(
        context.store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          NATIVE_SOL,
        ),
      ).toMatchObject({
        quantityRaw: 200_000n,
        totalCostQuoteRaw: 100_000_000n,
        accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
      });
      expect(
        context.database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fills")
          .get(),
      ).toEqual({ count: 1 });
      expect(context.store.count("follower_trades")).toBe(1);
    } finally {
      context.database.close();
    }
  });

  it("reconciles a crash after send without sending twice", async () => {
    const ledger: PaperLedger = { results: new Map() };
    const context = await setup("AFTER_SEND", ledger);
    try {
      expect(ledger.results.size).toBe(1);
      const report = await new RecoveryManager(
        context.store,
        new PaperTransactionSender(
          new MockJupiterOrderProvider(1n, 500n),
          ledger,
        ),
      ).recover();
      expect(report).toEqual({ committed: 1, safelyRetried: 0, uncertain: 0 });
      expect(ledger.results.size).toBe(1);
      expect(context.store.count("follower_trades")).toBe(1);
      const pre = context.store.getRiskDecisionForIntent(
        "PRE_QUOTE",
        context.intent.executionKey,
      );
      const post = context.store.getRiskDecisionForIntent(
        "POST_QUOTE",
        context.intent.executionKey,
      );
      expect(post).toMatchObject({
        phase: "POST_QUOTE",
        preDecisionId: pre?.decisionId,
        intentId: context.intent.executionKey,
      });
    } finally {
      context.database.close();
    }
  });

  it("recovers available fee evidence exactly once without changing fill economics", async () => {
    const ledger: PaperLedger = { results: new Map() };
    const baseProvider = new MockJupiterOrderProvider(1n, 500n);
    const provider: JupiterOrderProvider = {
      async getOrder(request) {
        return {
          ...(await baseProvider.getOrder(request)),
          feeBps: 5,
          feeMint: request.inputMint,
          platformFee: {
            amountRaw: 500n,
            feeBps: 5,
            feeMint: request.inputMint,
          },
        };
      },
    };
    const context = await setup("AFTER_SEND", ledger, provider);
    try {
      const sender = new PaperTransactionSender(provider, ledger);
      const first = await new RecoveryManager(context.store, sender).recover();
      const second = await new RecoveryManager(context.store, sender).recover();

      expect(first).toEqual({ committed: 1, safelyRetried: 0, uncertain: 0 });
      expect(second).toEqual({ committed: 0, safelyRetried: 0, uncertain: 0 });
      const fill = context.database.sqlite
        .prepare(
          "SELECT fee_evidence_status, fee_evidence_contract_id, fee_bps, fee_mint, fee_amount_raw FROM paper_fills",
        )
        .get();
      expect(fill).toEqual({
        fee_evidence_status: "AVAILABLE",
        fee_evidence_contract_id: "FEE_EVIDENCE_CONTRACT_V1",
        fee_bps: 5,
        fee_mint: NATIVE_SOL,
        fee_amount_raw: "500",
      });
      expect(
        context.database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fill_applications")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        context.store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          NATIVE_SOL,
        ),
      ).toMatchObject({
        quantityRaw: 200_000n,
        totalCostQuoteRaw: 100_000_000n,
        realizedPnlQuoteRaw: 0n,
      });
    } finally {
      context.database.close();
    }
  });

  it("commits a durable result after a crash before position commit", async () => {
    const context = await setup("AFTER_RESULT");
    try {
      const report = await new RecoveryManager(
        context.store,
        new PaperTransactionSender(),
      ).recover();
      expect(report).toEqual({ committed: 1, safelyRetried: 0, uncertain: 0 });
      expect(
        context.store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          NATIVE_SOL,
        )?.rawAmount,
      ).toBe(200_000n);
    } finally {
      context.database.close();
    }
  });

  it("applies a committed PaperFill after a crash before application", async () => {
    const context = await setup("AFTER_FILL");
    try {
      expect(
        context.database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fills")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        context.database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fill_applications")
          .get(),
      ).toEqual({ count: 0 });

      const report = await new RecoveryManager(
        context.store,
        new PaperTransactionSender(),
      ).recover();

      expect(report).toEqual({ committed: 1, safelyRetried: 0, uncertain: 0 });
      expect(
        context.store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          NATIVE_SOL,
        ),
      ).toMatchObject({
        quantityRaw: 200_000n,
        totalCostQuoteRaw: 100_000_000n,
      });
    } finally {
      context.database.close();
    }
  });

  it("marks response-lost execution uncertain instead of copying again", async () => {
    const context = await setup("AFTER_SEND");
    try {
      const report = await new RecoveryManager(
        context.store,
        new PaperTransactionSender(),
      ).recover();
      expect(report).toEqual({ committed: 0, safelyRetried: 0, uncertain: 1 });
      expect(
        context.store.followerTradeState(context.intent.executionKey),
      ).toBe("UNCERTAIN");
      expect(
        context.store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          TOKEN_MINT,
          NATIVE_SOL,
        )?.rawAmount,
      ).toBe(0n);
    } finally {
      context.database.close();
    }
  });
});
