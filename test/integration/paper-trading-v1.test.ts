import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CopyEngine } from "../../src/copy/copy-engine.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import type { PaperFill } from "../../src/domain/paper-trading.js";
import type { StateStore } from "../../src/persistence/state-store.js";
import { StateStore as PersistentStateStore } from "../../src/persistence/state-store.js";
import { SqliteDatabase } from "../../src/persistence/database.js";
import { ExecutionCoordinator } from "../../src/execution/execution-coordinator.js";
import { PaperTransactionSender } from "../../src/execution/paper-transaction-sender.js";
import { MockJupiterOrderProvider } from "../../src/execution/mock-jupiter-order-provider.js";
import { envelope } from "../helpers/envelope.js";
import { TEST_RISK_POLICY, testStore } from "../helpers/database.js";
import { TestClock } from "../helpers/test-clock.js";
import {
  FOLLOWER,
  LEADER_A,
  MAINNET_FIXTURES,
} from "../fixtures/mainnet-fixtures.js";
import { USDC_MINT, WSOL_MINT } from "../../src/domain/assets.js";
import { FEE_EVIDENCE_CONTRACT_V1 } from "../../src/domain/execution.js";

const migrationsDirectory = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
  "migrations",
);

const originalPaperOnly = process.env.PAPER_ONLY;
const originalLiveFundsEnabled = process.env.LIVE_FUNDS_ENABLED;

beforeEach(() => {
  process.env.PAPER_ONLY = "true";
  process.env.LIVE_FUNDS_ENABLED = "false";
});

afterEach(() => {
  if (originalPaperOnly === undefined) delete process.env.PAPER_ONLY;
  else process.env.PAPER_ONLY = originalPaperOnly;
  if (originalLiveFundsEnabled === undefined)
    delete process.env.LIVE_FUNDS_ENABLED;
  else process.env.LIVE_FUNDS_ENABLED = originalLiveFundsEnabled;
});

async function reservedBuy(store: StateStore) {
  await store.upsertWallet(LEADER_A, "LEADER", 1_000);
  await store.upsertWallet(FOLLOWER, "FOLLOWER");
  const classification = new SwapClassifier().classify(
    new TransactionNormalizer(new TestClock()).normalize(
      envelope(MAINNET_FIXTURES.jupiterBuy),
    ),
    LEADER_A,
  );
  if (!classification.accepted) throw new Error(classification.code);
  await store.saveLeaderTrade(classification.event);
  const intent = new CopyEngine().decide(classification.event, {
    followerWallet: FOLLOWER,
    copyRatioBps: 1_000,
    mode: "SHADOW",
  });
  await store.reserveIntent(intent);
  return { event: classification.event, intent };
}

function fillFor(
  event: Awaited<ReturnType<typeof reservedBuy>>["event"],
  intent: Awaited<ReturnType<typeof reservedBuy>>["intent"],
  overrides: Partial<PaperFill> = {},
): PaperFill {
  return {
    id: "fill_default",
    intentId: intent.executionKey,
    leaderTradeId: intent.leaderTradeId,
    leaderTxSignature: event.signature,
    leaderWallet: intent.leaderWallet,
    followerWallet: intent.followerWallet,
    side: "BUY",
    inputMint: intent.quoteMint,
    outputMint: intent.tokenMint,
    tokenDecimals: event.token.decimals,
    quoteDecimals: event.quote.decimals,
    inputAmountRaw: 100_000_000n,
    outputAmountRaw: 2_000_000n,
    quoteRequestTimestampMs: 1_730_000_000_000,
    quoteTimestampMs: 1_730_000_000_125,
    quoteRttMs: 125,
    feeEvidence: {
      status: "AMOUNT_UNAVAILABLE",
      feeBps: 5,
      feeMint: intent.quoteMint,
    },
    provider: "JUPITER_SWAP_V2_ORDER",
    requestId: "request-default",
    fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
    createdAtMs: 1_730_000_000_125,
    ...overrides,
  };
}

describe("Paper Trading v1 persistence", () => {
  it("round-trips paper fill raw amounts beyond safe integer ranges", async () => {
    const { database, store } = testStore("paper-fill-bigint-");
    try {
      const { event, intent } = await reservedBuy(store);
      const inputAmountRaw = 9_007_199_254_753_337n;
      const outputAmountRaw = 9_223_372_036_854_775_806n;
      const feeAmountRaw = 9_223_372_036_854_775_807n;
      expect(
        await store.savePaperFill(
          fillFor(event, intent, {
            id: "fill_bigint_roundtrip",
            inputAmountRaw,
            outputAmountRaw,
            feeEvidence: {
              status: "AVAILABLE",
              feeBps: 5,
              feeMint: intent.quoteMint,
              feeAmountRaw,
            },
            requestId: "request-bigint",
          }),
        ),
      ).toBe(true);

      expect(store.getPaperFill("fill_bigint_roundtrip")).toMatchObject({
        inputAmountRaw,
        outputAmountRaw,
        feeEvidence: { feeAmountRaw },
      });
      expect(
        database.sqlite
          .prepare(
            `
            SELECT typeof(input_amount_raw) AS input_type,
                   typeof(output_amount_raw) AS output_type,
                   typeof(fee_amount_raw) AS fee_type
            FROM paper_fills WHERE id = 'fill_bigint_roundtrip'
          `,
          )
          .get(),
      ).toEqual({
        input_type: "text",
        output_type: "text",
        fee_type: "text",
      });
    } finally {
      database.close();
    }
  });

  it("keeps an existing paper fill immutable", async () => {
    const { database, store } = testStore("paper-fill-immutable-");
    try {
      const { event, intent } = await reservedBuy(store);
      const original = fillFor(event, intent, { id: "fill_immutable" });
      expect(await store.savePaperFill(original)).toBe(true);
      expect(
        await store.savePaperFill({
          ...original,
          outputAmountRaw: 99_999_999n,
        }),
      ).toBe(false);
      expect(store.getPaperFill(original.id)?.outputAmountRaw).toBe(2_000_000n);
    } finally {
      database.close();
    }
  });

  it("keeps legacy unavailable fills unchanged beside future available evidence", async () => {
    const { database, store } = testStore("paper-fill-mixed-fee-evidence-");
    try {
      const { event, intent } = await reservedBuy(store);
      const legacy = fillFor(event, intent, { id: "fill_legacy_unavailable" });
      expect(await store.savePaperFill(legacy)).toBe(true);
      expect(await store.applyPaperFill(legacy.id)).toBe("APPLIED");

      const nextEvent = {
        ...event,
        id: "leader_mixed_fee_evidence",
        signature: "signature_mixed_fee_evidence",
      };
      await store.saveLeaderTrade(nextEvent);
      const nextIntent = new CopyEngine().decide(nextEvent, {
        followerWallet: FOLLOWER,
        copyRatioBps: 1_000,
        mode: "SHADOW",
      });
      await store.reserveIntent(nextIntent);
      const baseProvider = new MockJupiterOrderProvider(2n, 1n);
      const result = await new PaperTransactionSender({
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
      }).send(nextIntent);
      const futureFillId = await store.savePaperFillFromExecutionResult(result);
      expect(await store.applyPaperFill(futureFillId)).toBe("APPLIED");

      expect(store.getPaperFill(legacy.id)?.feeEvidence).toEqual({
        status: "AMOUNT_UNAVAILABLE",
        feeBps: 5,
        feeMint: intent.quoteMint,
      });
      expect(store.getPaperFill(futureFillId)?.feeEvidence).toEqual({
        status: "AVAILABLE",
        feeEvidenceContractId: FEE_EVIDENCE_CONTRACT_V1,
        feeBps: 5,
        feeMint: nextIntent.quoteMint,
        feeAmountRaw: 500n,
      });
      expect(
        database.sqlite
          .prepare(
            "SELECT fee_evidence_status, fee_evidence_contract_id, fee_amount_raw FROM paper_fills WHERE id = ?",
          )
          .get(legacy.id),
      ).toEqual({
        fee_evidence_status: "AMOUNT_UNAVAILABLE",
        fee_evidence_contract_id: null,
        fee_amount_raw: null,
      });
    } finally {
      database.close();
    }
  });

  it("persists V1 provenance for future unavailable evidence", async () => {
    const { database, store } = testStore("paper-fill-unavailable-provenance-");
    try {
      const { intent } = await reservedBuy(store);
      const result = await new PaperTransactionSender(
        new MockJupiterOrderProvider(2n, 1n),
      ).send(intent);
      const fillId = await store.savePaperFillFromExecutionResult(result);

      expect(store.getPaperFill(fillId)?.feeEvidence).toMatchObject({
        status: "AMOUNT_UNAVAILABLE",
        feeEvidenceContractId: FEE_EVIDENCE_CONTRACT_V1,
      });
      expect(
        database.sqlite
          .prepare(
            "SELECT fee_evidence_contract_id FROM paper_fills WHERE id = ?",
          )
          .get(fillId),
      ).toEqual({ fee_evidence_contract_id: FEE_EVIDENCE_CONTRACT_V1 });
    } finally {
      database.close();
    }
  });

  it("rejects a non-canonical WSOL PaperFill before persistence", async () => {
    const { database, store } = testStore("paper-fill-wsol-rejected-");
    try {
      const { event, intent } = await reservedBuy(store);

      await expect(
        store.savePaperFill(
          fillFor(event, intent, {
            id: "fill_wsol_rejected",
            inputMint: WSOL_MINT,
          }),
        ),
      ).rejects.toThrow("NON_CANONICAL_QUOTE_MINT");
      expect(store.getPaperFill("fill_wsol_rejected")).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("rejects a WSOL quote before domain trade persistence", async () => {
    const { database, store } = testStore("paper-trade-wsol-rejected-");
    try {
      await store.upsertWallet(LEADER_A, "LEADER", 1_000);
      const classification = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.jupiterBuy),
        ),
        LEADER_A,
      );
      if (!classification.accepted) throw new Error(classification.code);

      await expect(
        store.saveLeaderTrade({
          ...classification.event,
          quote: { ...classification.event.quote, mint: WSOL_MINT },
        }),
      ).rejects.toThrow("NON_CANONICAL_QUOTE_MINT");
      expect(store.count("leader_trades")).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects a WSOL reservation without creating a second position identity", async () => {
    const { database, store } = testStore("paper-reservation-wsol-rejected-");
    try {
      const { intent } = await reservedBuy(store);

      await expect(
        store.reserveIntent({
          ...intent,
          executionKey: "exec_non_canonical_wsol",
          quoteMint: WSOL_MINT,
        }),
      ).rejects.toThrow("NON_CANONICAL_QUOTE_MINT");
      expect(
        store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          intent.tokenMint,
          intent.quoteMint,
        ),
      ).toBeDefined();
      expect(
        store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          intent.tokenMint,
          WSOL_MINT,
        ),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("does not insert a second paper fill for the same intent", async () => {
    const { database, store } = testStore("paper-fill-intent-idempotent-");
    try {
      const { event, intent } = await reservedBuy(store);
      expect(
        await store.savePaperFill(fillFor(event, intent, { id: "fill_first" })),
      ).toBe(true);
      expect(
        await store.savePaperFill(
          fillFor(event, intent, { id: "fill_second" }),
        ),
      ).toBe(false);
      expect(store.getPaperFill("fill_second")).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("applies a persisted BUY fill to its position exactly once", async () => {
    const { database, store } = testStore("paper-fill-application-");
    try {
      const { event, intent } = await reservedBuy(store);
      const fill = fillFor(event, intent, { id: "fill_apply_once" });
      expect(await store.savePaperFill(fill)).toBe(true);

      expect(await store.applyPaperFill(fill.id)).toBe("APPLIED");
      expect(await store.applyPaperFill(fill.id)).toBe("ALREADY_APPLIED");
      expect(
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          intent.tokenMint,
          intent.quoteMint,
        ),
      ).toMatchObject({
        quantityRaw: 2_000_000n,
        reservedRaw: 0n,
        totalCostQuoteRaw: 100_000_000n,
        realizedPnlQuoteRaw: 0n,
        status: "OPEN",
      });
      expect(
        database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fill_applications")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("recovers an unapplied fill exactly once after SQLite close and reopen", async () => {
    const first = testStore("paper-fill-recovery-");
    const { event, intent } = await reservedBuy(first.store);
    const fill = fillFor(event, intent, { id: "fill_recovery" });
    await first.store.savePaperFill(fill);
    first.database.close();

    const reopenedDatabase = new SqliteDatabase({
      path: first.path,
      migrationsDirectory,
    });
    const reopenedStore = new PersistentStateStore(
      reopenedDatabase,
      new TestClock(),
      TEST_RISK_POLICY,
    );
    try {
      expect(await reopenedStore.recoverUnappliedPaperFills()).toBe(1);
      const recovered = reopenedStore.getPaperPosition(
        FOLLOWER,
        LEADER_A,
        intent.tokenMint,
        intent.quoteMint,
      );
      expect(recovered).toMatchObject({
        quantityRaw: fill.outputAmountRaw,
        totalCostQuoteRaw: fill.inputAmountRaw,
        realizedPnlQuoteRaw: 0n,
      });
      expect(await reopenedStore.recoverUnappliedPaperFills()).toBe(0);
      expect(
        reopenedStore.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          intent.tokenMint,
          intent.quoteMint,
        ),
      ).toEqual(recovered);
    } finally {
      reopenedDatabase.close();
    }
  });

  it("rolls back the application ledger when the position mutation fails", async () => {
    const { database, store } = testStore("paper-fill-atomic-rollback-");
    try {
      const { event, intent } = await reservedBuy(store);
      const fill = fillFor(event, intent, { id: "fill_atomic_rollback" });
      await store.savePaperFill(fill);
      database.sqlite.exec(`
        CREATE TRIGGER reject_paper_position_update
        BEFORE UPDATE OF accounting_policy_version ON follower_positions
        BEGIN
          SELECT RAISE(ABORT, 'injected position failure');
        END
      `);

      await expect(store.applyPaperFill(fill.id)).rejects.toThrow(
        "injected position failure",
      );
      expect(
        database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fill_applications")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          intent.tokenMint,
          intent.quoteMint,
        ),
      ).toMatchObject({ rawAmount: 0n });
      expect(
        database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fills")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("persists and applies a PaperFill only from a complete Jupiter order", async () => {
    const { database, store } = testStore("paper-fill-coordinator-");
    try {
      await store.upsertWallet(LEADER_A, "LEADER", 1_000);
      await store.upsertWallet(FOLLOWER, "FOLLOWER");
      const classification = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.jupiterBuy),
        ),
        LEADER_A,
      );
      if (!classification.accepted) throw new Error(classification.code);
      await store.saveLeaderTrade(classification.event);
      const intent = new CopyEngine().decide(classification.event, {
        followerWallet: FOLLOWER,
        copyRatioBps: 1_000,
        mode: "SHADOW",
      });

      const baseProvider = new MockJupiterOrderProvider(2n, 1n);
      const coordinator = new ExecutionCoordinator(
        store,
        new PaperTransactionSender({
          async getOrder(request) {
            return {
              ...(await baseProvider.getOrder(request)),
              feeBps: 5,
              feeMint: request.inputMint,
              platformFee: {
                amountRaw: 9_223_372_036_854_775_807n,
                feeBps: 5,
                feeMint: request.inputMint,
              },
            };
          },
        }),
      );
      const result = await coordinator.execute(intent);

      expect(result?.state).toBe("PAPER_EXECUTED");
      expect(
        database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fills")
          .get(),
      ).toEqual({ count: 1 });
      const persistedFillId = (
        database.sqlite.prepare("SELECT id FROM paper_fills").get() as {
          id: string;
        }
      ).id;
      expect(store.getPaperFill(persistedFillId)).toMatchObject({
        intentId: intent.executionKey,
        leaderTradeId: intent.leaderTradeId,
        leaderTxSignature: classification.event.signature,
        leaderWallet: LEADER_A,
        followerWallet: FOLLOWER,
        side: "BUY",
        inputMint: intent.quoteMint,
        outputMint: intent.tokenMint,
        inputAmountRaw: 100_000_000n,
        outputAmountRaw: 200_000_000n,
        feeEvidence: {
          status: "AVAILABLE",
          feeBps: 5,
          feeMint: intent.quoteMint,
          feeAmountRaw: 9_223_372_036_854_775_807n,
        },
        provider: "JUPITER_SWAP_V2_ORDER",
        fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
      });
      expect(store.getPaperFill(persistedFillId)).not.toHaveProperty(
        "transaction",
      );
      expect(
        database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fill_applications")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          intent.tokenMint,
          intent.quoteMint,
        ),
      ).toMatchObject({
        quantityRaw: 200_000_000n,
        totalCostQuoteRaw: 100_000_000n,
      });
      const beforeDuplicate = store.getPaperPosition(
        FOLLOWER,
        LEADER_A,
        intent.tokenMint,
        intent.quoteMint,
      );
      expect(await coordinator.execute(intent)).toBeUndefined();
      expect(
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          intent.tokenMint,
          intent.quoteMint,
        ),
      ).toEqual(beforeDuplicate);
      expect(
        database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM paper_fills")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("releases the exact persisted reservation after a second BUY fill", async () => {
    const { database, store } = testStore("paper-fill-buy-reservation-");
    try {
      await store.upsertWallet(LEADER_A, "LEADER", 1_000);
      await store.upsertWallet(FOLLOWER, "FOLLOWER");
      const classification = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.jupiterBuy),
        ),
        LEADER_A,
      );
      if (!classification.accepted) throw new Error(classification.code);
      const engine = new CopyEngine();
      const policy = {
        followerWallet: FOLLOWER,
        copyRatioBps: 1_000,
        mode: "SHADOW" as const,
      };
      await store.saveLeaderTrade(classification.event);
      const firstIntent = engine.decide(classification.event, policy);
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider(1n, 500n)),
      ).execute(firstIntent);

      const secondEvent = {
        ...classification.event,
        id: "leader_buy_second",
        signature: "signature_buy_second",
      };
      await store.saveLeaderTrade(secondEvent);
      const secondIntent = engine.decide(secondEvent, policy);
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider(1n, 500n)),
      ).execute(secondIntent);

      expect(
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          firstIntent.tokenMint,
          firstIntent.quoteMint,
        ),
      ).toMatchObject({
        quantityRaw: 400_000n,
        reservedRaw: 0n,
        totalCostQuoteRaw: 200_000_000n,
      });
    } finally {
      database.close();
    }
  });

  it("maps partial and full SELL fills to the verified BUY position with exact PnL", async () => {
    const { database, store } = testStore("paper-fill-sell-pipeline-");
    try {
      await store.upsertWallet(LEADER_A, "LEADER", 1_000);
      await store.upsertWallet(FOLLOWER, "FOLLOWER");
      const engine = new CopyEngine();
      const policy = {
        followerWallet: FOLLOWER,
        copyRatioBps: 1_000,
        mode: "SHADOW" as const,
      };

      const buyClassification = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.jupiterBuy),
        ),
        LEADER_A,
      );
      if (!buyClassification.accepted) throw new Error(buyClassification.code);
      await store.saveLeaderTrade(buyClassification.event);
      const buyIntent = engine.decide(buyClassification.event, policy);
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider(1n, 500n)),
      ).execute(buyIntent);
      expect(
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          buyIntent.tokenMint,
          buyIntent.quoteMint,
        ),
      ).toMatchObject({
        quantityRaw: 200_000n,
        totalCostQuoteRaw: 100_000_000n,
      });

      const partialClassification = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.partialSell),
        ),
        LEADER_A,
      );
      if (!partialClassification.accepted)
        throw new Error(partialClassification.code);
      await store.saveLeaderTrade(partialClassification.event);
      const partialIntent = engine.decide(
        partialClassification.event,
        policy,
        store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          buyIntent.tokenMint,
          buyIntent.quoteMint,
        ),
      );
      expect(partialIntent.theoreticalTokenRaw).toBe(50_000n);
      const partialCoordinator = new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider(600n, 1n)),
      );
      await partialCoordinator.execute(partialIntent);
      const afterPartial = store.getPaperPosition(
        FOLLOWER,
        LEADER_A,
        buyIntent.tokenMint,
        buyIntent.quoteMint,
      );
      expect(afterPartial).toMatchObject({
        quantityRaw: 150_000n,
        totalCostQuoteRaw: 75_000_000n,
        realizedPnlQuoteRaw: 5_000_000n,
        status: "OPEN",
      });
      expect(await partialCoordinator.execute(partialIntent)).toBeUndefined();
      expect(
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          buyIntent.tokenMint,
          buyIntent.quoteMint,
        ),
      ).toEqual(afterPartial);

      const fullClassification = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.fullSell),
        ),
        LEADER_A,
      );
      if (!fullClassification.accepted)
        throw new Error(fullClassification.code);
      await store.saveLeaderTrade(fullClassification.event);
      const fullIntent = engine.decide(
        fullClassification.event,
        policy,
        store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          buyIntent.tokenMint,
          buyIntent.quoteMint,
        ),
      );
      expect(fullIntent.theoreticalTokenRaw).toBe(150_000n);
      const fullCoordinator = new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider(400n, 1n)),
      );
      await fullCoordinator.execute(fullIntent);
      const closed = store.getPaperPosition(
        FOLLOWER,
        LEADER_A,
        buyIntent.tokenMint,
        buyIntent.quoteMint,
      );
      expect(closed).toMatchObject({
        quantityRaw: 0n,
        totalCostQuoteRaw: 0n,
        realizedPnlQuoteRaw: -10_000_000n,
        status: "CLOSED",
      });
      expect(await fullCoordinator.execute(fullIntent)).toBeUndefined();
      expect(
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          buyIntent.tokenMint,
          buyIntent.quoteMint,
        ),
      ).toEqual(closed);

      const negativeApplication = database.sqlite
        .prepare(
          `
          SELECT typeof(realized_pnl_delta_raw) AS storage_type,
                 realized_pnl_delta_raw, realized_pnl_after_raw
          FROM paper_fill_applications
          WHERE realized_pnl_delta_raw LIKE '-%'
        `,
        )
        .get();
      expect(negativeApplication).toEqual({
        storage_type: "text",
        realized_pnl_delta_raw: "-15000000",
        realized_pnl_after_raw: "-10000000",
      });
    } finally {
      database.close();
    }
  });

  it("keeps BUY positions with different quote mints as distinct identities", async () => {
    const { database, store } = testStore("paper-fill-cross-quote-");
    try {
      await store.upsertWallet(LEADER_A, "LEADER", 1_000);
      await store.upsertWallet(FOLLOWER, "FOLLOWER");
      const classification = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.jupiterBuy),
        ),
        LEADER_A,
      );
      if (!classification.accepted) throw new Error(classification.code);
      const engine = new CopyEngine();
      const policy = {
        followerWallet: FOLLOWER,
        copyRatioBps: 1_000,
        mode: "SHADOW" as const,
      };
      await store.saveLeaderTrade(classification.event);
      const nativeIntent = engine.decide(classification.event, policy);
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider(1n, 500n)),
      ).execute(nativeIntent);

      const usdcEvent = {
        ...classification.event,
        id: "leader_buy_usdc",
        signature: "signature_buy_usdc",
        quote: {
          mint: USDC_MINT,
          raw: 50_000_000n,
          decimals: 6,
        },
      };
      await store.saveLeaderTrade(usdcEvent);
      const usdcIntent = engine.decide(usdcEvent, policy);
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider(1n, 250n)),
      ).execute(usdcIntent);

      expect(
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          nativeIntent.tokenMint,
          nativeIntent.quoteMint,
        )?.totalCostQuoteRaw,
      ).toBe(100_000_000n);
      expect(
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          usdcIntent.tokenMint,
          usdcIntent.quoteMint,
        )?.totalCostQuoteRaw,
      ).toBe(5_000_000n);
      expect(
        database.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM follower_positions WHERE raw_amount <> '0'",
          )
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it("keeps a positive legacy position isolated without mutating its balance", async () => {
    const { database, store } = testStore("paper-fill-legacy-isolation-");
    try {
      const { intent } = await reservedBuy(store);
      database.sqlite
        .prepare(
          `
          UPDATE follower_positions
          SET raw_amount = '9007199254740993', quote_mint = NULL,
              total_cost_quote_raw = NULL, realized_pnl_quote_raw = NULL,
              accounting_policy_version = NULL
        `,
        )
        .run();

      const legacy = store.getFollowerPosition(
        FOLLOWER,
        LEADER_A,
        intent.tokenMint,
        intent.quoteMint,
      );
      expect(legacy).toMatchObject({
        rawAmount: 9_007_199_254_740_993n,
      });
      expect(legacy).not.toHaveProperty("accountingPolicyVersion");
      expect(() =>
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          intent.tokenMint,
          intent.quoteMint,
        ),
      ).toThrowError("LEGACY_POSITION_COST_BASIS_UNAVAILABLE");
      expect(
        database.sqlite
          .prepare(
            `
            SELECT raw_amount, quote_mint, total_cost_quote_raw,
                   realized_pnl_quote_raw, accounting_policy_version
            FROM follower_positions
          `,
          )
          .get(),
      ).toEqual({
        raw_amount: "9007199254740993",
        quote_mint: null,
        total_cost_quote_raw: null,
        realized_pnl_quote_raw: null,
        accounting_policy_version: null,
      });

      const sellClassification = new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(MAINNET_FIXTURES.partialSell),
        ),
        LEADER_A,
      );
      if (!sellClassification.accepted)
        throw new Error(sellClassification.code);
      await store.saveLeaderTrade(sellClassification.event);
      const sellIntent = new CopyEngine().decide(
        sellClassification.event,
        {
          followerWallet: FOLLOWER,
          copyRatioBps: 1_000,
          mode: "SHADOW",
        },
        legacy,
      );
      expect(sellIntent.skipReason).toBe(
        "LEGACY_POSITION_COST_BASIS_UNAVAILABLE",
      );
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider()),
      ).execute(sellIntent);

      expect(
        store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          intent.tokenMint,
          intent.quoteMint,
        ),
      ).toMatchObject({ rawAmount: 9_007_199_254_740_993n });
      expect(
        database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM follower_positions")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it.each([
    ["NO_PROVIDER", undefined, "PAPER_FILL_QUOTE_REQUIRED"],
    [
      "QUOTE_FAILURE",
      {
        async getOrder() {
          throw new Error("quote unavailable");
        },
      },
      "JUPITER_ORDER_FAILED",
    ],
    [
      "INVALID_SCHEMA",
      new MockJupiterOrderProvider(0n, 1n),
      "JUPITER_SCHEMA_INVALID",
    ],
  ])(
    "%s leaves PaperFill, Position, and PnL unchanged",
    async (name, provider, reason) => {
      const { database, store } = testStore(`paper-fill-${name}-`);
      try {
        await store.upsertWallet(LEADER_A, "LEADER", 1_000);
        await store.upsertWallet(FOLLOWER, "FOLLOWER");
        const classification = new SwapClassifier().classify(
          new TransactionNormalizer(new TestClock()).normalize(
            envelope(MAINNET_FIXTURES.jupiterBuy),
          ),
          LEADER_A,
        );
        if (!classification.accepted) throw new Error(classification.code);
        await store.saveLeaderTrade(classification.event);
        const intent = new CopyEngine().decide(classification.event, {
          followerWallet: FOLLOWER,
          copyRatioBps: 1_000,
          mode: "SHADOW",
        });

        const result = await new ExecutionCoordinator(
          store,
          new PaperTransactionSender(provider),
        ).execute(intent);

        expect(result).toMatchObject({
          state: "FAILED",
          reason,
          executedTokenRaw: 0n,
          executedQuoteRaw: 0n,
        });
        expect(
          database.sqlite
            .prepare("SELECT COUNT(*) AS count FROM paper_fills")
            .get(),
        ).toEqual({ count: 0 });
        expect(
          database.sqlite
            .prepare("SELECT COUNT(*) AS count FROM paper_fill_applications")
            .get(),
        ).toEqual({ count: 0 });
        expect(
          store.getPaperPosition(
            FOLLOWER,
            LEADER_A,
            intent.tokenMint,
            intent.quoteMint,
          ),
        ).toBeUndefined();
        expect(
          store.getFollowerPosition(
            FOLLOWER,
            LEADER_A,
            intent.tokenMint,
            intent.quoteMint,
          ),
        ).toMatchObject({ rawAmount: 0n, reservedRawAmount: 0n });
      } finally {
        database.close();
      }
    },
  );

  it.each([
    [
      "provider failure",
      {
        async getOrder() {
          throw new Error("quote unavailable");
        },
      },
      "JUPITER_ORDER_FAILED",
    ],
    [
      "invalid Jupiter schema",
      new MockJupiterOrderProvider(0n, 1n),
      "JUPITER_SCHEMA_INVALID",
    ],
  ])(
    "releases a SELL reservation after %s",
    async (_name, provider, reason) => {
      const { database, store } = testStore("paper-sell-provider-failure-");
      try {
        await store.upsertWallet(LEADER_A, "LEADER", 1_000);
        await store.upsertWallet(FOLLOWER, "FOLLOWER");
        const engine = new CopyEngine();
        const policy = {
          followerWallet: FOLLOWER,
          copyRatioBps: 1_000,
          mode: "SHADOW" as const,
        };
        const normalizer = new TransactionNormalizer(new TestClock());
        const classifier = new SwapClassifier();
        const buy = classifier.classify(
          normalizer.normalize(envelope(MAINNET_FIXTURES.jupiterBuy)),
          LEADER_A,
        );
        if (!buy.accepted) throw new Error(buy.code);
        await store.saveLeaderTrade(buy.event);
        const buyIntent = engine.decide(buy.event, policy);
        await new ExecutionCoordinator(
          store,
          new PaperTransactionSender(new MockJupiterOrderProvider(1n, 500n)),
        ).execute(buyIntent);

        const sell = classifier.classify(
          normalizer.normalize(envelope(MAINNET_FIXTURES.partialSell)),
          LEADER_A,
        );
        if (!sell.accepted) throw new Error(sell.code);
        await store.saveLeaderTrade(sell.event);
        const before = store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          buyIntent.tokenMint,
          buyIntent.quoteMint,
        );
        const sellIntent = engine.decide(
          sell.event,
          policy,
          store.getFollowerPosition(
            FOLLOWER,
            LEADER_A,
            buyIntent.tokenMint,
            buyIntent.quoteMint,
          ),
        );

        const result = await new ExecutionCoordinator(
          store,
          new PaperTransactionSender(provider),
        ).execute(sellIntent);

        expect(result).toMatchObject({
          state: "FAILED",
          reason,
        });
        expect(
          store.getPaperPosition(
            FOLLOWER,
            LEADER_A,
            buyIntent.tokenMint,
            buyIntent.quoteMint,
          ),
        ).toMatchObject({
          quantityRaw: before?.quantityRaw,
          reservedRaw: 0n,
          totalCostQuoteRaw: before?.totalCostQuoteRaw,
          realizedPnlQuoteRaw: before?.realizedPnlQuoteRaw,
          status: before?.status,
        });
        expect(
          store.getFollowerPosition(
            FOLLOWER,
            LEADER_A,
            buyIntent.tokenMint,
            buyIntent.quoteMint,
          )?.reservedRawAmount,
        ).toBe(0n);
      } finally {
        database.close();
      }
    },
  );

  it("does not reserve a SIZE_ROUNDED_TO_ZERO SELL", async () => {
    const { database, store } = testStore("paper-sell-rounded-zero-");
    try {
      await store.upsertWallet(LEADER_A, "LEADER", 1_000);
      await store.upsertWallet(FOLLOWER, "FOLLOWER");
      const engine = new CopyEngine();
      const policy = {
        followerWallet: FOLLOWER,
        copyRatioBps: 1_000,
        mode: "SHADOW" as const,
      };
      const normalizer = new TransactionNormalizer(new TestClock());
      const classifier = new SwapClassifier();
      const buy = classifier.classify(
        normalizer.normalize(envelope(MAINNET_FIXTURES.jupiterBuy)),
        LEADER_A,
      );
      if (!buy.accepted) throw new Error(buy.code);
      await store.saveLeaderTrade(buy.event);
      const buyIntent = engine.decide(buy.event, policy);
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider(1n, 500n)),
      ).execute(buyIntent);

      const sell = classifier.classify(
        normalizer.normalize(envelope(MAINNET_FIXTURES.partialSell)),
        LEADER_A,
      );
      if (!sell.accepted) throw new Error(sell.code);
      const roundedEvent = {
        ...sell.event,
        id: "leader_sell_rounded_zero",
        signature: "signature_sell_rounded_zero",
        token: { ...sell.event.token, raw: 1n },
        leaderPreTokenRaw: 1_000_000_000_000n,
      };
      await store.saveLeaderTrade(roundedEvent);
      const before = store.getPaperPosition(
        FOLLOWER,
        LEADER_A,
        buyIntent.tokenMint,
        buyIntent.quoteMint,
      );
      const intent = engine.decide(
        roundedEvent,
        policy,
        store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          buyIntent.tokenMint,
          buyIntent.quoteMint,
        ),
      );
      expect(intent.skipReason).toBe("SIZE_ROUNDED_TO_ZERO");

      const result = await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider()),
      ).execute(intent);

      expect(result).toMatchObject({
        state: "SKIPPED",
        reason: "SIZE_ROUNDED_TO_ZERO",
      });
      expect(
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          buyIntent.tokenMint,
          buyIntent.quoteMint,
        ),
      ).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("keeps a SELL reservation consistent across application rollback and recovery", async () => {
    const { database, store } = testStore("paper-sell-application-recovery-");
    try {
      await store.upsertWallet(LEADER_A, "LEADER", 1_000);
      await store.upsertWallet(FOLLOWER, "FOLLOWER");
      const engine = new CopyEngine();
      const policy = {
        followerWallet: FOLLOWER,
        copyRatioBps: 1_000,
        mode: "SHADOW" as const,
      };
      const normalizer = new TransactionNormalizer(new TestClock());
      const classifier = new SwapClassifier();
      const buy = classifier.classify(
        normalizer.normalize(envelope(MAINNET_FIXTURES.jupiterBuy)),
        LEADER_A,
      );
      if (!buy.accepted) throw new Error(buy.code);
      await store.saveLeaderTrade(buy.event);
      const buyIntent = engine.decide(buy.event, policy);
      await new ExecutionCoordinator(
        store,
        new PaperTransactionSender(new MockJupiterOrderProvider(1n, 500n)),
      ).execute(buyIntent);

      const sell = classifier.classify(
        normalizer.normalize(envelope(MAINNET_FIXTURES.partialSell)),
        LEADER_A,
      );
      if (!sell.accepted) throw new Error(sell.code);
      await store.saveLeaderTrade(sell.event);
      const before = store.getPaperPosition(
        FOLLOWER,
        LEADER_A,
        buyIntent.tokenMint,
        buyIntent.quoteMint,
      );
      if (!before) throw new Error("expected BUY position");
      const sellIntent = engine.decide(
        sell.event,
        policy,
        store.getFollowerPosition(
          FOLLOWER,
          LEADER_A,
          buyIntent.tokenMint,
          buyIntent.quoteMint,
        ),
      );
      await expect(
        new ExecutionCoordinator(
          store,
          new PaperTransactionSender(new MockJupiterOrderProvider(600n, 1n)),
          "AFTER_FILL",
        ).execute(sellIntent),
      ).rejects.toThrow("Injected crash at AFTER_FILL");
      expect(
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          buyIntent.tokenMint,
          buyIntent.quoteMint,
        ),
      ).toMatchObject({
        quantityRaw: before.quantityRaw,
        reservedRaw: sellIntent.theoreticalTokenRaw,
        totalCostQuoteRaw: before.totalCostQuoteRaw,
      });

      database.sqlite.exec(`
        CREATE TRIGGER reject_sell_paper_position_update
        BEFORE UPDATE OF accounting_policy_version ON follower_positions
        BEGIN
          SELECT RAISE(ABORT, 'injected SELL position failure');
        END
      `);
      await expect(store.recoverUnappliedPaperFills()).rejects.toThrow(
        "injected SELL position failure",
      );
      expect(
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          buyIntent.tokenMint,
          buyIntent.quoteMint,
        ),
      ).toMatchObject({
        quantityRaw: before.quantityRaw,
        reservedRaw: sellIntent.theoreticalTokenRaw,
        totalCostQuoteRaw: before.totalCostQuoteRaw,
      });

      database.sqlite.exec("DROP TRIGGER reject_sell_paper_position_update");
      expect(await store.recoverUnappliedPaperFills()).toBe(1);
      expect(
        store.getPaperPosition(
          FOLLOWER,
          LEADER_A,
          buyIntent.tokenMint,
          buyIntent.quoteMint,
        ),
      ).toMatchObject({
        quantityRaw: before.quantityRaw - sellIntent.theoreticalTokenRaw,
        reservedRaw: 0n,
        totalCostQuoteRaw: 75_000_000n,
        realizedPnlQuoteRaw: 5_000_000n,
      });
      expect(await store.recoverUnappliedPaperFills()).toBe(0);
    } finally {
      database.close();
    }
  });
});
