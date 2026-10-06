import {DAMM,validateDammEvidence} from "./damm-v2-evidence.js";
import {DLMM,validateDlmmEvidence} from "./dlmm-evidence.js";
import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { WSOL_MINT, USDC_MINT } from "../domain/assets.js";
import { PROGRAM_IDS as P } from "../decoder/program-registry.js";
import { digest, DeliveryPolicySchema, ExecutionAssetSchema, MANUAL_EXECUTION_ASSET, executionUnqualified, DLMM_EXECUTION_SCOPE, type ExecutionAsset, type DeliveryPolicy } from "./protocol.js";
import { validateNarrowCpiEvidence, type CpiSemanticEvidence } from "./cpi-semantic-evidence.js";

export const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE = "ComputeBudget111111111111111111111111111111";
export const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export interface ReviewScope {
  executionScope?:string;
  executionPurpose?: "EXECUTION_FUNCTION_TEST";
  deliveryPolicy?: DeliveryPolicy;
  asset?: ExecutionAsset;
  poolAddress?: string;
  requestId?: string;
  wallet: string;
  side: "BUY" | "SELL";
  inputRaw: string;
  quotedOutputRaw: string;
  maxSlippageBps: number;
  maxPlatformFeeBps: number;
  networkFeeCapLamports: string;
}
export interface TransactionReview {
  tipLamports?: string;
  tipRecipient?: string;
  computeUnitLimit?: string;
  computeUnitPriceMicroLamports?: string;
  priorityFeeLamports?: string;
  preparationCommitment?: "confirmed";
  independentContextSlot?: number;
  asset?: ExecutionAsset;
  tokenAccount?: string;
  messageDigest: string;
  transactionDigest: string;
  blockhash: string;
  wallet: string;
  sourceAccount: string;
  destinationAccount: string;
  wsolAccount: string;
  usdcAccount: string;
  inputMint: string;
  outputMint: string;
  inputRaw: string;
  quotedOutputRaw: string;
  minimumOutputRaw: string;
  slippageBps: number;
  platformFeeBps: number;
  accountKeys: string[];
  writableAccounts: string[];
  programs: string[];
  routeDataHex: string;
  routeAccounts: string[];
  instructions: { program: string; accounts: string[]; dataHex: string }[];
  abiEvidence:
    | "ROUTE_V2_CAPTURE_CORROBORATED_NOT_FIRST_PARTY_IDL"
    | "OFFICIAL_V1_SINGLE_RAYDIUM_CLMM"
    | "OFFICIAL_V1_SINGLE_METEORA_DLMM"
    | "OFFICIAL_DIRECT_DAMM_V2_EXACT_IN";
}
export function reviewAsset(review: Pick<TransactionReview, "asset">): ExecutionAsset {
  return review.asset ? ExecutionAssetSchema.parse(review.asset) : MANUAL_EXECUTION_ASSET;
}
export function reviewTokenAccount(review: Pick<TransactionReview, "tokenAccount" | "usdcAccount" | "asset">): string {
  if (review.asset && !review.tokenAccount) throw Error("REVIEW_TOKEN_ACCOUNT_MISSING");
  return review.tokenAccount ?? review.usdcAccount;
}
export async function associatedAccount(
  wallet: string,
  mint: string,
): Promise<string> {
  const encode = getAddressEncoder();
  return (
    await getProgramDerivedAddress({
      programAddress: address(ATA),
      seeds: [
        encode.encode(address(wallet)),
        encode.encode(address(P.TOKEN)),
        encode.encode(address(mint)),
      ],
    })
  )[0];
}
export function decodeWire(encoded: string) {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.length > 1232)
    throw new Error("INVALID_TRANSACTION_ENCODING");
  const transaction = getTransactionDecoder().decode(bytes);
  if (!Buffer.from(getTransactionEncoder().encode(transaction)).equals(bytes))
    throw new Error("NON_CANONICAL_TRANSACTION");
  const message = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  );
  if (message.version !== 0 && message.version !== "legacy")
    throw new Error("UNSUPPORTED_TRANSACTION_VERSION");
  if (
    message.header.numSignerAccounts !== 1 ||
    message.header.numReadonlySignerAccounts !== 0
  )
    throw new Error("UNSUPPORTED_SIGNER_SCOPE");
  return { bytes, transaction, message };
}

/** Exact bytes are reviewed, never the provider's human-readable summary alone.
 * Only an explicitly bound graduated CLMM delivery policy admits its fixed tip;
 * all other tips, shared-account, ledger, RFQ, Token-2022 and arbitrary setup fail. */
export async function reviewTransaction(
  encoded: string,
  scope: ReviewScope,
  resolveLookup: (key: string) => Promise<readonly string[]>,
  cpiEvidence?: CpiSemanticEvidence,
): Promise<TransactionReview> {
  const asset = scope.asset ? ExecutionAssetSchema.parse(scope.asset) : MANUAL_EXECUTION_ASSET;
  const delivery = scope.deliveryPolicy ? DeliveryPolicySchema.parse(scope.deliveryPolicy) : undefined;
  const functionDeliveryScope = scope.executionPurpose === "EXECUTION_FUNCTION_TEST" &&
    !scope.asset && asset.tokenMint === USDC_MINT;
  const followerDeliveryScope = scope.executionPurpose === undefined && !!scope.asset;
  if (delivery && !functionDeliveryScope && !followerDeliveryScope)
    throw Error("DELIVERY_FUNCTION_SCOPE_REQUIRED");
  const { bytes, transaction, message } = decodeWire(encoded);
  if (
    message.staticAccounts[0] !== scope.wallet ||
    Object.values(transaction.signatures).some(
      (s) => s && s.some((b) => b !== 0),
    )
  )
    throw new Error("UNEXPECTED_SIGNER_OR_PRE_SIGNATURE");
  const keys: string[] = [...message.staticAccounts],
    writable: string[] = message.staticAccounts.filter(
      (_, i) =>
        i <
        message.staticAccounts.length -
          message.header.numReadonlyNonSignerAccounts,
    );
  const loadedWritable: string[] = [],
    loadedReadonly: string[] = [];
  if (message.version === 0)
    for (const lookup of message.addressTableLookups ?? []) {
      const addresses = await resolveLookup(lookup.lookupTableAddress);
      for (const i of lookup.writableIndexes) {
        if (!addresses[i]) throw new Error("LOOKUP_INDEX_UNRESOLVED");
        loadedWritable.push(addresses[i]!);
      }
      for (const i of lookup.readonlyIndexes) {
        if (!addresses[i]) throw new Error("LOOKUP_INDEX_UNRESOLVED");
        loadedReadonly.push(addresses[i]!);
      }
    }
  keys.push(...loadedWritable, ...loadedReadonly);
  writable.push(...loadedWritable);
  if (new Set(keys).size !== keys.length)
    throw new Error("DUPLICATE_ACCOUNT_KEYS");
  const wsol = await associatedAccount(scope.wallet, WSOL_MINT),
    usdc = await associatedAccount(scope.wallet, asset.tokenMint);
  const source = scope.side === "BUY" ? wsol : usdc,
    destination = scope.side === "BUY" ? usdc : wsol;
  const inputMint = scope.side === "BUY" ? WSOL_MINT : asset.tokenMint,
    outputMint = scope.side === "BUY" ? asset.tokenMint : WSOL_MINT;
  const instructions = message.instructions.map((i) => {
    const program = keys[i.programAddressIndex];
    const accounts = (i.accountIndices ?? []).map((n) => keys[n]);
    if (!program || accounts.some((a) => !a))
      throw new Error("INVALID_INSTRUCTION_INDEX");
    return {
      program,
      accounts: accounts as string[],
      dataHex: Buffer.from(i.data ?? []).toString("hex"),
    };
  });
  let route: (typeof instructions)[number] | undefined,
    slippage = 0,
    fee = 0,
    transfer = 0n,
    cuLimit = 1400000n,
    cuPrice = 0n;
  let tipCount = 0;
  let closeCount = 0,
    syncCount = 0,
    abiEvidence: TransactionReview["abiEvidence"] =
      "ROUTE_V2_CAPTURE_CORROBORATED_NOT_FIRST_PARTY_IDL";
  const computeKinds = new Set<number>(),
    created = new Set<string>();
  const eventAuthority = (
    await getProgramDerivedAddress({
      programAddress: address(P.JUPITER_V6),
      seeds: [Buffer.from("__event_authority")],
    })
  )[0];
  for (const [index, i] of instructions.entries()) {
    const d = Buffer.from(i.dataHex, "hex"),
      a = i.accounts;
    if (i.program === P.SYSTEM) {
      if (delivery && a[1] === delivery.tipAccount) {
        if (d.length !== 12 || d.readUInt32LE(0) !== 2 || a.length !== 2 || a[0] !== scope.wallet ||
            d.readBigUInt64LE(4) !== BigInt(delivery.tipLamports) || !route || closeCount !== 1 ||
            index !== instructions.length - 1 || ++tipCount !== 1 || !writable.includes(delivery.tipAccount))
          throw Error("DELIVERY_TIP_SCOPE");
        continue;
      }
      if (
        d.length !== 12 ||
        d.readUInt32LE(0) !== 2 ||
        a.length !== 2 ||
        a[0] !== scope.wallet ||
        a[1] !== wsol ||
        scope.side !== "BUY" ||
        route
      )
        throw new Error("UNAUTHORIZED_SOL_TRANSFER");
      transfer += d.readBigUInt64LE(4);
      if (transfer !== BigInt(scope.inputRaw))
        throw new Error("UNAUTHORIZED_SOL_TRANSFER");
    } else if (i.program === ATA) {
      if (
        route ||
        d.length !== 1 ||
        d[0] !== 1 ||
        a.length !== 6 ||
        a[0] !== scope.wallet ||
        a[2] !== scope.wallet ||
        !(a[3] === WSOL_MINT || a[3] === asset.tokenMint) ||
        a[1] !== (a[3] === WSOL_MINT ? wsol : usdc) ||
        a[4] !== P.SYSTEM ||
        a[5] !== P.TOKEN ||
        created.has(a[1]!)
      )
        throw new Error("UNAUTHORIZED_ACCOUNT_CREATION");
      created.add(a[1]!);
    } else if (i.program === P.TOKEN) {
      if (
        d.length === 1 &&
        d[0] === 17 &&
        a.length === 1 &&
        a[0] === wsol &&
        !route
      ) {
        if (++syncCount > 1) throw new Error("DUPLICATE_SYNC");
      } else if (
        d.length === 1 &&
        d[0] === 9 &&
        a.length === 3 &&
        a[0] === wsol &&
        a[1] === scope.wallet &&
        a[2] === scope.wallet &&
        route
      ) {
        if (++closeCount > 1) throw new Error("DUPLICATE_CLOSE");
      } else throw new Error("UNAUTHORIZED_TOKEN_INSTRUCTION");
    } else if (i.program === COMPUTE) {
      if (a.length !== 0 || route || computeKinds.has(d[0]!))
        throw new Error("UNAUTHORIZED_COMPUTE_BUDGET");
      computeKinds.add(d[0]!);
      if (d.length === 5 && d[0] === 2) {
        cuLimit = BigInt(d.readUInt32LE(1));
        if (cuLimit === 0n || cuLimit > 1400000n)
          throw new Error("COMPUTE_LIMIT");
      } else if (d.length === 9 && d[0] === 3) cuPrice = d.readBigUInt64LE(1);
      else if (d.length === 5 && d[0] === 4 && d.readUInt32LE(1) <= 67108864) {
        /* bounded loaded account data limit */
      } else throw new Error("UNAUTHORIZED_COMPUTE_BUDGET");
    } else if (i.program === DAMM) {
      if (route || !scope.asset || d.length !== 25 || d.subarray(0,8).toString("hex") !== "414b3f4ceb5b5b88" || d[24] !== 0)
        throw Error("DAMM_EXACT_IN_REQUIRED");
      if (!Number.isInteger(scope.maxSlippageBps) || scope.maxSlippageBps < 0 || scope.maxSlippageBps > 10000 ||
        d.readBigUInt64LE(8) !== BigInt(scope.inputRaw) || d.readBigUInt64LE(16) !== BigInt(scope.quotedOutputRaw)*BigInt(10000-scope.maxSlippageBps)/10000n)
        throw Error("DAMM_AMOUNT_BOUND");
      slippage=scope.maxSlippageBps; fee=0; route=i; abiEvidence="OFFICIAL_DIRECT_DAMM_V2_EXACT_IN";
    } else if (i.program === P.JUPITER_V6) {
      if (route) throw new Error("UNSUPPORTED_JUPITER_ROUTE");
      if (
        d.length === 35 &&
        d.subarray(0, 8).toString("hex") === "e517cb977ae3ad2a"
      ) {
        if (
          d.readUInt32LE(8) !== 1 ||
          d[12] !== (scope.executionScope===DLMM_EXECUTION_SCOPE?38:26) ||
          d[13] !== 100 ||
          d[14] !== 0 ||
          d[15] !== 1
        )
          throw followerDeliveryScope && delivery ? executionUnqualified("UNSUPPORTED_V1_ROUTE_PLAN") :
            new Error("UNSUPPORTED_V1_ROUTE_PLAN");
        if (
          a[0] !== P.TOKEN ||
          a[1] !== scope.wallet ||
          a[2] !== source ||
          a[3] !== destination ||
          a[4] !== P.JUPITER_V6 ||
          a[5] !== outputMint ||
          a[6] !== P.JUPITER_V6 ||
          a[7] !== eventAuthority ||
          a[8] !== P.JUPITER_V6
        )
          throw new Error("ROUTE_ACCOUNT_SCOPE");
        if (
          d.readBigUInt64LE(16) !== BigInt(scope.inputRaw) ||
          d.readBigUInt64LE(24) !== BigInt(scope.quotedOutputRaw) ||
          d[34] !== 0
        )
          throw new Error("ROUTE_AMOUNT_SCOPE");
        slippage = d.readUInt16LE(32);
        fee = 0;
        if (slippage > scope.maxSlippageBps)
          throw new Error("ROUTE_FEE_OR_SLIPPAGE_SCOPE");
        abiEvidence = scope.executionScope===DLMM_EXECUTION_SCOPE?"OFFICIAL_V1_SINGLE_METEORA_DLMM":"OFFICIAL_V1_SINGLE_RAYDIUM_CLMM";
        if(abiEvidence==="OFFICIAL_V1_SINGLE_METEORA_DLMM"){
          if(!scope.asset||scope.executionPurpose||a.length!==29||a[9]!==DLMM||a[10]!==scope.poolAddress||a[14]!==source||a[15]!==destination||a[20]!==scope.wallet)
            throw Error("DLMM_CPI_AUTHORITY_SCOPE");
        }else if (
          a.length < 21 ||
          a.length > 40 ||
          a[9] !== RAYDIUM_CLMM ||
          a[10] !== scope.wallet ||
          a[13] !== source ||
          a[14] !== destination ||
          a[18] !== P.TOKEN ||
          (scope.poolAddress !== undefined && a[12] !== scope.poolAddress)
        )
          throw new Error("RAYDIUM_CPI_AUTHORITY_SCOPE");
      } else {
        if (scope.asset) throw followerDeliveryScope && delivery ? executionUnqualified("DYNAMIC_V1_ROUTE_REQUIRED") :
          Error("DYNAMIC_V1_ROUTE_REQUIRED");
        if (
          d.length < 35 ||
          d.subarray(0, 8).toString("hex") !== "bb64facc31c4af14"
        )
          throw new Error("UNSUPPORTED_JUPITER_ROUTE");
        if (
          a[0] !== scope.wallet ||
          a[1] !== source ||
          a[2] !== destination ||
          a[3] !== inputMint ||
          a[4] !== outputMint ||
          a[5] !== P.TOKEN ||
          a[6] !== P.TOKEN ||
          ![P.JUPITER_V6, destination].includes(a[7]!) ||
          a[9] !== P.JUPITER_V6
        )
          throw new Error("ROUTE_ACCOUNT_SCOPE");
        if (
          d.readBigUInt64LE(8) !== BigInt(scope.inputRaw) ||
          d.readBigUInt64LE(16) !== BigInt(scope.quotedOutputRaw)
        )
          throw new Error("ROUTE_AMOUNT_SCOPE");
        slippage = d.readUInt16LE(24);
        fee = d.readUInt16LE(26);
        if (
          slippage > scope.maxSlippageBps ||
          fee > scope.maxPlatformFeeBps ||
          d.readUInt16LE(28) !== 0 ||
          d.readUInt32LE(30) < 1 ||
          d.readUInt32LE(30) > 8
        )
          throw new Error("ROUTE_FEE_OR_SLIPPAGE_SCOPE");
        if (a[8] !== eventAuthority) throw new Error("ROUTE_EVENT_AUTHORITY");
      }
      route = i;
    } else throw new Error("UNSUPPORTED_OUTER_PROGRAM");
  }
  if (
    !route ||
    closeCount !== 1 ||
    (scope.side === "BUY" &&
      (transfer !== BigInt(scope.inputRaw) || syncCount !== 1))
  )
    throw new Error("INCOMPLETE_SWAP_LIFECYCLE");
  if (delivery && (tipCount !== 1 || !computeKinds.has(2) || !computeKinds.has(3) || cuPrice <= 0n))
    throw Error("DELIVERY_TIP_OR_PRIORITY_REQUIRED");
  if (delivery && abiEvidence !== "OFFICIAL_V1_SINGLE_RAYDIUM_CLMM"&&abiEvidence!=="OFFICIAL_V1_SINGLE_METEORA_DLMM")
    throw Error("DELIVERY_ROUTE_SCOPE");
  const priorityFee = (cuLimit * cuPrice + 999999n) / 1000000n;
  if (
    priorityFee + 5000n + BigInt(delivery?.tipLamports ?? "0") >
    BigInt(scope.networkFeeCapLamports)
  )
    throw new Error("NETWORK_FEE_CAP");
  if (
    !("lifetimeToken" in message) ||
    typeof message.lifetimeToken !== "string"
  )
    throw new Error("MISSING_BLOCKHASH");
  if (![scope.wallet, source, destination].every((k) => writable.includes(k)))
    throw new Error("MISSING_WRITABLE_WALLET_ACCOUNTS");
  if (abiEvidence === "OFFICIAL_V1_SINGLE_RAYDIUM_CLMM"||abiEvidence === "OFFICIAL_V1_SINGLE_METEORA_DLMM") {
    const expectedPrograms = scope.side === "BUY"
      ? [COMPUTE, COMPUTE, ATA, ATA, P.SYSTEM, P.TOKEN, P.JUPITER_V6, P.TOKEN]
      : [COMPUTE, COMPUTE, ATA, P.JUPITER_V6, P.TOKEN];
    if (delivery) expectedPrograms.push(P.SYSTEM);
    if (instructions.length !== expectedPrograms.length ||
        instructions.some((i, n) => i.program !== expectedPrograms[n]))
      throw new Error("CPI_OUTER_INSTRUCTION_SHAPE");
    if(abiEvidence==="OFFICIAL_V1_SINGLE_METEORA_DLMM")
      await validateDlmmEvidence(cpiEvidence,bytes,message,keys,route!.accounts,{...scope,asset},wsol,usdc);
    else await validateNarrowCpiEvidence(cpiEvidence, bytes, message, keys,
      route!.accounts, { ...scope, ...(scope.asset ? { asset } : {}) }, wsol, usdc);
  }
  if (abiEvidence === "OFFICIAL_DIRECT_DAMM_V2_EXACT_IN") {
    const expected = scope.side === "BUY" ? [COMPUTE,COMPUTE,ATA,ATA,P.SYSTEM,P.TOKEN,DAMM,P.TOKEN] : [COMPUTE,COMPUTE,ATA,DAMM,P.TOKEN];
    if (instructions.length !== expected.length || instructions.some((i,n)=>i.program!==expected[n])) throw Error("DAMM_LIFECYCLE_SHAPE");
    await validateDammEvidence(cpiEvidence,bytes,message,keys,route.accounts,scope,wsol,usdc);
  }
  return {
    ...(delivery ? {tipLamports:delivery.tipLamports,tipRecipient:delivery.tipAccount,
      computeUnitLimit:cuLimit.toString(),computeUnitPriceMicroLamports:cuPrice.toString(),priorityFeeLamports:priorityFee.toString(),
      preparationCommitment:delivery.preparationCommitment,independentContextSlot:cpiEvidence!.accounts.slot} : {}),
    messageDigest: digest(Buffer.from(transaction.messageBytes)),
    transactionDigest: digest(bytes),
    blockhash: message.lifetimeToken,
    wallet: scope.wallet,
    sourceAccount: source,
    destinationAccount: destination,
    wsolAccount: wsol,
    usdcAccount: scope.asset ? "" : usdc,
    ...(scope.asset ? { asset, tokenAccount: usdc } : {}),
    inputMint,
    outputMint,
    inputRaw: scope.inputRaw,
    quotedOutputRaw: scope.quotedOutputRaw,
    minimumOutputRaw: (
      (BigInt(scope.quotedOutputRaw) * BigInt(10000 - slippage)) /
      10000n
    ).toString(),
    slippageBps: slippage,
    platformFeeBps: fee,
    accountKeys: keys,
    writableAccounts: writable,
    programs: [...new Set(instructions.map((i) => i.program))],
    routeDataHex: route.dataHex,
    routeAccounts: route.accounts,
    instructions,
    abiEvidence,
  };
}

/** Signature intake only. No key loader or signing implementation exists here. */
export function verifyExternalSignature(
  unsigned: string,
  signed: string,
  wallet: string,
): { signature: string; messageDigest: string } {
  const before = decodeWire(unsigned),
    after = decodeWire(signed);
  if (
    !Buffer.from(before.transaction.messageBytes).equals(
      Buffer.from(after.transaction.messageBytes),
    ) ||
    after.message.staticAccounts[0] !== wallet
  )
    throw new Error("SIGNER_CHANGED_TRANSACTION");
  const signature = after.transaction.signatures[address(wallet)];
  if (!signature || signature.length !== 64)
    throw new Error("MISSING_SIGNATURE");
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(bs58.decode(wallet)),
    ]),
    format: "der",
    type: "spki",
  });
  if (
    !verify(
      null,
      Buffer.from(after.transaction.messageBytes),
      publicKey,
      Buffer.from(signature),
    )
  )
    throw new Error("INVALID_SIGNATURE");
  return {
    signature: bs58.encode(signature),
    messageDigest: digest(Buffer.from(after.transaction.messageBytes)),
  };
}
