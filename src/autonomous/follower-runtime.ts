import { existsSync, mkdirSync, readFileSync, openSync, closeSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { LiveExecutor } from "../live/executor.js";
import type { LiveNetwork } from "../live/adapters.js";
import type { LiveAttempt } from "../live/journal.js";
import { AutonomousProtocolSchema, AutonomousLinkedExitAuthoritySchema, protocolDigest, type AutonomousExecutionProtocol } from "../live/protocol.js";
import { AutonomousJournalRuntime, episodeJournalPath, type EpisodeDescriptor } from "./journal-runtime.js";
import type { StageCapitalControls, CapitalReservation } from "./capital-controls.js";
import type { PolicySigningRequest } from "./signer-policy.js";
import { candidateFailure } from "./candidate-failures.mjs";

const need=(v:unknown,code:string):void=>{if(!v)throw Error(code)};
export interface ExecutableFollowDecision {
  id:string;
  decision:"FOLLOW";
  sourceId:string;
  source:{wallet:string;token:string;event_time_ms:number};
  sourceExpiresAtMs:number;
  minimumOutputRaw:string;
  inputRaw:string;
  followerWallet:string;
}
/** An operator-authorized execution calibration is explicitly not a leader
 * trade, FOLLOW, or strategy observation. It uses the same one-position owner. */
export interface ExecutionFunctionTestDecision extends Omit<ExecutableFollowDecision,"decision"> {
  decision:"EXECUTION_FUNCTION_TEST";
  executionPurpose:"EXECUTION_FUNCTION_TEST";
}
export type ExecutableRuntimeDecision = ExecutableFollowDecision | ExecutionFunctionTestDecision;
export interface RuntimeSigner {
  sign(request:PolicySigningRequest):Promise<{signedTransaction:string;signature:string;messageDigest:string;signedAtMs:number}>;
  recover(protocolDigest:string,attemptId:string):Promise<{signedTransaction:string;signature:string;messageDigest:string;signedAtMs:number}|null>;
}
export interface FollowerRuntimeDependencies {
  runtime:AutonomousJournalRuntime;
  capital:StageCapitalControls;
  signer:RuntimeSigner;
  policyDigest:string;
  authorizationDigest:string;
  /** Existing JupiterSelfRpcNetwork per bound asset; never a second Executor. */
  network:(protocol:AutonomousExecutionProtocol,journal:NonNullable<ReturnType<AutonomousJournalRuntime["recoverActive"]>>["journal"])=>LiveNetwork;
  /** Must validate actual Risk/capital/coverage/leader SELL/source/chase facts.
   * Repeated before prepare, before sign and before submit. This is not a model. */
  revalidate:(phase:"BEFORE_PREPARE"|"BEFORE_SIGN"|"BEFORE_SUBMIT",context:{side:"BUY"|"SELL";protocol:AutonomousExecutionProtocol;decision:ExecutableRuntimeDecision;attempt?:LiveAttempt})=>Promise<void>;
  leaderSold:(leader:string,mint:string,sinceMs:number)=>boolean;
  exitAfterMs:number;
  now?:()=>number;
  executionPurpose?:"EXECUTION_FUNCTION_TEST";
}

function saveOnce(file:string,value:unknown):void {
  const bytes=JSON.stringify(value,null,2)+"\n";
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  if(existsSync(file)){need(readFileSync(file,"utf8")===bytes,"RUNTIME_SAVED_EVIDENCE_CHANGED");return;}
  const fd=openSync(file,"wx",0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  const dir=openSync(dirname(file),"r");try{fsyncSync(dir);}finally{closeSync(dir);}
}

/** Lifecycle composition. All transaction review, signature intake, submission,
 * UNKNOWN, finalized accounting and position transitions stay in LiveExecutor /
 * LiveJournal. No resend method is exposed here. */
export class AutonomousFollowerRuntime {
  private busy=false;
  private readonly now:()=>number;
  constructor(private readonly dependencies:FollowerRuntimeDependencies){
    need(Number.isSafeInteger(dependencies.exitAfterMs)&&dependencies.exitAfterMs>0,"RUNTIME_EXIT_POLICY_REQUIRED");
    this.now=dependencies.now??Date.now;
  }
  private async serialized<T>(action:()=>Promise<T>):Promise<T>{
    need(!this.busy,"RUNTIME_CONCURRENT_OPERATION");this.busy=true;
    try{return await action();}catch(error){
      const candidate=candidateFailure(error);
      if(!candidate||this.dependencies.runtime.recoverActive()||this.dependencies.capital.inspect().active)
        this.dependencies.runtime.haltEntry(error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:"RUNTIME_OPERATION_ATTENTION");
      throw error;
    }finally{this.busy=false;}
  }
  private current(){
    const active=this.dependencies.runtime.recoverActive();if(!active)return null;
    const bundle=JSON.parse(readFileSync(join(dirname(active.journalPath),"episode.json"),"utf8"));
    const protocol=AutonomousProtocolSchema.parse(bundle.protocol),decision=bundle.decision as ExecutableRuntimeDecision;
    need(protocol.executionPurpose===this.dependencies.executionPurpose&&
      (decision.decision==="EXECUTION_FUNCTION_TEST") === (this.dependencies.executionPurpose==="EXECUTION_FUNCTION_TEST"),"RUNTIME_EXECUTION_PURPOSE_BINDING");
    need(protocolDigest(protocol)===active.descriptor.protocolDigest&&protocol.wallet===active.descriptor.wallet&&
      protocol.tokenMint===active.descriptor.mint&&protocol.sourceEventId===active.descriptor.sourceId&&decision.id===active.descriptor.episodeId,
      "RUNTIME_EPISODE_PROTOCOL_BINDING");
    const network=this.dependencies.network(protocol,active.journal);
    return {...active,protocol,decision,executor:new LiveExecutor(active.journal,protocol,network,this.now)};
  }
  /** The same local owner serves operator cancellation and automatic failed
   * preparation cleanup. It never signs, sends or invents a settlement. */
  private cancelCurrentUnexported(current: NonNullable<ReturnType<AutonomousFollowerRuntime["current"]>>, attemptId: string, reason: string) {
    current.journal.atomic(() => {
      const status = current.journal.status();
      need(status.positionRaw === "0" && status.obligations.length === 1 && status.obligations[0]!.id === attemptId && !status.takeover, "UNEXPORTED_PREPARATION_HAS_RESPONSIBILITY");
      for (const a of status.attempts) {
        const d = a.data;
        need(!d.signingRequestIssued &&
          !["signingRequest", "exportedArtifact", "signedArtifact", "signature", "signedTransaction", "settlement", "providerReceipt", "submittedAtMs", "lastSubmissionKind", "submissionStartedAtMs"].some(k => Object.hasOwn(d,k)) &&
          (!Object.hasOwn(d,"submissionCount") || d.submissionCount === 0) &&
          a.state !== "UNKNOWN" && !(d.requestEvidence as {method?:string}[] | undefined)?.some(r => /sendTransaction|execute|sender/i.test(r.method ?? "")), "UNEXPORTED_PREPARATION_HAS_RESPONSIBILITY");
        current.journal.assertNoSignedHistory(a.id);
      }
      current.executor.cancelUnsigned(attemptId, reason);
    });
    const closed = current.journal.status();
    need(closed.closed && closed.obligations.length === 0 && closed.positionRaw === "0", "RUNTIME_CANDIDATE_CANCELLATION_INCOMPLETE");
    this.dependencies.capital.closeFinalized(current.descriptor.episodeId);
    this.dependencies.runtime.releaseClosedEpisode();
    return {state:"UNSIGNED_CANCELLED", positionRaw:"0", remainingObligations:0};
  }
  async cancelUnexported(attemptId: string, reason = "OPERATOR_CANCEL_UNEXPORTED_V1") {
    return this.serialized(async () => {
      const current = this.current();
      need(current, "EXISTING_OBLIGATION_REQUIRED");
      return this.cancelCurrentUnexported(current!, attemptId, reason);
    });
  }
  async accept(decision:ExecutableFollowDecision,protocolInput:unknown,valuation:Pick<CapitalReservation,"cnyPerSolMicro"|"valuationAtMs"|"valuationExpiresAtMs">){
    need(!this.dependencies.executionPurpose,"RUNTIME_EXECUTION_PURPOSE_BINDING");
    return this.acceptDecision(decision,protocolInput,valuation);
  }
  async acceptFunctionTest(decision:ExecutionFunctionTestDecision,protocolInput:unknown,valuation:Pick<CapitalReservation,"cnyPerSolMicro"|"valuationAtMs"|"valuationExpiresAtMs">){
    need(this.dependencies.executionPurpose==="EXECUTION_FUNCTION_TEST"&&decision.executionPurpose==="EXECUTION_FUNCTION_TEST","RUNTIME_EXECUTION_PURPOSE_BINDING");
    return this.acceptDecision(decision,protocolInput,valuation);
  }
  private async acceptDecision(decision:ExecutableRuntimeDecision,protocolInput:unknown,valuation:Pick<CapitalReservation,"cnyPerSolMicro"|"valuationAtMs"|"valuationExpiresAtMs">){
    return this.serialized(async()=>{
      const d=this.dependencies,p=AutonomousProtocolSchema.parse(protocolInput);
      need(p.executionPurpose===d.executionPurpose,"RUNTIME_EXECUTION_PURPOSE_BINDING");
      need(decision.decision===(d.executionPurpose??"FOLLOW")&&decision.sourceId===p.sourceEventId&&decision.source.token===p.tokenMint&&
        decision.followerWallet===p.wallet&&decision.inputRaw===p.buyLamports&&
        p.entryUntilMs<=decision.sourceExpiresAtMs,"RUNTIME_FOLLOW_BINDING");
      need(this.now()<decision.sourceExpiresAtMs,"SOURCE_STALE");
      need(p.approval==="FUNDS_AUTHORIZED"&&p.candidateDigest===d.runtime.identity.releaseDigest&&d.policyDigest===d.runtime.identity.policyDigest,"RUNTIME_RELEASE_NOT_AUTHORIZED");
      if(!d.executionPurpose)need(!d.leaderSold(decision.source.wallet,p.tokenMint,decision.source.event_time_ms),"LEADER_ALREADY_SOLD");
      d.runtime.assertEntryAllowed();await d.revalidate("BEFORE_PREPARE",{side:"BUY",protocol:p,decision});
      const descriptor:EpisodeDescriptor={episodeId:decision.id,protocolDigest:protocolDigest(p),wallet:p.wallet,
        leaderWallet:decision.source.wallet,mint:p.tokenMint,sourceId:p.sourceEventId,buyAmountRaw:p.buyLamports};
      const journalPath=episodeJournalPath(d.runtime.directory,descriptor);
      saveOnce(join(dirname(journalPath),"episode.json"),{schema:"AUTONOMOUS_EPISODE_V1",protocol:p,decision,valuation});
      const active=d.runtime.reserveEpisode(descriptor);need(active,"RUNTIME_CLAIM_FAILED");
      d.capital.reserve({id:decision.id,episodeId:decision.id,protocolDigest:descriptor.protocolDigest,journalPath,
        principalRaw:p.buyLamports,feeBudgetRaw:p.totalFeeBudgetLamports,rentCapRaw:p.accountRentCapLamports,
        exitReserveRaw:p.exitReserveLamports,...valuation});
      const current=this.current()!;
      try{
        const attempt=await current.executor.prepare("BUY");
        // The execution quote is new evidence, but never a relaxed leader chase.
        need(BigInt((attempt.data.review as {minimumOutputRaw:string}).minimumOutputRaw)>=BigInt(decision.minimumOutputRaw),"EXECUTION_CHASE_MINIMUM_OUTPUT");
        await this.signAndSubmit(current,attempt);
        return current.journal.status();
      }
      catch(error){
        const candidate=candidateFailure(error),status=current.journal.status();
        const unsigned=status.attempts.find(a=>a.side==="BUY"&&["ATTENTION","CREATED","REVIEWED"].includes(a.state));
        // Only a failed prepare explicitly recorded as never requesting a
        // signature may auto-close. Post-sign/UNKNOWN and SELL positions retain
        // their original responsibility paths. Economic candidate PASS also
        // reuses this exact owner, including a reviewed pre-sign chase reject.
        const failedPrepare = unsigned?.state === "ATTENTION" && unsigned.data.signatureNeverRequested === true;
        if (!unsigned || (!candidate && !failedPrepare)) throw error;
        this.cancelCurrentUnexported(current, unsigned.id, candidate ? "AUTO_CANDIDATE_PASS:" + candidate : "AUTO_CANCEL_UNEXPORTED_PREPARATION_V1");
        if (!candidate) throw error; // Transport/identity faults still stop cleanly.
        return {candidatePass:candidate};
      }
    });
  }
  private async signAndSubmit(current:NonNullable<ReturnType<AutonomousFollowerRuntime["current"]>>,attempt:LiveAttempt){
    const d=this.dependencies;
    d.capital.assertReserved(current.descriptor.episodeId);
    await d.revalidate("BEFORE_SIGN",{side:attempt.side,protocol:current.protocol,decision:current.decision,attempt});
    if(attempt.side==="BUY"&&!d.executionPurpose)need(!d.leaderSold(current.descriptor.leaderWallet,current.descriptor.mint,current.decision.source.event_time_ms),"LEADER_ALREADY_SOLD");
    const request=current.executor.signingRequest(attempt.id);
    const signed=await d.signer.sign({schema:"AUTONOMOUS_POLICY_SIGN_REQUEST_V1",journalPath:current.journalPath,
      policyDigest:d.policyDigest,authorizationDigest:d.authorizationDigest,request});
    await current.executor.importSignature(attempt.id,signed.signedTransaction);
    d.capital.assertReserved(current.descriptor.episodeId);
    await d.revalidate("BEFORE_SUBMIT",{side:attempt.side,protocol:current.protocol,decision:current.decision,attempt:current.journal.get(attempt.id)!});
    // Existing submit performs current authority/blockhash/wallet/program proof,
    // exact signed-byte simulation, final deadline checks, durable UNKNOWN, one send.
    const submitExecutor=new LiveExecutor(current.journal,current.protocol,d.network(current.protocol,current.journal),this.now);
    await submitExecutor.submit(attempt.id,false);
    // This policy grants repeated delivery of the SAME signed transaction,
    // never another economic BUY or a refreshed blockhash/message.
    const policy=current.protocol.deliveryPolicy;
    if(policy){
      for(let count=1;count<policy.maxBroadcasts;count++){
        const a=current.journal.get(attempt.id)!;
        if(a.state!=="UNKNOWN"||a.data.reason==="SUBMISSION_RESPONSE_UNKNOWN"||current.journal.status().takeover)break;
        await new Promise<void>(resolve=>setTimeout(resolve,policy.broadcastIntervalMs));
        const raw=await d.network(current.protocol,current.journal).signatureStatus(String(a.data.signature)) as {value?:unknown[]};
        need(Array.isArray(raw?.value)&&raw.value.length===1,"DELIVERY_SIGNATURE_STATUS_UNCERTAIN");
        // Any observed landing stops retransmission. Finalized accounting is
        // still performed only by the existing reconciliation owner.
        if(raw.value![0]!==null)break;
        if(this.now()>=Number(a.data.quoteExpiresAtMs)||this.now()>=Number(a.data.reviewedAtMs)+current.protocol.maxReviewAgeMs||
          this.now()>=(a.side==="BUY"?current.protocol.entryUntilMs:current.protocol.exitUntilMs))break;
        await new LiveExecutor(current.journal,current.protocol,d.network(current.protocol,current.journal),this.now).submit(attempt.id,true);
      }
    }
  }
  async tick(options:{allowNewExit?:boolean}={}){
    return this.serialized(async()=>{
      const d=this.dependencies,c=this.current();if(!c)return {state:"IDLE"};
      let status=c.journal.status();
      if(!status.closed)d.capital.assertReserved(c.descriptor.episodeId);
      if(status.takeover)return {state:"ATTENTION",reason:status.takeover,status};
      for(const a of status.attempts){
        if(a.state==="REVIEWED"&&a.data.signingRequestIssued){
          const saved=await d.signer.recover(c.descriptor.protocolDigest,a.id);
          if(saved)await c.executor.importSignature(a.id,saved.signedTransaction);
          // No automatic sign/resign/send after a crash at the signer boundary.
          return {state:saved?"SIGNED_UNSENT_RESPONSIBILITY":"EXPORTED_RESPONSIBILITY",status:c.journal.status()};
        }
        if(a.state==="SIGNED")return {state:"SIGNED_UNSENT_RESPONSIBILITY",status};
        if(a.state==="UNKNOWN"||(["SETTLED","CHAIN_FAILED"].includes(a.state)&&a.data.balanceReconciled!==true))await c.executor.reconcile(a.id);
      }
      status=c.journal.status();
      if(status.takeover)return {state:"ATTENTION",reason:status.takeover,status};
      if(status.obligations.length)return {state:"RESPONSIBILITY_PENDING",status};
      if(status.closed){
        const noLanding=status.attempts.some(a=>a.state==="EXPIRED_SUBMITTED_NOT_LANDED")&&!status.attempts.some(a=>a.state==="SETTLED");
        const outcome={schema:d.executionPurpose?"FINALIZED_EXECUTION_FUNCTION_TEST_OUTCOME_V1":"FINALIZED_FOLLOWER_OUTCOME_V1",...(d.executionPurpose?{executionPurpose:d.executionPurpose,strategySample:false}:{}),episodeId:c.descriptor.episodeId,leaderWallet:d.executionPurpose?null:c.descriptor.leaderWallet,
          ...(noLanding?{terminalDisposition:"EXPIRED_SUBMITTED_NOT_LANDED",fillCount:0}:{}),
          mint:c.descriptor.mint,protocolDigest:c.descriptor.protocolDigest,positionRaw:status.positionRaw,
          roundtripCompleted:status.roundtripCompleted,walletNetCashflowLamports:status.walletDeltaRaw,
          networkFeeLamports:status.networkFeeRaw,recoverableRentDeltaLamports:status.recoverableRentDeltaRaw,
          deliveryTipLamports:status.deliveryTipRaw,
          unknownCosts:status.unknownCosts,settlements:status.attempts.filter(a=>a.data.settlement).map(a=>({id:a.id,side:a.side,signature:a.data.signature,evidence:a.data.settlement})),
          tradingPnlExcludingRent:status.unknownCosts.length?"UNKNOWN":(BigInt(status.walletDeltaRaw)+BigInt(status.recoverableRentDeltaRaw)).toString()};
        saveOnce(join(dirname(c.journalPath),"outcome.json"),outcome);
        d.capital.closeFinalized(c.descriptor.episodeId);d.runtime.releaseClosedEpisode();
        return {state:noLanding?"TERMINAL_NOT_LANDED":"CLOSED",outcome};
      }
      const buy=status.attempts.find(a=>a.side==="BUY"&&a.state==="SETTLED");
      need(buy&&BigInt(status.positionRaw)>0n,"RUNTIME_POSITION_WITHOUT_FINALIZED_BUY");
      c.journal.stopEntry("ACTUAL_POSITION_EXIT_ONLY");
      const settled=buy!.data.settlement as Record<string,unknown>;
      const blockMs=Number(settled.blockTimeMs ?? Number((settled.rawFinalizedTransaction as {blockTime?:number}|undefined)?.blockTime)*1000);
      need(Number.isSafeInteger(blockMs)&&blockMs>0,"RUNTIME_BUY_BLOCK_TIME_REQUIRED");
      const exit=Boolean(d.executionPurpose)||d.leaderSold(c.descriptor.leaderWallet,c.descriptor.mint,c.decision.source.event_time_ms)||this.now()>=blockMs+d.exitAfterMs;
      if(options.allowNewExit===false)return {state:"OPEN_EXIT_ONLY",positionRaw:status.positionRaw,exitDue:exit,exitAtMs:blockMs+d.exitAfterMs};
      if(!exit)return {state:"OPEN",positionRaw:status.positionRaw,exitAtMs:blockMs+d.exitAfterMs};
      need(!status.attempts.some(a=>a.side==="SELL"),"RUNTIME_INITIAL_FULL_SELL_ALREADY_ATTEMPTED");
      await d.revalidate("BEFORE_PREPARE",{side:"SELL",protocol:c.protocol,decision:c.decision,attempt:buy!});
      const sell=await c.executor.prepare("SELL");
      need(sell.amount===status.positionRaw,"RUNTIME_FULL_SELL_AMOUNT_MISMATCH");
      await this.signAndSubmit(c,sell);
      return {state:"SELL_RESPONSIBILITY",status:c.journal.status()};
    });
  }
  /** One explicit recovery under the ORIGINAL, still-live exit authority.
   * tick never invokes this method: no transport loop or new economic intent. */
  async resumeUnsignedExit(){
    return this.serialized(async()=>{
      const c=this.current(),d=this.dependencies;
      need(c,"EXISTING_OBLIGATION_REQUIRED");
      const assertUnsigned=()=>{
        const s=c!.journal.status(),sell=s.attempts.filter(a=>a.side==="SELL"),a=sell[0];
        need(c!.protocol.approval==="FUNDS_AUTHORIZED"&&this.now()>=c!.protocol.validFromMs&&this.now()<c!.protocol.exitUntilMs&&
          !c!.journal.exitAuthority(),"ORIGINAL_EXIT_AUTHORITY_REQUIRED");
        need(!s.takeover&&BigInt(s.positionRaw)>0n&&sell.length===1&&a?.id==="SELL-1"&&a.amount===s.positionRaw&&
          s.obligations.length===1&&s.obligations[0]!.id===a.id&&a.state==="ATTENTION"&&a.data.reason==="PREPARATION_FAILED"&&
          a.data.signatureNeverRequested===true&&!a.data.signingRequestIssued&&Number(a.data.submissionCount??0)===0&&
          Number(a.data.unsignedPreparationCount??1)<3&&
          !["signature","signedTransaction","exportedArtifact","signedArtifact","settlement","providerReceipt","submissionStartedAtMs"].some(k=>Object.hasOwn(a.data,k)),
          "ORIGINAL_EXIT_NOT_UNSIGNED_PREPARATION_FAILURE");
        c!.journal.assertNoSignedHistory(a!.id);d.capital.assertReserved(c!.descriptor.episodeId);
        return a!;
      };
      const prior=assertUnsigned();
      need(!await d.signer.recover(c!.descriptor.protocolDigest,prior.id),"RUNTIME_HIDDEN_SELL_SIGNATURE");
      assertUnsigned();
      await d.revalidate("BEFORE_PREPARE",{side:"SELL",protocol:c!.protocol,decision:c!.decision,attempt:prior});
      assertUnsigned();
      // Existing Executor atomically consumes its durable max-3 preparation
      // count, refreshes finalized wallet agreement and rebuilds/reviews/simulates.
      const sell=await c!.executor.prepare("SELL");
      need(sell.id===prior.id&&sell.amount===c!.journal.status().positionRaw,"RUNTIME_FULL_SELL_AMOUNT_MISMATCH");
      await this.signAndSubmit(c!,sell);
      return{state:"SELL_RESPONSIBILITY",status:c!.journal.status()};
    });
  }
  /** Explicit liability-only command. No intake, new intent or automatic retry.
   * The original Executor bounds unsigned preparations on the SAME SELL-1. */
  async resumeLinkedExit(raw:unknown){
    return this.serialized(async()=>{
      const a=AutonomousLinkedExitAuthoritySchema.parse(raw),c=this.current(),d=this.dependencies;
      need(c&&c.descriptor.episodeId===a.episodeId&&c.descriptor.protocolDigest===a.parentProtocolDigest&&
        d.runtime.identity.releaseDigest===a.parentReleaseDigest&&d.policyDigest===a.parentConfigDigest&&
        d.authorizationDigest===a.parentAuthorizationDigest,"RUNTIME_LINKED_EXIT_BINDING");
      d.capital.assertReserved(a.episodeId);
      need(!await d.signer.recover(a.parentProtocolDigest,a.attemptId),"RUNTIME_HIDDEN_SELL_SIGNATURE");
      await d.revalidate("BEFORE_PREPARE",{side:"SELL",protocol:c!.protocol,decision:c!.decision,attempt:c!.journal.get(a.attemptId)!});
      await c!.executor.authorizeExit(a);
      const sell=await c!.executor.prepare("SELL");
      need(sell.id===a.attemptId&&sell.amount===a.remainingRaw&&sell.amount===c!.journal.status().positionRaw,"RUNTIME_FULL_SELL_AMOUNT_MISMATCH");
      await this.signAndSubmit(c!,sell);
      return{state:"SELL_RESPONSIBILITY",status:c!.journal.status()};
    });
  }
  halt(reason="OPERATOR_KILL_ENTRY"){this.dependencies.runtime.haltEntry(reason);const c=this.current();c?.journal.stopEntry(reason);}
}
