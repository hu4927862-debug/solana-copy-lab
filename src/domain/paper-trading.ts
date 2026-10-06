import type { TradeSide } from "./trades.js";
import type { FeeEvidenceUnavailableReason } from "./execution.js";
import { Decimal } from "decimal.js";
import { canonicalDomainQuoteMint } from "./assets.js";

export const PAPER_FILL_POLICY_VERSION =
  "JUPITER_ORDER_QUOTE_AS_FILL_V1" as const;
export const PAPER_ACCOUNTING_POLICY_VERSION = "WEIGHTED_AVERAGE_V1" as const;

export interface PaperFeeEvidence {
  readonly status: "AVAILABLE" | "AMOUNT_UNAVAILABLE";
  readonly feeEvidenceContractId?: string;
  readonly feeBps?: number;
  readonly feeMint?: string;
  readonly feeAmountRaw?: bigint;
  readonly unavailableReason?: FeeEvidenceUnavailableReason;
}

export interface PaperFill {
  readonly id: string;
  readonly intentId: string;
  readonly leaderTradeId: string;
  readonly leaderTxSignature: string;
  readonly leaderWallet: string;
  readonly followerWallet: string;
  readonly side: TradeSide;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly tokenDecimals: number;
  readonly quoteDecimals: number;
  readonly inputAmountRaw: bigint;
  readonly outputAmountRaw: bigint;
  readonly quoteRequestTimestampMs: number;
  readonly quoteTimestampMs: number;
  readonly quoteRttMs: number;
  readonly feeEvidence: PaperFeeEvidence;
  readonly provider: string;
  readonly requestId?: string;
  readonly fillPolicyVersion: typeof PAPER_FILL_POLICY_VERSION;
  readonly createdAtMs: number;
}

export interface PaperPosition {
  readonly followerWallet: string;
  readonly leaderWallet: string;
  readonly tokenMint: string;
  readonly quoteMint: string;
  readonly tokenDecimals: number;
  readonly quoteDecimals: number;
  readonly quantityRaw: bigint;
  readonly reservedRaw: bigint;
  readonly totalCostQuoteRaw: bigint;
  readonly realizedPnlQuoteRaw: bigint;
  readonly averageEntry: string | null;
  readonly openedAtMs: number | null;
  readonly updatedAtMs: number;
  readonly closedAtMs: number | null;
  readonly status: "OPEN" | "CLOSED";
  readonly accountingPolicyVersion: typeof PAPER_ACCOUNTING_POLICY_VERSION;
  readonly version: number;
}

export interface PaperPositionChange {
  readonly transition: "OPEN" | "ADD" | "REDUCE" | "CLOSE";
  readonly position: PaperPosition;
  readonly allocatedCostBasisRaw: bigint;
  readonly proceedsRaw: bigint;
  readonly realizedPnlDeltaRaw: bigint;
}

export type UnrealizedPnl =
  | { readonly status: "PRICE_UNAVAILABLE" }
  | {
      readonly status: "AVAILABLE";
      readonly positionValueQuoteRaw: bigint;
      readonly unrealizedPnlQuoteRaw: bigint;
    };

export function calculateUnrealizedPnl(
  position: PaperPosition,
  mark?: { readonly positionValueQuoteRaw: bigint },
): UnrealizedPnl {
  if (mark === undefined) return { status: "PRICE_UNAVAILABLE" };
  return {
    status: "AVAILABLE",
    positionValueQuoteRaw: mark.positionValueQuoteRaw,
    unrealizedPnlQuoteRaw:
      mark.positionValueQuoteRaw - position.totalCostQuoteRaw,
  };
}

function averageEntry(
  totalCostQuoteRaw: bigint,
  quantityRaw: bigint,
  tokenDecimals: number,
  quoteDecimals: number,
): string | null {
  if (quantityRaw === 0n) return null;
  return new Decimal(totalCostQuoteRaw.toString())
    .mul(new Decimal(10).pow(tokenDecimals))
    .div(
      new Decimal(quantityRaw.toString()).mul(
        new Decimal(10).pow(quoteDecimals),
      ),
    )
    .toString();
}

export function applyPaperFill(
  current: PaperPosition | undefined,
  fill: PaperFill,
): PaperPositionChange {
  const quoteMint = fill.side === "BUY" ? fill.inputMint : fill.outputMint;
  if (canonicalDomainQuoteMint(quoteMint) !== quoteMint) {
    throw new Error("NON_CANONICAL_QUOTE_MINT");
  }
  if (fill.inputAmountRaw <= 0n || fill.outputAmountRaw <= 0n) {
    throw new Error("NON_POSITIVE_FILL_AMOUNT");
  }
  if (fill.side === "BUY") {
    if (
      current !== undefined &&
      (current.followerWallet !== fill.followerWallet ||
        current.leaderWallet !== fill.leaderWallet ||
        current.tokenMint !== fill.outputMint ||
        current.quoteMint !== fill.inputMint)
    ) {
      throw new Error("POSITION_IDENTITY_MISMATCH");
    }
    if (
      current !== undefined &&
      (current.tokenDecimals !== fill.tokenDecimals ||
        current.quoteDecimals !== fill.quoteDecimals)
    ) {
      throw new Error("POSITION_DECIMALS_MISMATCH");
    }
    const reopening = current?.status === "CLOSED";
    if (
      reopening &&
      (current.quantityRaw !== 0n || current.totalCostQuoteRaw !== 0n)
    ) {
      throw new Error("CLOSED_POSITION_HAS_BALANCE");
    }
    const quantityRaw =
      (reopening ? 0n : (current?.quantityRaw ?? 0n)) + fill.outputAmountRaw;
    const totalCostQuoteRaw =
      (reopening ? 0n : (current?.totalCostQuoteRaw ?? 0n)) +
      fill.inputAmountRaw;
    return {
      transition: current === undefined || reopening ? "OPEN" : "ADD",
      position: {
        followerWallet: fill.followerWallet,
        leaderWallet: fill.leaderWallet,
        tokenMint: fill.outputMint,
        quoteMint: fill.inputMint,
        tokenDecimals: fill.tokenDecimals,
        quoteDecimals: fill.quoteDecimals,
        quantityRaw,
        reservedRaw: reopening ? 0n : (current?.reservedRaw ?? 0n),
        totalCostQuoteRaw,
        realizedPnlQuoteRaw: current?.realizedPnlQuoteRaw ?? 0n,
        averageEntry: averageEntry(
          totalCostQuoteRaw,
          quantityRaw,
          fill.tokenDecimals,
          fill.quoteDecimals,
        ),
        openedAtMs:
          current === undefined || reopening
            ? fill.createdAtMs
            : current.openedAtMs,
        updatedAtMs: fill.createdAtMs,
        closedAtMs: null,
        status: "OPEN",
        accountingPolicyVersion: PAPER_ACCOUNTING_POLICY_VERSION,
        version: (current?.version ?? 0) + 1,
      },
      allocatedCostBasisRaw: 0n,
      proceedsRaw: 0n,
      realizedPnlDeltaRaw: 0n,
    };
  }

  if (current === undefined || current.status !== "OPEN") {
    throw new Error("NO_MAPPED_POSITION");
  }
  if (
    current.followerWallet !== fill.followerWallet ||
    current.leaderWallet !== fill.leaderWallet ||
    current.tokenMint !== fill.inputMint ||
    current.quoteMint !== fill.outputMint
  ) {
    throw new Error("POSITION_IDENTITY_MISMATCH");
  }
  if (
    current.tokenDecimals !== fill.tokenDecimals ||
    current.quoteDecimals !== fill.quoteDecimals
  ) {
    throw new Error("POSITION_DECIMALS_MISMATCH");
  }
  if (fill.inputAmountRaw > current.quantityRaw) {
    throw new Error("SELL_EXCEEDS_POSITION");
  }
  const quantityRaw = current.quantityRaw - fill.inputAmountRaw;
  const allocatedCostBasisRaw =
    quantityRaw === 0n
      ? current.totalCostQuoteRaw
      : (current.totalCostQuoteRaw * fill.inputAmountRaw) / current.quantityRaw;
  const totalCostQuoteRaw = current.totalCostQuoteRaw - allocatedCostBasisRaw;
  const realizedPnlDeltaRaw = fill.outputAmountRaw - allocatedCostBasisRaw;
  const realizedPnlQuoteRaw = current.realizedPnlQuoteRaw + realizedPnlDeltaRaw;
  const closed = quantityRaw === 0n;
  return {
    transition: closed ? "CLOSE" : "REDUCE",
    position: {
      ...current,
      quantityRaw,
      reservedRaw:
        current.reservedRaw > fill.inputAmountRaw
          ? current.reservedRaw - fill.inputAmountRaw
          : 0n,
      totalCostQuoteRaw,
      realizedPnlQuoteRaw,
      averageEntry: averageEntry(
        totalCostQuoteRaw,
        quantityRaw,
        current.tokenDecimals,
        current.quoteDecimals,
      ),
      updatedAtMs: fill.createdAtMs,
      closedAtMs: closed ? fill.createdAtMs : null,
      status: closed ? "CLOSED" : "OPEN",
      version: current.version + 1,
    },
    allocatedCostBasisRaw,
    proceedsRaw: fill.outputAmountRaw,
    realizedPnlDeltaRaw,
  };
}
