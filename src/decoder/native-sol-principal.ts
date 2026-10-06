import bs58 from "bs58";
import {
  jupiterNetPrincipal,
  type PrincipalTransfer,
} from "./jupiter-net-principal.js";
import { WSOL_MINT } from "../domain/assets.js";
import { PROGRAM_IDS, dexForProgram } from "./program-registry.js";
import type { NormalizedTransaction } from "./transaction-normalizer.js";
import type { RawInstruction } from "./raw-transaction.js";

const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
function bytes(instruction: RawInstruction): Buffer | undefined {
  try {
    const data = instruction.data;
    if (!data) return undefined;
    return data.startsWith("base58:")
      ? Buffer.from(bs58.decode(data.slice(7)))
      : Buffer.from(data.replace(/^base64:/, ""), "base64");
  } catch {
    return undefined;
  }
}

/** A narrow proof for wrapped SOL routes, including accounts opened and closed
 * within the transaction. Wallet lamport changes remain observational evidence.
 * No fee/rent estimates are subtracted from the principal. */
export function nativeSolPrincipal(
  transaction: NormalizedTransaction,
  owner: string,
): {
  readonly raw?: bigint;
  readonly ambiguous: boolean;
  readonly proofVersion?: string;
} {
  const owned = new Set<string>();
  for (const balance of [
    ...transaction.preTokenBalances,
    ...transaction.postTokenBalances,
  ]) {
    if (balance.owner === owner && balance.mint === WSOL_MINT) {
      const account = transaction.accountKeys[balance.accountIndex]?.address;
      if (account) owned.add(account);
    }
  }
  for (const instruction of transaction.outerInstructions) {
    const data = bytes(instruction);
    if (
      instruction.programId === ATA &&
      instruction.accounts[2] === owner &&
      instruction.accounts[3] === WSOL_MINT &&
      instruction.accounts[5] === PROGRAM_IDS.TOKEN &&
      data &&
      (data.length === 0 ||
        (data.length === 1 && (data[0] === 0 || data[0] === 1)))
    ) {
      owned.add(instruction.accounts[1]!);
    }
  }
  const ancillary =
    transaction.outerInstructions.some(
      (instruction) =>
        (instruction.programId === PROGRAM_IDS.SYSTEM &&
          instruction.accounts.includes(owner)) ||
        (instruction.programId === ATA && instruction.accounts[0] === owner),
    ) ||
    transaction.innerInstructions.some((instruction) => {
      const data = bytes(instruction);
      return (
        instruction.accounts.includes(owner) &&
        ((instruction.programId === PROGRAM_IDS.SYSTEM &&
          data &&
          data.length >= 4 &&
          data.readUInt32LE(0) === 0) ||
          (instruction.programId === PROGRAM_IDS.TOKEN &&
            data?.[0] === 9 &&
            instruction.accounts[1] === owner))
      );
    });
  if (owned.size === 0) return { ambiguous: ancillary };
  if (
    transaction.outerInstructions.filter((instruction) =>
      dexForProgram(instruction.programId),
    ).length !== 1
  )
    return { ambiguous: true };
  const infrastructure = new Set<string>([
    PROGRAM_IDS.SYSTEM,
    PROGRAM_IDS.TOKEN,
    PROGRAM_IDS.TOKEN_2022,
    ATA,
    "ComputeBudget111111111111111111111111111111",
  ]);
  if (
    transaction.outerInstructions.some(
      (instruction) =>
        !dexForProgram(instruction.programId) &&
        !infrastructure.has(instruction.programId),
    )
  )
    return { ambiguous: true };
  const transfers: PrincipalTransfer[] = [];
  let incoming = 0n;
  let outgoing = 0n;
  for (const instruction of [
    ...transaction.outerInstructions,
    ...transaction.innerInstructions,
  ]) {
    if (instruction.programId !== PROGRAM_IDS.TOKEN) continue;
    const data = bytes(instruction);
    if (!instruction.accounts.some((account) => owned.has(account))) continue;
    if (!data) return { ambiguous: true };
    if (data[0] !== 3 && data[0] !== 12) continue;
    if (transaction.outerInstructions.includes(instruction))
      return { ambiguous: true };
    const checked = data[0] === 12;
    if (data.length !== (checked ? 10 : 9)) return { ambiguous: true };
    if (checked && (instruction.accounts[1] !== WSOL_MINT || data[9] !== 9))
      return { ambiguous: true };
    const source = instruction.accounts[0];
    const destination = instruction.accounts[checked ? 2 : 1];
    if (!source || !destination) return { ambiguous: true };
    const amount = data.readBigUInt64LE(1);
    transfers.push({
      index: transaction.innerInstructions.indexOf(instruction),
      source,
      destination,
      amount,
    });
    if (owned.has(source) && !owned.has(destination)) outgoing += amount;
    if (owned.has(destination) && !owned.has(source)) incoming += amount;
  }
  if (incoming === outgoing) return { ambiguous: true };
  if (incoming > 0n && outgoing > 0n) {
    const raw = jupiterNetPrincipal(
      transaction,
      owner,
      owned,
      transfers,
      incoming,
      outgoing,
    );
    return raw === undefined
      ? { ambiguous: true }
      : {
          raw,
          ambiguous: false,
          proofVersion: "JUPITER_ROUTE_V2_NET_TRANSFERS_V1",
        };
  }
  return { raw: incoming - outgoing, ambiguous: false };
}
