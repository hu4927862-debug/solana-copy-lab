// The service composes existing Research and Live owners. It grants no funds
// approval, resumes no halted runtime, and never owns a second position ledger.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {createSealedRealtimeObserver,OBSERVER_SAFETY} from './observer.mjs';
import {PersistentAdmission} from './admission.mjs';
import {AutonomousFollowerRuntime} from './follower-runtime.ts';
import {candidateFailure} from './candidate-failures.mjs';

const need=(v,m)=>{if(!v)throw Error(m);};
const encode=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x);
const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(Buffer.isBuffer(v)?v:encode(canonical(v))).digest('hex');
const uint=v=>Number.isSafeInteger(v)&&v>=0;
const raw=v=>typeof v==='string'&&/^-?(0|[1-9][0-9]*)$/.test(v);
const safeError=e=>/^[A-Z0-9_:-]+$/.test(e?.message??'')?e.message:'AUTONOMOUS_SERVICE_ATTENTION';

/** factsProvider is an authenticated LOCAL receipt adapter, not a health guess.
 * Each returned section includes evidence:{path,sha256}; the evidence JSON must
 * exactly equal that section excluding evidence. Upstream raw references may be
 * included in the JSON. This proves immutable provenance, not an honest RPC.
 * No network request occurs here. No expired fact is silently re-stamped.
 */
export function validateServiceFacts(facts,{nowMs,wallet,forExit=false}){
 need(facts&&uint(nowMs),'SERVICE_FACTS_REQUIRED');
 const required=forExit?['provider']:['wallet','valuation','provider','accounting'];
 for(const name of required){
  const section=facts[name],ref=section?.evidence;
  need(section&&ref&&typeof ref.path==='string'&&/^[a-f0-9]{64}$/.test(ref.sha256??''),'SERVICE_'+name.toUpperCase()+'_EVIDENCE_REQUIRED');
  const file=path.resolve(ref.path),stat=fs.lstatSync(file);
  need(stat.isFile()&&!stat.isSymbolicLink()&&fs.realpathSync(file)===file,'SERVICE_FACT_FILE_TYPE');
  // The digest is checked on every read: an mtime is not a security boundary.
  const bytes=fs.readFileSync(file);need(hash(bytes)===ref.sha256,'SERVICE_FACT_HASH_CHANGED');
  const saved=JSON.parse(bytes);
  const {evidence,...record}=section;need(encode(canonical(saved))===encode(canonical(record)),'SERVICE_FACT_CONTENT_MISMATCH');
  need(uint(section.observedAtMs)&&uint(section.expiresAtMs)&&section.observedAtMs<=nowMs&&nowMs<section.expiresAtMs&&section.expiresAtMs>section.observedAtMs,'SERVICE_'+name.toUpperCase()+'_FACT_EXPIRED');
 }
 const p=facts.provider;
 need(['HEALTHY','DEGRADED','COOLDOWN'].includes(p.health)&&typeof p.rpcReference==='string'&&p.rpcReference.length>0&&typeof p.jupiterReference==='string'&&p.jupiterReference.length>0&&p.rpcReference.length<=256&&p.jupiterReference.length<=256&&!/https?:|secret=/i.test(p.rpcReference+p.jupiterReference),'SERVICE_PROVIDER_FACT_INVALID');
 if(forExit)return facts;
 const w=facts.wallet,v=facts.valuation,a=facts.accounting;
 need(w.wallet===wallet&&w.finalized===true&&uint(w.slot)&&raw(w.balanceLamports)&&BigInt(w.balanceLamports)>=0n&&typeof w.unexplainedActivity==='boolean'&&typeof w.unexpectedAssets==='boolean','SERVICE_FINALIZED_WALLET_FACT_INVALID');
 need(Number.isSafeInteger(v.cnyPerSolMicro)&&v.cnyPerSolMicro>0&&v.expiresAtMs-v.observedAtMs<=3600000,'SERVICE_VALUATION_FACT_INVALID');
 need(a.wallet===wallet&&a.utcDay===new Date(nowMs).toISOString().slice(0,10)&&raw(a.dailyRealizedNetLamports)&&Array.isArray(a.unknownCosts)&&a.unknownCosts.every(x=>typeof x==='string')&&a.finalizedOnly===true,'SERVICE_FINALIZED_ACCOUNTING_REQUIRED');
 return facts;
}

/** Actual position/pending exposure comes from LiveJournal; stage availability
 * comes from the existing cumulative capital ledger. The supplied daily net is
 * an explicit finalized receipt baseline, never virtual inventory or default 0.
 * Runtime halts/claims still independently prevent a second BUY.
 */
export function actualRiskContext({runtime,capital,facts,source,nowMs,entryReason=null}){
 const active=runtime.recoverActive(),c=capital.inspect();
 need(c.wallet===runtime.identity.wallet&&c.capitalLedgerKey==='humanFollow:v1'&&Number.isSafeInteger(c.remainingAfterHeldMicroCny),'SERVICE_CAPITAL_IDENTITY');
 const position=active?BigInt(active.status.positionRaw):0n;
 const cost=active?BigInt(active.descriptor.buyAmountRaw):0n;
 const positions=position>0n?[{positionId:active.descriptor.episodeId,followerWallet:runtime.identity.wallet,leaderWallet:active.descriptor.leaderWallet,tokenMint:active.descriptor.mint,quoteMint:'SOL_NATIVE',quantityRaw:position,totalCostQuoteRaw:cost,status:'OPEN'}]:[];
 const pending=active&&position===0n&&!active.status.closed?cost:0n;
 const blocked=Boolean(entryReason||active||c.active||c.actualReviewRequired||c.remainingAfterHeldMicroCny<=0||facts.wallet.unexpectedAssets||facts.wallet.unexplainedActivity||facts.accounting.unknownCosts.length);
 return{portfolioPositions:positions,pendingApprovedBuyQuoteRawByQuoteMint:{SOL_NATIVE:pending},pendingApprovedBuyQuoteRawForToken:active?.descriptor.mint===source.token?pending:0n,
  dailyRealizedPnlRawByQuoteMint:{SOL_NATIVE:BigInt(facts.accounting.dailyRealizedNetLamports)},quoteState:facts.accounting.unknownCosts.length?'HALT_NEW_RISK':'RUNNING',globalState:blocked?'HALT_NEW_RISK':'RUNNING',providerHealth:facts.provider.health};
}

/** Required inputs:
 * config={observer:<observer config>,admission:<PersistentAdmission policy>,
 *   exitAfterMs,stepIntervalMs?,outboxPageSize?};
 * policy={policyDigest,authorizationDigest,wallet,releaseDigest,killFile};
 * factsProvider()=>{wallet,valuation,provider,accounting} as above (sync);
 * protocolFactory(decision,facts)=>exact separately authorized protocol (sync).
 * Constructors are local-only. start/step never approve or resume runtime entry.
 * A kill file halts new risk while existing reconciliation/defined exits remain
 * owned by the original LiveExecutor. A halted observer never resets coverage.
 */
export async function createAutonomousService({directory,config,providerOptions,runtime,capital,signer,networkFactory,protocolFactory,policy,factsProvider,clock,fetchImpl=globalThis.fetch,
 followerFactory=dependencies=>new AutonomousFollowerRuntime(dependencies),observerFactory=createSealedRealtimeObserver}){
 config=structuredClone(config);policy=structuredClone(policy);
 // Six bounded execution/reconcile operations (6*50reads+2sends), plus
 // forty one-read provider-health refreshes during the approved exit interval.
 config.observer.executionReserve??={rpc:342,quote:4};
 need(config.observer.executionReserve.rpc>=342&&config.observer.executionReserve.quote>=4,'SERVICE_EXECUTION_RESERVE_TOO_SMALL');
 need(runtime&&capital&&signer&&typeof networkFactory==='function'&&typeof protocolFactory==='function'&&typeof factsProvider==='function'&&typeof followerFactory==='function','SERVICE_EXPLICIT_DEPENDENCIES_REQUIRED');
 need(policy&&['policyDigest','authorizationDigest','releaseDigest'].every(k=>/^[a-f0-9]{64}$/.test(policy[k]??''))&&policy.wallet===runtime.identity.wallet&&policy.releaseDigest===runtime.identity.releaseDigest&&policy.policyDigest===runtime.identity.policyDigest&&typeof policy.killFile==='string'&&path.isAbsolute(policy.killFile),'SERVICE_AUTHORITY_BINDING');
 need(config.observer.followerWallet===policy.wallet&&config.admission.ticketRaw===config.observer.ticketRaw&&Number.isSafeInteger(config.exitAfterMs)&&config.exitAfterMs>0,'SERVICE_CONFIG_BINDING');
 const now=()=>clock?.nowMs()??Date.now(),interval=config.stepIntervalMs??1000,pageSize=config.outboxPageSize??100;
 const maxClosedOutcomes=policy.maxClosedOutcomes??1;
 const maxRealizedLossMicroCny=policy.maxRealizedLossMicroCny??Number.MAX_SAFE_INTEGER;
 need(Number.isSafeInteger(maxClosedOutcomes)&&maxClosedOutcomes>=1&&maxClosedOutcomes<=3&&
  Number.isSafeInteger(maxRealizedLossMicroCny)&&maxRealizedLossMicroCny>0,'SERVICE_EXPERIMENT_LIMITS');
 if(maxClosedOutcomes>1)need(/^\d+$/.test(policy.feeBudgetLamports??'')&&/^\d+$/.test(policy.rentCapLamports??''),'SERVICE_EXPERIMENT_ECONOMICS_REQUIRED');
 const experimentGate=c=>{
  need(Number.isSafeInteger(c.experimentClosedOutcomes)&&Number.isSafeInteger(c.experimentSubmittedBuys)&&Number.isSafeInteger(c.experimentRealizedLossMicroCny),'SERVICE_EXPERIMENT_ACCOUNTING_REQUIRED');
  if(c.experimentClosedOutcomes>=maxClosedOutcomes)return'EXPERIMENT_CLOSED_OUTCOME_LIMIT';
  if(c.experimentSubmittedBuys>=maxClosedOutcomes)return'EXPERIMENT_BUY_ATTEMPT_LIMIT';
  if(c.experimentRealizedLossMicroCny>=maxRealizedLossMicroCny)return'EXPERIMENT_REALIZED_LOSS_LIMIT';
  return null;
 };
 need(Number.isSafeInteger(interval)&&interval>=100&&interval<=60000&&Number.isSafeInteger(pageSize)&&pageSize>0&&pageSize<=1000,'SERVICE_LOOP_BOUND');
 let admission,observer,execution,busy=false,closed=false,started=false,entryPause=false;
 const facts=(forExit=false)=>validateServiceFacts(factsProvider(),{nowMs:now(),wallet:policy.wallet,forExit});
 const entryReason=()=>{
  if(entryPause)return'FACT_CONTEXT_LAG_RECOVERY';
  if(fs.existsSync(policy.killFile))return'OPERATOR_KILL_ENTRY';
  try{runtime.assertEntryAllowed();if(observer){const b=observer.requestBudget();if(b.rpcRemaining<config.observer.executionReserve.rpc||b.quoteRemaining<config.observer.executionReserve.quote)return'INSUFFICIENT_EXECUTION_REQUEST_RESERVE';}const f=facts(),c=capital.inspect();if(c.wallet!==policy.wallet||c.capitalLedgerKey!=='humanFollow:v1')return'SERVICE_CAPITAL_IDENTITY';if(c.active||c.actualReviewRequired||c.walletClaimPresent)return'EXISTING_CAPITAL_RESPONSIBILITY';const experiment=experimentGate(c);if(experiment)return experiment;if(maxClosedOutcomes>1){const headroom=capital.experimentEntryReason({principalRaw:config.observer.ticketRaw,feeBudgetRaw:policy.feeBudgetLamports,rentCapRaw:policy.rentCapLamports,cnyPerSolMicro:f.valuation.cnyPerSolMicro});if(headroom)return headroom;}if(c.remainingAfterHeldMicroCny<=0)return'STAGE_BUDGET_EXHAUSTED';if(f.wallet.unexpectedAssets||f.wallet.unexplainedActivity||f.accounting.unknownCosts.length)return'CURRENT_FACTS_REQUIRE_REVIEW';if(f.provider.health!=='HEALTHY')return'PROVIDER_NOT_HEALTHY';return null;}catch(e){return safeError(e);}
 };
 observer=await observerFactory({directory,config:config.observer,providerOptions,clock,fetchImpl,
  admission:d=>admission.admit(d),admissionPrecheck:d=>admission.precheck(d),admissionCapacity:x=>entryReason()??admission.capacity(x,{deferWallet:true}),hasObligation:()=>Boolean(runtime.recoverActive()),
  actualRiskContext:source=>actualRiskContext({runtime,capital,facts:facts(),source,nowMs:now(),entryReason:entryReason()})});
 try{
  admission=observer.eventFirstAdmission??new PersistentAdmission({store:observer.store,policy:config.admission,watchlist:config.observer.walletUniverse.wallets.map(w=>w.address),entryGate:entryReason,...(clock?{clock}:{})});
  const binding={schema:'AUTONOMOUS_SERVICE_BINDING_V1',config,policy,observerBinding:observer.bindingDigest},bindingDigest=hash(binding);
  const serviceKey=observer.eventFirstAdmission?'autonomousServiceBinding:'+policy.authorizationDigest:'autonomousServiceBinding';
  const outboxKey=observer.eventFirstAdmission?'autonomousServiceOutbox:'+policy.authorizationDigest:'autonomousServiceOutbox';
  const old=observer.store.get(serviceKey);need(!old||old.digest===bindingDigest,'SERVICE_BINDING_CHANGED');
  if(!old)observer.store.set(serviceKey,{digest:bindingDigest,binding});
  const leaderSold=(leader,mint,sinceMs)=>Boolean(observer.store.db.prepare("SELECT 1 FROM events WHERE type='AUTONOMOUS_LEADER_SELL' AND json_extract(data,'$.wallet')=? AND json_extract(data,'$.mint')=? AND json_extract(data,'$.chainAtMs')>=? LIMIT 1").get(leader,mint,sinceMs));
  const unprovenSourceAfter=(leader,mint,sinceMs)=>Boolean(observer.store.db.prepare("SELECT 1 FROM events WHERE type='AUTONOMOUS_UNPROVEN_SOURCE_COVERAGE' AND json_extract(data,'$.wallet')=? AND json_extract(data,'$.chainAtMs')>=? AND (json_extract(data,'$.candidateMint') IS NULL OR json_extract(data,'$.candidateMint')=?) LIMIT 1").get(leader,sinceMs,mint));
  const revalidate=async(phase,{side,protocol,decision,attempt})=>{
   need(['BUY','SELL'].includes(side)&&protocol.wallet===policy.wallet&&protocol.candidateDigest===policy.releaseDigest,'SERVICE_EXECUTION_IDENTITY');
   const saved=observer.store.db.prepare("SELECT data FROM events WHERE id=? AND type='AUTONOMOUS_DECISION'").get(decision.id);
   need(saved&&encode(canonical(JSON.parse(saved.data)))===encode(canonical(decision))&&decision.decision==='FOLLOW'&&decision.bindingDigest===observer.bindingDigest&&decision.admission?.allowed===true,'SERVICE_DECISION_EVIDENCE_BINDING');
   const active=runtime.recoverActive();
   if(side==='BUY'){
    if(observer.eventFirstAdmission){const proof=admission.assertFundedSource(decision.source);need(proof.candidateDigest===policy.releaseDigest&&proof.authorizationDigest===policy.authorizationDigest&&proof.followerWallet===policy.wallet,'SERVICE_EVENT_FIRST_FUNDED_BINDING');}
    need(!fs.existsSync(policy.killFile),'OPERATOR_KILL_ENTRY');facts();
    need(observer.status().entryReady,'SOURCE_COVERAGE_NOT_READY');need(now()<decision.sourceExpiresAtMs&&decision.sourceExpiresAtMs===decision.source.event_time_ms+OBSERVER_SAFETY.sourceMaxAgeMs,'SOURCE_STALE');
    need(!leaderSold(decision.source.wallet,decision.source.token,decision.source.event_time_ms),'LEADER_ALREADY_SOLD');
    need(!unprovenSourceAfter(decision.source.wallet,decision.source.token,decision.source.event_time_ms),'LEADER_SELL_COVERAGE_UNPROVEN');
    if(phase==='BEFORE_PREPARE')need(entryReason()===null,entryReason()??'ENTRY_BLOCKED');
    else need(active?.descriptor.episodeId===decision.id&&active.status.positionRaw==='0'&&!active.status.takeover,'SERVICE_BUY_RESPONSIBILITY_CHANGED');
   }else{
    facts(true);need(active?.descriptor.episodeId===decision.id&&BigInt(active.status.positionRaw)>0n&&!active.status.takeover,'SERVICE_EXIT_POSITION_REQUIRED');
   }
   if(phase!=='BEFORE_PREPARE')need(attempt?.side===side,'SERVICE_ATTEMPT_SIDE_BINDING');
   observer.store.event('AUTONOMOUS_EXECUTION_GATE',{decisionId:decision.id,side,phase,atMs:now(),sourceExpiresAtMs:decision.sourceExpiresAtMs,actualPositionRaw:active?.status.positionRaw??'0',policyDigest:policy.policyDigest});
  };
  execution=followerFactory({runtime,capital,signer,network:networkFactory,policyDigest:policy.policyDigest,authorizationDigest:policy.authorizationDigest,revalidate,leaderSold,exitAfterMs:config.exitAfterMs,now});
  const checkpoint=()=>observer.store.get(outboxKey)??{lastSeq:0};
  const mark=(row,state,reason=null)=>observer.store.atomic(()=>{const current=checkpoint();need(current.lastSeq<row.seq,'SERVICE_OUTBOX_CONCURRENT');observer.store.event('AUTONOMOUS_EXECUTION_DISPOSITION',{decisionId:row.decision.id,sourceId:row.decision.sourceId,state,reason,atMs:now()},'disposition:'+row.decision.id);observer.store.set(outboxKey,{lastSeq:row.seq});});
  const status=()=>({schema:'AUTONOMOUS_SERVICE_STATUS_V1',started,closed,bindingDigest,observer:observer.status(),entryReason:entryReason(),outbox:checkpoint(),active:runtime.recoverActive()?.descriptor??null,capital:capital.inspect(),fundsApprovalCreated:false});
  async function step({entryPaused=false}={}){
   need(started&&!closed&&!busy,'SERVICE_NOT_STARTED_OR_BUSY');busy=true;entryPause=entryPaused;
   try{
    // Always reconcile existing responsibility before any new observation/entry.
    let lifecycle=await execution.tick();
    if(['ATTENTION','SIGNED_UNSENT_RESPONSIBILITY','EXPORTED_RESPONSIBILITY'].includes(lifecycle.state))return{state:'ATTENTION',lifecycle,status:status()};
    if(lifecycle.state==='CLOSED'){
     const c=capital.inspect();
     need(!c.active&&!c.actualReviewRequired&&!c.walletClaimPresent&&!runtime.recoverActive(),'SERVICE_CLOSED_RESPONSIBILITY_REMAINS');
     const limit=experimentGate(c);
     if(limit)return{state:'CLOSED',reason:limit,lifecycle,status:status()};
     runtime.resumeEntry('AUTHORIZED_CONTINUATION:'+policy.authorizationDigest);
     observer.store.event('AUTONOMOUS_CLOSED_CONTINUATION',{closedOutcomes:c.experimentClosedOutcomes,realizedLossMicroCny:c.experimentRealizedLossMicroCny,maxClosedOutcomes,maxRealizedLossMicroCny,atMs:now()});
     return{state:'CLOSED_CONTINUE',lifecycle,status:status()};
    }
    const active=runtime.recoverActive();
    if(active&&lifecycle.state!=='OPEN')return{state:'RESPONSIBILITY_PENDING',lifecycle,status:status()};
    // Expired provider facts stop new RPC; reconciliation above is independent
    // of research evidence age and still uses the execution owner's own bounds.
    facts(true);
    if(fs.existsSync(policy.killFile))runtime.haltEntry('OPERATOR_KILL_ENTRY');
    // A restart with liability deliberately left Research stopped until the
    // first reconcile completed. Only fresh provider facts allow observation.
    if(['IDLE','STOPPED'].includes(observer.status().state))observer.start();
    if(!['RUNNING','ENTRY_PAUSED'].includes(observer.status().state)){if(active&&observer.status().reason==='EXECUTION_REQUEST_RESERVE_PROTECTED')return{state:'RESPONSIBILITY_ONLY',reason:'RESEARCH_CAPACITY_RESERVED_FOR_EXECUTION',lifecycle,status:status()};return{state:'ATTENTION',reason:'OBSERVER_HALTED',lifecycle,status:status()};}
    try{await observer.step(active?{wallets:[active.descriptor.leaderWallet],episode:active}:{yieldOnFollow:true});}catch(e){if(active&&e.message==='EXECUTION_REQUEST_RESERVE_PROTECTED'){observer.store.gap('RESEARCH_CAPACITY_RESERVED_FOR_EXECUTION',now(),{leaderObservationPaused:true,timeExitUnchanged:true});return{state:'RESPONSIBILITY_ONLY',reason:'RESEARCH_CAPACITY_RESERVED_FOR_EXECUTION',lifecycle,status:status()};}throw e;}
    if(active){lifecycle=await execution.tick();return{state:lifecycle.state,lifecycle,status:status()};}
    for(const row of observer.readDecisions(checkpoint().lastSeq,pageSize)){
     const decision=row.decision;
     if(decision.decision!=='FOLLOW'){mark(row,'PASS',decision.reason);continue;}
     if(decision.admission?.allowed!==true){mark(row,'PASS',decision.admission?.reason??'ADMISSION_REJECTED');continue;}
     const gate=entryReason();
     if(gate||now()>=decision.sourceExpiresAtMs){mark(row,'PASS',gate??'SOURCE_STALE_AT_EXECUTION');continue;}
     // Token-2022 proof is Research capability, not executable CPI qualification.
     const token=decision.source.verified?.token;
     const tokenProgram=token?.tokenProgram??(decision.source.ownership?.accepted===true&&decision.source.ownership.verifier==='RPC_JUPITER_ROUTE_V2_OWNER_NET_V2'?'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA':null);
     if(tokenProgram!=='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {mark(row,'PASS','EXECUTION_TOKEN_PROGRAM_UNQUALIFIED');continue;}
     const f=facts();let protocol;
     try{protocol=protocolFactory(decision,f);}catch(error){
      const reason=candidateFailure(error);
      if(!reason)throw error;
      mark(row,'PASS',reason);
      observer.store.event('AUTONOMOUS_EXECUTION_CANDIDATE_PASS',{decisionId:decision.id,reason,atMs:now(),responsibilityCreated:false});
      return{state:'CANDIDATE_PASS',reason,status:status()};
     }
     need(!protocol?.then,'SERVICE_PROTOCOL_FACTORY_MUST_BE_SYNCHRONOUS');
     // Mark acceptance before any external work. A crash must not replay accept;
     // LiveJournal/runtime claim remains the only resumption/responsibility path.
     mark(row,'ACCEPTANCE_STARTED');
     let result;
     try{result=await execution.accept(decision,protocol,{cnyPerSolMicro:f.valuation.cnyPerSolMicro,valuationAtMs:f.valuation.observedAtMs,valuationExpiresAtMs:f.valuation.expiresAtMs});}
     catch(error){
      const reason=candidateFailure(error),c=capital.inspect();
      if(!reason||runtime.recoverActive()||c.active||c.actualReviewRequired||c.walletClaimPresent)throw error;
      observer.store.event('AUTONOMOUS_EXECUTION_CANDIDATE_PASS',{decisionId:decision.id,reason,atMs:now(),responsibilityCreated:false});
      return{state:'CANDIDATE_PASS',reason,status:status()};
     }
     if(result?.candidatePass){
      const c=capital.inspect();need(!runtime.recoverActive()&&!c.active&&!c.actualReviewRequired&&!c.walletClaimPresent,'SERVICE_CANDIDATE_PASS_RESPONSIBILITY_REMAINS');
      runtime.resumeEntry('AUDITED_UNSIGNED_CANDIDATE_PASS:'+decision.id);
      observer.store.event('AUTONOMOUS_EXECUTION_CANDIDATE_PASS',{decisionId:decision.id,reason:result.candidatePass,atMs:now(),responsibilityCreated:true,closedUnsigned:true});
      return{state:'CANDIDATE_PASS',reason:result.candidatePass,status:status()};
     }
     return{state:'EXECUTION_RESPONSIBILITY',result,status:status()};
    }
    return{state:'OBSERVING',lifecycle,status:status()};
   }catch(e){const reason=safeError(e);runtime.haltEntry(reason);observer.store.event('AUTONOMOUS_SERVICE_ATTENTION',{reason,atMs:now(),responsibilityRetained:true});throw e;}finally{entryPause=false;busy=false;}
  }
  return{observer,execution,bindingDigest,status,
   start(){
    need(!closed&&!started,'SERVICE_ALREADY_STARTED_OR_CLOSED');
    // An existing claim/attempt must be readable after facts or entry authority
    // expire. Do not start Research or touch freshness gates before reconcile.
    // This does not permit prepare/sign/send: their original gates remain.
    if(!runtime.recoverActive()){facts(true);observer.start();}
    started=true;return status();
   },step,
   async run({signal}={}){need(started,'SERVICE_NOT_STARTED');while(!signal?.aborted){const result=await step();if(['ATTENTION','CLOSED'].includes(result.state))return result;try{await sleep(interval,undefined,{signal});}catch(e){if(signal?.aborted)break;throw e;}}runtime.haltEntry('SERVICE_STOPPED');return{state:'STOPPED',status:status()};},
   halt(reason='OPERATOR_KILL_ENTRY'){execution.halt(reason);return status();},
   close(){need(!busy,'SERVICE_STEP_IN_PROGRESS');if(!closed){observer.close();closed=true;}}
  };
 }catch(e){observer.close();throw e;}
}
