import type { AssetAmount, AssetDelta } from "./assets.js";
import type { TradeTimestamps } from "./time.js";

export type TradeSide = "BUY" | "SELL";
export type DexName = "JUPITER" | "RAYDIUM" | "PUMP_FUN" | "PUMP_SWAP";

export interface Trade {
  readonly id: string;
  readonly signature: string;
  readonly eventIndex: number;
  readonly slot: bigint;
  readonly wallet: string;
  readonly side: TradeSide;
  readonly token: AssetAmount;
  readonly quote: AssetAmount;
  readonly dex: DexName;
  readonly timestamps: TradeTimestamps;
}

export interface LeaderTrade extends Trade {
  readonly leaderWallet: string;
  readonly leaderPreTokenRaw: bigint;
  readonly sourcePrice?: string;
  readonly evidence: readonly string[];
}

export interface FollowerTrade extends Trade {
  readonly leaderTradeId: string;
  readonly followerWallet: string;
  readonly executionKey: string;
  readonly copyRatioBps: number;
  readonly executionPrice?: string;
}

export interface SwapEvent {
  readonly id: string;
  readonly signature: string;
  readonly eventIndex: number;
  readonly slot: bigint;
  readonly leaderWallet: string;
  readonly side: TradeSide;
  readonly token: AssetAmount;
  readonly quote: AssetAmount;
  readonly leaderPreTokenRaw: bigint;
  readonly deltas: readonly AssetDelta[];
  readonly dex: DexName;
  readonly evidence: readonly string[];
  readonly timestamps: TradeTimestamps;
}

export type SwapRejectionCode =
  | "TRANSACTION_FAILED"
  | "LEADER_NOT_SIGNER"
  | "AMBIGUOUS_OWNERSHIP"
  | "NO_ASSET_DELTA"
  | "UNKNOWN_SWAP_PROGRAM"
  | "NO_SWAP_EVIDENCE"
  | "NO_QUOTE_ASSET"
  | "TOKEN_TO_TOKEN"
  | "ORDINARY_TRANSFER"
  | "LIQUIDITY_OPERATION"
  | "STAKE_OR_LENDING"
  | "MISSING_DECIMALS"
  | "UNSUPPORTED_TOKEN_2022"
  | "AMBIGUOUS_DIRECTION"
  | "NATIVE_SOL_PRINCIPAL_UNAVAILABLE";

export type SwapClassification =
  | { readonly accepted: true; readonly event: SwapEvent }
  | {
      readonly accepted: false;
      readonly code: SwapRejectionCode;
      readonly details: string;
    };
