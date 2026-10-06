import { describe, expect, it } from "vitest";
import {
  applyPaperFill,
  calculateUnrealizedPnl,
  type PaperFill,
} from "../../src/domain/paper-trading.js";
import { NATIVE_SOL, WSOL_MINT } from "../../src/domain/assets.js";
import {
  FOLLOWER,
  LEADER_A,
  TOKEN_MINT,
} from "../fixtures/mainnet-fixtures.js";

function buyFill(overrides: Partial<PaperFill> = {}): PaperFill {
  return {
    id: "fill_buy_1",
    intentId: "intent_buy_1",
    leaderTradeId: "leader_buy_1",
    leaderTxSignature: "signature_buy_1",
    leaderWallet: LEADER_A,
    followerWallet: FOLLOWER,
    side: "BUY",
    inputMint: NATIVE_SOL,
    outputMint: TOKEN_MINT,
    tokenDecimals: 0,
    quoteDecimals: 0,
    inputAmountRaw: 200n,
    outputAmountRaw: 100n,
    quoteRequestTimestampMs: 1_000,
    quoteTimestampMs: 1_125,
    quoteRttMs: 125,
    feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
    provider: "JUPITER_SWAP_V2_ORDER",
    fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
    createdAtMs: 1_125,
    ...overrides,
  };
}

function sellFill(overrides: Partial<PaperFill> = {}): PaperFill {
  return {
    ...buyFill(),
    id: "fill_sell_1",
    intentId: "intent_sell_1",
    leaderTradeId: "leader_sell_1",
    leaderTxSignature: "signature_sell_1",
    side: "SELL",
    inputMint: TOKEN_MINT,
    outputMint: NATIVE_SOL,
    inputAmountRaw: 25n,
    outputAmountRaw: 75n,
    createdAtMs: 3_000,
    ...overrides,
  };
}

describe("applyPaperFill", () => {
  it("creates an open position from the first BUY", () => {
    const change = applyPaperFill(undefined, buyFill());

    expect(change.transition).toBe("OPEN");
    expect(change.position).toMatchObject({
      followerWallet: FOLLOWER,
      leaderWallet: LEADER_A,
      tokenMint: TOKEN_MINT,
      quoteMint: NATIVE_SOL,
      quantityRaw: 100n,
      reservedRaw: 0n,
      totalCostQuoteRaw: 200n,
      realizedPnlQuoteRaw: 0n,
      averageEntry: "2",
      openedAtMs: 1_125,
      updatedAtMs: 1_125,
      closedAtMs: null,
      status: "OPEN",
      accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
      version: 1,
    });
  });

  it("adds a second BUY using weighted-average cost", () => {
    const first = applyPaperFill(undefined, buyFill()).position;
    const change = applyPaperFill(
      first,
      buyFill({
        id: "fill_buy_2",
        intentId: "intent_buy_2",
        inputAmountRaw: 400n,
        outputAmountRaw: 100n,
        createdAtMs: 2_000,
      }),
    );

    expect(change.transition).toBe("ADD");
    expect(change.position).toMatchObject({
      quantityRaw: 200n,
      totalCostQuoteRaw: 600n,
      realizedPnlQuoteRaw: 0n,
      averageEntry: "3",
      openedAtMs: 1_125,
      updatedAtMs: 2_000,
      status: "OPEN",
      version: 2,
    });
  });

  it("does not add informational fee evidence to BUY cost", () => {
    const change = applyPaperFill(
      undefined,
      buyFill({
        feeEvidence: {
          status: "AVAILABLE",
          feeMint: NATIVE_SOL,
          feeAmountRaw: 99n,
        },
      }),
    );

    expect(change.position.totalCostQuoteRaw).toBe(200n);
  });

  it("applies a partial SELL with weighted-average cost allocation and realized PnL", () => {
    const current = applyPaperFill(undefined, buyFill()).position;
    const change = applyPaperFill(current, sellFill());

    expect(change).toMatchObject({
      transition: "REDUCE",
      allocatedCostBasisRaw: 50n,
      proceedsRaw: 75n,
      realizedPnlDeltaRaw: 25n,
      position: {
        quantityRaw: 75n,
        totalCostQuoteRaw: 150n,
        realizedPnlQuoteRaw: 25n,
        averageEntry: "2",
        openedAtMs: 1_125,
        updatedAtMs: 3_000,
        closedAtMs: null,
        status: "OPEN",
        version: 2,
      },
    });
  });

  it("does not subtract informational fee evidence from SELL proceeds or PnL", () => {
    const current = applyPaperFill(undefined, buyFill()).position;
    const change = applyPaperFill(
      current,
      sellFill({
        feeEvidence: {
          status: "AVAILABLE",
          feeEvidenceContractId: "FEE_EVIDENCE_CONTRACT_V1",
          feeMint: NATIVE_SOL,
          feeAmountRaw: 99n,
        },
      }),
    );

    expect(change.proceedsRaw).toBe(75n);
    expect(change.realizedPnlDeltaRaw).toBe(25n);
    expect(change.position.realizedPnlQuoteRaw).toBe(25n);
  });

  it("produces identical accounting with legacy and prospective fee provenance", () => {
    const legacyBuy = applyPaperFill(undefined, buyFill()).position;
    const prospectiveBuy = applyPaperFill(
      undefined,
      buyFill({
        feeEvidence: {
          status: "AVAILABLE",
          feeEvidenceContractId: "FEE_EVIDENCE_CONTRACT_V1",
          feeBps: 5,
          feeMint: NATIVE_SOL,
          feeAmountRaw: 99n,
        },
      }),
    ).position;
    const legacySell = applyPaperFill(legacyBuy, sellFill());
    const prospectiveSell = applyPaperFill(
      prospectiveBuy,
      sellFill({
        feeEvidence: {
          status: "AVAILABLE",
          feeEvidenceContractId: "FEE_EVIDENCE_CONTRACT_V1",
          feeBps: 5,
          feeMint: NATIVE_SOL,
          feeAmountRaw: 999_999n,
        },
      }),
    );

    expect(prospectiveBuy).toEqual(legacyBuy);
    expect(prospectiveSell).toEqual(legacySell);
  });

  it("closes a position on a 100% SELL and allocates all remaining cost", () => {
    const current = applyPaperFill(undefined, buyFill()).position;
    const change = applyPaperFill(
      current,
      sellFill({ inputAmountRaw: 100n, outputAmountRaw: 150n }),
    );

    expect(change).toMatchObject({
      transition: "CLOSE",
      allocatedCostBasisRaw: 200n,
      proceedsRaw: 150n,
      realizedPnlDeltaRaw: -50n,
      position: {
        quantityRaw: 0n,
        totalCostQuoteRaw: 0n,
        realizedPnlQuoteRaw: -50n,
        averageEntry: null,
        closedAtMs: 3_000,
        status: "CLOSED",
      },
    });
  });

  it("reopens a CLOSED position while preserving lifetime realized PnL", () => {
    const opened = applyPaperFill(undefined, buyFill()).position;
    const closed = applyPaperFill(
      opened,
      sellFill({ inputAmountRaw: 100n, outputAmountRaw: 150n }),
    ).position;
    const change = applyPaperFill(
      closed,
      buyFill({
        id: "fill_buy_reopen",
        intentId: "intent_buy_reopen",
        inputAmountRaw: 80n,
        outputAmountRaw: 40n,
        createdAtMs: 4_000,
      }),
    );

    expect(change).toMatchObject({
      transition: "OPEN",
      position: {
        quantityRaw: 40n,
        totalCostQuoteRaw: 80n,
        realizedPnlQuoteRaw: -50n,
        averageEntry: "2",
        openedAtMs: 4_000,
        updatedAtMs: 4_000,
        closedAtMs: null,
        status: "OPEN",
        version: 3,
      },
    });
  });

  it("rounds partial cost allocation down and leaves all remainder in the position", () => {
    const current = applyPaperFill(
      undefined,
      buyFill({ inputAmountRaw: 100n, outputAmountRaw: 3n }),
    ).position;
    const change = applyPaperFill(
      current,
      sellFill({ inputAmountRaw: 1n, outputAmountRaw: 40n }),
    );

    expect(change.allocatedCostBasisRaw).toBe(33n);
    expect(change.position.quantityRaw).toBe(2n);
    expect(change.position.totalCostQuoteRaw).toBe(67n);
    expect(change.realizedPnlDeltaRaw).toBe(7n);
  });

  it("rejects zero-sized fills instead of creating accounting dust", () => {
    expect(() =>
      applyPaperFill(
        undefined,
        buyFill({ inputAmountRaw: 1n, outputAmountRaw: 0n }),
      ),
    ).toThrowError("NON_POSITIVE_FILL_AMOUNT");
  });

  it("reports unavailable unrealized PnL without a reliable mark", () => {
    const position = applyPaperFill(undefined, buyFill()).position;

    expect(calculateUnrealizedPnl(position)).toEqual({
      status: "PRICE_UNAVAILABLE",
    });
  });

  it("fails closed when decimals drift for the same position identity", () => {
    const position = applyPaperFill(undefined, buyFill()).position;

    expect(() =>
      applyPaperFill(
        position,
        buyFill({
          id: "fill_decimal_drift",
          intentId: "intent_decimal_drift",
          tokenDecimals: 1,
        }),
      ),
    ).toThrowError("POSITION_DECIMALS_MISMATCH");
  });

  it("rejects WSOL as a domain PaperFill quote identity", () => {
    expect(() =>
      applyPaperFill(undefined, buyFill({ inputMint: WSOL_MINT })),
    ).toThrowError("NON_CANONICAL_QUOTE_MINT");
  });
});
