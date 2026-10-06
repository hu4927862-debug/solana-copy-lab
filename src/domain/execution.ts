import type { TradeSide } from "./trades.js";
import type { AuthoritativeSourceTimestamp } from "./time.js";

export type ExecutionMode = "PAPER" | "SHADOW";
export const FEE_EVIDENCE_CONTRACT_V1 = "FEE_EVIDENCE_CONTRACT_V1" as const;
export const FEE_EVIDENCE_CONTRACT_VERSION = FEE_EVIDENCE_CONTRACT_V1;
export type FeeEvidenceUnavailableReason =
  | "PLATFORM_FEE_MISSING"
  | "PLATFORM_FEE_SCHEMA_INVALID"
  | "FEE_BPS_MISMATCH"
  | "FEE_MINT_MISMATCH"
  | "NON_QUOTE_FEE_MINT"
  | "FEE_AMOUNT_INVALID"
  | "OTHER_PROVIDER_VARIATION";

interface QuoteFeeEvidenceBase {
  readonly contractVersion: typeof FEE_EVIDENCE_CONTRACT_VERSION;
  readonly sourceType: "JUPITER_SWAP_V2_ORDER_RESPONSE";
  readonly sourceVersion: "JUPITER_SWAP_API_V2_OPENAPI_2_0_0";
  readonly feeType: "JUPITER_PLATFORM_FEE";
  readonly totalFeeBps: number;
  readonly totalFeeMint: string;
  readonly amountBasis: "PROVIDER_REPORTED_FEE_MINT_AMOUNT";
  readonly roundingMode: "PROVIDER_FINAL_INTEGER_NO_LOCAL_ROUNDING";
  readonly includedInQuotedAmount: true;
}

export type QuoteFeeEvidence =
  | (QuoteFeeEvidenceBase & {
      readonly status: "AVAILABLE";
      readonly feeAmountRaw: bigint;
      readonly feeBps: number;
      readonly feeMint: string;
    })
  | (QuoteFeeEvidenceBase & {
      readonly status: "AMOUNT_UNAVAILABLE";
      readonly unavailableReason: FeeEvidenceUnavailableReason;
    });
export type ExecutionState =
  | "CREATED"
  | "RESERVED"
  | "PAPER_EXECUTED"
  | "CONFIRMED"
  | "SKIPPED"
  | "UNCERTAIN"
  | "FAILED";

export interface ExecutionIntent {
  readonly executionKey: string;
  readonly leaderTradeId: string;
  readonly leaderWallet: string;
  readonly followerWallet: string;
  readonly mode: ExecutionMode;
  readonly side: TradeSide;
  readonly tokenMint: string;
  readonly quoteMint: string;
  readonly theoreticalTokenRaw: bigint;
  readonly theoreticalQuoteRaw: bigint;
  readonly copyRatioBps: number;
  readonly sellRatio?: {
    readonly numerator: bigint;
    readonly denominator: bigint;
  };
  readonly skipReason?: string;
  readonly diagnosticCode?: string;
  readonly authoritativeSourceTimestamp?: AuthoritativeSourceTimestamp;
  readonly createdAtMs: number;
  readonly createdMonotonicNs: bigint;
}

export interface PaperQuoteEvidence {
  readonly provider: "JUPITER_SWAP_V2_ORDER";
  readonly requestId: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountRaw: bigint;
  readonly outputAmountRaw: bigint;
  readonly requestTimestampMs: number;
  readonly responseTimestampMs: number;
  readonly requestMonotonicNs: bigint;
  readonly responseMonotonicNs: bigint;
  readonly httpStatus: number;
  readonly schemaValid: true;
  readonly feeBps: number;
  readonly feeMint: string;
  readonly feeEvidence?: QuoteFeeEvidence;
  readonly router: string;
  readonly mode: string;
  readonly priceImpactPct?: string;
  readonly priceImpactEvidence?: JupiterPriceImpactEvidence;
  readonly providerEvidence?: Readonly<Record<string, unknown>>;
  readonly route: readonly unknown[];
}

export interface ExecutionResult {
  readonly executionKey: string;
  readonly state:
    "PAPER_EXECUTED" | "CONFIRMED" | "SKIPPED" | "UNCERTAIN" | "FAILED";
  readonly executedTokenRaw: bigint;
  readonly executedQuoteRaw: bigint;
  readonly executionPrice?: string;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly paperQuoteEvidence?: PaperQuoteEvidence;
  readonly sentAtMs?: number;
  readonly confirmedAtMs?: number;
}

export interface JupiterPriceImpactEvidence {
  readonly contractVersion: "JUPITER_SWAP_V2_IMPACT_V1";
  readonly unit: "PERCENTAGE_POINTS";
  readonly raw: Readonly<{ priceImpact?: unknown; priceImpactPct?: unknown }>;
  readonly status: "AVAILABLE" | "MISSING" | "INVALID" | "CONFLICT";
  readonly normalizedPct?: string;
}
