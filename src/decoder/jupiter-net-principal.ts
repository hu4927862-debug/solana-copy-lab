import bs58 from "bs58";
import { PROGRAM_IDS } from "./program-registry.js";
import { WSOL_MINT } from "../domain/assets.js";
import type { NormalizedTransaction } from "./transaction-normalizer.js";
import { verifiedInstructionTrace } from "./instruction-trace.js";

export interface PrincipalTransfer {
  readonly index: number;
  readonly source: string;
  readonly destination: string;
  readonly amount: bigint;
}

/** Restrict mixed flows to an exact-in Jupiter RouteV2 invocation, using its
 * account bindings, complete runtime trace and u64 return as independent checks.
 * Economic principal is route net quote movement, including in-route deductions
 * and refunds, excluding rent and unrelated wallet lamport movements. */
export function jupiterNetPrincipal(
  transaction: NormalizedTransaction,
  owner: string,
  owned: ReadonlySet<string>,
  transfers: readonly PrincipalTransfer[],
  incoming: bigint,
  outgoing: bigint,
): bigint | undefined {
  if (owned.size !== 1) return undefined;
  const root = transaction.outerInstructions.findIndex(
    (i) => i.programId === PROGRAM_IDS.JUPITER_V6,
  );
  const route = transaction.outerInstructions[root];
  if (!route?.data) return undefined;
  let data: Buffer;
  try {
    data = route.data.startsWith("base58:")
      ? Buffer.from(bs58.decode(route.data.slice(7)))
      : Buffer.from(route.data.replace(/^base64:/, ""), "base64");
  } catch {
    return undefined;
  }
  // Anchor sha256("global:route_v2")[0..8]; exact-in fixed header precedes route plan.
  if (
    data.length < 34 ||
    data.subarray(0, 8).toString("hex") !== "bb64facc31c4af14"
  )
    return undefined;
  if (
    route.accounts[0] !== owner ||
    route.accounts[9] !== PROGRAM_IDS.JUPITER_V6
  )
    return undefined;
  const source = route.accounts[1],
    destination = route.accounts[2];
  const sourceMint = route.accounts[3],
    destinationMint = route.accounts[4];
  if (
    !source ||
    !destination ||
    source === destination ||
    !sourceMint ||
    !destinationMint
  )
    return undefined;
  const buy = sourceMint === WSOL_MINT && owned.has(source);
  const sell = destinationMint === WSOL_MINT && owned.has(destination);
  if (buy === sell) return undefined;
  if (route.accounts[buy ? 5 : 6] !== PROGRAM_IDS.TOKEN) return undefined;
  // Redirected destination variants need their own proof.
  if (
    route.accounts[7] !== PROGRAM_IDS.JUPITER_V6 &&
    route.accounts[7] !== destination
  )
    return undefined;
  const trace = verifiedInstructionTrace(transaction);
  const returned = trace?.rootReturns.get(root);
  if (!trace || returned === undefined || returned <= 0n) return undefined;
  if (transfers.some((t) => trace.innerRoots[t.index] !== root))
    return undefined;
  const input = data.readBigUInt64LE(8);
  if (input <= 0n) return undefined;
  const tokenMint = buy ? destinationMint : sourceMint;
  const tokenAccount = buy ? destination : source;
  const balances = [
    ...transaction.preTokenBalances,
    ...transaction.postTokenBalances,
  ];
  if (
    !balances.some(
      (b) =>
        b.owner === owner &&
        b.mint === tokenMint &&
        transaction.accountKeys[b.accountIndex]?.address === tokenAccount,
    )
  )
    return undefined;
  const sum = (bs: typeof transaction.preTokenBalances) =>
    bs
      .filter((b) => b.owner === owner && b.mint === tokenMint)
      .reduce((n, b) => n + BigInt(b.rawAmount), 0n);
  const tokenNet =
    sum(transaction.postTokenBalances) - sum(transaction.preTokenBalances);
  if (buy) {
    if (tokenNet !== returned || outgoing !== input || incoming >= outgoing)
      return undefined;
    // A refund must return from a counterparty already paid in this invocation;
    // never accept an arbitrary incoming transfer as a principal reduction.
    const refundable = new Map<string, bigint>();
    for (const t of transfers) {
      if (owned.has(t.source))
        refundable.set(
          t.destination,
          (refundable.get(t.destination) ?? 0n) + t.amount,
        );
      else if (owned.has(t.destination)) {
        const prior = transaction.preTokenBalances.find(
          (b) =>
            transaction.accountKeys[b.accountIndex]?.address === t.source &&
            b.mint === WSOL_MINT,
        );
        if (!prior || BigInt(prior.rawAmount) !== 0n) return undefined;
        // A zero opening token balance alone does not exclude fresh native
        // funding or a third party's token payment during this transaction.
        for (const instruction of [
          ...transaction.outerInstructions,
          ...transaction.innerInstructions,
        ]) {
          if (!instruction.accounts.includes(t.source)) continue;
          if (instruction.programId === PROGRAM_IDS.SYSTEM) return undefined;
          if (instruction.programId !== PROGRAM_IDS.TOKEN) continue;
          let transfer: Buffer;
          try {
            transfer = instruction.data?.startsWith("base58:")
              ? Buffer.from(bs58.decode(instruction.data.slice(7)))
              : Buffer.from(
                  (instruction.data ?? "").replace(/^base64:/, ""),
                  "base64",
                );
          } catch {
            return undefined;
          }
          if (
            transfer.length !== 10 ||
            transfer[0] !== 12 ||
            transfer[9] !== 9 ||
            instruction.accounts[1] !== WSOL_MINT
          )
            return undefined;
          if (
            !(
              instruction.accounts[0] === t.source &&
              owned.has(instruction.accounts[2]!)
            ) &&
            !(
              instruction.accounts[2] === t.source &&
              owned.has(instruction.accounts[0]!)
            )
          )
            return undefined;
        }
        const paid = refundable.get(t.source) ?? 0n;
        if (paid < t.amount) return undefined;
        refundable.set(t.source, paid - t.amount);
      }
    }
  } else {
    if (tokenNet !== -input || incoming - outgoing !== returned)
      return undefined;
    // Reverse flows must be deductions made by the outer Jupiter invocation,
    // not additional sales/transfers inside another route leg.
    if (
      transfers.some(
        (t) =>
          owned.has(t.source) &&
          trace.innerParents[t.index] !== PROGRAM_IDS.JUPITER_V6,
      )
    )
      return undefined;
  }
  return incoming - outgoing;
}
