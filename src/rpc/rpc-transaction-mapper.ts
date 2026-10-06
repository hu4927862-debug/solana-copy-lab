import type { StreamTransactionEnvelope } from "../domain/ports.js";
import type { ClockReading } from "../domain/time.js";
import { PROGRAM_IDS } from "../decoder/program-registry.js";
import type {
  RawInstruction,
  RawTokenBalance,
  RawTransaction,
} from "../decoder/raw-transaction.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function rawInstruction(
  value: unknown,
  accountKeys: readonly { readonly address: string }[],
): RawInstruction {
  const instruction = record(value);
  const parsed = record(instruction.parsed);
  const programId =
    typeof instruction.programId === "string"
      ? instruction.programId
      : (accountKeys[Number(instruction.programIdIndex)]?.address ?? "");
  const accounts = Array.isArray(instruction.accounts)
    ? instruction.accounts.map((value) =>
        typeof value === "number"
          ? (accountKeys[value]?.address ?? "")
          : String(value),
      )
    : [];
  return {
    programId,
    accounts,
    ...(typeof instruction.data === "string"
      ? { data: `base58:${instruction.data}` }
      : {}),
    ...(typeof parsed.type === "string" ? { parsedType: parsed.type } : {}),
  };
}

function rawTokenBalance(value: unknown): RawTokenBalance {
  const balance = record(value);
  const ui = record(balance.uiTokenAmount);
  return {
    accountIndex: Number(balance.accountIndex ?? 0),
    mint: String(balance.mint ?? ""),
    ...(typeof balance.owner === "string" && balance.owner.length > 0
      ? { owner: balance.owner }
      : {}),
    rawAmount: String(ui.amount ?? "0"),
    decimals: typeof ui.decimals === "number" ? ui.decimals : null,
    tokenProgram:
      balance.programId === PROGRAM_IDS.TOKEN_2022 ? "TOKEN_2022" : "TOKEN",
    unsupportedExtension: false,
  };
}

export function mapRpcTransaction(
  itemValue: unknown,
  received: ClockReading,
): StreamTransactionEnvelope {
  const item = record(itemValue);
  const transaction = record(item.transaction);
  const message = record(transaction.message);
  const meta = record(item.meta);
  const header = record(message.header);
  const requiredSignatures = Number(header.numRequiredSignatures ?? 0);
  const readonlySigned = Number(header.numReadonlySignedAccounts ?? 0);
  const readonlyUnsigned = Number(header.numReadonlyUnsignedAccounts ?? 0);
  const staticKeyCount = Array.isArray(message.accountKeys)
    ? message.accountKeys.length
    : 0;
  const messageAccountKeys = Array.isArray(message.accountKeys)
    ? message.accountKeys.map((value, index) => {
        const key = record(value);
        const isRawKey = typeof value === "string";
        const signer = isRawKey
          ? index < requiredSignatures
          : Boolean(key.signer);
        const writable = isRawKey
          ? signer
            ? index < requiredSignatures - readonlySigned
            : index < staticKeyCount - readonlyUnsigned
          : Boolean(key.writable);
        return {
          address: String(key.pubkey ?? value),
          signer,
          writable,
          source:
            key.source === "lookupTable"
              ? ("LOOKUP_WRITABLE" as const)
              : ("MESSAGE" as const),
        };
      })
    : [];
  const loadedAddresses = record(meta.loadedAddresses);
  const accountKeys = [
    ...messageAccountKeys,
    ...strings(loadedAddresses.writable).map((address) => ({
      address,
      signer: false,
      writable: true,
      source: "LOOKUP_WRITABLE" as const,
    })),
    ...strings(loadedAddresses.readonly).map((address) => ({
      address,
      signer: false,
      writable: false,
      source: "LOOKUP_READONLY" as const,
    })),
  ];
  const signatures = strings(transaction.signatures);
  const signature = signatures[0] ?? "";
  const innerInstructions: RawInstruction[] = [];
  if (Array.isArray(meta.innerInstructions)) {
    for (const groupValue of meta.innerInstructions) {
      const group = record(groupValue);
      if (Array.isArray(group.instructions))
        innerInstructions.push(
          ...group.instructions.map((value) =>
            rawInstruction(value, accountKeys),
          ),
        );
    }
  }
  const blockTime =
    typeof item.blockTime === "bigint"
      ? Number(item.blockTime)
      : Number(item.blockTime ?? 0);
  const raw: RawTransaction = {
    signature,
    slot: String(item.slot ?? "0"),
    version:
      item.version === 0 || Array.isArray(message.addressTableLookups)
        ? 0
        : "legacy",
    success: meta.err === null || meta.err === undefined,
    error:
      meta.err === null || meta.err === undefined
        ? null
        : JSON.stringify(meta.err),
    feeRaw: String(meta.fee ?? "0"),
    feePayer: accountKeys[0]?.address ?? "",
    accountKeys,
    preBalances: Array.isArray(meta.preBalances)
      ? meta.preBalances.map(String)
      : [],
    postBalances: Array.isArray(meta.postBalances)
      ? meta.postBalances.map(String)
      : [],
    preTokenBalances: Array.isArray(meta.preTokenBalances)
      ? meta.preTokenBalances.map(rawTokenBalance)
      : [],
    postTokenBalances: Array.isArray(meta.postTokenBalances)
      ? meta.postTokenBalances.map(rawTokenBalance)
      : [],
    outerInstructions: Array.isArray(message.instructions)
      ? message.instructions.map((value) => rawInstruction(value, accountKeys))
      : [],
    innerInstructions,
    logMessages: strings(meta.logMessages),
    ...(blockTime > 0 ? { sourceTimestampMs: blockTime * 1_000 } : {}),
    sourceTimestampPrecision: blockTime > 0 ? "SECOND" : "SLOT_ONLY",
    sourceTimestampProvenance: blockTime > 0 ? "CHAIN_BLOCK_TIME" : "UNKNOWN",
  };
  return {
    signature,
    slot: BigInt(raw.slot),
    ...(raw.sourceTimestampMs === undefined
      ? {}
      : { sourceTimestampMs: raw.sourceTimestampMs }),
    sourceTimestampPrecision: raw.sourceTimestampPrecision,
    sourceTimestampProvenance: raw.sourceTimestampProvenance,
    streamReceivedTimestampMs: received.wallMs,
    streamReceivedMonotonicNs: received.monotonicNs,
    payload: raw,
  };
}
