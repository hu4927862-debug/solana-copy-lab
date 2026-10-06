// One explicitly approved, finite zero-funds research successor. Not a grant,
// dynamic universe, capital owner, or funded-runtime resource configuration.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {FixedFileWalletUniverseProvider} from './research-owner.mjs';
const encode=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x);
const hash=v=>createHash('sha256').update(typeof v==='string'?v:encode(v)).digest('hex');
const need=(ok,code)=>{if(!ok)throw Error('ZERO_FUNDS_SUCCESSOR_'+code);};
const TYPE='ZERO_FUNDS_WATCHLIST_RESOURCE_SUCCESSOR',USE='ZERO_FUNDS_RESOURCE_CONSUMPTION';
const ACTIVE=Object.freeze(['EEXANfgNeeqdjwRsDrZGD7B9N4w1A7seh9YJ4FAFqAF1','FwVveA6uBvDp6MV4u98ihVH1uiWWMVdrFQLXinzCJvqr']);
const CSN='CsnWuLAU3cPY6f6CTWafnpVXPVzwZpBiNPHYfMtSE6u3';
const PARENT='c61a5477a9c28c99db970b2cba2b91a2eeed848e2bf5ca006f8df3c23a33ea1e';
export class ZeroFundsWatchlistResourceSuccessor {
 constructor({store,plan,assertNoFundsResponsibility}){
  need(store?.db&&typeof assertNoFundsResponsibility==='function','EXISTING_STORE_REQUIRED');
  const original=encode(plan?.activeWallets)===encode(ACTIVE)&&plan?.previousSuccessorDigest===undefined;
  const csn=plan?.id==='mint-first-csn-20261001'&&encode(plan.activeWallets)===encode([CSN])&&/^[a-f0-9]{64}$/.test(plan.previousSuccessorDigest??'');
  const fixed=plan?.mode==='ZERO_FUNDS_STATIC_WATCHLIST_SUCCESSOR';
  need(plan?.schema==='ZERO_FUNDS_WATCHLIST_RESOURCE_SUCCESSOR_V1'&&plan.parentReleaseDigest===PARENT&&(original||csn||fixed)&&
   /^[A-Za-z0-9_-]{1,100}$/.test(plan.id??'')&&plan.normalRpc===(fixed?140:100)&&plan.normalQuote===(fixed?16:12)&&plan.pollMs===30000&&
   Number.isSafeInteger(plan.startMs)&&plan.endMs-plan.startMs===(fixed?1200000:900000)&&plan.diagnosticEndMs===plan.endMs+180000&&
   (!fixed||plan.fundsAuthority===false&&Array.isArray(plan.activeWallets)&&plan.activeWallets.length>=1&&plan.activeWallets.length<=2&&
    Number.isSafeInteger(plan.preparationStartMs)&&plan.startMs-plan.preparationStartMs>=90000&&
    encode(plan.nonfundedConformanceAllowance)===encode({rpc:40,jupiter:4})),'EXACT_SCOPE');
  this.s=store;this.plan=structuredClone(plan);this.active=[...plan.activeWallets];this.noFunds=assertNoFundsResponsibility;
  this.fixed=fixed;
  this.parent=store.get('autonomousObserverBinding');need(this.parent?.digest&&store.get('observationStart')!==undefined,'PARENT_BINDING');
  const prior=store.events(TYPE);need(fixed||prior.length<=2,'ALREADY_EXISTS');
  this.identity={file:fs.realpathSync(path.join(store.dir,'collector.sqlite')),inode:fs.statSync(path.join(store.dir,'collector.sqlite')).ino,
   baseConfigSha256:hash(store.db.prepare("SELECT v FROM kv WHERE k='config'").get().v),budgetOrigin:store.get('observationStart'),observerBindingSha256:hash(this.parent)};
  if(fixed)need(encode(plan.storeIdentity)===encode(this.identity),'STORE_IDENTITY_CHANGED');
  need(prior.every(x=>hash(x.record)===x.digest&&encode(x.record.identity)===encode(this.identity)),'PRIOR_IDENTITY_CHANGED');
  const existing=prior.find(x=>x.record.plan.id===plan.id);
  if(existing){need(encode(existing.record.plan)===encode(this.plan),'ALREADY_EXISTS');this.record=existing.record;this.digest=existing.digest;}
  else{
   // Exactly one explicitly instructed future Csn-only window. The expired
   // predecessor remains immutable; its unused allowance is not carried over.
   if(fixed)need(prior.length>=1&&prior.at(-1).digest===plan.previousSuccessorDigest&&prior.at(-1).record.plan.endMs<=plan.preparationStartMs,'PREDECESSOR_NOT_FINISHED');
   else if(csn)need(prior.length===1&&prior[0].digest===plan.previousSuccessorDigest&&encode(prior[0].record.plan.activeWallets)===encode(ACTIVE)&&
    prior[0].record.plan.endMs<=(plan.preparationStartMs??plan.startMs),'PREDECESSOR_NOT_FINISHED');
   else need(prior.length===0,'ALREADY_EXISTS');
   const protectedBefore=this.protectedBudget();
   this.record={schema:'ZERO_FUNDS_WATCHLIST_RESOURCE_SUCCESSOR_RECORD_V1',plan:this.plan,identity:this.identity,
    originalAdmissionBindings:store.db.prepare("SELECT k,v FROM kv WHERE k LIKE 'autonomousAdmission:%' ORDER BY k").all(),
    priorObserverState:store.get('autonomousObserverState'),priorPollCursors:store.db.prepare("SELECT k,v FROM kv WHERE k LIKE 'poll:%' ORDER BY k").all(),
    requestHighWater:store.db.prepare('SELECT COALESCE(MAX(seq),0) n FROM requests').get().n,eventHighWater:store.db.prepare('SELECT COALESCE(MAX(seq),0) n FROM events').get().n,
    physicalRequestsBefore:store.db.prepare('SELECT COUNT(*) n FROM requests').get().n,
    historicalGrantRows:store.db.prepare("SELECT COUNT(*) n FROM requests WHERE kind='READ_ONLY_RESEARCH_GRANT_RPC'").get().n,
    protectedBefore,oldNormalRpcNotReused:true,fundsAuthorized:false};this.digest=hash(this.record);
   store.atomic(()=>{need(encode(store.events(TYPE))===encode(prior),'ALREADY_EXISTS');this.check();need(['STOPPED','HALTED','IDLE'].includes(store.get('autonomousObserverState')?.state),'OBSERVER_RUNNING');
    store.event(TYPE,{digest:this.digest,record:this.record},'zero-funds-successor:'+this.digest);});
  }
  need(hash(this.record)===this.digest,'RECORD_CHANGED');this.check();
  this.view=new Proxy(store,{get:(target,k)=>{if(k==='reserve')return this.reserve.bind(this);const v=Reflect.get(target,k,target);return typeof v==='function'?v.bind(target):v;}});
 }
 check(){need(this.noFunds()===true,'EXISTING_RESPONSIBILITY');
  if(this.fixed){const u=new FixedFileWalletUniverseProvider(this.plan.watchlist).snapshot({nowMs:this.s.clock.nowMs()});
   need(u.snapshotDigest===this.plan.watchlist.snapshotDigest&&encode(u.wallets.map(x=>x.address))===encode(this.active),'WATCHLIST_CHANGED');}
  need(hash(this.s.db.prepare("SELECT v FROM kv WHERE k='config'").get().v)===this.identity.baseConfigSha256&&
  this.s.get('observationStart')===this.identity.budgetOrigin&&hash(this.s.get('autonomousObserverBinding'))===this.identity.observerBindingSha256,'BASE_IDENTITY_CHANGED');}
 protectedBudget(){const count=(kind,extra)=>this.s.db.prepare('SELECT COUNT(*) n FROM requests WHERE kind=?'+extra).get(kind).n;
  const r=this.parent.binding.config.executionReserve;return{rpc:Math.max(0,r.rpc-count('RPC'," AND purpose='execution'")-count('RPC'," AND key LIKE 'facts-responsibility:%'")),quote:Math.max(0,r.quote-count('QUOTE'," AND purpose='execution'"))};}
 budget(){this.check();const uses=this.s.events(USE).filter(x=>x.digest===this.digest),n=(bucket,kind)=>uses.filter(x=>x.bucket===bucket&&x.kind===kind).length;
  for(const u of uses)need(this.s.db.prepare('SELECT key,kind,purpose FROM requests WHERE seq=?').get(u.requestId)?.key===u.key,'LEDGER_UNCERTAIN');
  const normalRemaining={rpc:this.plan.normalRpc-n('NORMAL','RPC'),quote:this.plan.normalQuote-n('NORMAL','QUOTE')},protectedRemaining=this.protectedBudget();need(normalRemaining.rpc>=0&&normalRemaining.quote>=0,'LEDGER_UNCERTAIN');
  const nonfundedConformanceRemaining=this.fixed?{rpc:this.plan.nonfundedConformanceAllowance.rpc-n('NONFUNDED_CONFORMANCE','RPC'),jupiter:this.plan.nonfundedConformanceAllowance.jupiter-n('NONFUNDED_CONFORMANCE','QUOTE')}:null;
  if(this.fixed)need(nonfundedConformanceRemaining.rpc>=0&&nonfundedConformanceRemaining.jupiter>=0,'LEDGER_UNCERTAIN');
  const executionUsed={rpc:this.parent.binding.config.executionReserve.rpc-protectedRemaining.rpc,quote:this.parent.binding.config.executionReserve.quote-protectedRemaining.quote};
  return{normalRemaining,protectedRemaining,executionUsed,priorityFactsUsed:0,rpcRemaining:normalRemaining.rpc+protectedRemaining.rpc,quoteRemaining:normalRemaining.quote+protectedRemaining.quote,
   totalRemaining:normalRemaining.rpc+normalRemaining.quote+protectedRemaining.rpc+protectedRemaining.quote,physicalRequests:this.s.db.prepare('SELECT COUNT(*) n FROM requests').get().n,historicalGrantRows:this.record.historicalGrantRows,
   successorDigest:this.digest,legacyRpcCapUnchanged:this.s.config.rpcCap,normalUsed:{rpc:this.plan.normalRpc-normalRemaining.rpc,quote:this.plan.normalQuote-normalRemaining.quote},...(this.fixed?{nonfundedConformanceRemaining}: {})};
 }
 guard(){this.check();const now=this.s.clock.nowMs();need(now>=(this.plan.preparationStartMs??this.plan.startMs)&&now<(this.s.get('zeroFundsConformance:'+this.digest)?this.plan.diagnosticEndMs:this.plan.endMs),'READ_DEADLINE');}
 observerContext({directory,config,storeConfig}){
  this.check();need(fs.realpathSync(directory)===fs.realpathSync(this.s.dir),'STORE_CHANGED');const old=this.parent.binding.config;
  const keep=c=>Object.fromEntries(Object.entries(c).filter(([k])=>!['walletUniverse','rpcCap','quoteCap','totalCap'].includes(k)));
  const scopes=this.s.events(TYPE).map(x=>x.record.plan);
  const rpcAdded=scopes.reduce((n,p)=>n+p.normalRpc+(p.nonfundedConformanceAllowance?.rpc??0),0),quoteAdded=scopes.reduce((n,p)=>n+p.normalQuote+(p.nonfundedConformanceAllowance?.jupiter??0),0);
  need(encode(keep(config))===encode(keep(old))&&encode(config.walletUniverse.wallets.map(x=>x.address))===encode(this.active)&&
   (!this.fixed||config.walletUniverse.snapshotDigest===this.plan.watchlist.snapshotDigest)&&
   config.rpcCap===old.rpcCap+rpcAdded&&config.quoteCap===old.quoteCap+quoteAdded&&config.totalCap===old.totalCap+rpcAdded+quoteAdded+this.record.historicalGrantRows,'OBSERVER_POLICY_CHANGED');
  const clean=c=>Object.fromEntries(Object.entries(c).filter(([k])=>!['rpcCap','quoteCap','quoteDaily','entryDaily','caps'].includes(k)));
  need(encode(clean(storeConfig))===encode(clean(this.s.config)),'RESEARCH_SEMANTICS_CHANGED');return{store:this.view,budget:this.budget.bind(this),guard:this.guard.bind(this)};
 }
 admissionContext({policy,watchlist}){
  this.check();const key='autonomousAdmission:'+policy.scopeId,saved=this.s.get(key);need(saved&&encode(saved.binding.policy)===encode(policy)&&encode(watchlist)===encode(this.active),'ADMISSION_POLICY_CHANGED');
  need(this.record.originalAdmissionBindings.some(x=>x.k===key&&x.v===encode(saved)),'ADMISSION_IDENTITY_CHANGED');
  return{binding:saved.binding,bindingDigest:saved.bindingDigest,allotmentWalletCount:saved.binding.watchlist.length};
 }
 beginConformance(decision,rawAssetProof){this.s.atomic(()=>{this.guard();need(decision?.decision==='FOLLOW'&&decision.executionEligibility?.eligible===true&&decision.admission?.allowed===true&&
   this.active.includes(decision.source?.wallet)&&this.s.clock.nowMs()<decision.sourceExpiresAtMs,'CONFORMANCE_REQUIRES_FRESH_ADMITTED_FOLLOW');need(!this.s.get('zeroFundsConformance:'+this.digest),'CONFORMANCE_ALREADY_STARTED');
   const saved=this.s.db.prepare('SELECT data FROM events WHERE id=?').get(decision.id);
   const payload=saved?JSON.parse(saved.data):null;if(this.fixed&&payload){delete payload.available_at_ms;delete payload.type;}
   need(payload&&encode(payload)===encode(decision),'FOLLOW_EVIDENCE_CHANGED');
   if(this.fixed){need(rawAssetProof?.classification==='PILOT_ASSET_ELIGIBLE'&&rawAssetProof.sourceId===decision.sourceId&&rawAssetProof.mint===decision.source.token&&
    Number.isSafeInteger(rawAssetProof.observedAtMs)&&rawAssetProof.observedAtMs<=this.s.clock.nowMs()&&this.s.clock.nowMs()-rawAssetProof.observedAtMs<=5000,'RAW_ASSET');
    const savedRaw=this.s.events('PILOT_RAW_ASSET_PROOF').find(x=>x.sourceId===decision.sourceId);
    need(savedRaw&&Object.entries(rawAssetProof).every(([k,v])=>encode(savedRaw[k])===encode(v)),'RAW_ASSET_EVIDENCE_CHANGED');}
   const r={sourceId:decision.sourceId,decisionId:decision.id,atMs:this.s.clock.nowMs(),fundsAuthorized:false};this.s.set('zeroFundsConformance:'+this.digest,r);this.s.event('ZERO_FUNDS_CONFORMANCE_START',{digest:this.digest,...r});});}
 reserve(key,kind,purpose,metadata){return this.s.atomic(()=>{
  this.guard();need(['RPC','QUOTE'].includes(kind),'REQUEST_KIND');need(!this.s.db.prepare('SELECT 1 FROM requests WHERE key=?').get(key),'REQUEST_ALREADY_ATTEMPTED');
  const external=purpose==='execution';need(!external||metadata?.kind!=='SEND'&&!/send|execute|submit/i.test(metadata?.method??''),'SEND_FORBIDDEN');
  need(external||['poll','extraPage','forwardHydration','metadata','entry','mark'].includes(purpose),'PURPOSE');
  if(!external&&kind==='RPC'&&['poll','extraPage'].includes(purpose))need(this.active.includes(metadata?.params?.params?.[0]),'WALLET_SCOPE');
  const started=!!this.s.get('zeroFundsConformance:'+this.digest),conformance=external&&started,bucket=conformance?(this.fixed?'NONFUNDED_CONFORMANCE':'PROTECTED_CONFORMANCE'):'NORMAL',b=this.budget(),k=kind==='RPC'?'rpc':'quote';
  need(!this.fixed||!started||external,'CONFORMANCE_OBSERVATION_STOPPED');
  need((conformance?(this.fixed?b.nonfundedConformanceRemaining[kind==='RPC'?'rpc':'jupiter']:b.protectedRemaining[k]):b.normalRemaining[k])>0,conformance?(this.fixed?'NONFUNDED_CONFORMANCE_BUDGET':'PROTECTED_BUDGET'):'NORMAL_'+kind+'_BUDGET');
  if(this.fixed&&conformance&&kind==='QUOTE'){
   const expected=['v1/GET/quote','v1/POST/swap','v1/GET/quote','v1/POST/swap'][this.plan.nonfundedConformanceAllowance.jupiter-b.nonfundedConformanceRemaining.jupiter];
   need(metadata?.kind==='JUPITER'&&metadata.method===expected,'CONFORMANCE_JUPITER_COMPOSITION');
  }
  if(external&&!conformance)need(kind==='RPC'&&['getMultipleAccounts','getTokenAccountsByOwner','getSignaturesForAddress'].includes(metadata?.method),'ADMIN_READ_ONLY');
  need((this.s.get('rawBytes')??0)+this.s.config.bodyBytes<=this.s.config.rawBytes,'STORAGE_BUDGET');
  const day=Math.max(0,Math.floor((this.s.clock.nowMs()-this.identity.budgetOrigin)/86400000));
  const requestId=Number(this.s.db.prepare('INSERT INTO requests(key,kind,purpose,day,requested,data) VALUES(?,?,?,?,?,?)').run(key,kind,purpose,day,this.s.clock.nowMs(),encode(metadata)).lastInsertRowid);
  // Administrative reads are charged normal. They must not reduce the protected
  // balance via the inherited purpose='execution' aggregate.
  const ledgerPurpose=external&&!conformance?'zeroFundsWalletFacts':this.fixed&&conformance?'zeroFundsConformance':purpose;
  if(ledgerPurpose!==purpose)this.s.db.prepare('UPDATE requests SET purpose=? WHERE seq=?').run(ledgerPurpose,requestId);
  this.s.event(USE,{digest:this.digest,requestId,key,kind,purpose:ledgerPurpose,bucket},'zero-funds-use:'+this.digest+':'+requestId);return requestId;
 });}
}
