// Existing-liability operator path. No current entry approval, fresh quote,
// signer, research polling or send capability is needed for reconciliation.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {verifyRelease,sha256,readJson} from './release.mjs';
import {loadSealedResearchOwner} from './research-owner.mjs';
import {openLocalRuntimeBindings} from './stage-binding.mjs';
import {inspectAutonomousRuntime} from './journal-runtime.ts';
import {StageCapitalControls} from './capital-controls.ts';
import {AutonomousFollowerRuntime} from './follower-runtime.ts';
import {createExecutionNetwork,recoverExpiredAutonomousAttempt} from './execution-network.ts';
import {privateRegularFile,SignerPolicySchema} from './signer-policy.ts';
import {UnixPolicySignerClient,PolicySigner,PolicySignatureArchive,servePolicySigner,loadProvisionedSignerKey} from './policy-signer.ts';
import {LiveExecutor} from '../live/executor.ts';
import {AutonomousProtocolSchema,AutonomousLinkedExitAuthoritySchema,assertLinkedExitProtocol,protocolDigest,digest} from '../live/protocol.ts';
import {JupiterRequestPacer} from '../network/jupiter-request-pacer.ts';
import {setTimeout as sleep} from 'node:timers/promises';

const need=(v,c)=>{if(!v)throw Error(c)};
// Finalized closure has deliberately released capital. Verify that terminal
// responsibility state rather than demanding the released reservation back.
export function assertReconciledResponsibility({result,journal,capital,runtime,episodeId,assertCurrent}){
 assertCurrent();const s=journal.status();
 if(result.state==='CLOSED'){
  const c=capital.inspect();
  need(s.closed&&s.roundtripCompleted&&s.positionRaw==='0'&&!s.obligations.length&&!s.takeover&&
   !runtime.recoverActive()&&!c.active&&!c.actualReviewRequired&&!c.walletClaimPresent,'CLOSED_RESPONSIBILITY_REMAINS');
 }else capital.assertReserved(episodeId);
 return s;
}
/** Narrow cross-release read-only recovery. The old identity is verified against
 * its retained complete closure; the new owner is independently sealed and
 * explicitly scoped to that parent. Neither check authorizes new execution. */
export function verifyResponsibilityRelease({root,config,command,kind,recoveryReleaseManifest,parentClosureRoot}){
 if(!recoveryReleaseManifest&&!parentClosureRoot)return verifyRelease(root,config.releaseManifest);
 need(command==='recover-expired'&&kind==='SUBMITTED'&&recoveryReleaseManifest&&parentClosureRoot,'RECOVERY_ONLY_CROSS_RELEASE_SCOPE');
 const successor=verifyRelease(root,recoveryReleaseManifest),m=readJson(path.resolve(root,recoveryReleaseManifest));
 need(!successor.mismatches.length&&successor.qualification==='OFFLINE_INTEGRATION_QUALIFIED'&&m.fundedAuthorization===false,'RECOVERY_SUCCESSOR_NOT_QUALIFIED');
 const parent=verifyRelease(path.resolve(root,parentClosureRoot),config.releaseManifest);
 need(!parent.mismatches.length&&m.responsibilityRecovery?.parentReleaseDigest===parent.candidateDigest&&
  m.responsibilityRecovery?.kind==='SUBMITTED'&&m.responsibilityRecovery?.newExecutionAllowed===false,'RECOVERY_PARENT_IDENTITY');
 return {...parent,recoveryOwnerDigest:successor.candidateDigest};
}
export async function handleExistingResponsibility({root,config,configPath,command,attemptId,kind,recoveryReleaseManifest,parentClosureRoot}){
 const absolute=p=>p?.startsWith('~/')?path.join(os.homedir(),p.slice(2)):path.resolve(root,p);
 const release=verifyResponsibilityRelease({root,config,command,kind,recoveryReleaseManifest,parentClosureRoot});need(!release.mismatches.length,'AUTONOMOUS_RELEASE_CHANGED');
 const directory=absolute(config.stateDirectory),before=inspectAutonomousRuntime(directory);
 need(before.state!=='NOT_INITIALIZED'&&before.identity?.wallet===config.wallet&&before.identity.releaseDigest===release.candidateDigest&&before.identity.policyDigest===sha256(fs.readFileSync(configPath)),'EXISTING_RUNTIME_IDENTITY_REQUIRED');
 const owners=await loadSealedResearchOwner();
 const bindings=openLocalRuntimeBindings({stageDirectory:absolute(config.stageDirectory),owners,stateDirectory:directory,identity:before.identity});
 const {stage,runtime}=bindings;
 try{
  const active=runtime.recoverActive();need(active,'EXISTING_OBLIGATION_REQUIRED');
  const episodeFile=path.join(path.dirname(active.journalPath),'episode.json');
  const p=AutonomousProtocolSchema.parse(readJson(episodeFile).protocol);
  need(p.executionPurpose===config.executionPurpose,'EXISTING_EXECUTION_PURPOSE_BINDING');
  need(protocolDigest(p)===active.descriptor.protocolDigest&&p.candidateDigest===release.candidateDigest&&p.wallet===config.wallet,'EXISTING_PROTOCOL_BINDING');
  const b=stage.get('autonomousCapital:v1'),reservation=b?.active??b?.outcomes?.[active.descriptor.episodeId]?.reservation;
  if(command==='close-unprepared'){
   // No external request. For a claim made before capital.reserve, the exact
   // prior authorization identity is still retained in the episode protocol.
   const digest=p.operator.split(':').at(-1);need(/^[a-f0-9]{64}$/.test(digest??''),'EXISTING_AUTHORIZATION_BINDING');
   const capital=new StageCapitalControls({store:stage,sourceStageWallet:config.sourceStageWallet,claimDirectory:absolute(config.claimDirectory),identity:{...before.identity,authorizationDigest:digest}});
   const result=runtime.closeUnpreparedEpisode(active.descriptor,capital);
   return{state:'ABANDONED_UNPREPARED',receipt:result,signatures:0,sends:0,newExecution:false};
  }
  need(reservation&&reservation.protocolDigest===protocolDigest(p)&&reservation.journalPath===active.journalPath&&reservation.identity.wallet===config.wallet&&reservation.identity.releaseDigest===release.candidateDigest&&reservation.identity.policyDigest===before.identity.policyDigest,'EXISTING_CAPITAL_BINDING');
  const capital=new StageCapitalControls({store:stage,sourceStageWallet:config.sourceStageWallet,claimDirectory:absolute(config.claimDirectory),identity:reservation.identity});
  const assertBinding=()=>{const current=verifyResponsibilityRelease({root,config,command,kind,recoveryReleaseManifest,parentClosureRoot});need(!current.mismatches.length&&current.candidateDigest===release.candidateDigest&&current.recoveryOwnerDigest===release.recoveryOwnerDigest,'AUTONOMOUS_RELEASE_CHANGED');capital.assertReserved(active.descriptor.episodeId);};
  const signer=new UnixPolicySignerClient(absolute(config.signer.socket),{uid:config.signer.uid,gid:config.signer.gid});
  const bytes=privateRegularFile(absolute(config.providers.credentialFile),root);let credentials;try{credentials=JSON.parse(bytes.toString('utf8'))}finally{bytes.fill(0)}
  const refs=readJson(absolute(config.providers.referenceFile)),rpcUrl=credentials.ALPHA_HELIUS_RPC_URL;credentials=null;
  need(sha256(Buffer.from(rpcUrl??''))===refs.heliusRpcSha256,'PROVIDER_REFERENCE_CHANGED');
  const network=()=>createExecutionNetwork({protocol:p,journal:active.journal,rpcUrl,evidenceDirectory:path.join(directory,'reconcile-requests'),operation:'RECONCILE',fundsAuthorized:false,buildProvider:config.executionBuildProvider});
  // A signer crash/lost response may leave REVIEWED in the Journal although
  // bytes already exist privately. Recover those bytes before classification.
  for(const a of active.journal.status().attempts){
   if(a.state==='REVIEWED'&&a.data.signingRequestIssued){
    const saved=await signer.recover(protocolDigest(p),a.id);
    if(saved)await new LiveExecutor(active.journal,p,network()).importSignature(a.id,saved.signedTransaction);
   }
  }
  if(command==='cancel-unexported'){
   need(attemptId,'EXACT_RECOVERY_SUBJECT_REQUIRED');
  }else if(command==='recover-expired'){
   need(attemptId&&['UNSIGNED','SIGNED_UNSENT','SUBMITTED'].includes(kind),'EXACT_RECOVERY_SUBJECT_REQUIRED');
   await recoverExpiredAutonomousAttempt({protocol:p,journal:active.journal,attemptId,kind,rpcUrl,evidenceDirectory:path.join(directory,'recovery'),assertCurrentBinding:assertBinding});
  }else need(command==='reconcile','RESPONSIBILITY_COMMAND_INVALID');
  const execution=new AutonomousFollowerRuntime({runtime,capital,policyDigest:before.identity.policyDigest,authorizationDigest:reservation.identity.authorizationDigest,
   ...(config.executionPurpose?{executionPurpose:config.executionPurpose}:{}),
   signer:{sign:async()=>{throw Error('RESPONSIBILITY_SIGN_FORBIDDEN')},recover:(p,a)=>signer.recover(p,a)},
   network:(protocol,journal)=>createExecutionNetwork({protocol,journal,rpcUrl,evidenceDirectory:path.join(directory,'reconcile-requests'),operation:'RECONCILE',fundsAuthorized:false,buildProvider:config.executionBuildProvider}),
   revalidate:async()=>{throw Error('RESPONSIBILITY_NEW_EXECUTION_FORBIDDEN')},leaderSold:()=>false,exitAfterMs:config.policy.exitAfterMs});
  let result;
  if(command==='cancel-unexported'&&active.journal.get(attemptId)?.side==='BUY'){
   result=await execution.cancelUnexported(attemptId,'OPERATOR_CANCEL_UNEXPORTED_V1');
  }else{
   // Existing operator SELL cancellation keeps the real position/claim and
   // exit-only responsibility. Automatic failed-prepare cleanup is BUY/zero only.
   if(command==='cancel-unexported')new LiveExecutor(active.journal,p,network()).cancelUnsigned(attemptId,'OPERATOR_CANCEL_UNEXPORTED_V1');
   result=await execution.tick({allowNewExit:false});
  }
  return{state:result.state,positionRaw:runtime.recoverActive()?.status.positionRaw??'0',remainingObligations:runtime.recoverActive()?.status.obligations.length??0,newExecution:false,signatures:0,sends:0};
 }finally{bindings.close();}
}

/** Existing release format and parent identity, with only the explicitly saved
 * changed source pins superseded. No entry authorization/config is rebound. */
export function verifyLinkedExitFiles({root,config,configPath,authorityFile,policyFile,nowMs=Date.now(),readOnly=false}){
 const absolute=p=>p?.startsWith('~/')?path.join(os.homedir(),p.slice(2)):path.resolve(root,p);
 const authority=AutonomousLinkedExitAuthoritySchema.parse(readJson(absolute(authorityFile)));
 const policy=SignerPolicySchema.parse(readJson(absolute(policyFile)));
 const release=verifyRelease(root,authority.recoveryReleaseManifest),manifest=readJson(absolute(authority.recoveryReleaseManifest));
 need(release.candidateDigest===authority.recoveryReleaseDigest&&!release.mismatches.length&&release.qualification==='OFFLINE_INTEGRATION_QUALIFIED','LINKED_EXIT_RELEASE_NOT_QUALIFIED');
 const parentRaw=fs.readFileSync(absolute(config.releaseManifest)),parent=JSON.parse(parentRaw),link=manifest.linkedExitRecovery;
 need(sha256(parentRaw)===authority.parentReleaseDigest&&link?.parentReleaseDigest===authority.parentReleaseDigest&&
  link.parentProtocolDigest===authority.parentProtocolDigest&&link.episodeId===authority.episodeId&&link.entryAllowed===false,'LINKED_EXIT_PARENT_RELEASE');
 for(const [file,hash]of Object.entries(parent.files)){
  const saved=link.retainedParentSources?.[file];
  need(saved?manifest.files[saved]===hash&&sha256(fs.readFileSync(absolute(saved)))===hash:manifest.files[file]===hash,'LINKED_EXIT_PARENT_PIN_NOT_PRESERVED');
 }
 need(sha256(fs.readFileSync(configPath))===authority.parentConfigDigest&&config.wallet===authority.wallet,'LINKED_EXIT_CONFIG_CHANGED');
 const parentPolicyRaw=fs.readFileSync(absolute(config.signer.policyFile)),parentPolicy=SignerPolicySchema.parse(JSON.parse(parentPolicyRaw));
 const {linkedExitAuthority,...basePolicy}=policy;
 need(sha256(parentPolicyRaw)===authority.parentSignerPolicyDigest&&JSON.stringify(basePolicy)===JSON.stringify(parentPolicy)&&
  JSON.stringify(linkedExitAuthority)===JSON.stringify(authority)&&policy.authorizationDigest===authority.parentAuthorizationDigest&&
  policy.candidateDigest===authority.parentReleaseDigest&&policy.policyDigest===authority.parentConfigDigest,'LINKED_EXIT_POLICY_BINDING');
 if(!readOnly){
  need(authority.approval==='FUNDS_AUTHORIZED','FUNDS_NOT_AUTHORIZED');
  for(const file of [absolute(authorityFile),absolute(policyFile)]){const st=fs.lstatSync(file);need(st.isFile()&&!st.isSymbolicLink()&&fs.realpathSync(file)===file&&(st.mode&0o077)===0,'LINKED_EXIT_AUTHORITY_FILE_PERMISSIONS');}
  need(nowMs>=authority.validFromMs&&nowMs<authority.exitUntilMs,'AUTHORIZATION_EXPIRED_OR_NOT_STARTED');
 }
 return{authority,policy,release,authorityDigest:digest(JSON.stringify(authority)),policyFileDigest:sha256(fs.readFileSync(absolute(policyFile)))};
}

/** Explicit exit-only CLI composition; no Research/observer/entry is created.
 * RECONCILE is send-disabled. RESUME executes one existing preparation attempt;
 * a transport failure returns to the operator, never an automatic retry loop. */
export async function handleLinkedExit({root,config,configPath,command,authorityFile,policyFile}){
 need(['reconcile-linked-exit','resume-linked-exit','serve-linked-exit-signer','serve-linked-exit-archive','inspect-linked-exit-archive'].includes(command),'LINKED_EXIT_COMMAND');
 const readOnly=['reconcile-linked-exit','serve-linked-exit-archive','inspect-linked-exit-archive'].includes(command);
 const args={root,config,configPath,authorityFile,policyFile,readOnly},checked=verifyLinkedExitFiles(args),{authority:a,policy}=checked;
 const absolute=p=>p?.startsWith('~/')?path.join(os.homedir(),p.slice(2)):path.resolve(root,p);
 const current=()=>{const c=verifyLinkedExitFiles(args);need(c.authorityDigest===checked.authorityDigest&&c.policyFileDigest===checked.policyFileDigest,'LINKED_EXIT_FILES_CHANGED');};
 const refs=readJson(absolute(config.signer.credentialReferenceFile));
 if(command==='serve-linked-exit-signer'||command==='serve-linked-exit-archive'||command==='inspect-linked-exit-archive'){
  need(process.getuid?.()===config.signer.uid&&process.getgid?.()===config.signer.gid,'SIGNER_SERVICE_IDENTITY');
  const parentPolicy=SignerPolicySchema.parse(readJson(absolute(config.signer.policyFile))),archive=new PolicySignatureArchive(parentPolicy,refs.stateDirectory);
  if(command==='serve-linked-exit-archive'){
   const server=await servePolicySigner(archive,absolute(config.signer.socket),config.signer.gid);
   console.log(JSON.stringify({state:'LINKED_EXIT_ARCHIVE_READ_ONLY',privateKeyLoaded:false,signApi:false,sendApi:false}));
   try{await new Promise(r=>{process.once('SIGTERM',r);process.once('SIGINT',r);});}finally{await new Promise(r=>server.close(r));archive.close();}return;
  }
  try{archive.assertNoSellSignature(a.parentProtocolDigest,a.buySignature);}finally{archive.close();}
  if(command==='inspect-linked-exit-archive')return{state:'LINKED_EXIT_ARCHIVE_NO_SELL',atMs:Date.now(),uid:process.getuid(),protocolDigest:a.parentProtocolDigest,buySignature:a.buySignature,sellSignature:null,privateKeyLoaded:false,networkRequests:0,signatures:0,sends:0};
  const key=loadProvisionedSignerKey({encryptedKeyPath:refs.encryptedKeyPath,passphrasePath:refs.passphrasePath,repositoryRoot:root});
  const signer=new PolicySigner(policy,key,refs.stateDirectory),server=await servePolicySigner(signer,absolute(config.signer.socket),config.signer.gid);
  console.log(JSON.stringify({state:'LINKED_EXIT_SIGNER_LISTENING',sendApi:false,entryAllowed:false,authorityDigest:checked.authorityDigest}));
  try{await new Promise(r=>{process.once('SIGTERM',r);process.once('SIGINT',r);});}finally{await new Promise(r=>server.close(r));signer.close();}return;
 }
 need(process.getuid?.()!==config.signer.uid&&process.getgroups?.().includes(config.signer.gid),'ISOLATED_SIGNER_UID_AND_SOCKET_GROUP_REQUIRED');
 const before=inspectAutonomousRuntime(absolute(config.stateDirectory));
 need(before.active?.episodeId===a.episodeId&&before.identity.releaseDigest===a.parentReleaseDigest&&before.identity.policyDigest===a.parentConfigDigest&&before.identity.wallet===a.wallet,'LINKED_EXIT_RUNTIME_BINDING');
 const owners=await loadSealedResearchOwner(),bindings=openLocalRuntimeBindings({stageDirectory:absolute(config.stageDirectory),owners,stateDirectory:absolute(config.stateDirectory),identity:before.identity});
 try{
  const {stage,runtime}=bindings,active=runtime.recoverActive(),bundle=readJson(path.join(path.dirname(active.journalPath),'episode.json'));
  const p=AutonomousProtocolSchema.parse(bundle.protocol);assertLinkedExitProtocol(p,a);
  need(active.descriptor.episodeId===a.episodeId&&active.descriptor.protocolDigest===a.parentProtocolDigest,'LINKED_EXIT_EPISODE_BINDING');
  const reservation=stage.get('autonomousCapital:v1')?.active;
  need(reservation?.identity.authorizationDigest===a.parentAuthorizationDigest,'LINKED_EXIT_CAPITAL_BINDING');
  const capital=new StageCapitalControls({store:stage,sourceStageWallet:config.sourceStageWallet,claimDirectory:absolute(config.claimDirectory),identity:reservation.identity});
  const assertBound=()=>{current();capital.assertReserved(a.episodeId);};assertBound();
  const bytes=privateRegularFile(absolute(config.providers.credentialFile),root);let credentials;try{credentials=JSON.parse(bytes.toString())}finally{bytes.fill(0);}
  const credentialRef=readJson(absolute(config.providers.referenceFile));
  need(sha256(Buffer.from(credentials.ALPHA_HELIUS_RPC_URL??''))===credentialRef.heliusRpcSha256&&sha256(Buffer.from(credentials.ALPHA_JUPITER_API_KEY??''))===credentialRef.jupiterKeySha256,'PROVIDER_REFERENCE_CHANGED');
  const {executionProviderPolicy,assertSubmissionBoundary}=await import('./configured-service.mjs');
  const providerCheck=()=>{
   const file=absolute(a.providerReference?.path??config.providers.quotaReferenceFile),raw=fs.readFileSync(file);
   if(a.providerReference)need(sha256(raw)===a.providerReference.sha256,'LINKED_EXIT_PROVIDER_REFERENCE_CHANGED');
   executionProviderPolicy(JSON.parse(raw),Date.now(),p.executionScope,config.executionBuildProvider);
  };
  if(!readOnly)providerCheck();
  const pacer=new JupiterRequestPacer(()=>Date.now());let releasePacer;
  const network=(protocol,journal)=>{
   const subject=journal.status().attempts.find(x=>x.id===a.attemptId&&x.state==='SIGNED');
   return createExecutionNetwork({protocol,journal,rpcUrl:credentials.ALPHA_HELIUS_RPC_URL,apiKey:credentials.ALPHA_JUPITER_API_KEY,
    evidenceDirectory:path.join(absolute(config.stateDirectory),'linked-exit-requests'),operation:readOnly?'RECONCILE':'EXECUTION',fundsAuthorized:!readOnly,buildProvider:config.executionBuildProvider,
    ...(subject?{submissionDeadlineMs:Math.min(Number(subject.data.quoteExpiresAtMs),Number(subject.data.reviewedAtMs)+p.maxReviewAgeMs,a.exitUntilMs)}:{}),
    beforeRequest:()=>{assertBound();if(!readOnly)providerCheck();},
    beforeTransport:async r=>{if(r.kind==='JUPITER'){await sleep(2000,undefined,{signal:r.signal});releasePacer=pacer.acquire();}assertBound();},
    afterRequest:r=>{if(r.kind==='JUPITER'){releasePacer?.();releasePacer=undefined;}},
    assertBeforeSend:()=>{assertBound();assertSubmissionBoundary({protocol,journal,subject});}});
  };
  const client=new UnixPolicySignerClient(absolute(config.signer.socket),{uid:config.signer.uid,gid:config.signer.gid});
  const follower=new AutonomousFollowerRuntime({runtime,capital,policyDigest:a.parentConfigDigest,authorizationDigest:a.parentAuthorizationDigest,
   signer:readOnly?{sign:async()=>{throw Error('RESPONSIBILITY_SIGN_FORBIDDEN')},recover:(p,id)=>client.recover(p,id)}:client,
   network,revalidate:async()=>{need(!readOnly,'RESPONSIBILITY_NEW_EXECUTION_FORBIDDEN');assertBound();},leaderSold:()=>false,exitAfterMs:config.policy.exitAfterMs});
  if(readOnly){
   // Refresh finalized wallet agreement even when BUY was already reconciled.
   const x=new LiveExecutor(active.journal,p,network(p,active.journal));
   const pendingSell=active.journal.attempts().some(x=>x.side==='SELL'&&(x.data.signature||x.data.signingRequestIssued||x.state==='UNKNOWN'));
   if(!pendingSell)await x.reconcile('BUY');
   const result=await follower.tick({allowNewExit:false}),s=assertReconciledResponsibility({result,journal:active.journal,capital,runtime,episodeId:a.episodeId,assertCurrent:current}),buy=active.journal.get('BUY');
   const balance=s.closed?s.attempts.filter(x=>x.data.balanceSnapshot).at(-1)?.data.balanceSnapshot:buy.data.balanceSnapshot;
   return{state:result.state,observedAt:new Date().toISOString(),protocolDigest:a.parentProtocolDigest,buySignature:buy.data.signature,buySettlementDigest:buy.data.settlement.chainEvidenceDigest,positionRaw:s.positionRaw,balanceSnapshot:balance,remainingObligations:s.obligations.length,unknown:s.attempts.some(x=>x.state==='UNKNOWN'),sellAttempts:s.attempts.filter(x=>x.side==='SELL').map(x=>({id:x.id,state:x.state,amount:x.amount,signature:x.data.signature??null,signingRequestIssued:!!x.data.signingRequestIssued,signatureNeverRequested:x.data.signatureNeverRequested,submissionCount:x.data.submissionCount??0})),claimsPreserved:!s.closed,newExecution:false,signatures:0,sends:0};
  }
  await follower.resumeLinkedExit(a);
  // Existing finalized accounting/claim closure, never a replacement SELL.
  return await follower.tick({allowNewExit:false});
 }finally{bindings.close();}
}
