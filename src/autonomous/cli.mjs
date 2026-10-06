#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {verifyRelease,readJson,sha256} from './release.mjs';
import {inspectAutonomousRuntime} from './journal-runtime.ts';
import {loadSealedResearchOwner,FixedFileWalletUniverseProvider} from './research-owner.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const expand=p=>p?.startsWith('~/')?path.join(os.homedir(),p.slice(2)):path.resolve(root,p);
const safe=e=>/^[A-Z0-9_:.-]+$/.test(e?.message??'')?e.message:'AUTONOMOUS_LOCAL_CHECK_FAILED';
const configPath=expand(process.argv[3]??'config/autonomous/v1-proposed.json');
function stageState(config){
 const file=path.join(expand(config.stageDirectory),'collector.sqlite');if(!fs.existsSync(file))return{error:'EXISTING_STAGE_MISSING'};
 const db=new Database(file,{readonly:true,fileMustExist:true});try{db.pragma('query_only = ON');db.exec('BEGIN');const get=k=>{const r=db.prepare('SELECT v FROM kv WHERE k=?').get(k);return r?JSON.parse(r.v):null;};const s=get('humanFollow:v1'),b=get('autonomousCapital:v1');const result={source:file,readAt:new Date().toISOString(),wallet:s?.wallet,stageCapMicroCny:s?.scope?.stageMicroCny,spentMicroCny:s?.spentMicroCny,historicalRentHeldMicroCny:s?.carry?.rentHeldMicroCny,historicalUnknownReserveMicroCny:s?.carry?.unknownReserveMicroCny,obligation:s?.obligation??null,actualReviewRequired:s?.actualReviewRequired??null,autonomousReservation:b?.active??null,trades:(s?.trades??[]).map(t=>({id:t.id,state:t.state,positionRaw:t.positionRaw}))};db.exec('ROLLBACK');return result;}finally{db.close();}
}
async function check(config){
 const blockers=[],facts=[];let release=null,research=null;
 try{release=verifyRelease(root,config.releaseManifest);if(release.mismatches.length)blockers.push('RELEASE_FILE_MISMATCH');}catch(e){blockers.push(safe(e));}
 try{research=(await loadSealedResearchOwner()).readiness;}catch(e){blockers.push(safe(e));}
 if(config.mode!=='AUTONOMOUS')blockers.push('CONFIG_DISABLED');
 if(!config.wallet)blockers.push('AUTOMATED_SIGNER_WALLET_NOT_PROVISIONED');
 if(!config.signer?.socket||!Number.isInteger(config.signer.uid)||!Number.isInteger(config.signer.gid)||!config.signer.policyFile)blockers.push('ISOLATED_SIGNER_NOT_CONFIGURED');
 const stage=stageState(config);if(stage.error)blockers.push(stage.error);if(stage.obligation||stage.actualReviewRequired||stage.autonomousReservation)blockers.push('EXISTING_STAGE_RESPONSIBILITY_OR_REVIEW');
 const claimDir=expand(config.claimDirectory),claims=fs.existsSync(claimDir)?fs.readdirSync(claimDir).filter(x=>!x.startsWith('.')):[];if(claims.length)blockers.push('EXISTING_WALLET_CLAIM');
 let universe;try{const file=expand(config.walletUniverse.file);universe=new FixedFileWalletUniverseProvider({file,sha256:config.walletUniverse.sha256}).snapshot({maxAgeMs:config.walletUniverse.maxAgeMs});}catch(e){blockers.push(safe(e));}
 let credential;try{const file=expand(config.providers.credentialFile),stat=fs.lstatSync(file);credential={reference:config.providers.credentialFile,exists:true,mode:(stat.mode&0o777).toString(8),secretContentsRead:false};if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077))blockers.push('PROVIDER_CREDENTIAL_PERMISSIONS');}catch{credential={reference:config.providers.credentialFile,exists:false,secretContentsRead:false};blockers.push('PROVIDER_CREDENTIAL_MISSING');}
 try{const q=readJson(expand(config.providers.quotaReferenceFile));facts.push({reference:config.providers.quotaReferenceFile,observedAtMs:q.atMs,expiresAtMs:q.atMs+86400000,status:Date.now()<q.atMs+86400000?'SAVED_REFERENCE_NOT_LIVE_VERIFIED':'EXPIRED'});if(Date.now()>=q.atMs+86400000)blockers.push('PROVIDER_QUOTA_REFERENCE_EXPIRED');}catch{blockers.push('PROVIDER_QUOTA_REFERENCE_MISSING');}
 blockers.push('NO_AUTONOMOUS_OPERATOR_AUTHORIZATION','FRESH_SIGNER_WALLET_AND_VALUATION_FACTS_REQUIRED','DYNAMIC_EXECUTION_REAL_UNSIGNED_CONFORMANCE_NOT_OBSERVED');
 return{state:'NOT_ACTIVATED',readyForMoney:false,blockers:[...new Set(blockers)],release,research,universe:universe?{snapshotDigest:universe.snapshotDigest,wallets:universe.wallets.map(w=>w.address)}:null,stage,claims,credential,referenceFacts:facts,runtime:inspectAutonomousRuntime(expand(config.stateDirectory)),realRequests:0,signatures:0,sends:0};
}
async function main(){
 const command=process.argv[2]??'check',config=readJson(configPath);
 if(config.schema!=='AUTONOMOUS_SMART_WALLET_CONFIG_V1')throw Error('CONFIG_SCHEMA');
 if(['reconcile-linked-exit','resume-linked-exit','serve-linked-exit-signer','serve-linked-exit-archive','inspect-linked-exit-archive'].includes(command)){
  if(!process.argv[4]||!process.argv[5])throw Error('LINKED_EXIT_AUTHORITY_AND_POLICY_REQUIRED');
  const {handleLinkedExit}=await import('./responsibility.mjs');
  const result=await handleLinkedExit({root,config,configPath,command,authorityFile:expand(process.argv[4]),policyFile:expand(process.argv[5])});
  if(result)console.log(JSON.stringify(result));return;
 }
 if(command==='check'||command==='inspect'){console.log(JSON.stringify(await check(config),null,2));return;}
 // Execution command wiring is supplied by the maintained composition, never
 // by a historical window launcher or by an approval flag on this check command.
 if(command==='run'||command==='resume-unsigned-exit'||command==='serve-signer'||command==='serve-signature-archive'){
  const {runConfiguredService}=await import('./configured-service.mjs');
  await runConfiguredService({root,config,configPath,command,authorizationFile:process.argv[4]});return;
 }
 if(command==='reconcile'||command==='recover-expired'||command==='close-unprepared'||command==='cancel-unexported'){
  const {handleExistingResponsibility}=await import('./responsibility.mjs');
  if(command==='recover-expired'&&process.argv[6]!=='--apply')throw Error('EXPLICIT_CONDITIONAL_RECOVERY_REQUIRED');
  if(command==='close-unprepared'&&process.argv[4]!=='--apply')throw Error('EXPLICIT_UNPREPARED_CLOSE_REQUIRED');
  if(command==='cancel-unexported'&&process.argv[5]!=='--apply')throw Error('EXPLICIT_UNEXPORTED_CANCEL_REQUIRED');
  const extra=process.argv.slice(7);
  if(extra.length&&!(command==='recover-expired'&&process.argv[5]==='SUBMITTED'&&extra.length===4&&extra[0]==='--recovery-release'&&extra[2]==='--parent-closure'))throw Error('RECOVERY_ONLY_CROSS_RELEASE_SCOPE');
  console.log(JSON.stringify(await handleExistingResponsibility({root,config,configPath,command,attemptId:process.argv[4],kind:process.argv[5],
    ...(extra.length?{recoveryReleaseManifest:extra[1],parentClosureRoot:extra[3]}:{})})));return;
 }
 throw Error('UNKNOWN_AUTONOMOUS_COMMAND');
}
main().catch(e=>{console.error(JSON.stringify({state:'STOPPED',reason:safe(e),activation:'NO_AUTOMATIC_ACTIVATION'}));process.exitCode=1;});
