import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
export function verifyRelease(root,file){
 const absolute=path.resolve(root,file),raw=fs.readFileSync(absolute),manifest=JSON.parse(raw);
 if(manifest.schema!=='AUTONOMOUS_SMART_WALLET_INTEGRATION_V1'||!manifest.files||!Object.keys(manifest.files).length)throw Error('AUTONOMOUS_RELEASE_SCHEMA');
 const mismatches=[];
 for(const [relative,hash]of Object.entries(manifest.files)){
  if(path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..')||!/^[a-f0-9]{64}$/.test(hash)){mismatches.push({path:relative,reason:'INVALID_MANIFEST_PATH'});continue;}
  const target=path.resolve(root,relative);
  try{const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||fs.realpathSync(target)!==target||sha256(fs.readFileSync(target))!==hash)mismatches.push({path:relative,reason:'CHANGED'});}
  catch{mismatches.push({path:relative,reason:'MISSING'});}
 }
 return{candidateDigest:sha256(raw),files:Object.keys(manifest.files).length,mismatches,qualification:manifest.qualification,fundedAuthorization:false};
}
export function verifyOperatorAuthorization({root,config,configFile,authorizationFile,nowMs=Date.now()}){
 const release=verifyRelease(root,config.releaseManifest);
 if(release.mismatches.length||release.qualification!=='OFFLINE_INTEGRATION_QUALIFIED')throw Error('AUTONOMOUS_RELEASE_NOT_QUALIFIED');
 const raw=fs.readFileSync(authorizationFile),a=JSON.parse(raw),stat=fs.lstatSync(authorizationFile);
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error('OPERATOR_AUTHORIZATION_FILE_PERMISSIONS');
 const configDigest=sha256(fs.readFileSync(configFile));
 if(config.eventFirst){
  const c=config.eventFirst,planRaw=fs.readFileSync(path.resolve(root,c.planFile)),p=JSON.parse(planRaw),s=a.eventFirstSource;
  if(config.mode!=='AUTONOMOUS'||p.schema!=='FUNDED_EVENT_FIRST_PILOT_PLAN_V1'||p.authority!=='EXPLICIT_OPERATOR_AUTHORIZATION_REQUIRED'||p.configSha256!==configDigest||
   c.sourceEligibilityMode!=='EVENT_FIRST_SEALED_SOURCE_V1'||c.acquisitionVersion!=='JUP6_GTFA_FULL_SUCCEEDED_LIMIT20_V1'||c.ticketRaw!=='10000000'||
   s?.mode!==c.sourceEligibilityMode||s.planSha256!==sha256(planRaw)||s.acquisitionVersion!==c.acquisitionVersion||s.researchReleaseSha256!==c.researchReleaseSha256||p.researchReleaseSha256!==c.researchReleaseSha256||
   !Number.isSafeInteger(a.entryUntilMs)||a.entryUntilMs<=a.validFromMs||a.entryUntilMs>=a.expiresAtMs)throw Error('EVENT_FIRST_FUNDED_AUTHORIZATION_BINDING');
 }
 const delivery=config.deliveryPolicy;
 const repeatDelivery=Boolean(delivery&&delivery.maxBroadcasts>1);
 if(delivery&&(a.executionPurpose!==config.executionPurpose||JSON.stringify(a.deliveryPolicy)!==JSON.stringify(delivery)||a.singleSendOnly!==!repeatDelivery||a.rebroadcastAllowed!==repeatDelivery||
  a.maxSameByteDeliveries!==delivery.maxBroadcasts))throw Error('DELIVERY_AUTHORIZATION_BINDING');
 if(config.executionPurpose==='EXECUTION_FUNCTION_TEST'&&(a.executionPurpose!=='EXECUTION_FUNCTION_TEST'||a.reviewScope?.strategySample!==false||
  a.reviewScope?.maxBuyAttempts!==1||a.reviewScope?.maxInitialFullSellAttempts!==1||a.reviewScope?.exit!=='IMMEDIATELY_AFTER_FINALIZED_BUY'||
  a.reviewScope?.buildProvider!==config.executionBuildProvider?.id))throw Error('FUNCTION_TEST_AUTHORIZATION_BINDING');
 if(a.schema!=='AUTONOMOUS_OPERATOR_AUTHORIZATION_V1'||a.approval!=='FUNDS_AUTHORIZED'||a.candidateDigest!==release.candidateDigest||a.configDigest!==configDigest||a.wallet!==config.wallet||a.sourceStageWallet!==config.sourceStageWallet||a.stageDirectory!==config.stageDirectory||a.singleSendOnly!==!repeatDelivery||a.rebroadcastAllowed!==repeatDelivery||a.maxClosedOutcomes!==config.policy.maxClosedOutcomes||
  (config.policy.maxClosedOutcomes===3&&(!Number.isSafeInteger(config.policy.maxExperimentLossMicroCny)||config.policy.maxExperimentLossMicroCny<=0||a.maxExperimentLossMicroCny!==config.policy.maxExperimentLossMicroCny||a.reviewScope?.maxRealizedLossMicroCny!==config.policy.maxExperimentLossMicroCny||a.reviewScope?.maxBuyAttempts!==3||a.reviewScope?.stopAfterFirstClosed!==false))||
  !Number.isSafeInteger(a.validFromMs)||!Number.isSafeInteger(a.expiresAtMs)||nowMs<a.validFromMs||nowMs>=a.expiresAtMs)throw Error('OPERATOR_AUTHORIZATION_BINDING_OR_TIME');
 return{...a,authorizationDigest:sha256(raw),policyDigest:configDigest};
}
