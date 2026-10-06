import { z } from "zod";
import bs58 from "bs58";
import { SystemClock } from "../domain/time.js";
import { USDC_MINT, WSOL_MINT } from "../domain/assets.js";
import { nativeSolPrincipal } from "../decoder/native-sol-principal.js";
import { TransactionNormalizer } from "../decoder/transaction-normalizer.js";
import { mapRpcTransaction } from "../rpc/rpc-transaction-mapper.js";
import { decodeWire, reviewAsset, reviewTokenAccount, type TransactionReview } from "./transaction-review.js";
import { digest, DeliveryPolicySchema } from "./protocol.js";
import { PROGRAM_IDS as P } from "../decoder/program-registry.js";

const integer = z
  .union([z.number().int().safe().nonnegative(), z.string().regex(/^\d+$/)])
  .transform(String);
const token = z
  .object({
    accountIndex: z.number().int().nonnegative(),
    mint: z.string(),
    owner: z.string(),
    programId: z.string().optional(),
    uiTokenAmount: z.object({
      amount: z.string().regex(/^\d+$/),
      decimals: z.number().int(),
    }),
  })
  .passthrough();
const metadata = z
  .object({
    err: z.union([
      z.null(),
      z.string().min(1),
      z
        .record(z.string(), z.unknown())
        .refine((v) => Object.keys(v).length > 0),
    ]),
    fee: integer,
    preBalances: z.array(integer),
    postBalances: z.array(integer),
    preTokenBalances: z.array(token),
    postTokenBalances: z.array(token),
    innerInstructions: z.array(z.unknown()),
    logMessages: z.array(z.string()),
    loadedAddresses: z
      .object({ writable: z.array(z.string()), readonly: z.array(z.string()) })
      .optional(),
  })
  .passthrough();

export interface ChainBinding {
  review: TransactionReview;
  signedTransaction: string;
  signature: string;
  side: "BUY" | "SELL";
  networkFeeCapLamports: string;
}
/** Caller supplies only getTransaction(... commitment=finalized, encoding=base64).
 * Exact signed wire bytes and ALT-expanded accounts bind metadata to the journal. */
export function settleChainTransaction(
  raw: unknown,
  binding: ChainBinding,
): Record<string, unknown> {
  const item = raw as Record<string, unknown>;
  if (!item || !item.meta) throw new Error("CHAIN_METADATA_MISSING");
  const asset = reviewAsset(binding.review);
  const m = metadata.parse(item.meta);
  if (!Object.hasOwn(m, "err")) throw new Error("CHAIN_ERROR_FIELD_MISSING");
  const transaction = z
    .tuple([z.string(), z.literal("base64")])
    .parse(item.transaction);
  if (transaction[0] !== binding.signedTransaction)
    throw new Error("CHAIN_TRANSACTION_BYTES_MISMATCH");
  const { message, transaction: tx } = decodeWire(transaction[0]);
  if (digest(Buffer.from(tx.messageBytes)) !== binding.review.messageDigest)
    throw new Error("CHAIN_MESSAGE_MISMATCH");
  const signature = Object.values(tx.signatures)[0];
  if (!signature || bs58.encode(signature) !== binding.signature)
    throw new Error("CHAIN_SIGNATURE_MISMATCH");
  const keys = [
    ...message.staticAccounts,
    ...(m.loadedAddresses?.writable ?? []),
    ...(m.loadedAddresses?.readonly ?? []),
  ];
  if (
    JSON.stringify(keys) !== JSON.stringify(binding.review.accountKeys) ||
    m.preBalances.length !== keys.length ||
    m.postBalances.length !== keys.length
  )
    throw new Error("CHAIN_ACCOUNT_BINDING_MISMATCH");
  const walletIndex = keys.indexOf(binding.review.wallet),
    usdcIndex = keys.indexOf(reviewTokenAccount(binding.review)),
    wsolIndex = keys.indexOf(binding.review.wsolAccount);
  if (walletIndex !== 0 || usdcIndex < 0 || wsolIndex < 0)
    throw new Error("CHAIN_WALLET_SCOPE");
  for (const b of [...m.preTokenBalances, ...m.postTokenBalances]) {
    if (b.accountIndex >= keys.length) throw new Error("CHAIN_TOKEN_INDEX");
    if (
      b.owner === binding.review.wallet &&
      (b.mint !== asset.tokenMint || b.accountIndex !== usdcIndex)
    )
      throw new Error("UNEXPECTED_WALLET_TOKEN_BALANCE");
    if (
      b.accountIndex === usdcIndex &&
      (b.owner !== binding.review.wallet ||
        b.mint !== asset.tokenMint ||
        b.uiTokenAmount.decimals !== asset.tokenDecimals ||
        (binding.review.asset !== undefined && b.programId !== asset.tokenProgram))
    )
      throw new Error("CHAIN_TOKEN_OWNER_MISMATCH");
  }
  const sum = (bs: typeof m.preTokenBalances) =>
    bs
      .filter((b) => b.owner === binding.review.wallet && b.mint === asset.tokenMint)
      .reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
  const tokenDelta = sum(m.postTokenBalances) - sum(m.preTokenBalances);
  const walletDelta = BigInt(m.postBalances[0]!) - BigInt(m.preBalances[0]!);
  const fee = BigInt(m.fee),
    rent =
      BigInt(m.postBalances[usdcIndex]!) - BigInt(m.preBalances[usdcIndex]!);
  if (
    BigInt(m.preBalances[wsolIndex]!) !== 0n ||
    BigInt(m.postBalances[wsolIndex]!) !== 0n
  )
    throw new Error("WSOL_NOT_CLOSED_OR_PREEXISTING");
  const failed = m.err !== null;
  let deliveryTip = 0n;
  const hasDeliveryTip = binding.review.tipLamports !== undefined || binding.review.tipRecipient !== undefined;
  if (hasDeliveryTip) {
    if (binding.review.tipLamports !== DeliveryPolicySchema.shape.tipLamports.value ||
        binding.review.tipRecipient !== DeliveryPolicySchema.shape.tipAccount.value ||
        binding.review.preparationCommitment !== "confirmed")
      throw Error("CHAIN_DELIVERY_TIP_BINDING");
    const tipIndex = keys.indexOf(binding.review.tipRecipient);
    const tipInstructions = message.instructions.filter(i => keys[i.programAddressIndex] === P.SYSTEM &&
      i.accountIndices?.[1] === tipIndex);
    const last = message.instructions.at(-1),tip = tipInstructions[0];
    const tipData = Buffer.from(tip?.data ?? []);
    if (tipIndex <= 0 || tipInstructions.length !== 1 || !tip || tip !== last || tip.accountIndices?.length !== 2 ||
        tip.accountIndices[0] !== 0 || tipData.length !== 12 || tipData.readUInt32LE(0) !== 2 ||
        tipData.readBigUInt64LE(4) !== BigInt(binding.review.tipLamports))
      throw Error("CHAIN_DELIVERY_TIP_INSTRUCTION");
    deliveryTip = failed ? 0n : BigInt(binding.review.tipLamports);
    if (BigInt(m.postBalances[tipIndex]!) - BigInt(m.preBalances[tipIndex]!) !== deliveryTip)
      throw Error("CHAIN_DELIVERY_TIP_DELTA");
  }
  let principal = 0n;
  if (!failed) {
    const mapped = mapRpcTransaction(
      {
        ...item,
        meta: m,
        transaction: {
          signatures: [binding.signature],
          message: {
            accountKeys: message.staticAccounts,
            header: {
              numRequiredSignatures: message.header.numSignerAccounts,
              numReadonlySignedAccounts:
                message.header.numReadonlySignerAccounts,
              numReadonlyUnsignedAccounts:
                message.header.numReadonlyNonSignerAccounts,
            },
            instructions: message.instructions.map((i) => ({
              programIdIndex: i.programAddressIndex,
              accounts: i.accountIndices ?? [],
              data: bs58.encode(Buffer.from(i.data ?? new Uint8Array())),
            })),
            ...(message.version === 0
              ? { addressTableLookups: message.addressTableLookups ?? [] }
              : {}),
          },
        },
      },
      new SystemClock().now(),
    );
    const normalized = new TransactionNormalizer(new SystemClock()).normalize(
      mapped,
    );
    const proof = nativeSolPrincipal(normalized, binding.review.wallet);
    if (proof.ambiguous || proof.raw === undefined)
      throw new Error("CHAIN_PRINCIPAL_UNPROVEN");
    principal = proof.raw;
    if (
      binding.side === "BUY"
        ? tokenDelta <= 0n || principal >= 0n
        : tokenDelta >= 0n || principal <= 0n
    )
      throw new Error("CHAIN_TRADE_DIRECTION_MISMATCH");
  } else if (tokenDelta !== 0n || rent !== 0n)
    throw new Error("FAILED_TRANSACTION_HAS_ASSET_CHANGES");
  const unexplained = walletDelta - principal + fee + rent + deliveryTip;
  const violations: string[] = [];
  if (unexplained !== 0n) violations.push("UNEXPLAINED_NATIVE_DELTA");
  if (fee + deliveryTip > BigInt(binding.networkFeeCapLamports))
    violations.push("NETWORK_FEE_CAP_EXCEEDED");
  const input = binding.side === "BUY" ? -principal : -tokenDelta,
    output = binding.side === "BUY" ? tokenDelta : principal;
  if (
    !failed &&
    (input > BigInt(binding.review.inputRaw) ||
      output < BigInt(binding.review.minimumOutputRaw))
  )
    violations.push("LANDED_AMOUNTS_OUTSIDE_AUTHORIZATION");
  return {
    signature: binding.signature,
    commitment: "finalized",
    slot: integer.parse(item.slot),
    failed,
    chainEvidenceDigest: digest(JSON.stringify(item)),
    rawFinalizedTransaction: item,
    tokenDeltaRaw: tokenDelta.toString(),
    walletDeltaRaw: walletDelta.toString(),
    nativePrincipalRaw: principal.toString(),
    networkFeeRaw: fee.toString(),
    ...(hasDeliveryTip ? {deliveryTipRaw:deliveryTip.toString(),deliveryTipRecipient:binding.review.tipRecipient} : {}),
    recoverableRentDeltaRaw: rent.toString(),
    unexplainedNativeDeltaRaw: unexplained.toString(),
    inputRaw: input.toString(),
    outputRaw: output.toString(),
    tokenPreRaw: sum(m.preTokenBalances).toString(),
    tokenPostRaw: sum(m.postTokenBalances).toString(),
    walletPreRaw: m.preBalances[0],
    walletPostRaw: m.postBalances[0],
    feeAccounting: hasDeliveryTip ? "NETWORK_TOTAL_OBSERVED_DELIVERY_TIP_SEPARATE_PLATFORM_DEX_IN_PRINCIPAL" :
      "NETWORK_TOTAL_OBSERVED_PLATFORM_DEX_ALREADY_EMBEDDED_IN_PRINCIPAL",
    unknownCosts: [
      "NETWORK_BASE_PRIORITY_SPLIT_UNATTRIBUTED",
      ...(!failed
        ? [
            "DEX_FEE_BREAKDOWN_UNATTRIBUTED",
            ...(binding.review.platformFeeBps > 0
              ? ["PLATFORM_FEE_EMBEDDED_AMOUNT_UNATTRIBUTED"]
              : []),
          ]
        : []),
    ],
    violations,
  };
}
