import { createHash } from "node:crypto";
import bs58 from "bs58";
import { z } from "zod";
import {
  AccountRole, address, blockhash, appendTransactionMessageInstructions,
  compileTransaction, compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage, getTransactionEncoder,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from "@solana/kit";
import { decodeIndependentAlt, type CpiSemanticEvidence } from "../live/cpi-semantic-evidence.js";
import { COMPUTE, decodeWire } from "../live/transaction-review.js";

/** Pure unsigned assembly boundary, not a funded ExecutionBuildProvider yet.
 * No transport, key, signer, Journal, authority or finality proof is created.
 * A successful canonical assembly is never an independent route review. */
const raw = z.string().regex(/^(0|[1-9]\d*)$/);
const ix = z.object({
  programId: z.string(), accounts: z.array(z.object({
    pubkey: z.string(), isSigner: z.boolean(), isWritable: z.boolean(),
  })).max(256), data: z.string(),
});
const buildSchema = z.object({
  inputMint: z.string(), outputMint: z.string(), inAmount: raw,
  outAmount: z.string().regex(/^[1-9]\d*$/), otherAmountThreshold: raw,
  swapMode: z.literal("ExactIn"), slippageBps: z.number().int().min(0).max(10000),
  priceImpactPct: z.string(),
  routePlan: z.array(z.object({ bps: z.number().int().min(0).max(10000),
    swapInfo: z.object({ inputMint: z.string(), outputMint: z.string(),
      inAmount: raw, outAmount: raw, ammKey: z.string(), label: z.string(),
    }).passthrough(),
  }).passthrough()).max(32),
  computeBudgetInstructions: z.array(ix).max(2), setupInstructions: z.array(ix).max(32),
  swapInstruction: ix, cleanupInstruction: ix.nullable(),
  otherInstructions: z.array(ix).max(32), tipInstruction: ix.nullable().optional(),
  addressesByLookupTableAddress: z.record(z.string(), z.array(z.string()).max(256)).nullable(),
  blockhashWithMetadata: z.object({
    blockhash: z.array(z.number().int().min(0).max(255)).length(32),
    lastValidBlockHeight: z.number().int().positive().safe(),
  }).passthrough(),
  contextSlot: z.number().int().positive().safe().optional(),
}).passthrough();
export interface JupiterBuildBinding {
  wallet: string; inputMint: string; outputMint: string;
  inputRaw: string; slippageBps: number;
}
export interface JupiterUnsignedAssemblyOptions extends JupiterBuildBinding {
  /** Raw independently acquired finalized RPC ALT accounts. */
  independentAlts: CpiSemanticEvidence["alt"];
  /** Caller-observed finalized lower bound, never relabelled as quote context. */
  minimumFinalizedSlot: number;
  computeUnitLimit: number;
  networkFeeCapLamports: string;
}
const need = (ok: unknown, code: string): void => { if (!ok) throw Error(code); };
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
function parse(value: unknown, binding: JupiterBuildBinding) {
  const b = buildSchema.parse(value);
  need(b.inputMint === binding.inputMint && b.outputMint === binding.outputMint &&
    b.inAmount === binding.inputRaw && b.slippageBps === binding.slippageBps,
  "V2_BUILD_QUOTE_BINDING");
  address(binding.wallet); address(binding.inputMint); address(binding.outputMint);
  const output = BigInt(b.outAmount), minimum = BigInt(b.otherAmountThreshold);
  need(minimum >= output * BigInt(10000 - b.slippageBps) / 10000n && minimum <= output,
    "V2_BUILD_MINIMUM_OUTPUT_INVALID");
  const data = Buffer.from(b.swapInstruction.data, "base64");
  need(data.toString("base64") === b.swapInstruction.data && data.length >= 8,
    "V2_BUILD_INSTRUCTION_ENCODING");
  return b;
}
export function inspectJupiterV2Build(value: unknown, binding: JupiterBuildBinding) {
  const b = parse(value, binding), discriminator = Buffer.from(b.swapInstruction.data, "base64").subarray(0,8).toString("hex");
  const routeKind = discriminator === "d19853937cfed8e9" ? "SHARED_ACCOUNTS_ROUTE_V2" :
    discriminator === "bb64facc31c4af14" ? "ROUTE_V2" :
      discriminator === "e517cb977ae3ad2a" ? "ROUTE_V1" : "UNKNOWN_ROUTE_ABI";
  const reasons: string[] = [];
  if (routeKind === "SHARED_ACCOUNTS_ROUTE_V2") reasons.push("CURRENT_REVIEWER_SHARED_ROUTE_UNSUPPORTED");
  if (routeKind !== "ROUTE_V1") reasons.push("CURRENT_DYNAMIC_REVIEWER_V1_ABI_REQUIRED");
  if (b.routePlan.length !== 1 || b.routePlan[0]?.bps !== 10000 ||
      b.routePlan[0]?.swapInfo.inputMint !== b.inputMint || b.routePlan[0]?.swapInfo.outputMint !== b.outputMint)
    reasons.push("CURRENT_REVIEWER_NON_DIRECT_ROUTE_UNSUPPORTED");
  const lookupTables = Object.keys(b.addressesByLookupTableAddress ?? {}).length;
  if (lookupTables > 1) reasons.push("CURRENT_EXECUTION_ONE_ALT_BOUND_EXCEEDED");
  if (b.tipInstruction) reasons.push("CURRENT_REVIEWER_TIP_UNSUPPORTED");
  if (b.contextSlot === undefined) reasons.push("QUOTE_CONTEXT_SLOT_NOT_RETURNED");
  return { routeKind, discriminator, routeSteps: b.routePlan.length, lookupTables,
    quoteFinality: b.contextSlot === undefined ? "NOT_PROVEN_MISSING_CONTEXT_SLOT" : "NOT_PROVEN_BY_ASSEMBLER",
    reasons, fundedEligible: false as const, classification: "UNSIGNED_DIAGNOSTIC_ONLY" as const };
}

export function assembleJupiterV2Unsigned(value: unknown, options: JupiterUnsignedAssemblyOptions) {
  const b = parse(value, options);
  need(Number.isSafeInteger(options.minimumFinalizedSlot) && options.minimumFinalizedSlot > 0,
    "V2_INDEPENDENT_ALT_CONTEXT_INVALID");
  need(Number.isInteger(options.computeUnitLimit) && options.computeUnitLimit > 0 && options.computeUnitLimit <= 1400000,
    "V2_COMPUTE_LIMIT_INVALID");
  const tables: Record<string, ReturnType<typeof address>[]> = {};
  const independentAltSlots: Record<string, number> = {};
  for (const [key, providerAddresses] of Object.entries(b.addressesByLookupTableAddress ?? {})) {
    const evidence = options.independentAlts[key];
    if (!evidence) throw new Error("V2_INDEPENDENT_ALT_MISSING");
    need(Number.isSafeInteger(evidence.slot) && evidence.slot >= options.minimumFinalizedSlot,
      "V2_INDEPENDENT_ALT_CONTEXT_STALE");
    const addresses = decodeIndependentAlt(evidence.account);
    need(addresses.length === providerAddresses.length && addresses.every((a,i) => a === providerAddresses[i]),
      "V2_ALT_PROVIDER_DISAGREEMENT");
    tables[key] = addresses.map(address); independentAltSlots[key] = evidence.slot;
  }
  let computePrice = 0n;
  need(b.computeBudgetInstructions.length <= 1, "V2_COMPUTE_BUDGET_SHAPE");
  for (const c of b.computeBudgetInstructions) {
    const data = Buffer.from(c.data, "base64");
    need(c.programId === COMPUTE && c.accounts.length === 0 && data.length === 9 && data[0] === 3,
      "V2_COMPUTE_BUDGET_SHAPE");
    computePrice = data.readBigUInt64LE(1);
  }
  need((BigInt(options.computeUnitLimit) * computePrice + 999999n) / 1000000n + 5000n <= BigInt(options.networkFeeCapLamports),
    "V2_NETWORK_FEE_CAP");
  const convert = (x: z.infer<typeof ix>): Instruction => {
    const data = Buffer.from(x.data, "base64");
    need(data.toString("base64") === x.data, "V2_BUILD_INSTRUCTION_ENCODING");
    need(x.accounts.every(a => !a.isSigner || a.pubkey === options.wallet), "V2_BUILD_SIGNER_BINDING");
    return { programAddress: address(x.programId), accounts: x.accounts.map(a => ({
      address: address(a.pubkey), role: a.isSigner ? a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER :
        a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })), data };
  };
  const limit = Buffer.alloc(5); limit[0] = 2; limit.writeUInt32LE(options.computeUnitLimit, 1);
  const instructions: Instruction[] = [ { programAddress: address(COMPUTE), accounts: [], data: limit },
    ...b.computeBudgetInstructions.map(convert), ...b.setupInstructions.map(convert), convert(b.swapInstruction),
    ...(b.cleanupInstruction ? [convert(b.cleanupInstruction)] : []), ...b.otherInstructions.map(convert),
    ...(b.tipInstruction ? [convert(b.tipInstruction)] : []), ];
  const message = appendTransactionMessageInstructions(instructions,
    setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(bs58.encode(Uint8Array.from(b.blockhashWithMetadata.blockhash))),
      lastValidBlockHeight: BigInt(b.blockhashWithMetadata.lastValidBlockHeight) },
    setTransactionMessageFeePayer(address(options.wallet), createTransactionMessage({version: 0}))));
  const compiled = compileTransaction(compressTransactionMessageUsingAddressLookupTables(message, tables));
  const bytes = Buffer.from(getTransactionEncoder().encode(compiled));
  const transaction = bytes.toString("base64"), decoded = decodeWire(transaction);
  return { transaction, transactionDigest: sha(bytes), messageDigest: sha(Buffer.from(decoded.transaction.messageBytes)), wireBytes: bytes.length,
    independentAltSlots, quote: { inputMint:b.inputMint, outputMint:b.outputMint, inputRaw:b.inAmount,
      outputRaw:b.outAmount, minimumOutputRaw:b.otherAmountThreshold, slippageBps:b.slippageBps,
      priceImpactPct:b.priceImpactPct }, classification: inspectJupiterV2Build(value, options) };
}
