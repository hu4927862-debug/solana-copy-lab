// One append-only operational grant on an ALREADY OPEN sealed Research Store.
// No new Store, configuration override, polling loop, quote or funds authority.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {loadSealedResearchOwner} from './research-owner.mjs';

const {Stop}=await loadSealedResearchOwner();

export const GRANT_RPC_KIND='READ_ONLY_RESEARCH_GRANT_RPC';
const TYPE='READ_ONLY_RESEARCH_GRANT', SCOPE='BOUNDED_INHERITED_WALLET_SUPPLY_SCREEN';
const json=v=>JSON.stringify(v),sha=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:json(v)).digest('hex');
const need=(ok,code)=>{if(!ok)throw new Stop(code);};
const address=(v,n)=>{try{return typeof v==='string'&&bs58.decode(v).length===n;}catch{return false;}};
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

export function researchGrantStoreIdentity(store){
 need(store?.db&&typeof store.atomic==='function'&&typeof store.event==='function'&&!store.closed,'READ_ONLY_GRANT_EXISTING_STORE_REQUIRED');
 const file=fs.realpathSync(path.join(store.dir,'collector.sqlite')),stat=fs.statSync(file);
 const config=store.db.prepare("SELECT v FROM kv WHERE k='config'").get()?.v;
 need(config&&config===json(store.config),'READ_ONLY_GRANT_BASE_CONFIG_CHANGED');
 const bindings=store.db.prepare("SELECT k,v FROM kv WHERE k LIKE 'autonomousAdmission:%' ORDER BY k").all().map(r=>({key:r.k,binding:JSON.parse(r.v).binding}));
 return freeze({schema:'READ_ONLY_RESEARCH_STORE_IDENTITY_V1',file,device:stat.dev,inode:stat.ino,
  baseConfigSha256:sha(config),budgetOrigin:store.get('observationStart')??null,
  observerBindingSha256:sha(store.get('autonomousObserverBinding')??null),admissionBindingsSha256:sha(bindings)});
}

function baseBudget(store){
 const count=(kind,where='')=>store.db.prepare('SELECT COUNT(*) n FROM requests WHERE kind=?'+where).get(kind).n;
 const binding=store.get('autonomousObserverBinding')?.binding?.config?.executionReserve;
 need(binding&&Number.isSafeInteger(binding.rpc)&&Number.isSafeInteger(binding.quote),'READ_ONLY_GRANT_PROTECTED_BINDING_REQUIRED');
 const rpcUsed=count('RPC'),quoteUsed=count('QUOTE');
 const priority=count('RPC'," AND key LIKE 'facts-responsibility:%'");
 const protectedRpc=Math.max(0,binding.rpc-count('RPC'," AND purpose='execution'")-priority);
 const protectedQuote=Math.max(0,binding.quote-count('QUOTE'," AND purpose='execution'"));
 return {rpcCap:store.config.rpcCap,rpcUsed,quoteCap:store.config.quoteCap,quoteUsed,protectedRpc,protectedQuote,normalRpc:store.config.rpcCap-rpcUsed-protectedRpc};
}

export function appendReadOnlyResearchGrant({store,identity,proposal,startedAtMs,deadlineMs}){
 const bytes=fs.readFileSync(proposal.path),p=JSON.parse(bytes);
 need(sha(bytes)===proposal.sha256&&p.schema==='BOUNDED_READ_ONLY_RESEARCH_EXTENSION_PROPOSAL_V1'&&
  p.requestedAdditionalNormalRpc===32&&p.requestedAdditionalQuote===0&&p.currentRpcCapUnchanged===800&&
  p.protectedRpcUnchanged===318&&p.protectedQuoteUnchanged===4&&p.perWalletBodiesMax===2&&
  Array.isArray(p.candidateWallets)&&p.candidateWallets.length===25&&new Set(p.candidateWallets).size===25&&p.candidateWallets.every(w=>address(w,32)),
 'READ_ONLY_GRANT_APPROVED_SCOPE');
 need(Number.isSafeInteger(startedAtMs)&&Number.isSafeInteger(deadlineMs)&&deadlineMs>startedAtMs&&deadlineMs-startedAtMs<=300000,'READ_ONLY_GRANT_TIME_BOUND');
 need(fs.realpathSync(p.sameLedger)===fs.realpathSync(store.dir),'READ_ONLY_GRANT_PROPOSAL_STORE');
 const record={schema:'READ_ONLY_RESEARCH_GRANT_V1',scope:SCOPE,identity,
  approvalProposal:{path:fs.realpathSync(proposal.path),sha256:proposal.sha256},rpcCap:32,quoteCap:0,
  purposes:['inheritedSupplyHead','inheritedSupplyBody'],wallets:p.candidateWallets,headLimit:6,maxBodiesPerWallet:2,recentWindowMs:21600000,
  startedAtMs,deadlineMs,authority:'READ_ONLY_RESEARCH_NO_FUNDS_NO_OBSERVER'};
 // Times preserve the initial bounded read plan, not a renewable resource period.
 // The grant is a finite allocation, independent of Provider reference expiry.
 // Every read session still uses the unchanged Provider/caller deadline and pacing.
 const digest=sha(record);
 store.atomic(()=>{
  need(json(researchGrantStoreIdentity(store))===json(identity),'READ_ONLY_GRANT_STORE_IDENTITY');
  const grants=store.events(TYPE);
  if(grants.length){need(grants.length===1&&grants[0].grantDigest===digest&&json(grants[0].grant)===json(record),'READ_ONLY_GRANT_ALREADY_EXISTS');return;}
  const b=baseBudget(store);
  need(b.rpcCap===800&&b.protectedRpc===318&&b.protectedQuote===4&&b.normalRpc===0,'READ_ONLY_GRANT_BASE_BUDGET_CHANGED');
  need(store.clock.nowMs()>=startedAtMs&&store.clock.nowMs()<deadlineMs,'READ_ONLY_GRANT_DEADLINE');
  store.event(TYPE,{grantDigest:digest,grant:record},'read-only-research-grant:'+digest);
 });
 return new ReadOnlyResearchGrant({store,digest});
}

export class ReadOnlyResearchGrant {
 constructor({store,digest}){
  this.store=store;this.digest=digest;
  const events=store.events(TYPE);need(events.length===1&&events[0].grantDigest===digest,'READ_ONLY_GRANT_NOT_FOUND');
  const record=events[0].grant;need(sha(record)===digest,'READ_ONLY_GRANT_RECORD_CHANGED');
  this.record=freeze(record);this.status();
 }
 status(){
  need(json(researchGrantStoreIdentity(this.store))===json(this.record.identity),'READ_ONLY_GRANT_STORE_IDENTITY');
  const grants=this.store.events(TYPE);
  need(grants.length===1&&grants[0].grantDigest===this.digest&&sha(grants[0].grant)===this.digest,'READ_ONLY_GRANT_RECORD_CHANGED');
  const uses=this.store.events('READ_ONLY_RESEARCH_GRANT_CONSUMPTION');
  const requests=this.store.db.prepare('SELECT seq,key,kind,purpose FROM requests WHERE kind=? ORDER BY seq').all(GRANT_RPC_KIND);
  need(uses.length===requests.length&&uses.length<=32&&uses.every((u,i)=>u.grantDigest===this.digest&&u.ordinal===i+1&&
   u.requestId===requests[i].seq&&u.key===requests[i].key&&u.purpose===requests[i].purpose),'READ_ONLY_GRANT_LEDGER_UNCERTAIN');
  return freeze({digest:this.digest,scope:this.record.scope,rpcCap:32,quoteCap:0,usedRpc:uses.length,remainingRpc:32-uses.length,
   baseBudget:baseBudget(this.store),physicalRequests:this.store.db.prepare('SELECT COUNT(*) n FROM requests').get().n});
 }
 headRequest(wallet){
  need(this.record.wallets.includes(wallet),'READ_ONLY_GRANT_WALLET_SCOPE');
  return freeze({key:'research-grant:'+this.digest+':'+wallet+':head',purpose:'poll',
   params:{method:'getSignaturesForAddress',params:[wallet,{commitment:'finalized',limit:6}]}});
 }
 bodyRequest(wallet,signature){
  need(this.record.wallets.includes(wallet)&&address(signature,64),'READ_ONLY_GRANT_WALLET_OR_SIGNATURE_SCOPE');
  return freeze({key:'research-grant:'+this.digest+':'+wallet+':tx:'+signature,purpose:'forwardHydration',
   params:{method:'getTransaction',params:[signature,{commitment:'finalized',encoding:'json',maxSupportedTransactionVersion:1}]}});
 }
 #operation(key,kind,purpose,metadata){
  need(kind==='RPC'&&['poll','forwardHydration'].includes(purpose),'READ_ONLY_GRANT_PURPOSE_DENIED');
  need(metadata&&Object.keys(metadata).sort().join('|')==='params|requested_at_ms|requested_mono_ns'&&
   Number.isSafeInteger(metadata.requested_at_ms)&&metadata.requested_at_ms>=this.record.startedAtMs&&metadata.requested_at_ms<=this.store.clock.nowMs()&&
   /^[0-9]+$/.test(metadata.requested_mono_ns),'READ_ONLY_GRANT_REQUEST_METADATA');
  const wallet=this.record.wallets.find(w=>key.startsWith('research-grant:'+this.digest+':'+w+':'));
  need(wallet,'READ_ONLY_GRANT_REQUEST_SCOPE');
  if(purpose==='poll'){
   const expected=this.headRequest(wallet);
   need(key===expected.key&&json(metadata.params)===json(expected.params),'READ_ONLY_GRANT_HEAD_CONTRACT');
   return {wallet,purpose:'inheritedSupplyHead',signature:null,parentHeadRequestId:null};
  }
  const signature=metadata.params?.params?.[0],expected=this.bodyRequest(wallet,signature);
  need(key===expected.key&&json(metadata.params)===json(expected.params),'READ_ONLY_GRANT_BODY_CONTRACT');
  const head=this.store.db.prepare('SELECT * FROM requests WHERE key=?').get(this.headRequest(wallet).key);
  need(head?.responded!==null&&head?.kind===GRANT_RPC_KIND&&head?.purpose==='inheritedSupplyHead'&&head?.body,'READ_ONLY_GRANT_SUCCESSFUL_HEAD_REQUIRED');
  const receipt=JSON.parse(head.data),body=JSON.parse(head.body);
  need(receipt.http_status===200&&receipt.body_sha256===sha(head.body)&&!receipt.error&&body.jsonrpc==='2.0'&&body.id===head.seq&&
   !body.error&&Array.isArray(body.result)&&body.result.length<=6,'READ_ONLY_GRANT_HEAD_EVIDENCE');
  const item=body.result.find(r=>r.signature===signature);
  need(item?.err===null&&Number.isSafeInteger(item.slot)&&item.slot>=0&&Number.isSafeInteger(item.blockTime)&&
   item.blockTime*1000>=Math.max(this.record.startedAtMs,this.store.clock.nowMs())-this.record.recentWindowMs&&item.blockTime*1000<=this.store.clock.nowMs(),'READ_ONLY_GRANT_RECENT_SUCCESSFUL_SIGNATURE_REQUIRED');
  const count=this.store.db.prepare('SELECT COUNT(*) n FROM requests WHERE kind=? AND key LIKE ? AND purpose=?')
   .get(GRANT_RPC_KIND,'research-grant:'+this.digest+':'+wallet+':tx:%','inheritedSupplyBody').n;
  need(count<2,'READ_ONLY_GRANT_WALLET_BODY_CAP');
  return {wallet,purpose:'inheritedSupplyBody',signature,parentHeadRequestId:head.seq};
 }
 #reserve(key,kind,purpose,metadata){
  return this.store.atomic(()=>{
   const balance=this.status(),now=this.store.clock.nowMs();
   need(now>=this.record.startedAtMs,'READ_ONLY_GRANT_CLOCK');
   need(balance.remainingRpc>0,'READ_ONLY_GRANT_RPC_BUDGET');
   need(!this.store.db.prepare('SELECT 1 FROM requests WHERE key=?').get(key),'REQUEST_ALREADY_ATTEMPTED');
   const operation=this.#operation(key,kind,purpose,metadata);
   need((this.store.get('rawBytes')??0)+this.store.config.bodyBytes<=this.store.config.rawBytes,'STORAGE_BUDGET');
   const day=Math.max(0,Math.floor((now-(this.store.get('observationStart')??now))/86400000));
   const requestId=Number(this.store.db.prepare('INSERT INTO requests(key,kind,purpose,day,requested,data) VALUES(?,?,?,?,?,?)')
    .run(key,GRANT_RPC_KIND,operation.purpose,day,now,json(metadata)).lastInsertRowid);
   this.store.event('READ_ONLY_RESEARCH_GRANT_CONSUMPTION',{grantDigest:this.digest,requestId,key,ordinal:balance.usedRpc+1,...operation},
    'read-only-research-grant-use:'+this.digest+':'+requestId);
   return requestId;
  });
 }
 providerStore(){
  // The existing AccountProvider retains transport, deadlines, shared lastSend,
  // response persistence and failure semantics. Only reserve is grant-scoped.
  const s=this.store;
  return Object.freeze({db:s.db,config:s.config,clock:s.clock,get:s.get.bind(s),set:s.set.bind(s),event:s.event.bind(s),gap:s.gap.bind(s),
   response:s.response.bind(s),reserve:this.#reserve.bind(this)});
 }
}
