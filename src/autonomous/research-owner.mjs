// Stable, local-only seams over the existing sealed Research owners. Importing
// this module never opens a Store, starts a collector, or makes a network call.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import bs58 from 'bs58';

const root=fileURLToPath(new URL('../../',import.meta.url));
const p='reports/project-current-state-audit-20260926/smart-wallet-follow';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const requireThat=(ok,code)=>{if(!ok)throw Error(code);};
function readRegular(file){const absolute=path.resolve(file),stat=fs.lstatSync(absolute);requireThat(stat.isFile()&&!stat.isSymbolicLink()&&fs.realpathSync(absolute)===absolute,'RESEARCH_AUTHORITY_FILE_TYPE');return fs.readFileSync(absolute);}

export const RESEARCH_AUTHORITY=Object.freeze({
 schema:'AUTONOMOUS_SEALED_RESEARCH_DEPENDENCY_V1',
 releaseSha256:'30b62aabd22fcae25b0195e8912dd0200ac982d3dc884a436ec59ec6c4cbb44b',
 loaderPath:p+'/owners.mjs',loaderSha256:'bdf665e834bab0bd94b5621395fc716aaa8a0cd3d09d25305e9a5f9c6fc64476',
 closurePath:p+'/OWNERS.json',closureSha256:'e7b7c66876a719258c76aa286e658266015e9c2815b0031f6a221608b800df40',closureFiles:33,
});

export async function loadSealedResearchOwner(){
 const a=RESEARCH_AUTHORITY;
 requireThat(hash(readRegular(path.join(root,a.loaderPath)))===a.loaderSha256,'RESEARCH_AUTHORITY_LOADER_CHANGED');
 requireThat(hash(readRegular(path.join(root,a.closurePath)))===a.closureSha256,'RESEARCH_AUTHORITY_CLOSURE_CHANGED');
 const {loadResearchOwners}=await import(pathToFileURL(path.join(root,a.loaderPath)).href);
 const owners=await loadResearchOwners();
 requireThat(owners.identity.releaseSha256===a.releaseSha256&&Object.keys(owners.identity.files).length===a.closureFiles,'RESEARCH_AUTHORITY_IDENTITY');
 return Object.freeze({...owners,readiness:Object.freeze({sealedDependenciesVerified:true,networkStarted:false,longRunningObserverBound:false,liveExecutionBound:false})});
}

// Dependency factory only: the caller must explicitly supply the lifecycle,
// request budgets, coverage/health gates and actual-position Risk inputs.
export const createSealedObserverDependencies=loadSealedResearchOwner;

const uint=v=>Number.isSafeInteger(v)&&v>=0;
const address=v=>{try{return typeof v==='string'&&bs58.decode(v).length===32;}catch{return false;}};
const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const json=v=>JSON.stringify(canonical(v));
const deepFreeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))deepFreeze(x);Object.freeze(v);}return v;};

/** WalletUniverseProvider contract: synchronous, pinned local facts. A future
 * Dune adapter may emit this snapshot contract, but cannot confer trade authority.
 * No implied staleness refresh: asOf is the source's actual saved timestamp. */
export class FixedFileWalletUniverseProvider {
 constructor({file,sha256}){requireThat(typeof file==='string'&&/^[a-f0-9]{64}$/.test(sha256??''),'WALLET_UNIVERSE_PIN_REQUIRED');this.file=path.resolve(file);this.sha256=sha256;}
 snapshot({nowMs=Date.now(),maxAgeMs=Infinity}={}){
  requireThat(uint(nowMs)&&(maxAgeMs===Infinity||(uint(maxAgeMs)&&maxAgeMs>0)),'WALLET_UNIVERSE_CLOCK');
  const bytes=readRegular(this.file);requireThat(hash(bytes)===this.sha256,'WALLET_UNIVERSE_HASH_CHANGED');
  const data=JSON.parse(bytes);
  requireThat(['SMART_WALLET_SUPPLY_WATCHLIST_V1','AUTONOMOUS_FIXED_WALLET_UNIVERSE_V1'].includes(data.schema),'WALLET_UNIVERSE_SCHEMA');
  const asOfMs=data.schema==='SMART_WALLET_SUPPLY_WATCHLIST_V1'?Date.parse(data.frozenAt):data.asOfMs;
  requireThat(uint(asOfMs),'WALLET_UNIVERSE_ASOF_REQUIRED');requireThat(asOfMs<=nowMs,'WALLET_UNIVERSE_FUTURE');requireThat(nowMs-asOfMs<=maxAgeMs,'WALLET_UNIVERSE_STALE');
  requireThat(Array.isArray(data.wallets)&&data.wallets.length>0&&data.wallets.every(w=>w&&address(w.address)),'WALLET_UNIVERSE_ADDRESSES');
  requireThat(new Set(data.wallets.map(w=>w.address)).size===data.wallets.length,'WALLET_UNIVERSE_DUPLICATE');
  const snapshot={schema:'WALLET_UNIVERSE_SNAPSHOT_V1',provider:'FIXED_FILE',file:this.file,fileSha256:this.sha256,asOfMs,
   selection:data.selection??'FIXED_CANDIDATES_NOT_PROFITABILITY_PROOF',wallets:data.wallets.map(w=>({address:w.address,evidence:w.evidence??null})),executionAuthority:false};
  return deepFreeze({...snapshot,snapshotDigest:hash(json(snapshot))});
 }
}

const exactKeys=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
/** A future model receives public, point-in-time scalar facts only. This pure
 * contract neither invokes a model nor upgrades a recommendation to a gate. */
export function createModelShadowRequest({decisionId,wallet,mint,observedAtMs,features}){
 requireThat(typeof decisionId==='string'&&decisionId.length>0&&decisionId.length<=200&&address(wallet)&&address(mint)&&uint(observedAtMs),'SHADOW_INPUT_IDENTITY');
 requireThat(features&&typeof features==='object'&&!Array.isArray(features)&&Object.entries(features).every(([k,v])=>
  /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)&&!/(secret|password|mnemonic|privatekey|apikey|rpcurl|authorization|signedbytes)/i.test(k)&&
  (v===null||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v))||(typeof v==='string'&&v.length<=512&&!/https?:\/\//i.test(v)))), 'SHADOW_PUBLIC_FEATURES_ONLY');
 requireThat(Buffer.byteLength(json(features))<=32768,'SHADOW_FEATURE_BUDGET');
 const body={schema:'MODEL_DECISION_SHADOW_REQUEST_V1',decisionId,wallet,mint,observedAtMs,features:{...features},role:'SHADOW_ONLY',executionAuthority:false};
 return deepFreeze({...body,inputDigest:hash(json(body))});
}

export function validateModelShadowResponse(request,response){
 requireThat(exactKeys(request,['schema','decisionId','wallet','mint','observedAtMs','features','role','executionAuthority','inputDigest']),'SHADOW_REQUEST_SHAPE');
 const rebuilt=createModelShadowRequest(request);
 requireThat(json(rebuilt)===json(request),'SHADOW_REQUEST_CHANGED');
 requireThat(exactKeys(response,['schema','decisionId','inputDigest','modelId','evaluatedAtMs','recommendation','reasonCodes']),'SHADOW_RESPONSE_SHAPE');
 requireThat(response.schema==='MODEL_DECISION_SHADOW_RESPONSE_V1'&&response.decisionId===request.decisionId&&response.inputDigest===request.inputDigest,'SHADOW_BINDING');
 requireThat(typeof response.modelId==='string'&&/^[A-Za-z0-9_.:/-]{1,128}$/.test(response.modelId)&&uint(response.evaluatedAtMs)&&response.evaluatedAtMs>=request.observedAtMs,'SHADOW_RESPONSE_IDENTITY');
 requireThat(['FOLLOW','PASS','ABSTAIN'].includes(response.recommendation)&&Array.isArray(response.reasonCodes)&&response.reasonCodes.length<=16&&response.reasonCodes.every(r=>typeof r==='string'&&/^[A-Z0-9_:-]{1,80}$/.test(r)),'SHADOW_RESPONSE_VALUE');
 return deepFreeze({...response,reasonCodes:[...response.reasonCodes],role:'SHADOW_ONLY',executionAuthority:false});
}

/** Bounded SOURCE read/ack adapter on an ALREADY OPEN sealed Store. It does not
 * poll, hydrate, decode, quote or create a database. commitPage's callback must
 * write only synchronous local effects through the supplied SAME Store; never
 * perform network/send/sign/external side effects in a SQLite transaction.
 * A crash rolls back both local downstream effects and the seq checkpoint.
 * Receipt time and permanent GAP records are never rewritten by this adapter. */
export class SourceEventCursor {
 constructor({store,consumerId,pageSize=100}){
  requireThat(store?.db&&typeof store.get==='function'&&typeof store.set==='function'&&typeof store.atomic==='function','SOURCE_EXISTING_STORE_REQUIRED');
  requireThat(typeof consumerId==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(consumerId),'SOURCE_CONSUMER_ID');
  requireThat(Number.isSafeInteger(pageSize)&&pageSize>0&&pageSize<=1000,'SOURCE_PAGE_BOUND');
  this.store=store;this.consumerId=consumerId;this.pageSize=pageSize;this.key='autonomous:source-cursor:'+consumerId;
 }
 checkpoint(){
  const c=this.store.get(this.key)??{schema:'AUTONOMOUS_SOURCE_CURSOR_V1',consumerId:this.consumerId,releaseSha256:RESEARCH_AUTHORITY.releaseSha256,lastSeq:0};
  requireThat(c.schema==='AUTONOMOUS_SOURCE_CURSOR_V1'&&c.consumerId===this.consumerId&&c.releaseSha256===RESEARCH_AUTHORITY.releaseSha256&&uint(c.lastSeq),'SOURCE_CURSOR_BINDING');return deepFreeze(c);
 }
 readPage(){
  const checkpoint=this.checkpoint();
  const rows=this.store.db.prepare("SELECT seq,id,data FROM events WHERE type='SOURCE' AND seq>? ORDER BY seq LIMIT ?").all(checkpoint.lastSeq,this.pageSize).map(row=>({seq:row.seq,id:row.id,source:JSON.parse(row.data)}));
  const body={schema:'AUTONOMOUS_SOURCE_PAGE_V1',consumerId:this.consumerId,checkpoint,rows};return deepFreeze({...body,pageDigest:hash(json(body))});
 }
 commitPage(page,apply){
  requireThat(typeof apply==='function','SOURCE_DURABLE_CONSUMER_REQUIRED');
  requireThat(exactKeys(page,['schema','consumerId','checkpoint','rows','pageDigest'])&&page.schema==='AUTONOMOUS_SOURCE_PAGE_V1'&&page.consumerId===this.consumerId&&Array.isArray(page.rows)&&page.rows.length>0&&page.rows.length<=this.pageSize,'SOURCE_PAGE_CONTRACT');
  const {pageDigest,...body}=page;requireThat(hash(json(body))===pageDigest,'SOURCE_PAGE_CHANGED');
  return this.store.atomic(()=>{
   const current=this.checkpoint();requireThat(json(current)===json(page.checkpoint),'SOURCE_CURSOR_CONCURRENT_CHANGE');
   const lastSeq=page.rows.at(-1)?.seq;requireThat(uint(lastSeq)&&lastSeq>current.lastSeq,'SOURCE_PAGE_RANGE');
   const actual=this.store.db.prepare("SELECT seq,id,data FROM events WHERE type='SOURCE' AND seq>? AND seq<=? ORDER BY seq LIMIT ?").all(current.lastSeq,lastSeq,this.pageSize+1).map(row=>({seq:row.seq,id:row.id,source:JSON.parse(row.data)}));
   requireThat(json(actual)===json(page.rows),'SOURCE_PAGE_CHANGED');
   for(const row of page.rows){const result=apply(row,this.store);requireThat(!result||typeof result.then!=='function','SOURCE_CONSUMER_MUST_BE_SYNCHRONOUS');}
   const next={...current,lastSeq};this.store.set(this.key,next);return deepFreeze(next);
  });
 }
}
