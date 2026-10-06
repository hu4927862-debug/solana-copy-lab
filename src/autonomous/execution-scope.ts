/** Execution capability, not financial authority. Keep the proved Manual scope
 * explicit: source decoding and a Jupiter quote do not qualify a new CPI route. */
import bs58 from "bs58";
import { USDC_MINT, WSOL_MINT } from "../domain/assets.js";
import { PROGRAM_IDS } from "../decoder/program-registry.js";
import { reviewTransaction, verifyExternalSignature, type ReviewScope } from "../live/transaction-review.js";
import type { CpiSemanticEvidence } from "../live/cpi-semantic-evidence.js";

// These are the maintained Manual owners, not copies or relaxed replacements.
// Importing this module performs no RPC, signing, sending or state initialization.
export { decodeWire, verifyExternalSignature } from "../live/transaction-review.js";
export { decodeIndependentAlt } from "../live/cpi-semantic-evidence.js";
export { QuoteFinality, FINALITY_SYNC_POLICY } from "../live/quote-finality.js";
export { sealedProgramAttestation, validateFullAttestation, validateProgramMetadata }
  from "../live/program-attestation.js";

export const MANUAL_EXECUTION_SCOPE = "CLASSIC_SOL_USDC_JUPITER_V1_RAYDIUM_CLMM";
export const DYNAMIC_EXECUTION_SCOPE = "CLASSIC_SOL_DYNAMIC_JUPITER_V1_RAYDIUM_CLMM";
export const RAYDIUM_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
/** Negative-only quote-domain screening before quota consumption. This proves
 * neither pool/ABI semantics nor executable bytes; independent review, simulation
 * and all authorization/capital checks remain mandatory. No funds authority. */
export function preliminaryFollowerExecutionEligibility(source: any, entry: any, reverse: any) {
  const block=(reason:string)=>({eligible:false,reason,preliminaryOnly:true,executionAuthority:false});
  const token=source?.verified?.token;
  const tokenProgram=token?.tokenProgram??(source?.ownership?.accepted===true&&source.ownership.verifier==="RPC_JUPITER_ROUTE_V2_OWNER_NET_V2"?PROGRAM_IDS.TOKEN:null);
  if(tokenProgram!==PROGRAM_IDS.TOKEN)return block("EXECUTION_TOKEN_PROGRAM_UNQUALIFIED");
  for(const [quote,input,output]of [[entry,WSOL_MINT,token?.mint],[reverse,token?.mint,WSOL_MINT]]){
    if(!quote||quote.error||!Array.isArray(quote.route)||quote.route.length!==1)return block("EXECUTION_ROUTE_NOT_SINGLE");
    const step=quote.route[0],swap=step?.swapInfo;
    if(step?.percent!==100||swap?.label!=="Raydium CLMM")return block("EXECUTION_ROUTE_UNQUALIFIED");
    if(swap.inputMint!==input||swap.outputMint!==output||swap.inAmount!==String(quote.input_raw)||swap.outAmount!==String(quote.output_raw))return block("EXECUTION_ROUTE_PLAN_SCOPE");
  }
  return{eligible:true,reason:null,preliminaryOnly:true,executionAuthority:false};
}
export interface ExecutionScopeRequest {
  side: "BUY" | "SELL";
  tokenMint: string;
  tokenProgram: string;
  tokenDecimals: number;
  route: {
    label: string;
    instructionVersion: string;
    direct: boolean;
    hopCount: number;
    platformFeeBps: number;
  };
  /** Routing facts only. These are NOT a substitute for independent raw pool,
   * vault, tick-array, account-privilege and ProgramData evidence. */
  pool: {
    owner: string;
    mint0: string;
    mint1: string;
    decimals0: number;
    decimals1: number;
  };
}
export interface ExecutionScopeAssessment {
  status: "BLOCKED" | "MANUAL_PRIMITIVES_AVAILABLE" | "DYNAMIC_PRIMITIVES_AVAILABLE";
  code: string;
  scope: typeof MANUAL_EXECUTION_SCOPE | typeof DYNAMIC_EXECUTION_SCOPE;
  fundedExecutionAllowed: false;
  missing: readonly string[];
  direction?: { inputMint: string; outputMint: string; zeroForOne: boolean };
}
function key(value: string): boolean {
  try { return bs58.decode(value).length === 32; } catch { return false; }
}
/** All outcomes deny autonomous funds authority. Capability describes the code
 * path only; each order still needs independent raw evidence, actual review,
 * simulation and separately bound autonomous release/capital/signer authority. */
export function assessExecutionScope(request: ExecutionScopeRequest): ExecutionScopeAssessment {
  const scope = request.tokenMint === USDC_MINT ? MANUAL_EXECUTION_SCOPE : DYNAMIC_EXECUTION_SCOPE;
  const block = (code: string): ExecutionScopeAssessment => ({ status: "BLOCKED", code,
    scope, fundedExecutionAllowed: false, missing: [code] });
  if (!["BUY", "SELL"].includes(request.side) || !key(request.tokenMint) ||
      request.tokenMint === WSOL_MINT || !Number.isInteger(request.tokenDecimals) ||
      request.tokenDecimals < 0 || request.tokenDecimals > 18)
    return block("EXECUTION_ASSET_SCOPE_INVALID");
  if (request.tokenProgram !== PROGRAM_IDS.TOKEN) return block("EXECUTION_TOKEN_PROGRAM_UNQUALIFIED");
  const route = request.route;
  if (!route || route.label !== "Raydium CLMM" || route.instructionVersion !== "V1" ||
      route.direct !== true || route.hopCount !== 1 || route.platformFeeBps !== 0)
    return block("EXECUTION_ROUTE_UNQUALIFIED");
  const pool = request.pool;
  if (!pool || pool.owner !== RAYDIUM_CLMM_PROGRAM || !key(pool.mint0) || !key(pool.mint1) ||
      Buffer.compare(bs58.decode(pool.mint0), bs58.decode(pool.mint1)) >= 0 ||
      ![pool.mint0, pool.mint1].includes(WSOL_MINT) ||
      ![pool.mint0, pool.mint1].includes(request.tokenMint) ||
      pool.decimals0 !== (pool.mint0 === WSOL_MINT ? 9 : request.tokenDecimals) ||
      pool.decimals1 !== (pool.mint1 === WSOL_MINT ? 9 : request.tokenDecimals))
    return block("EXECUTION_POOL_IDENTITY_MISMATCH");
  const inputMint = request.side === "BUY" ? WSOL_MINT : request.tokenMint;
  const outputMint = request.side === "BUY" ? request.tokenMint : WSOL_MINT;
  const direction = { inputMint, outputMint, zeroForOne: inputMint === pool.mint0 };
  if (scope === DYNAMIC_EXECUTION_SCOPE) return { status: "DYNAMIC_PRIMITIVES_AVAILABLE",
    code: "AUTONOMOUS_AUTHORITY_NOT_GRANTED", scope, direction,
    fundedExecutionAllowed: false, missing: ["LIVE_DYNAMIC_SCOPE_VALIDATION", "AUTONOMOUS_SIGNER_AND_RELEASE_AUTHORITY"] };
  if (request.tokenDecimals !== 6 || pool.mint0 !== WSOL_MINT || pool.mint1 !== USDC_MINT)
    return block("LEGACY_MANUAL_POOL_SCOPE_MISMATCH");
  return { status: "MANUAL_PRIMITIVES_AVAILABLE", code: "AUTONOMOUS_AUTHORITY_NOT_GRANTED",
    scope, direction, fundedExecutionAllowed: false,
    missing: ["AUTONOMOUS_SIGNER_AND_RELEASE_AUTHORITY"] };
}

/** Only the old independently reviewed scope is delegated. This method returns
 * a transaction review, never a signer or funded-release authorization. */
export async function reviewLegacyManualTransaction(
  encoded: string,
  executionScope: ExecutionScopeRequest,
  reviewScope: ReviewScope,
  resolveLookup: (key: string) => Promise<readonly string[]>,
  evidence?: CpiSemanticEvidence,
) {
  const capability = assessExecutionScope(executionScope);
  if (capability.status === "DYNAMIC_PRIMITIVES_AVAILABLE") throw Error("DYNAMIC_SCOPE_REQUIRES_INDEPENDENT_ASSET_REVIEW");
  if (capability.status !== "MANUAL_PRIMITIVES_AVAILABLE") throw Error(capability.code);
  if (executionScope.side !== reviewScope.side || reviewScope.maxPlatformFeeBps !== 0)
    throw Error("EXECUTION_REVIEW_SCOPE_MISMATCH");
  const review = await reviewTransaction(encoded, reviewScope, resolveLookup, evidence);
  if (review.abiEvidence !== "OFFICIAL_V1_SINGLE_RAYDIUM_CLMM")
    throw Error("EXECUTION_ROUTE_UNQUALIFIED");
  return review;
}

/** Cryptographic verification only. The caller still must durably import the
 * responsibility and perform authority/freshness/simulation gates before send. */
export function verifyBoundSignedBytes(
  unsigned: string,
  signed: string,
  wallet: string,
  expectedMessageDigest: string,
) {
  if (!/^[a-f0-9]{64}$/.test(expectedMessageDigest)) throw Error("AUTONOMOUS_MESSAGE_BINDING_MISMATCH");
  const verified = verifyExternalSignature(unsigned, signed, wallet);
  if (verified.messageDigest !== expectedMessageDigest) throw Error("AUTONOMOUS_MESSAGE_BINDING_MISMATCH");
  return verified;
}
