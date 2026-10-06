// Continuous-service Research composition. No signer/build/send, no virtual fill,
// no implicit network start and no reset of a capital ledger. Capacity exhaustion
// requires maintenance; it is never silently turned into a fresh resource budget.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import bs58 from 'bs58';
import {loadSealedResearchOwner,RESEARCH_AUTHORITY,SourceEventCursor} from './research-owner.mjs';
import {preliminaryFollowerExecutionEligibility} from './execution-scope.ts';
import {ZeroFundsWatchlistResourceSuccessor} from './zero-funds-watchlist-resource-successor.mjs';

const need=(v,m)=>{if(!v)throw Error(m);};
const stringify=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x);
const hash=v=>createHash('sha256').update(Buffer.isBuffer(v)?v:stringify(v)).digest('hex');
const positive=n=>Number.isSafeInteger(n)&&n>0;
const safeError=e=>/^[A-Z0-9_:-]+$/.test(e?.message??'')?e.message:'OBSERVER_LOCAL_OR_PROVIDER_FAILURE';
const P=fileURLToPath(new URL('../../reports/project-current-state-audit-20260926/smart-wallet-follow/',import.meta.url));
export const OBSERVER_SAFETY=Object.freeze({sourceMaxAgeMs:60000,metadataMaxAgeMs:5000,quoteMaxAgeMs:5000,chaseBps:100});
const extensions=Object.freeze({
 'ownership-token2022.mjs':'4322cc1453e3f38c7a65a0fd36d63108f93d06a6af87fab76ae6e08b32400459',
 'token2022-proof.mjs':'d0be5be7299f4030349f4bc61a44af654ed6b51e45e179683ac53fe2097f23b4',
 'metadata-provider.mjs':'afce9c3f5533c03534936706a1c4c55e0037995ae8f64a8900234267e8c703cd',
 'transport-observation.mjs':'3e13444c072c19cf75fae82a6cf56d921b5e90dff9559073817672d51c3a1d2f',
});
async function loadExtensions(){
 for(const [name,digest]of Object.entries(extensions)){const file=path.join(P,name);need(fs.lstatSync(file).isFile()&&fs.realpathSync(file)===file,'OBSERVER_EXTENSION_FILE_TYPE');need(createHash('sha256').update(fs.readFileSync(file)).digest('hex')===digest,'OBSERVER_EXTENSION_CHANGED:'+name);}
 const [ownership,metadata,transport]=await Promise.all(['ownership-token2022.mjs','metadata-provider.mjs','transport-observation.mjs'].map(f=>import(pathToFileURL(path.join(P,f)).href)));
 return{...ownership,...metadata,...transport};
}

/** The existing canonical single-SOURCE assessor, shared by wallet polling and
 * report-local event-first composition. No Collector/Store construction, fetch,
 * signer or execution authority. The caller supplies the existing providers and
 * actual-state gates; raw-asset freshness may only add a refusal, never bypass Risk.
 */
export function createSealedSourceDecisionAssessor({store,config,clock,measurement,actualRiskContext,admission,
 admissionPrecheck=()=>null,nextResearchSendAt,expiredBeforeSend,bindingDigest,proofFreshness=()=>null}){
 need(store?.db&&clock&&measurement?.risk&&typeof actualRiskContext==='function'&&typeof admission==='function'&&
  typeof admissionPrecheck==='function'&&typeof nextResearchSendAt==='function'&&typeof expiredBeforeSend==='function'&&typeof proofFreshness==='function','SOURCE_ASSESSOR_EXISTING_OWNERS_REQUIRED');
 config=structuredClone(config);
 need(/^[1-9][0-9]*$/.test(config.ticketRaw??'')&&typeof config.followerWallet==='string','SOURCE_ASSESSOR_IDENTITY');
  const rawQuotePre=(source,context)=>{
   const required=['portfolioPositions','pendingApprovedBuyQuoteRawByQuoteMint','pendingApprovedBuyQuoteRawForToken','dailyRealizedPnlRawByQuoteMint','quoteState','globalState','providerHealth'];
   need(context&&required.every(k=>Object.hasOwn(context,k))&&Array.isArray(context.portfolioPositions)&&typeof context.pendingApprovedBuyQuoteRawForToken==='bigint'&&['RUNNING','HALT_NEW_RISK'].includes(context.globalState)&&['RUNNING','HALT_NEW_RISK'].includes(context.quoteState)&&['HEALTHY','DEGRADED','COOLDOWN'].includes(context.providerHealth),'ACTUAL_RISK_CONTEXT_REQUIRED');
   const intent={intentId:'autonomous:'+source.id,leaderTradeId:source.id,leaderWallet:source.wallet,followerWallet:config.followerWallet,side:'BUY',tokenMint:source.token,quoteMint:'SOL_NATIVE',requestedTokenRaw:0n,requestedQuoteRaw:BigInt(config.ticketRaw),createdAtMs:clock.nowMs(),authoritativeSourceTimestamp:{valueMs:source.event_time_ms,provenance:'CHAIN_BLOCK_TIME',precision:'SECOND'}};
   return{intent,result:measurement.risk.evaluatePreQuote({...context,phase:'PRE_QUOTE',nowMs:clock.nowMs(),intent})};
  };
  return async function assess(d,coveragePaused=false){
   const result={id:'decision:'+d.id,sourceId:d.id,source:d,decision:'PASS',reason:null,decisionAtMs:clock.nowMs(),bindingDigest,followerWallet:config.followerWallet,inputRaw:config.ticketRaw,sourceExpiresAtMs:d.event_time_ms+OBSERVER_SAFETY.sourceMaxAgeMs,executionAuthority:false};
   const pass=reason=>({...result,reason,decisionAtMs:clock.nowMs()});
   if(d.side!=='BUY'||d.ownership?.accepted!==true||!d.verified||d.verified.side!=='BUY'||d.verified.quote?.mint!=='SOL_NATIVE'||d.token!==d.verified.token?.mint)return pass(d.side==='SELL'?'LEADER_SELL_OBSERVED':d.ownership?.reason??'UNSUPPORTED_SOURCE');
   if(coveragePaused)return pass('POLL_COVERAGE_RECOVERY_ENTRY_PAUSED');
   if(clock.nowMs()>result.sourceExpiresAtMs)return pass('SOURCE_STALE');
   if(store.db.prepare("SELECT 1 FROM events WHERE type='AUTONOMOUS_UNPROVEN_SOURCE_COVERAGE' AND json_extract(data,'$.wallet')=? AND json_extract(data,'$.chainAtMs')>=? AND (json_extract(data,'$.candidateMint') IS NULL OR json_extract(data,'$.candidateMint')=?) LIMIT 1").get(d.wallet,d.event_time_ms,d.token))return pass('LEADER_SELL_COVERAGE_UNPROVEN');
   if(store.db.prepare("SELECT 1 FROM events WHERE type='AUTONOMOUS_LEADER_SELL' AND json_extract(data,'$.wallet')=? AND json_extract(data,'$.mint')=? AND json_extract(data,'$.chainAtMs')>=? LIMIT 1").get(d.wallet,d.token,d.event_time_ms))return pass('LEADER_ALREADY_SOLD');
   const certificate=d.ownership?.proof?.metadataCertificate;
   if(certificate&&(clock.nowMs()<certificate.observedAtMs||clock.nowMs()-certificate.observedAtMs>OBSERVER_SAFETY.metadataMaxAgeMs))return pass('TOKEN2022_METADATA_STALE');
   if(!/^[1-9][0-9]*$/.test(String(d.verified.quote.raw))||!/^[1-9][0-9]*$/.test(String(d.verified.token.raw)))return pass('SOURCE_DUST_OR_INVALID');
   result.sourcePrincipalRaw=String(d.verified.quote.raw);
   result.followerToSourcePrincipal={numeratorRaw:config.ticketRaw,denominatorRaw:result.sourcePrincipalRaw,purpose:'DESCRIPTIVE_ONLY'};
   const early=await admissionPrecheck(d);
   if(early){result.admission=await admission(d);need(result.admission?.allowed===false,'EARLY_ADMISSION_REFUSAL_CHANGED');return pass(early);}
   const initialProofFailure=proofFreshness(d);if(initialProofFailure)return pass(initialProofFailure);
   result.pre=rawQuotePre(d,await actualRiskContext(d));if(result.pre.result.decision!=='ALLOW'||result.pre.result.approvedQuoteRaw!==BigInt(config.ticketRaw))return pass(result.pre.result.reasonCode);
   const entryKey='autonomous-entry:'+d.id;
   if(nextResearchSendAt('QUOTE')>result.sourceExpiresAtMs)return pass('SOURCE_EXPIRED_BEFORE_ENTRY_QUOTE');
   try{result.entry=await measurement.quote(entryKey,'entry','SOL_NATIVE',d.token,BigInt(config.ticketRaw),result.sourceExpiresAtMs,d.slot);}
   catch(e){if(expiredBeforeSend(e,entryKey,result.sourceExpiresAtMs))return pass('SOURCE_EXPIRED_BEFORE_ENTRY_QUOTE');throw e;}
   if(result.entry.error==='PROVIDER_TRANSIENT_UNAVAILABLE')throw Error('PROVIDER_TRANSIENT_UNAVAILABLE');
   if(result.entry.error)return pass(result.entry.error);
   result.post=measurement.post(d,result.pre,result.entry);if(result.post.decision!=='ALLOW')return pass(result.post.reasonCode);
   const reverseKey='autonomous-reverse:'+d.id,reverseDeadline=Math.min(result.sourceExpiresAtMs,result.entry.receipt.responded_at_ms+OBSERVER_SAFETY.quoteMaxAgeMs);
   if(nextResearchSendAt('QUOTE')>reverseDeadline)return pass('SOURCE_EXPIRED_BEFORE_REVERSE_QUOTE');
   try{result.reverse=await measurement.quote(reverseKey,'mark',d.token,'SOL_NATIVE',BigInt(result.entry.output_raw),reverseDeadline,d.slot);}
   catch(e){if(expiredBeforeSend(e,reverseKey,reverseDeadline))return pass('SOURCE_EXPIRED_BEFORE_REVERSE_QUOTE');throw e;}
   if(result.reverse.error==='PROVIDER_TRANSIENT_UNAVAILABLE')throw Error('PROVIDER_TRANSIENT_UNAVAILABLE');
   if(result.reverse.error)return pass(result.reverse.error);
   result.post=measurement.post(d,result.pre,result.entry);if(result.post.decision!=='ALLOW')return pass(result.post.reasonCode);
   if(clock.nowMs()>result.sourceExpiresAtMs)return pass('SOURCE_STALE_AFTER_REVERSE');
   if(certificate&&clock.nowMs()-certificate.observedAtMs>OBSERVER_SAFETY.metadataMaxAgeMs)return pass('TOKEN2022_METADATA_STALE_AFTER_REVERSE');
   const denominator=BigInt(d.verified.quote.raw)*BigInt(10000+OBSERVER_SAFETY.chaseBps);result.minimumOutputRaw=String((BigInt(config.ticketRaw)*BigInt(d.verified.token.raw)*10000n+denominator-1n)/denominator);
   if(BigInt(result.entry.output_raw)<BigInt(result.minimumOutputRaw))return pass('CHASE_ABOVE_LEADER_1_PERCENT');
   const finalProofFailure=proofFreshness(d);if(finalProofFailure)return pass(finalProofFailure);
   // FOLLOW remains an economic Research signal. Execution capability and quota
   // are independent dispositions, never a redefinition of that signal.
   result.executionEligibility=preliminaryFollowerExecutionEligibility(d,result.entry,result.reverse);
   result.admission=result.executionEligibility.eligible?await admission(d):{allowed:false,reason:result.executionEligibility.reason,consumed:false,executionAuthority:false};
   need(typeof result.admission?.allowed==='boolean','ADMISSION_PROOF_REQUIRED');
   return{...result,decision:'FOLLOW',decisionAtMs:clock.nowMs()};
  }
}

/** Requires explicit actualRiskContext(source) and admission(source). A source
 * decision is NOT execution authority. Consumers must idempotently drain the
 * durable AUTONOMOUS_DECISION outbox; callbacks alone are not crash delivery.
 * config: serviceId, followerWallet, walletUniverse(snapshotDigest+wallets),
 * ticketRaw, rpcCap, quoteCap,totalCap; optional pollMs,maxPages,sourceCap,rowCap,
 * rawBytes,token2022MetadataOnly,maxSourcesPerStep,maxConsecutivePollFailures.
 */
export async function createSealedRealtimeObserver({directory,config,providerOptions,actualRiskContext,admission,admissionPrecheck=()=>null,admissionCapacity=()=>null,hasObligation,
 onDecoded=()=>{},onDecision=()=>{},clock,fetchImpl=globalThis.fetch,zeroFundsSuccessor}){
 config=structuredClone(config); // callbacks/caller cannot mutate the bound economic/resource snapshot
 need(typeof actualRiskContext==='function'&&typeof admission==='function'&&typeof hasObligation==='function','OBSERVER_ACTUAL_STATE_ADAPTERS_REQUIRED');
 need(typeof onDecoded==='function'&&typeof onDecision==='function'&&typeof fetchImpl==='function'&&typeof admissionCapacity==='function'&&typeof admissionPrecheck==='function','OBSERVER_CALLBACK_CONTRACT');
 need(config&&/^[A-Za-z0-9_-]{1,100}$/.test(config.serviceId??'')&&typeof config.followerWallet==='string','OBSERVER_IDENTITY');
 const wallets=config.walletUniverse?.wallets?.map(w=>w.address);
 need(Array.isArray(wallets)&&wallets.length>0&&new Set(wallets).size===wallets.length&&!wallets.includes(config.followerWallet)&&wallets.every(w=>typeof w==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w))&&/^[a-f0-9]{64}$/.test(config.walletUniverse.snapshotDigest??''),'OBSERVER_UNIVERSE_REQUIRED');
 need(/^[1-9][0-9]*$/.test(config.ticketRaw??'')&&['rpcCap','quoteCap','totalCap'].every(k=>positive(config[k]))&&config.totalCap>=config.rpcCap+config.quoteCap,'OBSERVER_RESOURCE_POLICY');
 const owners=await loadSealedResearchOwner(),ext=await loadExtensions();clock??=owners.systemClock;
 const pollMs=config.pollMs??30000,maxSources=config.maxSourcesPerStep??100,maxFailures=config.maxConsecutivePollFailures??3;
 need(positive(pollMs)&&positive(maxSources)&&maxSources<=1000&&positive(maxFailures),'OBSERVER_SCHEDULING_POLICY');
 const executionReserve=config.executionReserve??{rpc:0,quote:0};
 need(['rpc','quote'].every(k=>Number.isSafeInteger(executionReserve[k])&&executionReserve[k]>=0)&&executionReserve.rpc<=config.rpcCap&&executionReserve.quote<=config.quoteCap,'OBSERVER_EXECUTION_RESERVE_POLICY');
 const storeConfig={...owners.DEFAULTS,pollMs,maxPages:config.maxPages??2,rpcCap:config.rpcCap,quoteCap:config.quoteCap,quoteDaily:config.quoteCap,entryDaily:config.quoteCap,
  rawBytes:config.rawBytes??64*1024*1024,sourceCap:config.sourceCap??20000,rowCap:config.rowCap??100000,
  caps:{discoveryPage:0,discoveryHydration:0,poll:config.rpcCap,forwardHydration:config.rpcCap,extraPage:config.rpcCap,metadata:config.rpcCap,execution:config.rpcCap}};
 for(const k of ['maxPages','rawBytes','sourceCap','rowCap'])need(positive(storeConfig[k]),'OBSERVER_STORAGE_POLICY');
 const binding={schema:'AUTONOMOUS_OBSERVER_BINDING_V1',config,authority:RESEARCH_AUTHORITY.releaseSha256,extensions,safety:OBSERVER_SAFETY,storeConfig};
 need(zeroFundsSuccessor===undefined||zeroFundsSuccessor instanceof ZeroFundsWatchlistResourceSuccessor,'OBSERVER_ZERO_FUNDS_SUCCESSOR');
 const context=zeroFundsSuccessor?.observerContext({directory,config,storeConfig});
 const bindingDigest=hash(binding),store=context?.store??new owners.Store(directory,storeConfig,clock);let inFlight=false,closed=false;
 try{
  const prior=store.get('autonomousObserverBinding');need(context||!prior||prior.digest===bindingDigest,'OBSERVER_CONFIG_CHANGED');
  if(!prior){store.atomic(()=>{store.set('autonomousObserverBinding',{digest:bindingDigest,binding});store.set('observationStart',clock.nowMs());store.set('registry',{wallets,digest:config.walletUniverse.snapshotDigest,selection:'EXPLICIT_UNIVERSE_NOT_ALPHA'});store.set('autonomousObserverState',{state:'IDLE',nextPollMs:0,cycle:0,pendingWallets:[],consecutivePollFailures:0});});}
  const initialWall=clock.nowMs(),initialMono=clock.mono();
  const guard=()=>{need(!closed,'OBSERVER_CLOSED');need(Math.abs(clock.nowMs()-initialWall-Number(clock.mono()-initialMono)/1e6)<=1000,'CLOCK_DRIFT');if(context)context.guard();else need(store.db.prepare('SELECT COUNT(*) n FROM requests').get().n<config.totalCap,'TOTAL_REQUEST_BUDGET');};
  const fetchFn=ext.observeTransport(fetchImpl,d=>store.event('AUTONOMOUS_TRANSPORT_DETAIL',d),[providerOptions?.rpcUrl,providerOptions?.quoteKey,providerOptions?.rpcUrl?new URL(providerOptions.rpcUrl).searchParams.get('api-key'):null]);
  const budget=()=>{
   if(context)return context.budget();
   const rows=store.db.prepare("SELECT kind,COUNT(*) n,SUM(CASE WHEN purpose='execution' THEN 1 ELSE 0 END) external,SUM(CASE WHEN key LIKE 'facts-responsibility:%' THEN 1 ELSE 0 END) priority FROM requests GROUP BY kind").all();
   const count=k=>Number(rows.find(r=>r.kind===k)?.n??0),used=k=>Number(rows.find(r=>r.kind===k)?.external??0),priority=Number(rows.find(r=>r.kind==='RPC')?.priority??0);
   return{rpcRemaining:config.rpcCap-count('RPC'),quoteRemaining:config.quoteCap-count('QUOTE'),totalRemaining:config.totalCap-count('RPC')-count('QUOTE'),executionUsed:{rpc:used('RPC'),quote:used('QUOTE')},priorityFactsUsed:priority,protectedRemaining:{rpc:Math.max(0,executionReserve.rpc-used('RPC')-priority),quote:Math.max(0,executionReserve.quote-used('QUOTE'))}};
  };
  const assertResearchBudget=(kind,{responsibility=false}={})=>{guard();need(['RPC','QUOTE'].includes(kind),'OBSERVER_RESEARCH_REQUEST_KIND');const b=budget(),k=kind==='RPC'?'rpc':'quote';need(b[k+'Remaining']>0,kind+'_BUDGET');if(responsibility){need(kind==='RPC'&&hasObligation(),'PRIORITY_FACTS_REQUIRE_EXISTING_RESPONSIBILITY');return;}need(b[k+'Remaining']>b.protectedRemaining[k],'EXECUTION_REQUEST_RESERVE_PROTECTED');};
  let currentResearchKind=null,externalPacing=false;
  const options={...providerOptions,clock,fetchFn,beforeRequest:()=>{guard();if(currentResearchKind)assertResearchBudget(currentResearchKind);}};
  const provider=new owners.AccountProvider(store,options),metadata=config.token2022MetadataOnly===true?new ext.MetadataProvider(store,options):null,measurement=new owners.Measurement(store,provider,clock);
  const paceCheck=signal=>{guard();need(!signal?.aborted,'EXTERNAL_TRANSPORT_DEADLINE');need(!store.get('accountProviderHalt'),'ACCOUNT_PROVIDER_STOPPED');};
  const waitUntil=async(target,signal)=>{while(clock.nowMs()<target){paceCheck(signal);await clock.sleep(Math.min(100,target-clock.nowMs()));}paceCheck(signal);};
  const unknownQuoteTarget=()=>{const r=store.db.prepare("SELECT requested,responded,purpose FROM requests WHERE kind='QUOTE' ORDER BY seq DESC LIMIT 1").get();return r&&r.responded===null&&r.purpose==='execution'?r.requested+10000+provider.rate.interval_ms:0;};
  // A lower bound on dispatch under the existing pacing policy. It never
  // grants freshness: the sealed Provider still checks validUntil at send.
  const nextResearchSendAt=kind=>{
   let target=Math.max(clock.nowMs(),(store.get('lastSend:'+kind)??0)+(kind==='RPC'?storeConfig.rpcIntervalMs:storeConfig.quoteIntervalMs));
   if(kind==='QUOTE'){
    const limit=Math.max(1,...provider.rate.windows.map(w=>w.max_requests));
    const rows=store.db.prepare("SELECT requested,responded,purpose FROM requests WHERE kind='QUOTE' ORDER BY seq DESC LIMIT ?").all(limit),last=rows[0];
    target=Math.max(target,provider.quietUntil,unknownQuoteTarget(),last?(last.responded??last.requested+(last.purpose==='execution'?10000:storeConfig.timeoutMs))+provider.rate.interval_ms:0);
    for(const w of provider.rate.windows)if(rows.length>=w.max_requests)target=Math.max(target,rows[w.max_requests-1].requested+w.window_ms+1);
   }
   return target;
  };
  const expiredBeforeSend=(error,key,deadline)=>error?.message==='SOURCE_EXPIRED_IN_COLLECTOR_QUEUE'&&clock.nowMs()>deadline&&!store.db.prepare('SELECT 1 FROM requests WHERE key=?').get(key);
  for(const reader of [provider,metadata].filter(Boolean)){const original=reader.request.bind(reader);reader.request=async(kind,...args)=>{need(!currentResearchKind&&!externalPacing,'CONCURRENT_SHARED_PROVIDER_REQUEST');assertResearchBudget(kind);currentResearchKind=kind;try{if(kind==='QUOTE')await waitUntil(unknownQuoteTarget());return await original(kind,...args);}finally{currentResearchKind=null;}};}
  const externalKey=r=>'execution:'+hash([r.auditPath,r.requestId]);
  const validateExternal=r=>{need(r&&typeof r.auditPath==='string'&&path.isAbsolute(r.auditPath)&&r.auditPath.length<=4096&&positive(r.requestId)&&Number.isSafeInteger(r.atMs)&&r.atMs>=0&&['EXECUTION','RECONCILE','RECOVERY'].includes(r.operation)&&/^[a-f0-9]{64}$/.test(r.protocolDigest??'')&&['RPC_READ','SIMULATION','JUPITER','SEND'].includes(r.kind)&&typeof r.method==='string'&&/^[A-Za-z0-9_/]{1,80}$/.test(r.method),'EXTERNAL_REQUEST_IDENTITY');};
  const reserveExternalRequest=r=>{validateExternal(r);guard();const kind=r.kind==='JUPITER'?'QUOTE':'RPC',key=externalKey(r);const id=store.reserve(key,kind,'execution',{schema:'EXTERNAL_EXECUTION_REQUEST_V1',request_id:r.requestId,externalAuditPath:r.auditPath,protocolDigest:r.protocolDigest,operation:r.operation,kind:r.kind,method:r.method,requested_at_ms:clock.nowMs(),externalStartedAtMs:r.atMs,responseSource:'EXTERNAL_EXECUTION_AUDIT',responseStatus:'UNKNOWN_UNTIL_AUDIT_COMPLETION'});return{storeRequestId:id,externalAuditPath:r.auditPath,externalRequestId:r.requestId};};
  const completeExternalRequest=r=>{const row=store.db.prepare('SELECT seq,data,responded FROM requests WHERE key=?').get(externalKey(r));need(row&&row.responded===null,'EXTERNAL_REQUEST_RECEIPT_MISSING_OR_DUPLICATE');const saved=JSON.parse(row.data);need(saved.protocolDigest===r.protocolDigest&&saved.operation===r.operation&&saved.kind===r.kind&&saved.method===r.method&&Number.isSafeInteger(r.completedAtMs)&&r.completedAtMs>=saved.externalStartedAtMs&&r.completedAtMs<=clock.nowMs()&&['COMPLETE','FAILED'].includes(r.outcome),'EXTERNAL_REQUEST_RECEIPT_BINDING');
   store.response(row.seq,{...saved,request_id:row.seq,externalRequestId:r.requestId,externalCompletedAtMs:r.completedAtMs,responded_at_ms:clock.nowMs(),available_at_ms:clock.nowMs(),responseSource:'EXTERNAL_EXECUTION_AUDIT',responseStatus:r.outcome,...(Number.isInteger(r.httpStatus)&&r.httpStatus>=100&&r.httpStatus<=599?{http_status:r.httpStatus}:{}),...(typeof r.responseSha256==='string'&&/^[a-f0-9]{64}$/.test(r.responseSha256)?{external_body_sha256:r.responseSha256}:{})},'');
   if([401,402,403,429].includes(r.httpStatus))store.set('accountProviderHalt',{reason:'EXTERNAL_PROVIDER_HTTP_'+r.httpStatus,at_ms:clock.nowMs()});
  };
  const awaitExternalTransport=async({kind,method,signal})=>{need(['RPC_READ','SIMULATION','SEND','JUPITER'].includes(kind)&&typeof method==='string','EXTERNAL_TRANSPORT_KIND');need(!currentResearchKind&&!externalPacing,'CONCURRENT_SHARED_PROVIDER_REQUEST');externalPacing=true;try{paceCheck(signal);const k=kind==='JUPITER'?'QUOTE':'RPC';let target=(store.get('lastSend:'+k)??0)+(k==='RPC'?storeConfig.rpcIntervalMs:storeConfig.quoteIntervalMs);
   if(k==='QUOTE'){const limit=Math.max(1,...provider.rate.windows.map(w=>w.max_requests)),rows=store.db.prepare("SELECT requested,responded,purpose FROM requests WHERE kind='QUOTE' ORDER BY seq DESC LIMIT ?").all(limit),last=rows[0];target=Math.max(target,provider.quietUntil,last?(last.responded??last.requested+(last.purpose==='execution'?10000:storeConfig.timeoutMs))+provider.rate.interval_ms:0);for(const w of provider.rate.windows)if(rows.length>=w.max_requests)target=Math.max(target,rows[w.max_requests-1].requested+w.window_ms+1);}
   if(target>clock.nowMs())store.event('AUTONOMOUS_EXTERNAL_RATE_WAIT',{kind,method,startMs:clock.nowMs(),notBeforeMs:target,source:'EXISTING_ACCOUNT_PROVIDER_POLICY',retry:false});await waitUntil(target,signal);store.set('lastSend:'+k,clock.nowMs());return{permittedAtMs:clock.nowMs(),kind:k};
  }finally{externalPacing=false;}};
  const cursor=new SourceEventCursor({store,consumerId:'autonomous-decision',pageSize:1});
  const state=()=>store.get('autonomousObserverState');const writeState=value=>store.set('autonomousObserverState',value);
  const entryReady=()=>state().state==='RUNNING'&&state().pendingWallets.length===0;
  const status=()=>({...state(),providerReadyAtMs:provider.quietUntil,bindingDigest,sourceCursor:cursor.checkpoint().lastSeq,entryReady:entryReady(),networkStarted:store.db.prepare('SELECT COUNT(*) n FROM requests').get().n>0,resourceBudgetNeverReset:true});
  const start=()=>{need(!closed&&!inFlight,'OBSERVER_BUSY_OR_CLOSED');const s=state();need(!['HALTED'].includes(s.state),'OBSERVER_HALTED_REQUIRES_REVIEW');writeState({...s,state:s.pendingWallets.length?'ENTRY_PAUSED':'RUNNING'});return status();};
  const stop=(reason='OPERATOR_STOP')=>{need(!inFlight,'OBSERVER_STEP_IN_PROGRESS');writeState({...state(),state:'STOPPED',reason});store.event('AUTONOMOUS_OBSERVER_STOP',{reason,atMs:clock.nowMs()});return status();};
  // Explicit *new* unfunded observation, not resume/recovery. The old segment,
  // cursors and failures remain archived in the same Store. All head reads debit
  // its existing Provider policy/budget; an empty/failed bootstrap commits none.
  async function beginZeroFundsObservationSegment({mode,segmentId,readDeadlineMs,assertNoFundsResponsibility}){
   need(mode==='ZERO_FUNDS_NEW_OBSERVATION'&&typeof segmentId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(segmentId)&&positive(readDeadlineMs)&&typeof assertNoFundsResponsibility==='function','ZERO_FUNDS_SEGMENT_CONTRACT');
   need(!closed&&!inFlight,'OBSERVER_BUSY_OR_CLOSED');need(['IDLE','STOPPED','HALTED'].includes(state().state),'OBSERVER_NEW_SEGMENT_REQUIRES_STOPPED');
   const key='autonomous:observation-segment:'+segmentId;need(!store.get(key),'OBSERVATION_SEGMENT_ALREADY_EXISTS');
   const check=()=>{guard();need(!hasObligation()&&assertNoFundsResponsibility()===true,'OBSERVATION_SEGMENT_EXISTING_FUNDS_RESPONSIBILITY');need(clock.nowMs()<readDeadlineMs,'OBSERVATION_BOOTSTRAP_DEADLINE');need(!store.get('accountProviderHalt'),'ACCOUNT_PROVIDER_STOPPED');};
   check();inFlight=true;const previousState=state(),previousSegment=store.get('autonomousObservationSegment')??null,previousSourceCursor=cursor.checkpoint(),previousPoll=Object.fromEntries(wallets.map(w=>[w,store.get('poll:'+w)??null]));
   const priorSourceHighWaterSeq=store.db.prepare("SELECT COALESCE(MAX(seq),0) n FROM events WHERE type='SOURCE'").get().n,anchors={};
   try{
    need(provider.quietUntil<readDeadlineMs,'OBSERVATION_BOOTSTRAP_DEADLINE');await waitUntil(provider.quietUntil);check();
    for(const wallet of wallets){check();const r=await provider.request('RPC','poll','observation-bootstrap:'+segmentId+':'+wallet,{method:'getSignaturesForAddress',params:[wallet,{commitment:'confirmed',limit:1}]},readDeadlineMs);check();
     need(!r.error&&Array.isArray(r.data)&&r.data.length===1,'OBSERVATION_BOOTSTRAP_EMPTY_OR_FAILED');const head=r.data[0];let validSignature=false;try{validSignature=typeof head.signature==='string'&&bs58.decode(head.signature).length===64;}catch{}
     need(validSignature&&Number.isSafeInteger(head.slot)&&head.slot>=0&&(head.blockTime===null||Number.isSafeInteger(head.blockTime))&&Object.hasOwn(head,'err')&&Number.isSafeInteger(r.receipt?.responded_at_ms),'OBSERVATION_BOOTSTRAP_HEAD_CONTRACT');
     anchors[wallet]={wallet,signature:head.signature,slot:head.slot,blockTime:head.blockTime,err:head.err,commitment:'confirmed',requestId:r.receipt.request_id,bodySha256:r.receipt.body_sha256,receivedAtMs:r.receipt.responded_at_ms};
    }
    check();const committedAtMs=clock.nowMs(),segment={schema:'AUTONOMOUS_ZERO_FUNDS_OBSERVATION_SEGMENT_V1',segmentId,mode,bindingDigest,committedAtMs,readDeadlineMs,anchors,previousState,previousPoll,previousSourceCursor,priorSourceHighWaterSeq,previousSegmentId:previousSegment?.segmentId??null,
     continuity:'GAP_PRESERVED_NEW_SEGMENT_NOT_HISTORICAL_BACKFILL',boundary:'PRE_SEGMENT_AND_ANCHOR_SLOT_OR_EARLIER_CENSORED_NO_SAME_SLOT_ORDER',historicalFeatures:'LEFT_CENSORED_ACROSS_GAP_NOT_CLOSED',fundsAuthorized:false,resourceBudgetNeverReset:true};
    store.atomic(()=>{need(stringify(state())===stringify(previousState),'OBSERVATION_BOOTSTRAP_CONCURRENT_STATE');
     store.set(key,segment);store.set('autonomousObservationSegment',segment);
     store.gap('EXPLICIT_NEW_OBSERVATION_SEGMENT_UNCOVERED_INTERVAL',committedAtMs,{segmentId,previousSegmentId:segment.previousSegmentId,oldCursorTimes:Object.fromEntries(wallets.map(w=>[w,previousPoll[w]?.started??null])),anchors,covered:false,virtualPositionsNotClosed:true});
     for(const wallet of wallets)store.set('poll:'+wallet,{started:anchors[wallet].receivedAtMs,next:committedAtMs,newest:anchors[wallet].signature});
     writeState({...previousState,state:'IDLE',segmentId,nextPollMs:committedAtMs,pendingWallets:[],consecutivePollFailures:0,reason:'EXPLICIT_NEW_ZERO_FUNDS_SEGMENT'});
     store.event('AUTONOMOUS_OBSERVATION_SEGMENT',segment,key);
    });return structuredClone(segment);
   }catch(e){store.event('AUTONOMOUS_OBSERVATION_BOOTSTRAP_FAILED',{segmentId,reason:safeError(e),atMs:clock.nowMs(),successfulHeads:Object.keys(anchors),priorSegmentUnchanged:true});throw e;}finally{inFlight=false;}
  }
  async function decode(source){
   const key='autonomous-hydrate:'+source.signature;let hydration;
   const row=store.db.prepare('SELECT body,data FROM requests WHERE key=?').get(key);
   if(row){const receipt=JSON.parse(row.data);hydration={receipt,error:receipt.error??null,data:row.body?JSON.parse(row.body).result:null};}
   else {
    const deadline=source.event_time_ms+OBSERVER_SAFETY.sourceMaxAgeMs;
    if(nextResearchSendAt('RPC')>deadline)return{...source,sourceId:source.id,side:'UNKNOWN',token:null,ownership:{accepted:false,reason:'SOURCE_EXPIRED_BEFORE_HYDRATION'},queueDrop:{possibleSide:'UNKNOWN',candidateMint:null,stage:'forwardHydration',readyAtMs:nextResearchSendAt('RPC'),validUntilMs:deadline},decoded_at_ms:clock.nowMs()};
    try{hydration=await provider.transaction(source.signature,'forwardHydration',key);}
    catch(e){if(!expiredBeforeSend(e,key,deadline))throw e;return{...source,sourceId:source.id,side:'UNKNOWN',token:null,ownership:{accepted:false,reason:'SOURCE_EXPIRED_BEFORE_HYDRATION'},queueDrop:{possibleSide:'UNKNOWN',candidateMint:null,stage:'forwardHydration',readyAtMs:clock.nowMs(),validUntilMs:deadline},decoded_at_ms:clock.nowMs()};}
   }
   if(hydration.error)throw Error(hydration.error);
   if(!hydration.data)return{...source,sourceId:source.id,side:'UNKNOWN',token:null,ownership:{accepted:false,reason:'PREVIOUS_HYDRATION_UNRESOLVED_OR_NULL'},decoded_at_ms:clock.nowMs()};
   const tx=hydration.data;need(tx.transaction?.signatures?.[0]===source.signature&&tx.slot===source.slot&&tx.blockTime*1000===source.event_time_ms,'TRANSACTION_BINDING_CONTRACT');
   let proof=owners.verifyOwner(tx,source.wallet,source.first_received_at_ms);
   if(metadata&&!proof.accepted&&proof.reason==='UNSUPPORTED_OR_UNPROVEN_TOKEN_PROGRAM'){
    const c=ext.identifyToken2022Candidate(tx,source.wallet,source.first_received_at_ms);
    if(c.candidate){
     const capacity=c.side==='BUY'?admissionCapacity({wallet:source.wallet,mint:c.mint}):null;
     need(capacity===null||(typeof capacity==='string'&&/^[A-Z0-9_:-]+$/.test(capacity)),'ADMISSION_CAPACITY_RESULT_REQUIRED');
     if(capacity)return{...source,sourceId:source.id,side:'UNKNOWN',token:null,ownership:{accepted:false,reason:'ADMISSION_CAP_BEFORE_METADATA'},metadataDeferred:{reason:capacity,candidateMint:c.mint,ownership:'NOT_PROVEN'},decoded_at_ms:clock.nowMs()};
     const metadataKey='autonomous-metadata:'+source.id;
     if(store.db.prepare('SELECT 1 FROM requests WHERE key=?').get(metadataKey))throw Error('PREVIOUS_METADATA_UNRESOLVED_NO_RETRY');
     else {
      const deadline=source.event_time_ms+OBSERVER_SAFETY.sourceMaxAgeMs,readyAt=nextResearchSendAt('RPC');
      if(readyAt>deadline)return{...source,sourceId:source.id,side:'UNKNOWN',token:null,ownership:{accepted:false,reason:'SOURCE_EXPIRED_BEFORE_METADATA'},queueDrop:{possibleSide:c.side,candidateMint:c.mint,stage:'metadata',readyAtMs:readyAt,validUntilMs:deadline},decoded_at_ms:clock.nowMs(),hydrationRequestId:hydration.receipt?.request_id??null};
      let r;try{r=await metadata.request('RPC','metadata',metadataKey,{method:'getMultipleAccounts',params:[[c.mint,...c.tokenAccounts],{encoding:'base64',commitment:'confirmed',minContextSlot:source.slot}]},deadline);}
      catch(e){if(!expiredBeforeSend(e,metadataKey,deadline))throw e;return{...source,sourceId:source.id,side:'UNKNOWN',token:null,ownership:{accepted:false,reason:'SOURCE_EXPIRED_BEFORE_METADATA'},queueDrop:{possibleSide:c.side,candidateMint:c.mint,stage:'metadata',readyAtMs:clock.nowMs(),validUntilMs:deadline},decoded_at_ms:clock.nowMs(),hydrationRequestId:hydration.receipt?.request_id??null};}
      need(!r.error,r.error);const responseBody=store.db.prepare('SELECT body FROM requests WHERE seq=?').get(r.receipt.request_id).body;proof=ext.verifyToken2022Owner(tx,source.wallet,source.first_received_at_ms,{data:r.data,receipt:r.receipt,responseBody},clock.nowMs());
     }
    }else proof={...proof,reason:c.reason};
   }
   return{...source,sourceId:source.id,side:proof.accepted?proof.event.side:'UNKNOWN',token:proof.accepted?proof.event.token.mint:null,verified:proof.accepted?proof.event:undefined,ownership:proof,decoded_at_ms:clock.nowMs(),hydrationRequestId:hydration.receipt?.request_id??null};
  }
  const assess=createSealedSourceDecisionAssessor({store,config,clock,measurement,actualRiskContext,admission,admissionPrecheck,nextResearchSendAt,expiredBeforeSend,bindingDigest});
  async function drain(paused,yieldOnFollow,selected){
   const produced=[];
   const restricted=selected.length<wallets.length?new Set(selected):null;
   for(let n=0;n<maxSources;n++){
    const page=cursor.readPage();if(!page.rows.length)break;const source=page.rows[0].source,segment=store.get('autonomousObservationSegment'),anchor=segment?.anchors?.[source.wallet];
    let d,decision;const already=store.db.prepare("SELECT data FROM events WHERE id=?").get('decision:'+source.id);
    if(already){cursor.commitPage(page,()=>{});continue;}
    if(segment&&(page.rows[0].seq<=segment.priorSourceHighWaterSeq||!anchor||source.slot<=anchor.slot||source.event_time_ms<segment.committedAtMs)){const reason=page.rows[0].seq<=segment.priorSourceHighWaterSeq?'PRE_SEGMENT_SOURCE_NOT_EVALUATED':'OBSERVATION_SEGMENT_BOUNDARY_CENSORED';d={...source,side:'UNKNOWN',token:null,ownership:{accepted:false,reason},observationSegmentId:segment.segmentId};decision={id:'decision:'+source.id,sourceId:source.id,source:d,decision:'PASS',reason,decisionAtMs:clock.nowMs(),bindingDigest,executionAuthority:false};}
    else if(restricted&&!restricted.has(source.wallet)){d={...source,side:'UNKNOWN',token:null,ownership:{accepted:false,reason:'ENTRY_PAUSED_FOR_EXISTING_RESPONSIBILITY'}};decision={id:'decision:'+source.id,sourceId:source.id,source:d,decision:'PASS',reason:d.ownership.reason,decisionAtMs:clock.nowMs(),bindingDigest,executionAuthority:false};}
    else if(!Number.isSafeInteger(source.event_time_ms)||source.event_time_ms<store.get('observationStart')||source.event_time_ms>clock.nowMs()||clock.nowMs()-source.event_time_ms>OBSERVER_SAFETY.sourceMaxAgeMs){d={...source,side:'UNKNOWN',token:null,ownership:{accepted:false,reason:'SOURCE_LEFT_CENSORED_STALE_OR_CLOCK'}};decision={id:'decision:'+source.id,sourceId:source.id,source:d,decision:'PASS',reason:d.ownership.reason,decisionAtMs:clock.nowMs(),bindingDigest,executionAuthority:false};}
    else{d=await decode(source);if(d.side==='SELL')store.event('AUTONOMOUS_LEADER_SELL',{sourceId:d.id,wallet:d.wallet,mint:d.token,chainAtMs:d.event_time_ms,receivedAtMs:d.first_received_at_ms},'leader-sell:'+d.id);decision=await assess(d,paused);}
    cursor.commitPage(page,()=>{if(d.queueDrop&&d.queueDrop.possibleSide!=='BUY')store.event('AUTONOMOUS_UNPROVEN_SOURCE_COVERAGE',{sourceId:source.id,wallet:source.wallet,candidateMint:d.queueDrop.candidateMint,possibleSide:d.queueDrop.possibleSide,chainAtMs:source.event_time_ms,firstReceivedAtMs:source.first_received_at_ms,stage:d.queueDrop.stage,readyAtMs:d.queueDrop.readyAtMs,validUntilMs:d.queueDrop.validUntilMs},'source-coverage:'+source.id);store.event('AUTONOMOUS_DECODE',{source:d},'decode:'+source.id);store.event('AUTONOMOUS_DECISION',decision,decision.id);});
    produced.push(decision);await onDecoded(d);await onDecision(decision);
    // Commit the exact decision/cursor before yielding; leave the rest durable.
    if(yieldOnFollow&&decision.decision==='FOLLOW')break;
   }
   return produced;
  }
  async function step({wallets:selected=wallets,yieldOnFollow=false}={}){
   need(typeof yieldOnFollow==='boolean','OBSERVER_YIELD_CONTRACT');
   need(!closed&&!inFlight,'OBSERVER_BUSY_OR_CLOSED');need(['RUNNING','ENTRY_PAUSED'].includes(state().state),'OBSERVER_NOT_RUNNING');
   need(Array.isArray(selected)&&selected.length>0&&new Set(selected).size===selected.length&&selected.every(w=>wallets.includes(w)),'OBSERVER_WALLET_SCOPE');
   if(clock.nowMs()<provider.quietUntil)return{status:status(),decisions:[]};
   const backlog=cursor.readPage().rows.length>0;
   if(!backlog&&clock.nowMs()<state().nextPollMs)return{status:status(),decisions:[]};
   inFlight=true;const cycleStart=clock.nowMs(),prior=state();let paused=prior.pendingWallets.length>0;
   try{
    // Existing durable SOURCE rows drain without first polling more wallets or
    // waiting for the next poll slot. The cursor preserves their original order.
    if(backlog)return{status:status(),decisions:await drain(paused,yieldOnFollow,selected)};
    const pending=new Set(prior.pendingWallets);const ordered=[...selected.slice(prior.cycle%selected.length),...selected.slice(0,prior.cycle%selected.length)];
    for(const wallet of ordered){
     const checkpoint=store.get('poll:'+wallet);guard();const segment=store.get('autonomousObservationSegment');
     // Existing Collector's overlap/pages/GAP rules are unchanged. Only the
     // explicit new segment's lower time boundary is supplied at initialization;
     // the original observationStart and its budget period remain untouched.
     const pollStore=segment?new Proxy(store,{get(target,k){if(k==='get')return key=>key==='observationStart'?Math.max(store.get(key),segment.committedAtMs):store.get(key);const value=Reflect.get(target,k,target);return typeof value==='function'?value.bind(target):value;}}):store;
     await owners.Collector.prototype.poll.call({s:pollStore,p:provider,clock},wallet);
     const row=store.db.prepare("SELECT data FROM events WHERE type='POLL' ORDER BY seq DESC LIMIT 1").get(),receipt=row?JSON.parse(row.data):null;
     if(receipt?.wallet!==wallet||receipt.complete!==true){
      paused=true;pending.add(wallet);const current=store.get('poll:'+wallet);
      store.set('poll:'+wallet,{...current,started:checkpoint?.started??store.get('observationStart'),newest:checkpoint?.newest??null});
      writeState({...state(),state:'ENTRY_PAUSED',pendingWallets:[...pending],consecutivePollFailures:state().consecutivePollFailures+1});
      store.event('AUTONOMOUS_COVERAGE_PAUSED',{wallet,checkpoint,atMs:clock.nowMs(),retry:false,gapRetained:true});
      need(!hasObligation(),'OBLIGATION_SOURCE_COVERAGE_GAP');need(state().consecutivePollFailures<maxFailures,'REPEATED_SOURCE_COVERAGE_GAP');
     }else pending.delete(wallet);
    }
    const decisions=await drain(paused,yieldOnFollow,selected);const current=state();
    writeState({...current,state:pending.size?'ENTRY_PAUSED':'RUNNING',pendingWallets:[...pending],consecutivePollFailures:pending.size?current.consecutivePollFailures:0,cycle:prior.cycle+1,nextPollMs:Math.max(cycleStart+pollMs,clock.nowMs())});
    if(paused&&!pending.size)store.event('AUTONOMOUS_COVERAGE_RECOVERED',{atMs:clock.nowMs(),historicalGapsRetained:true,drainBuysNotAdmitted:true});
    return{status:status(),decisions};
   }catch(e){const reason=safeError(e);writeState({...state(),state:'HALTED',reason});store.event('AUTONOMOUS_OBSERVER_HALTED',{reason,atMs:clock.nowMs(),obligationRetained:true});throw e;}finally{inFlight=false;}
  }
  return{store,accountProvider:provider,start,step,stop,status,beginZeroFundsObservationSegment,bindingDigest,requestBudget:budget,assertResearchBudget,reserveExternalRequest,completeExternalRequest,awaitExternalTransport,
   readDecisions(afterSeq=0,limit=100){need(Number.isSafeInteger(afterSeq)&&afterSeq>=0&&positive(limit)&&limit<=1000,'OBSERVER_OUTBOX_BOUND');return store.db.prepare("SELECT seq,data FROM events WHERE type='AUTONOMOUS_DECISION' AND seq>? ORDER BY seq LIMIT ?").all(afterSeq,limit).map(r=>({seq:r.seq,decision:JSON.parse(r.data)}));},
   close(){need(!inFlight,'OBSERVER_STEP_IN_PROGRESS');if(!closed){store.close();closed=true;}}
  };
 }catch(e){store.close();throw e;}
}
