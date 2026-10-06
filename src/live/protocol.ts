export const SIGNATURE_SUBMISSION_POLICY = "EXACT_SIGNED_BYTES_ONCE_AFTER_CHECKS_V1" as const;
export const BOUNDED_DELIVERY_SUBMISSION_POLICY = "EXACT_SIGNED_BYTES_BOUNDED_DELIVERY_V1" as const;
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { z } from "zod";
import { NATIVE_SOL, USDC_MINT, WSOL_MINT } from "../domain/assets.js";
import { PROGRAM_IDS } from "../decoder/program-registry.js";

const raw = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((s) => BigInt(s) <= 18446744073709551615n);
const key = z.string().refine((s) => {
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
});
const ProtocolObject = z
  .object({
    version: z.literal("MANUAL_ROUNDTRIP_V1"),
    experimentId: z.string().regex(/^manual-live-[a-z0-9-]+$/),
    approval: z.enum(["PROPOSED", "FUNDS_AUTHORIZED"]),
    wallet: key,
    cluster: z.literal("mainnet-beta"),
    quoteMint: z.literal(NATIVE_SOL),
    tokenMint: z.literal(USDC_MINT),
    transport: z.enum(["JUPITER_MANAGED_METIS", "JUPITER_V1_SELF_RPC"]),
    signer: z.literal("EXTERNAL_WALLET_STANDARD"),
    validFromMs: z.number().int().safe().nonnegative(),
    entryUntilMs: z.number().int().safe().positive(),
    exitUntilMs: z.number().int().safe().positive(),
    fundingCapLamports: raw,
    buyLamports: raw,
    networkFeeCapLamports: raw,
    totalFeeBudgetLamports: raw,
    accountRentCapLamports: raw,
    exitReserveLamports: raw,
    maxSlippageBps: z.number().int().min(0).max(100),
    maxPlatformFeeBps: z.number().int().min(0).max(100),
    maxPriceImpactPct: z.string().regex(/^\d+(\.\d+)?$/),
    maxSellAttempts: z.number().int().min(1).max(3),
    maxReviewAgeMs: z.number().int().min(1000).max(60000),
    operator: z.string().min(1),
    takeoverInstructions: z.string().min(1),
    candidateDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
function validateBudget(p: {validFromMs:number;entryUntilMs:number;exitUntilMs:number;
  buyLamports:string;totalFeeBudgetLamports:string;accountRentCapLamports:string;
  exitReserveLamports:string;fundingCapLamports:string;networkFeeCapLamports:string;
  maxSellAttempts:number}, c: z.RefinementCtx) {
    if (!(p.validFromMs < p.entryUntilMs && p.entryUntilMs <= p.exitUntilMs))
      c.addIssue({ code: "custom", message: "INVALID_AUTHORIZATION_WINDOW" });
    if (
      BigInt(p.buyLamports) <= 0n ||
      BigInt(p.buyLamports) +
        BigInt(p.totalFeeBudgetLamports) +
        BigInt(p.accountRentCapLamports) +
        BigInt(p.exitReserveLamports) >
        BigInt(p.fundingCapLamports)
    )
      c.addIssue({ code: "custom", message: "INVALID_BUDGET_RESERVES" });
    if (
      BigInt(p.networkFeeCapLamports) * (1n + BigInt(p.maxSellAttempts)) >
      BigInt(p.totalFeeBudgetLamports)
    )
      c.addIssue({ code: "custom", message: "INSUFFICIENT_FEE_BUDGET" });
}
export const ProtocolSchema = ProtocolObject.superRefine(validateBudget);
export type LiveProtocol = z.infer<typeof ProtocolSchema>;
/** Explicitly bound graduated delivery. The public Sender SWQOS-only contract
 * uses a fixed 5,000-lamport tip. This is not inherited by an old authorization
 * or an implicit Smart Wallet protocol. Fees + tip share the existing fee cap.
 * https://www.helius.dev/docs/sending-transactions/sender-swqos-only */
export const DeliveryPolicySchema = z.object({
  id:z.literal("HELIUS_SWQOS_ONLY_V1"),
  tipAccount:z.literal("4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE"),
  tipLamports:z.literal("5000"),
  maxBroadcasts:z.union([z.literal(1),z.literal(3)]),broadcastIntervalMs:z.literal(1000),
  preparationCommitment:z.literal("confirmed"),preflightCommitment:z.literal("confirmed"),
  skipPreflight:z.literal(true),maxRetries:z.literal(0),
}).strict();
export type DeliveryPolicy = z.infer<typeof DeliveryPolicySchema>;
/** Route/domain refusal uses the existing candidate-level pool qualification
 * disposition, with an explicit public code and concrete reason. It is not a
 * transport, identity or responsibility error and never authorizes fallback. */
export function executionUnqualified(reason: string) {
  return Object.assign(new Error("EXECUTION_POOL_UNQUALIFIED"), {
    code: "EXECUTION_UNQUALIFIED" as const, reason,
  });
}
/** Separate identity: the sealed Manual schema and its funded scope are unchanged.
 * One protocol remains one BUY and its position-derived exit, never a portfolio. */
export const ExecutionAssetSchema = z.object({
  tokenMint: key.refine(mint => mint !== WSOL_MINT),
  tokenProgram: z.literal(PROGRAM_IDS.TOKEN),
  tokenDecimals: z.number().int().min(0).max(18),
}).strict();
export type ExecutionAsset = z.infer<typeof ExecutionAssetSchema>;
// First DLMM qualification is one observed pair, not arbitrary Meteora authority.
export const DLMM_EXECUTION_SCOPE = "CLASSIC_SOL_EXACT_JUPITER_V1_METEORA_DLMM" as const;
export const DLMM_QUALIFIED_MINT = "C8fU5GdfAt5mnw2RK7HE6XJGFNxHpaskZMkXxdm88888";
export const DLMM_QUALIFIED_POOL = "JCLQiP7t1uxHiZHPotpUoVvPFFE48UxpkXHsVJJJvUrJ";
export const MANUAL_EXECUTION_ASSET: ExecutionAsset = Object.freeze({
  tokenMint: USDC_MINT, tokenProgram: PROGRAM_IDS.TOKEN, tokenDecimals: 6,
});
export const AutonomousProtocolSchema = ProtocolObject.extend({
  version: z.literal("AUTONOMOUS_SINGLE_POSITION_V1"),
  experimentId: z.string().regex(/^autonomous-[a-z0-9-]+$/),
  tokenMint: ExecutionAssetSchema.shape.tokenMint,
  tokenProgram: ExecutionAssetSchema.shape.tokenProgram,
  tokenDecimals: ExecutionAssetSchema.shape.tokenDecimals,
  signer: z.literal("AUTOMATED_POLICY_SIGNER_V1"),
  transport: z.enum(["JUPITER_V1_SELF_RPC","DIRECT_DAMM_V2_SELF_RPC"]),
  executionScope: z.enum(["CLASSIC_SOL_DYNAMIC_JUPITER_V1_RAYDIUM_CLMM","CLASSIC_SOL_DYNAMIC_DIRECT_DAMM_V2",DLMM_EXECUTION_SCOPE]),
  /** Explicit independent function calibration; not a source-derived follower
   * sample. Reuses the original static USDC reviewer, not relaxed dynamic mint
   * authority checks. Absence preserves every existing autonomous protocol. */
  executionPurpose: z.literal("EXECUTION_FUNCTION_TEST").optional(),
  deliveryPolicy: DeliveryPolicySchema.optional(),
  executionPool: key.optional(),
  sourceEventId: z.string().min(1),
  maxSellAttempts: z.literal(1),
  maxPlatformFeeBps: z.literal(0),
}).superRefine((p,ctx)=>{
  validateBudget(p,ctx);
  if(p.deliveryPolicy && (p.transport!=="JUPITER_V1_SELF_RPC" ||
      !["CLASSIC_SOL_DYNAMIC_JUPITER_V1_RAYDIUM_CLMM",DLMM_EXECUTION_SCOPE].includes(p.executionScope)))
    ctx.addIssue({code:"custom",message:"DELIVERY_EXECUTION_SCOPE_BINDING"});
  if ((p.transport === "DIRECT_DAMM_V2_SELF_RPC") !== (p.executionScope === "CLASSIC_SOL_DYNAMIC_DIRECT_DAMM_V2") ||
    (p.transport === "DIRECT_DAMM_V2_SELF_RPC" || p.executionScope === DLMM_EXECUTION_SCOPE ? !p.executionPool : p.executionPool !== undefined))
    ctx.addIssue({code:"custom",message:"EXECUTION_BUILD_SCOPE_BINDING"});
  if (p.executionScope === DLMM_EXECUTION_SCOPE &&
    (p.transport !== "JUPITER_V1_SELF_RPC" || p.tokenMint !== DLMM_QUALIFIED_MINT ||
      p.tokenDecimals !== 9 || p.executionPool !== DLMM_QUALIFIED_POOL || p.executionPurpose !== undefined))
    ctx.addIssue({code:"custom",message:"DLMM_EXACT_PAIR_SCOPE_BINDING"});
  if (p.executionPurpose === "EXECUTION_FUNCTION_TEST" &&
      (p.tokenMint !== USDC_MINT || p.tokenProgram !== PROGRAM_IDS.TOKEN || p.tokenDecimals !== 6 ||
       p.transport !== "JUPITER_V1_SELF_RPC" || p.executionScope !== "CLASSIC_SOL_DYNAMIC_JUPITER_V1_RAYDIUM_CLMM"))
    ctx.addIssue({code:"custom",message:"EXECUTION_FUNCTION_TEST_SCOPE"});
});
export type AutonomousExecutionProtocol = z.infer<typeof AutonomousProtocolSchema>;
export type ExecutionProtocol = LiveProtocol | AutonomousExecutionProtocol;
export function signatureSubmissionPolicy(p:ExecutionProtocol){
  return p.version==="AUTONOMOUS_SINGLE_POSITION_V1"&&p.deliveryPolicy
    ? BOUNDED_DELIVERY_SUBMISSION_POLICY : SIGNATURE_SUBMISSION_POLICY;
}
/** One explicit function-test identity inherits the existing static USDC owner.
 * Normal autonomous CLMM/DAMM protocols keep their dynamic review contract. */
export function isDynamicExecutionProtocol(protocol: ExecutionProtocol): boolean {
  return protocol.version === "AUTONOMOUS_SINGLE_POSITION_V1" &&
    protocol.executionPurpose !== "EXECUTION_FUNCTION_TEST";
}
export function parseExecutionProtocol(value: unknown): ExecutionProtocol {
  return value && typeof value === "object" && "version" in value && value.version === "AUTONOMOUS_SINGLE_POSITION_V1"
    ? AutonomousProtocolSchema.parse(value) : ProtocolSchema.parse(value);
}
export function executionAsset(protocol: ExecutionProtocol): ExecutionAsset {
  return protocol.version === "MANUAL_ROUNDTRIP_V1" ? MANUAL_EXECUTION_ASSET :
    ExecutionAssetSchema.parse({ tokenMint: protocol.tokenMint, tokenProgram: protocol.tokenProgram,
      tokenDecimals: protocol.tokenDecimals });
}
const ManualExitAuthoritySchema = z
  .object({
    version: z.literal("LIVE_EXIT_ONLY_AUTHORIZATION_V1"),
    approval: z.literal("FUNDS_AUTHORIZED"),
    parentProtocolDigest: z.string().regex(/^[a-f0-9]{64}$/),
    wallet: key,
    tokenMint: z.literal(USDC_MINT),
    remainingRaw: raw,
    baseSellAttemptCount: z.number().int().min(0),
    maxAdditionalSellAttempts: z.number().int().min(1).max(3),
    validFromMs: z.number().int().safe().nonnegative(),
    exitUntilMs: z.number().int().safe().positive(),
    additionalRequestBudget: z.number().int().min(20).max(200),
    operator: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
/** A linked permission for one already-owned, never-signed SELL-1. The parent
 * protocol/Journal/capital identity remains immutable; this is not new entry. */
export const AutonomousLinkedExitAuthoritySchema = z.object({
  version: z.literal("AUTONOMOUS_LINKED_EXIT_ONLY_V1"),
  approval: z.enum(["NOT_APPROVED", "FUNDS_AUTHORIZED"]),
  recoveryReleaseManifest: z.string().min(1),
  recoveryReleaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  providerReference: z.object({path:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),
  parentReleaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  parentConfigDigest: z.string().regex(/^[a-f0-9]{64}$/),
  parentAuthorizationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  parentSignerPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  parentProtocolDigest: z.string().regex(/^[a-f0-9]{64}$/),
  episodeId: z.string().min(1),
  wallet: key, tokenMint: key,
  buySignature: z.string().min(64).max(88),
  buySettlementDigest: z.string().regex(/^[a-f0-9]{64}$/),
  remainingRaw: raw.refine(s => BigInt(s) > 0n),
  attemptId: z.literal("SELL-1"),
  baseAttemptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  baseUnsignedPreparationCount: z.number().int().min(1).max(2),
  baseSellAttemptCount: z.literal(0), maxAdditionalSellAttempts: z.literal(1),
  maxNewSignatures: z.literal(1), maxPosts: z.literal(1),
  buyAllowed: z.literal(false), partialSellAllowed: z.literal(false),
  rebroadcastAllowed: z.literal(false), replacementAllowed: z.literal(false),
  validFromMs: z.number().int().safe().nonnegative(),
  exitUntilMs: z.number().int().safe().positive(),
  additionalRequestBudget: z.number().int().min(20).max(200),
}).strict().refine(a => a.exitUntilMs > a.validFromMs && a.exitUntilMs - a.validFromMs <= 1800000,
  "LINKED_EXIT_WINDOW_BOUND");
export type AutonomousLinkedExitAuthority = z.infer<typeof AutonomousLinkedExitAuthoritySchema>;
export const ExitAuthoritySchema = z.union([ManualExitAuthoritySchema, AutonomousLinkedExitAuthoritySchema]);
export type ExitAuthority = z.infer<typeof ExitAuthoritySchema>;
export function assertLinkedExitProtocol(p: ExecutionProtocol, a: AutonomousLinkedExitAuthority): void {
  if (p.version !== "AUTONOMOUS_SINGLE_POSITION_V1" || p.executionPurpose !== undefined ||
      p.executionScope !== "CLASSIC_SOL_DYNAMIC_JUPITER_V1_RAYDIUM_CLMM" || p.transport !== "JUPITER_V1_SELF_RPC" ||
      p.candidateDigest !== a.parentReleaseDigest || protocolDigest(p) !== a.parentProtocolDigest ||
      p.wallet !== a.wallet || p.tokenMint !== a.tokenMint || p.maxSellAttempts !== 1 ||
      p.deliveryPolicy?.maxBroadcasts !== 1 || p.deliveryPolicy.maxRetries !== 0)
    throw Error("LINKED_EXIT_PARENT_BINDING");
}
export const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export function protocolDigest(p: ExecutionProtocol): string {
  return digest(JSON.stringify(parseExecutionProtocol(p)));
}
export function assertAuthority(
  p: ExecutionProtocol,
  side: "BUY" | "SELL",
  now: number,
  funds: boolean,
): void {
  if (
    now < p.validFromMs ||
    now >= (side === "BUY" ? p.entryUntilMs : p.exitUntilMs)
  )
    throw new Error("AUTHORIZATION_EXPIRED_OR_NOT_STARTED");
  if (funds && p.approval !== "FUNDS_AUTHORIZED")
    throw new Error("FUNDS_NOT_AUTHORIZED");
}
