// Existing alpha-pilot (pilot.mjs:102-128) / FollowBook admission semantics,
// adapted to durable service quotas. Those owners have no separable pure export:
// importing runPilotEngine would construct a bounded historical experiment.
// This adapter does not own funds, positions, intent, quotes or execution.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {OBSERVER_SAFETY} from './observer.mjs';
import {loadSealedResearchOwner,RESEARCH_AUTHORITY} from './research-owner.mjs';
import {ZeroFundsWatchlistResourceSuccessor} from './zero-funds-watchlist-resource-successor.mjs';
import {verifyOperatorAuthorization} from './release.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const positive=n=>Number.isSafeInteger(n)&&n>0;
const encode=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x);
const hash=v=>createHash('sha256').update(encode(v)).digest('hex');
const byteHash=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>v&&typeof v==='object'?(Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]))):v;
const same=(a,b)=>encode(canonical(a))===encode(canonical(b));
const eventFirstBindings=new WeakMap();
const EVENT_FIRST='EVENT_FIRST_SEALED_SOURCE_V1';
const GTFA='JUP6_GTFA_FULL_SUCCEEDED_LIMIT20_V1';
const JUPITER='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const withoutBinding=d=>Object.fromEntries(Object.entries(d).filter(([k])=>k!=='eventFirstProof'));
// Receipt times belong to an acquisition. Everything economic remains exact.
// The first durable SOURCE is never replaced by a later acquisition's view.
const economicSource=d=>{const v=structuredClone(withoutBinding(d));delete v.first_received_at_ms;delete v.decoded_at_ms;
 if(v.ownership?.event)delete v.ownership.event.timestamps;if(v.verified)delete v.verified.timestamps;return v;};

/** A zero-funds seam on the SAME historical Store, not a new admission scope.
 * The opaque binding comes only from pinned local plan/config plus the actual
 * sealed verifier. No funded caller/mandate is enabled by this interface. */
export async function createEventFirstSealedSourceBinding({store,planFile,planSha256,configFile,configSha256,clock={nowMs:()=>Date.now()},funded}){
 const pinned=(file,digest)=>{need(/^[a-f0-9]{64}$/.test(digest??''),'ADMISSION_EVENT_PIN');
  const f=path.resolve(file);need(fs.lstatSync(f).isFile()&&!fs.lstatSync(f).isSymbolicLink()&&fs.realpathSync(f)===f,'ADMISSION_EVENT_FILE');
  const b=fs.readFileSync(f);need(byteHash(b)===digest,'ADMISSION_EVENT_IDENTITY_CHANGED');return JSON.parse(b);};
 const plan=pinned(planFile,planSha256),config=pinned(configFile,configSha256),owners=await loadSealedResearchOwner();
 const sourceConfig=funded?config.eventFirst:config;
 let authorization;
 const authority=()=>{
  if(!funded)return null;
  const a=verifyOperatorAuthorization({root:funded.root,config,configFile,authorizationFile:funded.authorizationFile,nowMs:clock.nowMs()});
  need(a.candidateDigest===funded.candidateDigest&&a.authorizationDigest===funded.authorizationDigest&&a.configDigest===configSha256&&
   same(a.eventFirstSource,{mode:EVENT_FIRST,planSha256,acquisitionVersion:GTFA,researchReleaseSha256:RESEARCH_AUTHORITY.releaseSha256})&&
   path.resolve(sourceConfig?.planFile??'')===path.resolve(planFile)&&Number.isSafeInteger(a.entryUntilMs),
   'ADMISSION_EVENT_FUNDED_AUTHORITY_BINDING');
  return a;
 };
 if(funded){
  need(plan.schema==='FUNDED_EVENT_FIRST_PILOT_PLAN_V1'&&plan.authority==='EXPLICIT_OPERATOR_AUTHORIZATION_REQUIRED'&&config.mode==='AUTONOMOUS'&&
   plan.configSha256===configSha256&&plan.sourceEligibilityMode===EVENT_FIRST&&sourceConfig?.sourceEligibilityMode===EVENT_FIRST&&
   sourceConfig.ticketRaw==='10000000'&&plan.sourceProgram===JUPITER&&sourceConfig.acquisitionVersion===GTFA&&
   plan.researchReleaseSha256===RESEARCH_AUTHORITY.releaseSha256&&sourceConfig.researchReleaseSha256===RESEARCH_AUTHORITY.releaseSha256,
   'ADMISSION_EVENT_FUNDED_CONFIG');
  authorization=authority();
 }else{
 need(plan.schema==='ROUTE_ALIGNED_EVENT_FIRST_INTEGRATED_ZERO_FUNDS_PLAN_V1'&&config.schema==='EVENT_FIRST_ZERO_FUNDS_OPERATION_CONFIG_V1'&&
  plan.fundsAuthority===false&&config.fundsAuthority===false&&plan.sourceEligibilityMode===EVENT_FIRST&&config.sourceEligibilityMode===EVENT_FIRST&&
  plan.configSha256===configSha256&&plan.sourceProgram===JUPITER&&config.ticketRaw==='10000000'&&
  plan.researchReleaseSha256===RESEARCH_AUTHORITY.releaseSha256&&config.researchReleaseSha256===RESEARCH_AUTHORITY.releaseSha256,'ADMISSION_EVENT_ZERO_FUNDS_ONLY');
 }
 const check=()=>{
  pinned(planFile,planSha256);pinned(configFile,configSha256);
  if(funded)authorization=authority();
  const i=plan.storeIdentity;need(store?.db&&i&&fs.realpathSync(store.dir)===i.directory&&
   byteHash(store.db.prepare("SELECT v FROM kv WHERE k='config'").get().v)===i.baseConfigSha256&&
   store.get(i.admissionKey)?.bindingDigest===i.admissionBindingDigest,'ADMISSION_EVENT_STORE_BINDING');
 };
 check();
 const savedEvent=(id,type)=>{const r=store.db.prepare('SELECT type,data FROM events WHERE id=?').get(id);
  need(r?.type===type,'ADMISSION_EVENT_SAVED_PROOF_REQUIRED');return Object.fromEntries(Object.entries(JSON.parse(r.data)).filter(([k])=>!['available_at_ms','type'].includes(k)&&(type==='SOURCE'||k!=='id')));};
 const readRequest=id=>{
  need(Number.isSafeInteger(id)&&id>0,'ADMISSION_EVENT_REQUEST_ID');const r=store.db.prepare('SELECT * FROM requests WHERE seq=?').get(id);
  need(r?.kind==='RPC'&&r.responded!==null&&typeof r.body==='string'&&r.body.length>0,'ADMISSION_EVENT_BODY_REQUIRED');
  const meta=JSON.parse(r.data),body=JSON.parse(r.body);
  need(meta.http_status===200&&!meta.error&&!body.error&&meta.body_sha256===byteHash(r.body)&&Number.isSafeInteger(meta.responded_at_ms),'ADMISSION_EVENT_BODY_HASH');
  return{row:r,meta,body};
 };
 const readBatch=(d,refs)=>{
  need((funded||plan.approval==='USER_APPROVED_ZERO_FUNDS_OPERATION')&&plan.acquisition?.version===GTFA&&sourceConfig.acquisitionVersion===GTFA&&
   refs.acquisitionVersion===GTFA&&plan.acquisition.limit===20&&plan.acquisition.lookbackSeconds===60,'ADMISSION_EVENT_ACQUISITION_IDENTITY');
  need(Number.isSafeInteger(refs.batchRequestId)&&refs.batchRequestId>0&&Number.isSafeInteger(refs.ordinal)&&refs.ordinal>=0&&refs.ordinal<20,'ADMISSION_EVENT_BATCH_LOCATOR');
  const row=store.db.prepare('SELECT * FROM requests WHERE seq=?').get(refs.batchRequestId),e=savedEvent('gtfa-batch:'+refs.batchRequestId,'EVENT_FIRST_GTFA_BATCH_EVIDENCE');
  need(row?.kind==='RPC'&&row.purpose==='discoveryBatch'&&row.responded!==null,'ADMISSION_EVENT_BATCH_RECEIPT');
  const meta=JSON.parse(row.data);
  need(e.schema==='EVENT_FIRST_GTFA_BATCH_EVIDENCE_V1'&&e.requestId===row.seq&&e.planSha256===planSha256&&e.configSha256===configSha256&&e.acquisitionVersion===GTFA&&
   meta.operationPlanSha256===planSha256&&meta.operationConfigSha256===configSha256&&meta.acquisitionVersion===GTFA&&same(meta.externalRawEvidence,e)&&
   e.bodyComplete===true&&e.httpStatus===200&&meta.http_status===200&&!meta.error&&meta.body_sha256===e.responseBodySha256&&
   e.requestedAtMs===row.requested&&e.receivedAtMs<=row.responded&&meta.responded_at_ms===e.receivedAtMs&&meta.requested_at_ms===e.requestedAtMs,
   'ADMISSION_EVENT_BATCH_RECEIPT');
  const raw=(file,digest)=>{
   const dir=fs.realpathSync(plan.acquisition.evidenceDirectory),f=path.resolve(file);
   need(f.startsWith(dir+path.sep)&&fs.lstatSync(f).isFile()&&!fs.lstatSync(f).isSymbolicLink()&&fs.realpathSync(f)===f&&
    fs.statSync(f).size<=8388608,'ADMISSION_EVENT_BATCH_RAW_FILE');
   const bytes=fs.readFileSync(f);need(byteHash(bytes)===digest,'ADMISSION_EVENT_BATCH_PARENT_HASH');return JSON.parse(bytes);
  };
  need(refs.parentRequestSha256===e.requestBodySha256&&refs.parentResponseSha256===e.responseBodySha256,'ADMISSION_EVENT_BATCH_PARENT_HASH');
  const request=raw(e.requestRawFile,e.requestBodySha256),response=raw(e.responseRawFile,e.responseBodySha256),o=request.params?.[1];
  need(request.jsonrpc==='2.0'&&request.id===row.seq&&request.method==='getTransactionsForAddress'&&request.params?.length===2&&request.params[0]===JUPITER&&
   same(meta.params,{method:request.method,params:request.params})&&same(o,{transactionDetails:'full',encoding:'json',commitment:'confirmed',sortOrder:'desc',limit:20,maxSupportedTransactionVersion:1,
    filters:{status:'succeeded',tokenAccounts:'none',blockTime:{gte:o?.filters?.blockTime?.gte,lte:o?.filters?.blockTime?.lte}}})&&
   Number.isSafeInteger(o.filters.blockTime.gte)&&Number.isSafeInteger(meta.sampleAtMs??row.requested)&&
   (meta.sampleAtMs??row.requested)<=row.requested&&o.filters.blockTime.lte===Math.floor((meta.sampleAtMs??row.requested)/1000)&&o.filters.blockTime.lte-o.filters.blockTime.gte===60,
   'ADMISSION_EVENT_BATCH_REQUEST_CONTRACT');
  need(response.jsonrpc==='2.0'&&response.id===request.id&&!response.error&&Array.isArray(response.result?.data)&&response.result.data.length<=20&&
   Object.hasOwn(response.result,'paginationToken')&&(response.result.paginationToken===null||typeof response.result.paginationToken==='string'),'ADMISSION_EVENT_BATCH_RESPONSE_CONTRACT');
  const tx=response.result.data[refs.ordinal];
  need(tx&&hash(tx)===refs.itemSha256&&tx.transaction?.signatures?.[0]===d.signature&&tx.slot===d.slot&&tx.blockTime*1000===d.event_time_ms&&
   ['legacy',0,1].includes(tx.version)&&tx.meta?.err===null,'ADMISSION_EVENT_BATCH_ITEM_BINDING');
  const m=tx.transaction?.message;
  need(Number.isSafeInteger(m?.header?.numRequiredSignatures)&&Array.isArray(m.accountKeys)&&Array.isArray(m.instructions)&&
   ['preBalances','postBalances','preTokenBalances','postTokenBalances','innerInstructions','logMessages'].every(k=>Array.isArray(tx.meta?.[k]))&&Number.isSafeInteger(tx.meta.fee)&&tx.meta.fee>=0&&
   (!m.addressTableLookups?.length||(Array.isArray(tx.meta.loadedAddresses?.writable)&&Array.isArray(tx.meta.loadedAddresses?.readonly)))&&
   [...tx.meta.preTokenBalances,...tx.meta.postTokenBalances].every(b=>['accountIndex','mint','owner','programId'].every(k=>Object.hasOwn(b,k))&&Object.hasOwn(b.uiTokenAmount??{},'amount')&&Object.hasOwn(b.uiTokenAmount??{},'decimals')),
   'ADMISSION_EVENT_BATCH_OWNER_FIELDS');
  need(Number.isSafeInteger(e.receivedAtMs)&&e.receivedAtMs>=row.requested&&e.receivedAtMs===d.first_received_at_ms&&d.decoded_at_ms>=e.receivedAtMs&&
   d.event_time_ms>=o.filters.blockTime.gte*1000&&d.event_time_ms<=o.filters.blockTime.lte*1000&&
   e.receivedAtMs<=d.event_time_ms+OBSERVER_SAFETY.sourceMaxAgeMs&&d.decoded_at_ms<=d.event_time_ms+OBSERVER_SAFETY.sourceMaxAgeMs,'ADMISSION_EVENT_TIME_SIGNATURE_BINDING');
  return{tx,record:{acquisitionVersion:GTFA,batchRequestId:row.seq,ordinal:refs.ordinal,itemLocator:'/result/data/'+refs.ordinal,
   parentRequestSha256:e.requestBodySha256,parentResponseSha256:e.responseBodySha256,itemSha256:refs.itemSha256,
   batchReceiptAtMs:e.receivedAtMs,transactionVersion:tx.version}};
 };
 const verifySaved=(d,refs)=>{
  check();need(d.sourceId===undefined||d.sourceId===d.id,'ADMISSION_EVENT_SOURCE_ID');
  need(refs?.sourceEventId===d.id,'ADMISSION_EVENT_SOURCE_ID');
  const original=savedEvent(refs.sourceEventId,'SOURCE'),owner=savedEvent(refs.ownerResultEventId,'EVENT_FIRST_SEALED_OWNER_RESULT');
  if(funded)need(d.event_time_ms>=authorization.validFromMs&&d.first_received_at_ms>=authorization.validFromMs&&
   clock.nowMs()<authorization.entryUntilMs&&clock.nowMs()<d.event_time_ms+OBSERVER_SAFETY.sourceMaxAgeMs,'ADMISSION_EVENT_NEW_FRESH_SOURCE_REQUIRED');
  const observed=owner.source??original;
  need((same(original,withoutBinding(d))||same(observed,withoutBinding(d)))&&owner.sourceId===d.id&&
   same(economicSource(original),economicSource(observed)),'ADMISSION_EVENT_SOURCE_CHANGED');
  let tx,acquisition;
  if(refs.acquisitionVersion===GTFA){
   need(owner.source&&owner.acquisitionVersion===GTFA&&owner.batchRequestId===refs.batchRequestId&&owner.ordinal===refs.ordinal&&owner.itemSha256===refs.itemSha256,'ADMISSION_EVENT_BATCH_OWNER_LOCATOR');
   ({tx,record:acquisition}=readBatch(observed,refs));
  }
  else{
  need(refs.acquisitionVersion===undefined,'ADMISSION_EVENT_ACQUISITION_IDENTITY');
  const page=readRequest(refs.pageRequestId),body=readRequest(refs.bodyRequestId);tx=body.body.result;
  need(page.meta.params?.method==='getSignaturesForAddress'&&page.meta.params.params?.[0]===JUPITER&&
   page.meta.params.params?.[1]?.commitment==='confirmed'&&body.meta.params?.method==='getTransaction'&&
   body.meta.params.params?.[0]===d.signature&&body.meta.params.params?.[1]?.commitment==='confirmed','ADMISSION_EVENT_REQUEST_CONTRACT');
  const row=page.body.result?.find(x=>x.signature===d.signature);
  need(row&&row.err===null&&row.slot===d.slot&&row.blockTime*1000===d.event_time_ms&&
   page.meta.responded_at_ms===observed.first_received_at_ms&&body.meta.responded_at_ms===observed.decoded_at_ms&&
   body.row.requested>=observed.first_received_at_ms&&body.row.requested<=d.event_time_ms+OBSERVER_SAFETY.sourceMaxAgeMs&&
   tx?.transaction?.signatures?.[0]===d.signature&&tx.slot===d.slot&&tx.blockTime*1000===d.event_time_ms,'ADMISSION_EVENT_TIME_SIGNATURE_BINDING');
  acquisition={pageRequestId:refs.pageRequestId,bodyRequestId:refs.bodyRequestId,pageBodySha256:page.meta.body_sha256,transactionBodySha256:body.meta.body_sha256};
  }
  const proof=owners.verifyOwner(tx,observed.wallet,observed.first_received_at_ms);
  need(proof.accepted===true&&proof.verifier==='RPC_JUPITER_ROUTE_V2_OWNER_NET_V2'&&proof.proof.signer===true&&proof.proof.route_owner===d.wallet&&
   proof.event.side==='BUY'&&proof.event.id===d.id&&proof.event.token.mint===d.token&&proof.event.quote.mint==='SOL_NATIVE'&&
   /^[1-9][0-9]*$/.test(String(proof.event.quote.raw))&&/^[1-9][0-9]*$/.test(String(proof.proof.token_net_raw))&&
   same(owner.result,proof)&&same(observed.ownership,proof)&&same(observed.verified,proof.event)&&d.side==='BUY','ADMISSION_EVENT_SEALED_OWNER_PROOF');
  return{schema:EVENT_FIRST,planSha256,configSha256,researchReleaseSha256:RESEARCH_AUTHORITY.releaseSha256,
   sourceEventId:refs.sourceEventId,ownerResultEventId:refs.ownerResultEventId,...acquisition,
   sourceId:d.id,eventId:refs.sourceEventId,signature:d.signature,slot:d.slot,chainAtMs:d.event_time_ms,
   firstReceivedAtMs:original.first_received_at_ms,wallet:d.wallet,mint:d.token,sourceSha256:hash(canonical(original)),ownerResultSha256:hash(canonical(owner.result)),
   ...(funded?{fundsAuthority:true,candidateDigest:authorization.candidateDigest,authorizationDigest:authorization.authorizationDigest,followerWallet:config.wallet}: {fundsAuthority:false})};
 };
 const bind=(d,refs)=>store.atomic(()=>{
  const record=verifySaved(d,refs),id='event-first-sealed-proof:'+hash(record.acquisitionVersion===GTFA?
   [planSha256,d.id,GTFA,record.batchRequestId,record.ordinal]:[planSha256,d.id]),old=store.db.prepare('SELECT data FROM events WHERE id=?').get(id);
  let saved=record;
  if(old){saved=savedEvent(id,'EVENT_FIRST_SEALED_SOURCE_PROOF');need(same(saved,record),'ADMISSION_EVENT_PROOF_CHANGED');}else store.event('EVENT_FIRST_SEALED_SOURCE_PROOF',record,id);
  return{...savedEvent(d.id,'SOURCE'),eventFirstProof:{id,sha256:hash(saved),planSha256,configSha256}};
 });
 const validate=d=>{
  const ref=d.eventFirstProof;need(ref&&ref.planSha256===planSha256&&ref.configSha256===configSha256,'ADMISSION_EVENT_BINDING_REQUIRED');
  const record=savedEvent(ref.id,'EVENT_FIRST_SEALED_SOURCE_PROOF');need(hash(record)===ref.sha256,'ADMISSION_EVENT_PROOF_CHANGED');
  const actual=verifySaved(d,record);
  need(same(actual,record),'ADMISSION_EVENT_PROOF_CHANGED');return record;
 };
 const sameSource=(a,b)=>{
  const get=ref=>{const r=savedEvent(ref?.id,'EVENT_FIRST_SEALED_SOURCE_PROOF');need(hash(r)===ref.sha256,'ADMISSION_EVENT_PROOF_CHANGED');return r;};
  const x=get(a),y=get(b);
  return ['researchReleaseSha256','sourceId','eventId','signature','slot','chainAtMs','firstReceivedAtMs','wallet','mint','sourceSha256'].every(k=>x[k]===y[k]);
 };
 const binding=Object.freeze({mode:EVENT_FIRST,planSha256,configSha256,fundsAuthority:!!funded});
 eventFirstBindings.set(binding,{store,plan,check,bind,validate,sameSource});return binding;
}

/** entryGate MUST synchronously read the actual runtime/capital/kill status and
 * return null or an uppercase refusal reason. No healthy/empty fallback.
 * Quota period rollover affects research sampling only, never capital stage.
 * episode exclusion deliberately spans period boundaries and process restarts. */
export class PersistentAdmission {
 #eventFirst;
 constructor({store,policy,watchlist,entryGate,clock={nowMs:()=>Date.now()},zeroFundsSuccessor,eventFirstSource}){
  need(store?.db&&typeof store.atomic==='function'&&typeof entryGate==='function','ADMISSION_EXISTING_STORE_AND_DUTY_REQUIRED');
  need(policy&&/^[A-Za-z0-9_-]{1,100}$/.test(policy.scopeId??'')&&Number.isSafeInteger(policy.periodStartMs)&&policy.periodStartMs>=0&&
   ['periodMs','maxAdmissions','perWalletAdmissions','perMintAdmissions','episodeMs'].every(k=>positive(policy[k]))&&/^[1-9][0-9]*$/.test(policy.ticketRaw??''),'ADMISSION_POLICY_REQUIRED');
  need(Array.isArray(watchlist)&&watchlist.length>0&&new Set(watchlist).size===watchlist.length&&watchlist.every(w=>typeof w==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)),'ADMISSION_WATCHLIST');
  this.s=store;this.p=structuredClone(policy);this.wallets=[...watchlist];this.entryGate=entryGate;this.clock=clock;
  this.binding={schema:'AUTONOMOUS_ADMISSION_POLICY_V1',policy:this.p,watchlist:this.wallets,safety:OBSERVER_SAFETY};this.bindingDigest=hash(this.binding);this.key='autonomousAdmission:'+policy.scopeId;
  need(zeroFundsSuccessor===undefined||zeroFundsSuccessor instanceof ZeroFundsWatchlistResourceSuccessor,'ADMISSION_ZERO_FUNDS_SUCCESSOR');
  if(zeroFundsSuccessor){const c=zeroFundsSuccessor.admissionContext({policy,watchlist});this.binding=c.binding;this.bindingDigest=c.bindingDigest;this.allotmentWalletCount=c.allotmentWalletCount;}
  store.atomic(()=>{const old=store.get(this.key);need(!old||old.bindingDigest===this.bindingDigest,'ADMISSION_POLICY_CHANGED');if(!old)store.set(this.key,{binding:this.binding,bindingDigest:this.bindingDigest});});
  if(eventFirstSource!==undefined){const c=eventFirstBindings.get(eventFirstSource);need(c?.store===store&&c.plan.storeIdentity.admissionKey===this.key&&c.plan.storeIdentity.admissionBindingDigest===this.bindingDigest,'ADMISSION_EVENT_BINDING_REQUIRED');c.check();this.#eventFirst=c;}
 }
 bindEventFirstSource(d,refs){need(this.#eventFirst,'ADMISSION_EVENT_MODE_NOT_ENABLED');return this.#eventFirst.bind(d,refs);}
 assertFundedSource(d){need(this.#eventFirst,'ADMISSION_EVENT_MODE_NOT_ENABLED');const r=this.#eventFirst.validate(d);need(r.fundsAuthority===true,'ADMISSION_EVENT_FUNDED_AUTHORITY_REQUIRED');return r;}
 period(){const now=this.clock.nowMs();need(Number.isSafeInteger(now)&&now>=this.p.periodStartMs,'ADMISSION_CLOCK');return Math.floor((now-this.p.periodStartMs)/this.p.periodMs);}
 /** Conservative negative-only pre-metadata hook; never grants authority or
  * consumes a reservation. Formal admit repeats it inside the Store transaction. */
 capacity({wallet,mint},{deferWallet=false}={}){
  const base="type='AUTONOMOUS_ADMISSION' AND json_extract(data,'$.bindingDigest')=? AND json_extract(data,'$.period')=? AND json_extract(data,'$.allowed')=1";
  const count=(extra='',args=[])=>this.s.db.prepare('SELECT COUNT(*) n FROM events WHERE '+base+extra).get(this.bindingDigest,this.period(),...args).n;
  if(count()>=this.p.maxAdmissions)return'ADMISSION_PERIOD_CAP';
  const allotment=Math.min(this.p.perWalletAdmissions,Math.floor(this.p.maxAdmissions/(this.allotmentWalletCount??this.wallets.length)));
  if(!deferWallet&&count(" AND json_extract(data,'$.wallet')=?",[wallet])>=allotment)return'WALLET_ALLOTMENT';
  if(count(" AND json_extract(data,'$.mint')=?",[mint])>=this.p.perMintAdmissions)return'MINT_CAP';
  return null;
 }
 precheck(d,{deferWallet=true}={}){
  need(typeof d?.id==='string'&&d.id.length>0,'ADMISSION_SOURCE_ID');
  let reason=this.entryGate();need(reason===null||(typeof reason==='string'&&/^[A-Z0-9_:-]+$/.test(reason)),'ADMISSION_DUTY_RESULT_REQUIRED');
  const now=this.clock.nowMs();
  const bound=d.eventFirstProof?this.#eventFirst?.validate(d):null;
  if(d.eventFirstProof)need(bound,'ADMISSION_EVENT_MODE_NOT_ENABLED');
  if(!reason&&((!this.wallets.includes(d.wallet)&&!bound)||d.side!=='BUY'||d.ownership?.accepted!==true||!d.verified||(d.verified.side!==undefined&&d.verified.side!=='BUY')||d.verified.quote?.mint!=='SOL_NATIVE'||d.token!==d.verified.token?.mint))reason='UNSUPPORTED_SOURCE';
  if(!reason&&(![d.event_time_ms,d.first_received_at_ms,d.decoded_at_ms].every(Number.isSafeInteger)||d.event_time_ms>now||d.first_received_at_ms<d.event_time_ms||d.first_received_at_ms>now||d.decoded_at_ms>now||now-d.event_time_ms>OBSERVER_SAFETY.sourceMaxAgeMs))reason='SOURCE_STALE_OR_CLOCK';
  if(!reason&&(!/^[1-9][0-9]*$/.test(String(d.verified.quote.raw))||!/^[1-9][0-9]*$/.test(String(d.verified.token.raw))))reason='SOURCE_DUST_OR_INVALID';
  if(!reason&&this.s.db.prepare("SELECT 1 FROM events WHERE type='AUTONOMOUS_LEADER_SELL' AND json_extract(data,'$.wallet')=? AND json_extract(data,'$.mint')=? AND json_extract(data,'$.chainAtMs')>=? LIMIT 1").get(d.wallet,d.token,d.event_time_ms))reason='LEADER_ALREADY_SOLD';
  if(!reason)reason=this.capacity({wallet:d.wallet,mint:d.token},{deferWallet});
  if(!reason&&this.s.db.prepare("SELECT 1 FROM events WHERE type='AUTONOMOUS_ADMISSION' AND json_extract(data,'$.bindingDigest')=? AND json_extract(data,'$.allowed')=1 AND json_extract(data,'$.wallet')=? AND json_extract(data,'$.mint')=? AND json_extract(data,'$.lockUntilMs')>? LIMIT 1").get(this.bindingDigest,d.wallet,d.token,now))reason='EPISODE_ALREADY_ADMITTED';
  return reason;
 }
 /** The same atomic consumer repeats ALL checks, including wallet capacity.
  * Call only after economic/chase and preliminary execution eligibility. */
 admit(d){return this.s.atomic(()=>{
  need(typeof d?.id==='string'&&d.id.length>0,'ADMISSION_SOURCE_ID');const id='autonomous-admission:'+hash([this.p.scopeId,d.id]);
  if(d.eventFirstProof){need(this.#eventFirst,'ADMISSION_EVENT_MODE_NOT_ENABLED');this.#eventFirst.validate(d);}
  const old=this.s.db.prepare('SELECT data FROM events WHERE id=?').get(id);if(old){const prior=JSON.parse(old.data);
   if(prior.sourceMode===EVENT_FIRST){need(d.eventFirstProof&&this.#eventFirst,'ADMISSION_EVENT_BINDING_REQUIRED');this.#eventFirst.validate(d);need(this.#eventFirst.sameSource(prior.eventFirstProof,d.eventFirstProof),'ADMISSION_EVENT_PROOF_CHANGED');}
   return{...prior,duplicate:true};}
  const reason=this.precheck(d,{deferWallet:false}),now=this.clock.nowMs(),period=this.period();
  const record={sourceId:d.id,scopeId:this.p.scopeId,bindingDigest:this.bindingDigest,period,wallet:d.wallet,mint:d.token,atMs:now,lockUntilMs:now+this.p.episodeMs,allowed:!reason,reason,reservedQuotes:reason?0:2,executionAuthority:false,
   ...(d.eventFirstProof?{sourceMode:EVENT_FIRST,eventFirstProof:d.eventFirstProof}: {})};
  this.s.event('AUTONOMOUS_ADMISSION',record,id);return record;
 });}
}
