import bs58 from "bs58";
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
  if (!value || typeof value !== "object")
    throw new Error("Yellowstone update field is not an object");
  return value as UnknownRecord;
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error("Expected byte array from Yellowstone");
}

function address(value: unknown): string {
  return typeof value === "string" ? value : bs58.encode(bytes(value));
}

function integer(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return fallback;
}

function amount(value: unknown): string {
  if (
    typeof value === "bigint" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return String(value);
  return "0";
}

function compiledInstruction(
  value: unknown,
  accountKeys: readonly string[],
  stackHeight?: number,
): RawInstruction {
  const instruction = record(value);
  const programIdIndex = integer(instruction.programIdIndex);
  const accountIndexes = [...bytes(instruction.accounts ?? [])];
  return {
    programId:
      accountKeys[programIdIndex] ?? `UNKNOWN_PROGRAM_INDEX_${programIdIndex}`,
    accounts: accountIndexes.map(
      (index) => accountKeys[index] ?? `UNKNOWN_ACCOUNT_INDEX_${index}`,
    ),
    data: `base64:${Buffer.from(bytes(instruction.data ?? [])).toString("base64")}`,
    ...(stackHeight === undefined ? {} : { stackHeight }),
  };
}

function tokenBalance(value: unknown): RawTokenBalance {
  const balance = record(value);
  const ui = record(balance.uiTokenAmount ?? {});
  const programId =
    typeof balance.programId === "string"
      ? balance.programId
      : PROGRAM_IDS.TOKEN;
  return {
    accountIndex: integer(balance.accountIndex),
    mint: String(balance.mint ?? ""),
    ...(typeof balance.owner === "string" && balance.owner.length > 0
      ? { owner: balance.owner }
      : {}),
    rawAmount: amount(ui.amount),
    decimals: ui.decimals === undefined ? null : integer(ui.decimals),
    tokenProgram: programId === PROGRAM_IDS.TOKEN_2022 ? "TOKEN_2022" : "TOKEN",
    unsupportedExtension: false,
  };
}

export function mapYellowstoneTransaction(
  update: unknown,
  received: ClockReading,
): StreamTransactionEnvelope | undefined {
  const root = record(update);
  if (!root.transaction) return undefined;
  const transactionUpdate = record(root.transaction);
  const transaction = record(transactionUpdate.transaction);
  const message = record(transaction.message);
  const meta = record(transactionUpdate.meta ?? {});
  const staticKeys = Array.isArray(message.accountKeys)
    ? message.accountKeys.map(address)
    : [];
  const writable = Array.isArray(meta.loadedWritableAddresses)
    ? meta.loadedWritableAddresses.map(address)
    : [];
  const readonly = Array.isArray(meta.loadedReadonlyAddresses)
    ? meta.loadedReadonlyAddresses.map(address)
    : [];
  const accountKeys = [...staticKeys, ...writable, ...readonly];
  const header = record(message.header ?? {});
  const requiredSignatures = integer(header.numRequiredSignatures);
  const readonlySigned = integer(header.numReadonlySignedAccounts);
  const readonlyUnsigned = integer(header.numReadonlyUnsignedAccounts);
  const staticWritableEnd = staticKeys.length - readonlyUnsigned;
  const accounts = accountKeys.map((key, index) => ({
    address: key,
    signer: index < requiredSignatures,
    writable:
      index < staticKeys.length
        ? index < requiredSignatures
          ? index < requiredSignatures - readonlySigned
          : index < staticWritableEnd
        : index < staticKeys.length + writable.length,
    source:
      index < staticKeys.length
        ? ("MESSAGE" as const)
        : index < staticKeys.length + writable.length
          ? ("LOOKUP_WRITABLE" as const)
          : ("LOOKUP_READONLY" as const),
  }));
  const signatures = Array.isArray(transaction.signatures)
    ? transaction.signatures
    : [];
  const signature =
    signatures.length > 0
      ? address(signatures[0])
      : address(transactionUpdate.signature);
  const outer = Array.isArray(message.instructions)
    ? message.instructions.map((instruction) =>
        compiledInstruction(instruction, accountKeys),
      )
    : [];
  const inner: RawInstruction[] = [];
  if (Array.isArray(meta.innerInstructions)) {
    for (const groupValue of meta.innerInstructions) {
      const group = record(groupValue);
      if (!Array.isArray(group.instructions)) continue;
      for (const instructionValue of group.instructions) {
        const instruction = record(instructionValue);
        inner.push(
          compiledInstruction(
            instruction,
            accountKeys,
            integer(instruction.stackHeight, 1),
          ),
        );
      }
    }
  }
  const slot = amount(transactionUpdate.slot ?? root.slot);
  const raw: RawTransaction = {
    signature,
    slot,
    version:
      message.versioned === true || message.addressTableLookups !== undefined
        ? 0
        : "legacy",
    success: meta.err === null || meta.err === undefined,
    error:
      meta.err === null || meta.err === undefined
        ? null
        : JSON.stringify(meta.err),
    feeRaw: amount(meta.fee),
    feePayer: accountKeys[0] ?? "",
    accountKeys: accounts,
    preBalances: Array.isArray(meta.preBalances)
      ? meta.preBalances.map(amount)
      : [],
    postBalances: Array.isArray(meta.postBalances)
      ? meta.postBalances.map(amount)
      : [],
    preTokenBalances: Array.isArray(meta.preTokenBalances)
      ? meta.preTokenBalances.map(tokenBalance)
      : [],
    postTokenBalances: Array.isArray(meta.postTokenBalances)
      ? meta.postTokenBalances.map(tokenBalance)
      : [],
    outerInstructions: outer,
    innerInstructions: inner,
    logMessages: Array.isArray(meta.logMessages)
      ? meta.logMessages.map(String)
      : [],
    sourceTimestampPrecision: "SLOT_ONLY",
    sourceTimestampProvenance: "UNKNOWN",
  };
  return {
    signature,
    slot: BigInt(slot),
    sourceTimestampPrecision: "SLOT_ONLY",
    sourceTimestampProvenance: "UNKNOWN",
    streamReceivedTimestampMs: received.wallMs,
    streamReceivedMonotonicNs: received.monotonicNs,
    payload: raw,
  };
}
