import { realpathSync, lstatSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute, join, sep } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { AutonomousProtocolSchema, AutonomousLinkedExitAuthoritySchema, assertLinkedExitProtocol, protocolDigest, digest, signatureSubmissionPolicy, DeliveryPolicySchema, isDynamicExecutionProtocol } from "../live/protocol.js";
import { reviewTransaction } from "../live/transaction-review.js";
import { decodeIndependentAlt, type CpiSemanticEvidence } from "../live/cpi-semantic-evidence.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const raw = z.string().regex(/^(0|[1-9][0-9]*)$/);
/** Operator-owned, read-only policy. A model result or a signing request cannot
 * raise these limits. It is separate from every historical Manual approval. */
export const SignerPolicySchema = z.object({
  schema: z.literal("AUTONOMOUS_SIGNER_POLICY_V1"),
  candidateDigest: hash,
  policyDigest: hash,
  wallet: z.string().min(32).max(44),
  notBeforeMs: z.number().int().safe().nonnegative(),
  expiresAtMs: z.number().int().safe().positive(),
  buyLamports: raw,
  walletCapLamports: raw,
  feePerAttemptLamports: raw,
  totalFeeLamports: raw,
  rentCapLamports: raw,
  exitReserveLamports: raw,
  maxSlippageBps: z.number().int().min(0).max(100),
  maxPriceImpactPct: z.string().regex(/^\d+(\.\d+)?$/),
  journalRoot: z.string().min(1),
  stageDatabase: z.string().min(1),
  sourceStageWallet: z.string().min(32).max(44),
  claimDirectory: z.string().min(1),
  killFile: z.string().min(1),
  authorizationDigest: hash,
  deliveryPolicy: DeliveryPolicySchema.optional(),
  linkedExitAuthority: AutonomousLinkedExitAuthoritySchema.optional(),
}).strict();
export type SignerPolicy = z.infer<typeof SignerPolicySchema>;

export interface PolicySigningRequest {
  schema: "AUTONOMOUS_POLICY_SIGN_REQUEST_V1";
  journalPath: string;
  policyDigest: string;
  authorizationDigest: string;
  request: Record<string, unknown>;
}
const need = (ok: unknown, code: string): void => { if (!ok) throw Error(code); };

function linkedRequest(policy: SignerPolicy, input: PolicySigningRequest) {
  const a = policy.linkedExitAuthority, r = input.request;
  if (!a) { need(r.exitAuthority == null, "SIGNER_AUTHORITY_BINDING"); return undefined; }
  const p = AutonomousProtocolSchema.parse(r.authorization);
  assertLinkedExitProtocol(p, a);
  need(a.approval === "FUNDS_AUTHORIZED" && r.attemptId === a.attemptId &&
    JSON.stringify(r.exitAuthority) === JSON.stringify(a) && r.exitAuthorityDigest === digest(JSON.stringify(a)) &&
    a.parentReleaseDigest === policy.candidateDigest && a.parentConfigDigest === policy.policyDigest &&
    a.parentAuthorizationDigest === policy.authorizationDigest && a.wallet === policy.wallet,
    "SIGNER_LINKED_EXIT_BINDING");
  return a;
}
function linkedJournal(db: Database.Database, policy: SignerPolicy, input: PolicySigningRequest, meta: Record<string,string>) {
  const a = linkedRequest(policy,input); if (!a) return;
  need(meta.exitAuthority === JSON.stringify(a) && !!meta.entryStopped, "SIGNER_LINKED_EXIT_JOURNAL_BINDING");
  const rows=db.prepare("SELECT id,side,state,amount,data FROM live_attempts ORDER BY id").all() as {id:string;side:string;state:string;amount:string;data:string}[];
  const buy=rows.find(r=>r.id==="BUY"), sell=rows.find(r=>r.id===a.attemptId), b=buy?JSON.parse(buy.data):{};
  need(rows.length===2 && buy?.state==="SETTLED" && b.balanceReconciled===true && b.signature===a.buySignature &&
    b.settlement?.commitment==="finalized" && b.settlement?.chainEvidenceDigest===a.buySettlementDigest &&
    sell?.side==="SELL" && sell.state==="REVIEWED" && sell.amount===a.remainingRaw, "SIGNER_LINKED_EXIT_POSITION_BINDING");
  const settlements=db.prepare("SELECT evidence FROM live_settlements").all() as {evidence:string}[];
  need(settlements.length===1 && settlements.reduce((s,r)=>s+BigInt(JSON.parse(r.evidence).tokenDeltaRaw),0n).toString()===a.remainingRaw,
    "SIGNER_FULL_SELL_POSITION_MISMATCH");
  for (const r of db.prepare("SELECT payload FROM live_events WHERE kind='STATE_CHANGED'").all() as {payload:string}[]) {
    const e=JSON.parse(r.payload); if(e.id!==a.attemptId)continue;
    need(![e.from,e.to].some(s=>["SIGNED","UNKNOWN","SETTLED","CHAIN_FAILED"].includes(s)) &&
      !["signature","signedTransaction","settlement","submissionStartedAtMs"].some(k=>Object.hasOwn(e.evidence??{},k)), "SIGNER_LINKED_EXIT_SIGNED_HISTORY");
  }
}

/** Synchronous last check immediately before crypto.sign, after async review.
 * Detects kill/expiry/Journal or same-stage capital changes during that review. */
export function assertSigningCriticalSection(policy:SignerPolicy,input:PolicySigningRequest,nowMs:number,expected?:string):string {
  const r=input.request,p=AutonomousProtocolSchema.parse(r.authorization);
  const linked=linkedRequest(policy,input);
  need(nowMs>=(linked?.validFromMs??policy.notBeforeMs)&&nowMs<(linked?.exitUntilMs??policy.expiresAtMs)&&nowMs<Number(r.expiresAtMs),"SIGNER_AUTHORIZATION_EXPIRED");
  const db=new Database(input.journalPath,{readonly:true,fileMustExist:true});
  let journal:unknown;
  try {
    db.pragma("query_only = ON");db.exec("BEGIN");
    const meta=Object.fromEntries((db.prepare("SELECT key,value FROM live_meta ORDER BY key").all() as {key:string;value:string}[]).map(x=>[x.key,x.value]));
    const a=db.prepare("SELECT * FROM live_attempts WHERE id=?").get(r.attemptId) as {state:string;side:string;data:string}|undefined;
    need(a?.state==="REVIEWED"&&meta.protocol===r.protocolDigest&&!meta.takeover,"SIGNER_JOURNAL_CHANGED");
    const data=JSON.parse(a!.data);
    linkedJournal(db,policy,input,meta);
    need(data.signingRequestIssued===true&&!data.signature&&!data.signedTransaction&&data.submissionStartedAtMs===undefined&&Number(data.submissionCount??0)===0&&data.unsignedTransaction===r.unsignedTransaction,"SIGNER_JOURNAL_CHANGED");
    need(nowMs<Number(data.quoteExpiresAtMs)&&nowMs<=Number(data.reviewedAtMs)+p.maxReviewAgeMs&&nowMs<(a!.side==="BUY"?p.entryUntilMs:(linked?.exitUntilMs??p.exitUntilMs)),"SIGNER_ORIGINAL_QUOTE_EXPIRED");
    if(a!.side==="BUY"){
      need(!meta.entryStopped,"SIGNER_ENTRY_STOPPED_OR_AMOUNT");
      try{lstatSync(policy.killFile);throw Error("SIGNER_ENTRY_KILLED");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    }
    journal={meta,a,settlements:db.prepare("SELECT * FROM live_settlements ORDER BY signature").all()};db.exec("ROLLBACK");
  } finally {db.close();}
  const stageDb=new Database(policy.stageDatabase,{readonly:true,fileMustExist:true});let stage:unknown;
  try{
    stageDb.pragma("query_only = ON");stageDb.exec("BEGIN");
    const get=(k:string)=>JSON.parse((stageDb.prepare("SELECT v FROM kv WHERE k=?").get(k) as {v:string}).v);
    const state=get("humanFollow:v1"),bridge=get("autonomousCapital:v1"),active=bridge.active;
    need(state.wallet===policy.sourceStageWallet&&!state.obligation&&active&&state.actualReviewRequired===active.barrier&&
      active.protocolDigest===r.protocolDigest&&active.journalPath===input.journalPath&&active.identity.wallet===policy.wallet&&
      active.identity.releaseDigest===policy.candidateDigest&&active.identity.policyDigest===policy.policyDigest&&
      active.identity.authorizationDigest===policy.authorizationDigest,"SIGNER_CAPITAL_RESERVATION_MISMATCH");
    if(linked)need(active.episodeId===linked.episodeId,"SIGNER_LINKED_EXIT_EPISODE_MISMATCH");
    need(active.id===active.episodeId&&active.principalRaw===p.buyLamports&&active.feeBudgetRaw===p.totalFeeBudgetLamports&&active.rentCapRaw===p.accountRentCapLamports&&active.exitReserveRaw===p.exitReserveLamports,"SIGNER_CAPITAL_ECONOMIC_MISMATCH");
    need(state.spentMicroCny+state.carry.rentHeldMicroCny+state.carry.unknownReserveMicroCny+active.reservedMicroCny<=state.scope.stageMicroCny,"SIGNER_CAPITAL_LIMIT");
    for(const wallet of new Set([policy.wallet,policy.sourceStageWallet])){
      const claim=JSON.parse(readFileSync(join(policy.claimDirectory,wallet+".json"),"utf8"));
      need(claim.reservationId===active.id&&claim.protocolDigest===active.protocolDigest&&claim.wallet===policy.wallet&&
        claim.releaseDigest===policy.candidateDigest&&claim.policyDigest===policy.policyDigest&&claim.authorizationDigest===policy.authorizationDigest,"SIGNER_WALLET_CLAIM_MISMATCH");
    }
    stage={state,active};stageDb.exec("ROLLBACK");
  }finally{stageDb.close();}
  const fingerprint=digest(JSON.stringify({journal,stage}));need(expected===undefined||fingerprint===expected,"SIGNER_STATE_CHANGED_DURING_REVIEW");return fingerprint;
}

export function privateRegularFile(path: string, outsideRoot?: string): Buffer {
  const absolute = resolve(path), info = lstatSync(absolute);
  need(info.isFile() && !info.isSymbolicLink() && info.nlink===1 && realpathSync(absolute) === absolute, "SIGNER_CREDENTIAL_FILE_TYPE");
  need((info.mode & 0o077) === 0 && (process.getuid === undefined || info.uid === process.getuid()), "SIGNER_CREDENTIAL_PERMISSIONS");
  if (outsideRoot) {
    const rel = relative(realpathSync(outsideRoot), absolute);
    need(rel===".." || rel.startsWith(".."+sep) || isAbsolute(rel), "SIGNER_CREDENTIAL_INSIDE_REPOSITORY");
  }
  need(info.size > 0 && info.size <= 16384, "SIGNER_CREDENTIAL_SIZE");
  return readFileSync(absolute);
}

/** Read-only journal check, not LiveJournal construction. The signer never
 * trusts an arbitrary request's amount/side or caller-provided position. */
export async function validatePolicySigningRequest(policyValue: unknown, input: PolicySigningRequest, nowMs: number) {
  const policy = SignerPolicySchema.parse(policyValue);
  need(input.schema === "AUTONOMOUS_POLICY_SIGN_REQUEST_V1" && input.policyDigest === policy.policyDigest && input.authorizationDigest === policy.authorizationDigest, "SIGNER_POLICY_BINDING");
  const request = input.request;
  const protocol = AutonomousProtocolSchema.parse(request.authorization);
  const linked=linkedRequest(policy,input);
  need(protocol.approval === "FUNDS_AUTHORIZED" && protocol.wallet === policy.wallet && protocol.candidateDigest === policy.candidateDigest &&
    request.wallet === policy.wallet && request.fundsAuthorized === true && request.submissionPolicy === signatureSubmissionPolicy(protocol) &&
    request.protocolDigest === protocolDigest(protocol) && request.experimentId === protocol.experimentId,
    "SIGNER_AUTHORITY_BINDING");
  need(nowMs >= (linked?.validFromMs??policy.notBeforeMs) && nowMs < (linked?.exitUntilMs??policy.expiresAtMs) && nowMs >= protocol.validFromMs &&
    Number.isSafeInteger(request.expiresAtMs) && nowMs < Number(request.expiresAtMs), "SIGNER_AUTHORIZATION_EXPIRED");
  need(protocol.buyLamports === policy.buyLamports && protocol.fundingCapLamports === policy.walletCapLamports &&
    protocol.networkFeeCapLamports === policy.feePerAttemptLamports && protocol.totalFeeBudgetLamports === policy.totalFeeLamports &&
    protocol.accountRentCapLamports === policy.rentCapLamports && protocol.exitReserveLamports === policy.exitReserveLamports &&
    protocol.maxSlippageBps <= policy.maxSlippageBps && Number(protocol.maxPriceImpactPct) <= Number(policy.maxPriceImpactPct) &&
    protocol.maxReviewAgeMs <= 60000 && protocol.maxSellAttempts === 1, "SIGNER_ECONOMIC_POLICY");
  need(JSON.stringify(protocol.deliveryPolicy)===JSON.stringify(policy.deliveryPolicy),"SIGNER_DELIVERY_POLICY_BINDING");
  const root = realpathSync(policy.journalRoot), file = resolve(input.journalPath), rel = relative(root, file);
  need(rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && realpathSync(file) === file && lstatSync(file).isFile(), "SIGNER_JOURNAL_PATH");
  const stateFingerprint=assertSigningCriticalSection(policy,input,nowMs);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  let row: { id: string; side: string; amount: string; state: string; data: string };
  let data: Record<string, unknown>;
  try {
    db.pragma("query_only = ON"); db.exec("BEGIN");
    const meta = Object.fromEntries((db.prepare("SELECT key,value FROM live_meta").all() as {key:string;value:string}[]).map(r => [r.key,r.value]));
    linkedJournal(db,policy,input,meta);
    need(meta.protocol === request.protocolDigest && !meta.takeover, "SIGNER_JOURNAL_AUTHORITY");
    const found = db.prepare("SELECT * FROM live_attempts WHERE id=?").get(request.attemptId) as typeof row | undefined;
    need(found?.state === "REVIEWED", "SIGNER_JOURNAL_NOT_REVIEWED"); row = found!; data = JSON.parse(row.data);
    need(data.signingRequestIssued === true && !data.signature && !data.signedTransaction && data.submissionStartedAtMs === undefined &&
      Number(data.submissionCount ?? 0) === 0 && data.unsignedTransaction === request.unsignedTransaction,
      "SIGNER_JOURNAL_BYTES_OR_RESPONSIBILITY");
    need(nowMs < Number(data.quoteExpiresAtMs) && nowMs <= Number(data.reviewedAtMs) + protocol.maxReviewAgeMs,
      "SIGNER_ORIGINAL_QUOTE_EXPIRED");
    need(Number(request.expiresAtMs) <= Math.min(Number(data.quoteExpiresAtMs),Number(data.reviewedAtMs)+protocol.maxReviewAgeMs,
      row.side === "BUY" ? protocol.entryUntilMs : (linked?.exitUntilMs??protocol.exitUntilMs)), "SIGNER_REQUEST_EXTENDS_DEADLINE");
    if (row.side === "BUY") {
      need(!meta.entryStopped && row.amount === policy.buyLamports, "SIGNER_ENTRY_STOPPED_OR_AMOUNT");
      // Kill marker deliberately forbids entry only; already-owned exits remain possible.
      try { lstatSync(policy.killFile); throw Error("SIGNER_ENTRY_KILLED"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    } else {
      need(row.side === "SELL", "SIGNER_SIDE_INVALID");
      const settlements = db.prepare("SELECT evidence FROM live_settlements").all() as {evidence:string}[];
      const position = settlements.reduce((sum,r) => sum + BigInt(JSON.parse(r.evidence).tokenDeltaRaw), 0n);
      need(position > 0n && row.amount === position.toString(), "SIGNER_FULL_SELL_POSITION_MISMATCH");
    }
    db.exec("ROLLBACK");
  } finally { db.close(); }
  const proof = request.independentEvidence as {cpiEvidence?:CpiSemanticEvidence;poolAddress?:string} | undefined;
  need(proof?.cpiEvidence && proof.poolAddress, "SIGNER_INDEPENDENT_EVIDENCE_REQUIRED");
  const advertised = data!.review as {quotedOutputRaw:string;messageDigest:string};
  const review = await reviewTransaction(String(request.unsignedTransaction), {
    wallet: policy.wallet, side: row!.side as "BUY"|"SELL", inputRaw: row!.amount,
    ...(protocol.executionPurpose ? {executionPurpose:protocol.executionPurpose} : {}),
    ...(protocol.deliveryPolicy ? {deliveryPolicy:protocol.deliveryPolicy} : {}),
    quotedOutputRaw: advertised.quotedOutputRaw, maxSlippageBps: protocol.maxSlippageBps,
    maxPlatformFeeBps: 0, networkFeeCapLamports: policy.feePerAttemptLamports,
    poolAddress: proof!.poolAddress!, requestId: String(data!.requestId),
    ...(isDynamicExecutionProtocol(protocol) ? {asset: {tokenMint:protocol.tokenMint,tokenProgram:protocol.tokenProgram,tokenDecimals:protocol.tokenDecimals}} : {}),
  }, async key => {
    const fact = proof!.cpiEvidence!.alt[key]; need(fact, "SIGNER_ALT_EVIDENCE"); return decodeIndependentAlt(fact!.account);
  }, proof!.cpiEvidence);
  need(protocol.transport === "DIRECT_DAMM_V2_SELF_RPC"
    ? review.abiEvidence === "OFFICIAL_DIRECT_DAMM_V2_EXACT_IN" && proof!.poolAddress === protocol.executionPool
    : review.abiEvidence === "OFFICIAL_V1_SINGLE_RAYDIUM_CLMM", "SIGNER_EXECUTION_BUILD_SCOPE");
  need(review.messageDigest === advertised.messageDigest && review.wallet === policy.wallet, "SIGNER_REVIEW_BINDING");
  return {policy,protocol,review,stateFingerprint,side:row!.side as "BUY"|"SELL",id:digest(`${request.protocolDigest}:${request.attemptId}:${review.messageDigest}`),
    unsignedTransaction:String(request.unsignedTransaction),expiresAtMs:Number(request.expiresAtMs)};
}
