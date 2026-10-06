import type { Clock } from "../domain/time.js";
import type { StreamTransactionEnvelope } from "../domain/ports.js";
import {
  RawTransactionSchema,
  type RawInstruction,
  type RawTokenBalance,
} from "./raw-transaction.js";

export interface NormalizedTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly rawAmount: bigint;
  readonly decimals: number | null;
  readonly tokenProgram: "TOKEN" | "TOKEN_2022";
  readonly unsupportedExtension: boolean;
}

export interface NormalizedTransaction {
  readonly signature: string;
  readonly slot: bigint;
  readonly version: "legacy" | 0;
  readonly success: boolean;
  readonly error: string | null;
  readonly feeRaw: bigint;
  readonly feePayer: string;
  readonly accountKeys: readonly {
    readonly address: string;
    readonly signer: boolean;
    readonly writable: boolean;
    readonly source: "MESSAGE" | "LOOKUP_WRITABLE" | "LOOKUP_READONLY";
  }[];
  readonly preBalances: readonly bigint[];
  readonly postBalances: readonly bigint[];
  readonly preTokenBalances: readonly NormalizedTokenBalance[];
  readonly postTokenBalances: readonly NormalizedTokenBalance[];
  readonly outerInstructions: readonly RawInstruction[];
  readonly innerInstructions: readonly RawInstruction[];
  readonly logMessages: readonly string[];
  readonly sourceTimestampMs?: number;
  readonly sourceTimestampPrecision:
    "MILLISECOND" | "SECOND" | "SLOT_ONLY" | "UNKNOWN";
  readonly sourceTimestampProvenance: "CHAIN_BLOCK_TIME" | "UNKNOWN";
  readonly streamReceivedTimestampMs: number;
  readonly streamReceivedMonotonicNs: bigint;
  readonly detectedTimestampMs: number;
  readonly detectedMonotonicNs: bigint;
  readonly decodedTimestampMs: number;
  readonly decodedMonotonicNs: bigint;
}

function tokenBalance(balance: RawTokenBalance): NormalizedTokenBalance {
  return {
    accountIndex: balance.accountIndex,
    mint: balance.mint,
    ...(balance.owner === undefined ? {} : { owner: balance.owner }),
    rawAmount: BigInt(balance.rawAmount),
    decimals: balance.decimals,
    tokenProgram: balance.tokenProgram,
    unsupportedExtension: balance.unsupportedExtension,
  };
}

export class TransactionNormalizer {
  constructor(private readonly clock: Clock) {}

  normalize(envelope: StreamTransactionEnvelope): NormalizedTransaction {
    const detected = this.clock.now();
    const raw = RawTransactionSchema.parse(envelope.payload);
    const decoded = this.clock.now();
    return {
      signature: raw.signature,
      slot: BigInt(raw.slot),
      version: raw.version,
      success: raw.success,
      error: raw.error,
      feeRaw: BigInt(raw.feeRaw),
      feePayer: raw.feePayer,
      accountKeys: raw.accountKeys,
      preBalances: raw.preBalances.map(BigInt),
      postBalances: raw.postBalances.map(BigInt),
      preTokenBalances: raw.preTokenBalances.map(tokenBalance),
      postTokenBalances: raw.postTokenBalances.map(tokenBalance),
      outerInstructions: raw.outerInstructions,
      innerInstructions: raw.innerInstructions,
      logMessages: raw.logMessages,
      ...(raw.sourceTimestampMs === undefined
        ? {}
        : { sourceTimestampMs: raw.sourceTimestampMs }),
      sourceTimestampPrecision: raw.sourceTimestampPrecision,
      sourceTimestampProvenance: raw.sourceTimestampProvenance,
      streamReceivedTimestampMs: envelope.streamReceivedTimestampMs,
      streamReceivedMonotonicNs: envelope.streamReceivedMonotonicNs,
      detectedTimestampMs: detected.wallMs,
      detectedMonotonicNs: detected.monotonicNs,
      decodedTimestampMs: decoded.wallMs,
      decodedMonotonicNs: decoded.monotonicNs,
    };
  }
}
