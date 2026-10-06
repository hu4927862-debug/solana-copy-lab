import { createHash } from "node:crypto";
import {
  canonicalDomainQuoteMint,
  NATIVE_SOL,
  WSOL_MINT,
} from "../domain/assets.js";
import type { SwapClassification } from "../domain/trades.js";
import type { NormalizedTransaction } from "../decoder/transaction-normalizer.js";

export const LEADER_EVIDENCE_SCHEMA_VERSION = "LEADER_EVIDENCE_V1";
export const LEADER_EVIDENCE_EXTRACTOR_VERSION = "LEADER_EVIDENCE_EXTRACTOR_V1";

export type EvidenceStatus = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
export type EvidenceOrderStatus = "OBSERVED" | "DERIVED" | "UNAVAILABLE";
export type EvidenceConflictStatus = "NONE" | "CONFLICT";

export interface LeaderAccountBalanceEvidence {
  readonly accountIndex: number;
  readonly accountAddress: string | null;
  readonly mint: string;
  readonly tokenProgram: "TOKEN" | "TOKEN_2022" | "NATIVE_SOL";
  readonly preRaw: string | null;
  readonly postRaw: string | null;
  readonly deltaRaw: string | null;
  readonly decimals: number | null;
  readonly decimalsStatus: EvidenceStatus;
  readonly decimalsProvenance:
    "TRANSACTION_TOKEN_BALANCE" | "NATIVE_SOL_FIXED_9" | "UNAVAILABLE";
  readonly preOwner: string | null;
  readonly postOwner: string | null;
  readonly ownerStatus: EvidenceStatus;
  readonly ownerProvenance: "TRANSACTION_BALANCE" | "UNAVAILABLE";
}

export interface LeaderInstructionEvidence {
  readonly captureOrdinal: number;
  readonly kind: "OUTER" | "INNER";
  readonly outerOrdinal: number | null;
  readonly innerOrdinal: number | null;
  readonly orderingStatus: EvidenceOrderStatus;
  readonly programId: string;
  readonly accounts: readonly string[];
  readonly data: string | null;
  readonly parsedType: string | null;
  readonly stackHeight: number | null;
}

export interface LeaderResearchEvidence {
  readonly evidenceId: string;
  readonly schemaVersion: string;
  readonly extractorVersion: string;
  readonly decoderVersion: string;
  readonly normalizationVersion: string;
  readonly leaderWalletId: string;
  readonly signature: string;
  readonly slot: string;
  readonly blockTimeMs: number | null;
  readonly blockTimeStatus: EvidenceStatus;
  readonly transactionIndex: number | null;
  readonly transactionIndexStatus: EvidenceOrderStatus;
  readonly eventOrdinal: number | null;
  readonly eventOrdinalStatus: EvidenceOrderStatus;
  readonly signer: string | null;
  readonly signers: readonly string[];
  readonly feePayer: string | null;
  readonly sourceProvider: string;
  readonly sourceFingerprint: string;
  readonly inputMint: string | null;
  readonly outputMint: string | null;
  readonly inputMintCanonical: string | null;
  readonly outputMintCanonical: string | null;
  readonly canonicalQuoteMint: string | null;
  readonly inputAmountRaw: string | null;
  readonly outputAmountRaw: string | null;
  readonly inputDecimals: number | null;
  readonly outputDecimals: number | null;
  readonly inputDecimalsProvenance:
    "TRANSACTION_TOKEN_BALANCE" | "NATIVE_SOL_FIXED_9" | "UNAVAILABLE";
  readonly outputDecimalsProvenance:
    "TRANSACTION_TOKEN_BALANCE" | "NATIVE_SOL_FIXED_9" | "UNAVAILABLE";
  readonly feeRaw: string | null;
  readonly feeMint: typeof NATIVE_SOL;
  readonly feeAttributionStatus: "UNKNOWN" | "LEADER_FEE_PAYER";
  readonly priorityFeeRaw: string | null;
  readonly priorityFeeStatus: "AVAILABLE" | "UNAVAILABLE";
  readonly classificationCode: string;
  readonly tradingAuthorization: "AUTHORIZED" | "NOT_AUTHORIZED";
  readonly coverageStatus: EvidenceStatus;
  readonly gapStatus:
    | "NONE"
    | "ORDERING_UNAVAILABLE"
    | "MULTI_SWAP_UNAVAILABLE"
    | "OWNER_UNAVAILABLE";
  readonly conflictStatus: EvidenceConflictStatus;
  readonly backfillStatus: "NOT_ATTEMPTED";
  readonly accountBalances: readonly LeaderAccountBalanceEvidence[];
  readonly instructions: readonly LeaderInstructionEvidence[];
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function pairBalances(
  transaction: NormalizedTransaction,
  leader: string,
): LeaderAccountBalanceEvidence[] {
  const pairs = new Map<
    string,
    {
      pre?: (typeof transaction.preTokenBalances)[number];
      post?: (typeof transaction.postTokenBalances)[number];
    }
  >();
  for (const balance of transaction.preTokenBalances) {
    const key = `${balance.accountIndex}:${balance.mint}`;
    pairs.set(key, { pre: balance });
  }
  for (const balance of transaction.postTokenBalances) {
    const key = `${balance.accountIndex}:${balance.mint}`;
    pairs.set(key, { ...(pairs.get(key) ?? {}), post: balance });
  }
  const result: LeaderAccountBalanceEvidence[] = [];
  for (const pair of pairs.values()) {
    const sample = pair.post ?? pair.pre;
    if (!sample) continue;
    const owner = pair.post?.owner ?? pair.pre?.owner;
    if (owner !== undefined && owner !== leader) continue;
    const preValue = pair.pre?.rawAmount;
    const postValue = pair.post?.rawAmount;
    const pre = preValue === undefined ? null : preValue.toString();
    const post = postValue === undefined ? null : postValue.toString();
    const delta =
      preValue !== undefined && postValue !== undefined
        ? (postValue - preValue).toString()
        : null;
    result.push({
      accountIndex: sample.accountIndex,
      accountAddress:
        transaction.accountKeys[sample.accountIndex]?.address ?? null,
      mint: sample.mint,
      tokenProgram: sample.tokenProgram,
      preRaw: pre,
      postRaw: post,
      deltaRaw: delta,
      decimals: pair.post?.decimals ?? pair.pre?.decimals ?? null,
      decimalsStatus:
        (pair.post?.decimals ?? pair.pre?.decimals) === null ||
        (pair.post?.decimals ?? pair.pre?.decimals) === undefined
          ? "UNAVAILABLE"
          : "AVAILABLE",
      decimalsProvenance:
        (pair.post?.decimals ?? pair.pre?.decimals) === null ||
        (pair.post?.decimals ?? pair.pre?.decimals) === undefined
          ? "UNAVAILABLE"
          : "TRANSACTION_TOKEN_BALANCE",
      preOwner: pair.pre?.owner ?? null,
      postOwner: pair.post?.owner ?? null,
      ownerStatus: owner === undefined ? "UNAVAILABLE" : "AVAILABLE",
      ownerProvenance:
        owner === undefined ? "UNAVAILABLE" : "TRANSACTION_BALANCE",
    });
  }
  const leaderIndex = transaction.accountKeys.findIndex(
    (account) => account.address === leader,
  );
  const pre =
    leaderIndex >= 0 ? transaction.preBalances[leaderIndex] : undefined;
  const post =
    leaderIndex >= 0 ? transaction.postBalances[leaderIndex] : undefined;
  if (pre !== undefined || post !== undefined) {
    result.push({
      accountIndex: leaderIndex,
      accountAddress: leader,
      mint: NATIVE_SOL,
      tokenProgram: "NATIVE_SOL",
      preRaw: pre?.toString() ?? null,
      postRaw: post?.toString() ?? null,
      deltaRaw:
        pre !== undefined && post !== undefined
          ? (post - pre).toString()
          : null,
      decimals: 9,
      decimalsStatus: "AVAILABLE",
      decimalsProvenance: "NATIVE_SOL_FIXED_9",
      preOwner: leader,
      postOwner: leader,
      ownerStatus: "AVAILABLE",
      ownerProvenance: "TRANSACTION_BALANCE",
    });
  }
  return result.sort(
    (a, b) => a.accountIndex - b.accountIndex || a.mint.localeCompare(b.mint),
  );
}

function instructions(
  transaction: NormalizedTransaction,
): LeaderInstructionEvidence[] {
  const outer = transaction.outerInstructions.map(
    (instruction, outerOrdinal) => ({
      captureOrdinal: outerOrdinal,
      kind: "OUTER" as const,
      outerOrdinal,
      innerOrdinal: null,
      orderingStatus: "OBSERVED" as const,
      programId: instruction.programId,
      accounts: [...instruction.accounts],
      data: instruction.data ?? null,
      parsedType: instruction.parsedType ?? null,
      stackHeight: instruction.stackHeight ?? null,
    }),
  );
  const inner = transaction.innerInstructions.map(
    (instruction, innerOrdinal) => ({
      captureOrdinal: transaction.outerInstructions.length + innerOrdinal,
      kind: "INNER" as const,
      outerOrdinal: null,
      innerOrdinal,
      orderingStatus: "UNAVAILABLE" as const,
      programId: instruction.programId,
      accounts: [...instruction.accounts],
      data: instruction.data ?? null,
      parsedType: instruction.parsedType ?? null,
      stackHeight: instruction.stackHeight ?? null,
    }),
  );
  return [...outer, ...inner];
}

export class LeaderEvidenceExtractor {
  extract(
    transaction: NormalizedTransaction,
    leaderWalletId: string,
    classification: SwapClassification,
    sourceProvider = "UNKNOWN",
  ): LeaderResearchEvidence {
    const accepted = classification.accepted;
    const event = accepted ? classification.event : undefined;
    const balances = pairBalances(transaction, leaderWalletId);
    const quoteSource = event
      ? event.deltas.find(
          (delta) =>
            delta.mint === event.quote.mint ||
            canonicalDomainQuoteMint(delta.mint) === event.quote.mint,
        )
      : undefined;
    const inputMint = event
      ? event.side === "BUY"
        ? (quoteSource?.mint ?? event.quote.mint)
        : event.token.mint
      : null;
    const outputMint = event
      ? event.side === "BUY"
        ? event.token.mint
        : (quoteSource?.mint ?? event.quote.mint)
      : null;
    const inputDecimals = event
      ? event.side === "BUY"
        ? (quoteSource?.decimals ?? event.quote.decimals)
        : event.token.decimals
      : null;
    const outputDecimals = event
      ? event.side === "BUY"
        ? event.token.decimals
        : (quoteSource?.decimals ?? event.quote.decimals)
      : null;
    const sourceMaterial = {
      signature: transaction.signature,
      slot: transaction.slot,
      version: transaction.version,
      success: transaction.success,
      error: transaction.error,
      feeRaw: transaction.feeRaw,
      feePayer: transaction.feePayer,
      accountKeys: transaction.accountKeys,
      preBalances: transaction.preBalances,
      postBalances: transaction.postBalances,
      preTokenBalances: transaction.preTokenBalances,
      postTokenBalances: transaction.postTokenBalances,
      outerInstructions: transaction.outerInstructions,
      innerInstructions: transaction.innerInstructions,
      logMessages: transaction.logMessages,
      sourceTimestampMs: transaction.sourceTimestampMs ?? null,
      sourceTimestampPrecision: transaction.sourceTimestampPrecision,
      sourceTimestampProvenance: transaction.sourceTimestampProvenance,
    };
    const sourceFingerprint = hash(sourceMaterial);
    const evidenceId = `leader_evidence_${hash({ leaderWalletId, signature: transaction.signature, sourceFingerprint })}`;
    const ownerUnavailable = balances.some(
      (balance) =>
        balance.deltaRaw !== null && balance.ownerStatus === "UNAVAILABLE",
    );
    const multiSwap =
      !accepted && classification.code === "AMBIGUOUS_DIRECTION";
    return {
      evidenceId,
      schemaVersion: LEADER_EVIDENCE_SCHEMA_VERSION,
      extractorVersion: LEADER_EVIDENCE_EXTRACTOR_VERSION,
      decoderVersion: "RAW_TRANSACTION_V1",
      normalizationVersion: "TRANSACTION_NORMALIZER_V1",
      leaderWalletId,
      signature: transaction.signature,
      slot: transaction.slot.toString(),
      blockTimeMs: transaction.sourceTimestampMs ?? null,
      blockTimeStatus:
        transaction.sourceTimestampMs === undefined
          ? "UNAVAILABLE"
          : "AVAILABLE",
      transactionIndex: null,
      transactionIndexStatus: "UNAVAILABLE",
      eventOrdinal: null,
      eventOrdinalStatus: "UNAVAILABLE",
      signer:
        transaction.accountKeys.find(
          (account) => account.address === leaderWalletId && account.signer,
        )?.address ?? null,
      signers: transaction.accountKeys
        .filter((account) => account.signer)
        .map((account) => account.address),
      feePayer: transaction.feePayer || null,
      sourceProvider,
      sourceFingerprint,
      inputMint,
      outputMint,
      inputMintCanonical:
        inputMint === null ? null : canonicalDomainQuoteMint(inputMint),
      outputMintCanonical:
        outputMint === null ? null : canonicalDomainQuoteMint(outputMint),
      canonicalQuoteMint: event?.quote.mint ?? null,
      inputAmountRaw: event
        ? event.side === "BUY"
          ? event.quote.raw.toString()
          : event.token.raw.toString()
        : null,
      outputAmountRaw: event
        ? event.side === "BUY"
          ? event.token.raw.toString()
          : event.quote.raw.toString()
        : null,
      inputDecimals,
      outputDecimals,
      inputDecimalsProvenance:
        inputMint === null
          ? "UNAVAILABLE"
          : inputMint === NATIVE_SOL
            ? "NATIVE_SOL_FIXED_9"
            : "TRANSACTION_TOKEN_BALANCE",
      outputDecimalsProvenance:
        outputMint === null
          ? "UNAVAILABLE"
          : outputMint === NATIVE_SOL
            ? "NATIVE_SOL_FIXED_9"
            : "TRANSACTION_TOKEN_BALANCE",
      feeRaw: transaction.feeRaw.toString(),
      feeMint: NATIVE_SOL,
      feeAttributionStatus:
        transaction.feePayer === leaderWalletId
          ? "LEADER_FEE_PAYER"
          : "UNKNOWN",
      priorityFeeRaw: null,
      priorityFeeStatus: "UNAVAILABLE",
      classificationCode: accepted ? "ACCEPTED_SWAP" : classification.code,
      tradingAuthorization: accepted ? "AUTHORIZED" : "NOT_AUTHORIZED",
      coverageStatus: "PARTIAL",
      gapStatus: ownerUnavailable
        ? "OWNER_UNAVAILABLE"
        : multiSwap
          ? "MULTI_SWAP_UNAVAILABLE"
          : "ORDERING_UNAVAILABLE",
      conflictStatus: "NONE",
      backfillStatus: "NOT_ATTEMPTED",
      accountBalances: balances,
      instructions: instructions(transaction),
    };
  }
}

export const LEADER_EVIDENCE_SOURCE_MINTS = {
  nativeSol: NATIVE_SOL,
  wsol: WSOL_MINT,
} as const;
