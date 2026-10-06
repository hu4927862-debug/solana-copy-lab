import type { DexName, SwapClassification } from "../domain/trades.js";
import type { NormalizedTransaction } from "../decoder/transaction-normalizer.js";

export type ValidationClassification =
  | "BUY"
  | "SELL"
  | "TRANSFER"
  | "LP"
  | "STAKE"
  | "LENDING"
  | "UNKNOWN"
  | "UNSUPPORTED";

export interface GroundTruthResult {
  readonly classification: ValidationClassification;
  readonly source: "AUTO_RULE" | "HUMAN_REVIEW";
  readonly reviewReason?: string;
}

export interface ValidationRecord {
  readonly id: string;
  readonly signature: string;
  readonly eventIndex: number;
  readonly slot: bigint;
  readonly blockTimeMs?: number;
  readonly leader: string;
  readonly primaryProvider: string;
  readonly programIds: readonly string[];
  readonly systemClassification: ValidationClassification;
  readonly groundTruth: GroundTruthResult;
  readonly dex?: DexName;
  readonly tokenMint?: string;
  readonly quoteMint?: string;
  readonly balanceDeltas: readonly unknown[];
  readonly classifierEvidence: readonly string[];
  readonly skipReason?: string;
  readonly capturePath: string;
  readonly decodeError?: string;
  readonly isDuplicate: boolean;
  readonly createdAtMs: number;
}

export interface LivePipelineStages {
  readonly streamReceivedMonotonicNs: bigint;
  readonly detectedMonotonicNs?: bigint;
  readonly normalizedMonotonicNs?: bigint;
  readonly classifiedMonotonicNs?: bigint;
  readonly copyIntentCreatedMonotonicNs?: bigint;
  readonly jupiterRequestStartedMonotonicNs?: bigint;
  readonly jupiterResponseReceivedMonotonicNs?: bigint;
  readonly shadowExecutionCompletedMonotonicNs?: bigint;
}

export interface CapturedEvidence {
  readonly captureVersion: 1;
  readonly capturedAtMs: number;
  readonly provider: string;
  readonly leader: string;
  readonly transaction: unknown;
  readonly normalized?: NormalizedTransaction;
  readonly classification?: SwapClassification;
  readonly systemClassification: ValidationClassification;
  readonly groundTruth: GroundTruthResult;
}

export interface JupiterQuoteTelemetry {
  readonly validationEventId: string;
  readonly executionKey: string;
  readonly requestTimestampMs: number;
  readonly responseTimestampMs?: number;
  readonly requestMonotonicNs: bigint;
  readonly responseMonotonicNs?: bigint;
  readonly httpStatus?: number;
  readonly schemaValid: boolean;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputRaw: bigint;
  readonly expectedOutputRaw?: bigint;
  readonly router?: string;
  readonly route?: readonly unknown[];
  readonly priceImpactPct?: string;
  readonly quoteAgeMs?: number;
  readonly sourcePrice?: string;
  readonly expectedExecutionPrice?: string;
  readonly theoreticalPriceDifferencePct?: string;
  readonly adversePriceDifferencePct?: string;
  readonly provider?: string;
  readonly dex?: DexName;
  readonly tokenMint?: string;
  readonly leader?: string;
  readonly observedHour?: string;
  readonly failureReason?: string;
}
