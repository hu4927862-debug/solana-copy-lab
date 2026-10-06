// Public operator entry. Merely importing this file creates no state and reads
// no credentials. The delivered example is disabled; this task creates no funds
// authorization. A reviewed, separately provisioned configuration is mandatory.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {verifyOperatorAuthorization,sha256,readJson,verifyRelease} from './release.mjs';
import {loadSealedResearchOwner,FixedFileWalletUniverseProvider} from './research-owner.mjs';
import {openLocalRuntimeBindings} from './stage-binding.mjs';
import {createAutonomousService} from './service.mjs';
import {createReadonlyFactsProvider} from './facts-provider.mjs';
import {inspectAutonomousRuntime} from './journal-runtime.ts';
import {StageCapitalControls} from './capital-controls.ts';
import {createExecutionNetwork} from './execution-network.ts';
import {PolicySigner,PolicySignatureArchive,UnixPolicySignerClient,servePolicySigner,loadProvisionedSignerKey} from './policy-signer.ts';
import {SignerPolicySchema,privateRegularFile} from './signer-policy.ts';
import {AutonomousProtocolSchema,AutonomousLinkedExitAuthoritySchema,assertLinkedExitProtocol,protocolDigest} from '../live/protocol.ts';
import {PROGRAM_IDS} from '../decoder/program-registry.ts';

const need=(v,c)=>{if(!v)throw Error(c)};
const safe=e=>/^[A-Z0-9_:.-]+$/.test(e?.message??'')?e.message:'AUTONOMOUS_RUNTIME_ATTENTION';
function pinned(root,ref){need(ref&&typeof ref.path==='string'&&/^[a-f0-9]{64}$/.test(ref.sha256),'OPERATOR_FACT_REFERENCE_REQUIRED');const file=path.resolve(root,ref.path),st=fs.lstatSync(file);need(st.isFile()&&!st.isSymbolicLink()&&fs.realpathSync(file)===file&&sha256(fs.readFileSync(file))===ref.sha256,'OPERATOR_FACT_REFERENCE_CHANGED');return{path:file,sha256:ref.sha256,value:readJson(file)}};

export function verifySignerEconomicBinding(policy,config){
 need(JSON.stringify(policy.deliveryPolicy)===JSON.stringify(config.deliveryPolicy),'SIGNER_CONFIG_DELIVERY_MISMATCH');
 const q=config.policy;
 for(const [a,b]of [['buyLamports','buyLamports'],['walletCapLamports','walletCapLamports'],['feePerAttemptLamports','networkFeeCapLamports'],['totalFeeLamports','totalFeeBudgetLamports'],['rentCapLamports','accountRentCapLamports'],['exitReserveLamports','exitReserveLamports'],['maxSlippageBps','maxSlippageBps'],['maxPriceImpactPct','maxPriceImpactPct']])need(policy[a]===q[b],'SIGNER_CONFIG_ECONOMIC_MISMATCH');
}

export function executionProviderPolicy(reference,now=Date.now(),scope="CLASSIC_SOL_DYNAMIC_JUPITER_V1_RAYDIUM_CLMM",buildProvider){
 const at=reference.observedAtMs??reference.atMs,end=reference.expiresAtMs??at+86400000;
 need(Number.isSafeInteger(at)&&Number.isSafeInteger(end)&&at<=now&&now<end,'PROVIDER_EXECUTION_REFERENCE_EXPIRED');
 const buildPath=buildProvider?.id==='JUPITER_V1_FULL_SWAP_SELF_RPC_V1'?'api.jup.ag/swap/v1/swap':'api.jup.ag/swap/v1/swap-instructions';
 need(reference.jupiter?.paid_overage===false&&reference.jupiterPermissions?.includes('api.jup.ag/swap/v1/quote')&&(scope==='CLASSIC_SOL_DYNAMIC_DIRECT_DAMM_V2'||reference.jupiterPermissions?.includes(buildPath))&&reference.rpcExecutionAllowed===true,'PROVIDER_EXECUTION_CAPABILITY_NOT_CONFIRMED');
 return reference.jupiter;
}

/** A new inheritance reference never edits an old measured receipt/digest.
 * Only the measured semantic owners may be inherited. The funded entry wiring
 * is separately sealed/tested; every future order is still reviewed/simulated. */
export function verifyFundedClassQualification({root,config,authorization}){
 const link=pinned(root,config.facts.executionConformanceReference).value;
 need(link.schema==='AUTONOMOUS_CLMM_QUALIFICATION_SUCCESSOR_REFERENCE_V1'&&link.candidateDigest===authorization.candidateDigest&&link.wallet===config.wallet&&
  link.executionScope===config.policy.executionScope&&link.executionBuildProvider===config.executionBuildProvider.id&&
  link.programAttestationReference===config.executionBuildProvider.clmmProgramAttestationReference,'FUNDED_CLASS_QUALIFICATION_BINDING');
 const parent=pinned(root,link.measuredReference).value;
 need(parent.schema==='CURRENT_JUPITER_SINGLE_CLMM_NONFUNDED_QUALIFICATION_REFERENCE_V1'&&parent.status==='EXECUTION_CLASS_NONFUNDED_QUALIFIED'&&parent.fundsAuthority===false&&
  parent.programAttestationReference===link.programAttestationReference&&parent.representatives?.length===2&&parent.representatives.every(r=>r.buyReview==='PASS'&&r.buySimulation==='PASS'&&r.fullSellReview==='PASS'&&r.signatures===0&&r.sends===0)&&
  Date.parse(parent.observedAt)<=Date.now()&&Date.now()-Date.parse(parent.observedAt)<=86400000,'FUNDED_CLASS_MEASURED_REFERENCE_REQUIRED');
 const measuredBase=path.dirname(path.resolve(root,link.measuredReference.path));
 const sourceIdentity=readJson(path.join(measuredBase,'CONFORMANCE-SOURCE-IDENTITY.json'));
 for(const file of ['src/live/cpi-semantic-evidence.ts','src/live/transaction-review.ts','src/live/program-attestation.ts','src/autonomous/jupiter-v1-build-provider.ts','src/autonomous/execution-build-provider.ts'])need(link.unchangedMeasuredOwners?.[file]===sourceIdentity.files[file],'FUNDED_CLASS_MEASURED_OWNER_REQUIRED');
 for(const [file,digest]of Object.entries(link.unchangedMeasuredOwners))need(sourceIdentity.files[file]===digest&&sha256(fs.readFileSync(path.resolve(root,file)))===digest,'FUNDED_CLASS_MEASURED_OWNER_CHANGED');
 for(const [file,digest]of Object.entries(parent.artifacts))need(sha256(fs.readFileSync(path.join(path.dirname(path.resolve(root,link.measuredReference.path)),file)))===digest,'FUNDED_CLASS_MEASURED_EVIDENCE_CHANGED');
 return link;
}

// Keep the entry refresh gate identical in the funded loop and offline time
// boundary acceptance. Existing liabilities do not require entry facts.
export async function refreshEntryFactsBeforeStep(facts, active){
 if(!active&&facts.refreshDue())await facts.refresh();
}

/** Restart of the SAME approved experiment may continue after a completed
 * episode. An operator or uncertainty halt is never cleared by restart. */
export function authorizedStartupDisposition(previous,capital,maxClosedOutcomes,maxRealizedLossMicroCny){
 need(!capital.active&&!capital.actualReviewRequired&&!capital.walletClaimPresent,'STARTUP_EXISTING_LIABILITY');
 if(previous.state!=='NOT_INITIALIZED'&&previous.entryHalt!=='NOT_ACTIVATED'&&previous.entryHalt!==null&&previous.entryHalt!=='CLOSED_OUTCOME_REVIEW_REQUIRED')
  throw Error('RUNTIME_ENTRY_HALTED_REVIEW_REQUIRED');
 need(Number.isSafeInteger(capital.experimentClosedOutcomes)&&Number.isSafeInteger(capital.experimentSubmittedBuys)&&Number.isSafeInteger(capital.experimentRealizedLossMicroCny),'STARTUP_EXPERIMENT_ACCOUNTING_REQUIRED');
 if(capital.experimentClosedOutcomes>=maxClosedOutcomes||capital.experimentSubmittedBuys>=maxClosedOutcomes||capital.experimentRealizedLossMicroCny>=maxRealizedLossMicroCny)return'COMPLETE';
 return'CONTINUE';
}

/** Shared Provider pacing can await after Executor's own last checks. Recheck
 * original intent and exact duty synchronously AFTER that wait, never a new TTL. */
export function assertSubmissionBoundary({protocol,journal,subject,nowMs=Date.now()}){
 const status=journal.status(),a=status.attempts.find(x=>x.id===subject?.id);
 const rawExit=journal.exitAuthority?.(),linked=rawExit?.version==='AUTONOMOUS_LINKED_EXIT_ONLY_V1'?AutonomousLinkedExitAuthoritySchema.parse(rawExit):null;
 if(linked){assertLinkedExitProtocol(protocol,linked);need(linked.approval==='FUNDS_AUTHORIZED'&&a?.side==='SELL'&&a.id===linked.attemptId&&a.amount===linked.remainingRaw&&a.data.submissionCount===1&&nowMs>=linked.validFromMs,'SEND_LINKED_EXIT_BINDING');}
 need(subject&&a&&a.state==='UNKNOWN'&&!status.takeover&&status.protocolDigest===protocolDigest(protocol)&&
  a.side===subject.side&&a.amount===subject.amount&&a.data.signedTransaction===subject.data.signedTransaction&&a.data.signature===subject.data.signature&&a.data.messageDigest===subject.data.messageDigest,'SEND_EXACT_RESPONSIBILITY_CHANGED');
 need(Number.isSafeInteger(a.data.quoteExpiresAtMs)&&Number.isSafeInteger(a.data.reviewedAtMs)&&nowMs<a.data.quoteExpiresAtMs&&nowMs<a.data.reviewedAtMs+protocol.maxReviewAgeMs&&nowMs<(a.side==='BUY'?protocol.entryUntilMs:(linked?.exitUntilMs??protocol.exitUntilMs)),'SEND_ORIGINAL_INTENT_EXPIRED');
 if(a.side==='BUY')need(!status.entryStopped&&a.amount===protocol.buyLamports,'SEND_ENTRY_STOPPED_OR_AMOUNT');
 else need(BigInt(status.positionRaw)>0n&&a.amount===status.positionRaw,'SEND_FULL_POSITION_CHANGED');
 return a;
}

/** Source-derived token selection, never a hand-filled BUY quote output. */
export function protocolForDecision({decision,facts,config,authorization,nowMs=Date.now()}){
 const token=decision.source.verified?.token;
 if(config.deliveryPolicy){
  need(config.executionPurpose===undefined,'FOLLOWER_PURPOSE_BINDING');
  need(decision.decision==='FOLLOW'&&decision.source.side==='BUY'&&decision.source.ownership?.accepted===true&&
   decision.sourceId===decision.source.id&&token?.mint===decision.source.token&&decision.source.verified?.quote?.mint==='SOL_NATIVE','FOLLOWER_SOURCE_EVIDENCE_BINDING');
 }
 const classic=token?.tokenProgram===PROGRAM_IDS.TOKEN||(!token?.tokenProgram&&decision.source.ownership?.accepted===true&&decision.source.ownership?.verifier==='RPC_JUPITER_ROUTE_V2_OWNER_NET_V2');
 need(classic,'EXECUTION_TOKEN_PROGRAM_UNQUALIFIED');
 const q=config.policy;
 if(q.executionScope==='CLASSIC_SOL_EXACT_JUPITER_V1_METEORA_DLMM')need(config.executionBuildProvider?.id==='JUPITER_V1_FULL_SWAP_SELF_RPC_V1'&&config.executionBuildProvider?.pools?.[decision.source.token],'EXECUTION_POOL_UNQUALIFIED');
 if(q.executionScope==='CLASSIC_SOL_DYNAMIC_DIRECT_DAMM_V2')need(config.executionBuildProvider?.id==='DIRECT_DAMM_V2_EXACT_IN_V1'&&config.executionBuildProvider?.pools?.[decision.source.token],'EXECUTION_POOL_UNQUALIFIED');
 const exitUntilMs=Math.min(authorization.expiresAtMs,facts.provider.quotaExpiresAtMs??facts.provider.expiresAtMs,nowMs+q.exitAfterMs+q.exitGraceMs);
 need(exitUntilMs>=nowMs+q.exitAfterMs+q.exitGraceMs,'EXIT_AUTHORITY_OR_PROVIDER_RESERVE_TOO_SHORT');
 return AutonomousProtocolSchema.parse({version:'AUTONOMOUS_SINGLE_POSITION_V1',experimentId:'autonomous-'+sha256(Buffer.from(decision.id)).slice(0,32),approval:'FUNDS_AUTHORIZED',wallet:config.wallet,
  cluster:'mainnet-beta',quoteMint:'SOL_NATIVE',tokenMint:decision.source.token,tokenProgram:PROGRAM_IDS.TOKEN,tokenDecimals:token.decimals,
  transport:q.executionScope==='CLASSIC_SOL_DYNAMIC_DIRECT_DAMM_V2'?'DIRECT_DAMM_V2_SELF_RPC':'JUPITER_V1_SELF_RPC',...(['CLASSIC_SOL_DYNAMIC_DIRECT_DAMM_V2','CLASSIC_SOL_EXACT_JUPITER_V1_METEORA_DLMM'].includes(q.executionScope)?{executionPool:config.executionBuildProvider?.pools?.[decision.source.token]}:{}),...(config.deliveryPolicy?{deliveryPolicy:config.deliveryPolicy}:{}),signer:'AUTOMATED_POLICY_SIGNER_V1',executionScope:q.executionScope,sourceEventId:decision.sourceId,
  validFromMs:nowMs,entryUntilMs:Math.min(decision.sourceExpiresAtMs,authorization.entryUntilMs??decision.sourceExpiresAtMs),exitUntilMs,fundingCapLamports:q.walletCapLamports,buyLamports:q.buyLamports,
  networkFeeCapLamports:q.networkFeeCapLamports,totalFeeBudgetLamports:q.totalFeeBudgetLamports,accountRentCapLamports:q.accountRentCapLamports,exitReserveLamports:q.exitReserveLamports,
  maxSlippageBps:q.maxSlippageBps,maxPlatformFeeBps:q.maxPlatformFeeBps,maxPriceImpactPct:q.maxPriceImpactPct,maxSellAttempts:q.maxSellAttempts,maxReviewAgeMs:q.maxReviewAgeMs,
  operator:'EXPLICIT_AUTONOMOUS_OPERATOR_AUTHORIZATION:'+authorization.authorizationDigest,takeoverInstructions:'Stop entry; preserve exact bytes and claim; reconcile UNKNOWN; no automatic rebroadcast/re-sign.',candidateDigest:authorization.candidateDigest});
}

/** Preserve a concrete domain refusal beside its original request evidence.
 * The existing candidate disposition owns cancellation/PASS; this decorator
 * does not catch transport, identity or responsibility failures. */
export function recordExecutionDomainRefusals(network,{protocol,record,now=Date.now}){
 const order=network.order.bind(network);
 network.order=async(...args)=>{
  try{return await order(...args)}catch(error){
   if(error?.code==='EXECUTION_UNQUALIFIED'&&error.message==='EXECUTION_POOL_UNQUALIFIED')
    record({sourceId:protocol.sourceEventId,protocolDigest:protocolDigest(protocol),mint:protocol.tokenMint,side:args[0],state:'EXECUTION_UNQUALIFIED',reason:error.reason,atMs:now()});
   throw error;
  }
 };
 return network;
}

export async function runConfiguredService({root,config,configPath,command,authorizationFile}){
 const absolute=p=>p?.startsWith('~/')?path.join(os.homedir(),p.slice(2)):path.resolve(root,p);
 if(command==='serve-signature-archive'){
  const r=verifyRelease(root,config.releaseManifest),p=SignerPolicySchema.parse(readJson(absolute(config.signer.policyFile)));
  need(!r.mismatches.length&&p.candidateDigest===r.candidateDigest&&p.policyDigest===sha256(fs.readFileSync(configPath))&&p.wallet===config.wallet,'SIGNATURE_ARCHIVE_IDENTITY');
  need(process.getuid?.()===config.signer.uid&&process.getgid?.()===config.signer.gid,'SIGNER_SERVICE_IDENTITY');
  const refs=readJson(absolute(config.signer.credentialReferenceFile)),archive=new PolicySignatureArchive(p,refs.stateDirectory);
  const server=await servePolicySigner(archive,absolute(config.signer.socket),config.signer.gid);
  console.log(JSON.stringify({state:'SIGNATURE_ARCHIVE_READ_ONLY',privateKeyLoaded:false,signApi:false,sendApi:false}));
  await new Promise(r=>{process.once('SIGTERM',r);process.once('SIGINT',r)});await new Promise(r=>server.close(r));archive.close();return;
 }
 // A stopped entry authority is not a ban on reading an existing liability.
 // This branch has no signer/build/send capability and never creates a new one.
 const prior=inspectAutonomousRuntime(absolute(config.stateDirectory));
 if(command==='run'&&prior.active){
  const {handleExistingResponsibility}=await import('./responsibility.mjs');
  const r=await handleExistingResponsibility({root,config,configPath,command:'reconcile'});
  if(r.state!=='OPEN_EXIT_ONLY'){console.log(JSON.stringify(r));return;}
 }
 need(config.mode==='AUTONOMOUS','CONFIG_DISABLED');need(authorizationFile,'AUTONOMOUS_OPERATOR_AUTHORIZATION_REQUIRED');
 if(config.executionPurpose==='EXECUTION_FUNCTION_TEST'){
  const {validateFunctionTestConfig}=await import('./function-test.mjs');validateFunctionTestConfig(config);
 }
 const authorization=verifyOperatorAuthorization({root,config,configFile:configPath,authorizationFile:absolute(authorizationFile)});
 need(config.wallet&&config.signer?.policyFile&&config.signer?.socket&&Number.isInteger(config.signer.uid)&&Number.isInteger(config.signer.gid),'AUTOMATED_SIGNER_NOT_PROVISIONED');
 need(config.policy.maxConcurrentPositions===1&&[1,3].includes(config.policy.maxClosedOutcomes)&&config.policy.maxSellAttempts===1&&
  (config.policy.maxClosedOutcomes===1||(Number.isSafeInteger(config.policy.maxExperimentLossMicroCny)&&config.policy.maxExperimentLossMicroCny>0)),
  'V1_BOUNDED_OUTCOME_SCOPE');
 const policy=SignerPolicySchema.parse(readJson(absolute(config.signer.policyFile)));
 need(policy.candidateDigest===authorization.candidateDigest&&policy.policyDigest===authorization.policyDigest&&policy.authorizationDigest===authorization.authorizationDigest&&policy.wallet===config.wallet&&policy.sourceStageWallet===config.sourceStageWallet&&policy.expiresAtMs===authorization.expiresAtMs&&policy.notBeforeMs===authorization.validFromMs,'SIGNER_OPERATOR_POLICY_BINDING');
 need(policy.journalRoot===path.join(absolute(config.stateDirectory),'episodes')&&policy.stageDatabase===path.join(absolute(config.stageDirectory),'collector.sqlite')&&policy.claimDirectory===absolute(config.claimDirectory)&&policy.killFile===absolute(config.killFile),'SIGNER_STATE_PATH_BINDING');
 verifySignerEconomicBinding(policy,config);
 if(command==='serve-signer'){
  need(process.getuid?.()===config.signer.uid&&process.getgid?.()===config.signer.gid,'SIGNER_SERVICE_IDENTITY');
  need(config.signer.credentialReferenceFile,'SIGNER_CREDENTIAL_REFERENCE_REQUIRED');const refs=readJson(absolute(config.signer.credentialReferenceFile));
  const key=loadProvisionedSignerKey({encryptedKeyPath:refs.encryptedKeyPath,passphrasePath:refs.passphrasePath,repositoryRoot:root});
  const signer=new PolicySigner(policy,key,refs.stateDirectory),server=await servePolicySigner(signer,absolute(config.signer.socket),config.signer.gid);
  console.log(JSON.stringify({state:'POLICY_SIGNER_LISTENING',wallet:policy.wallet,sendApi:false}));
  await new Promise(r=>{process.once('SIGTERM',r);process.once('SIGINT',r)});await new Promise(r=>server.close(r));signer.close();return;
 }
 need(command==='run'||command==='resume-unsigned-exit','AUTONOMOUS_COMMAND_SCOPE');
 if(command==='resume-unsigned-exit')need(prior.active,'EXISTING_OBLIGATION_REQUIRED');
 // Separate UID is required in the operator entry, not merely a second process
 // able to read the same credential files. Dedicated group shares only the socket.
 need(process.getuid?.()!==config.signer.uid&&process.getgroups?.().includes(config.signer.gid),'ISOLATED_SIGNER_UID_AND_SOCKET_GROUP_REQUIRED');
 const conformance=pinned(root,config.facts?.executionConformanceReference).value;
 const functionTest=config.executionPurpose==='EXECUTION_FUNCTION_TEST';
 if(config.eventFirst)verifyFundedClassQualification({root,config,authorization});
 else{
 need(conformance.schema===(functionTest?'EXECUTION_FUNCTION_TEST_UNSIGNED_CONFORMANCE_V1':'AUTONOMOUS_DYNAMIC_UNSIGNED_CONFORMANCE_V1')&&
  (!functionTest||(conformance.strategySample===false&&conformance.executionBuildProvider===config.executionBuildProvider.id&&conformance.tokenMint===config.functionTest.tokenMint))&&
  (!config.deliveryPolicy||JSON.stringify(conformance.deliveryPolicy)===JSON.stringify(config.deliveryPolicy))&&
  conformance.candidateDigest===authorization.candidateDigest&&conformance.wallet===config.wallet&&conformance.realUnsigned===true&&conformance.buyReview==='PASS'&&conformance.buySimulation==='PASS'&&conformance.fullSellReview==='PASS'&&conformance.signatures===0&&conformance.sendCalls===0&&Number.isSafeInteger(conformance.observedAtMs)&&Date.now()-conformance.observedAtMs<=86400000,'DYNAMIC_EXECUTION_CONFORMANCE_REQUIRED');
 }
 const opening=pinned(root,config.facts.openingReference),fx=pinned(root,config.facts.fxReference);
 const quotaFile=absolute(config.providers.quotaReferenceFile),quotaReference={path:quotaFile,sha256:sha256(fs.readFileSync(quotaFile))};
 const jupiter=executionProviderPolicy(readJson(quotaFile),Date.now(),config.policy.executionScope,config.executionBuildProvider);
 const refs=readJson(absolute(config.providers.referenceFile)),secret=privateRegularFile(absolute(config.providers.credentialFile),root);let credentials;
 try{credentials=JSON.parse(secret.toString('utf8'))}finally{secret.fill(0)}
 need(sha256(Buffer.from(credentials.ALPHA_HELIUS_RPC_URL??''))===refs.heliusRpcSha256&&sha256(Buffer.from(credentials.ALPHA_JUPITER_API_KEY??''))===refs.jupiterKeySha256,'PROVIDER_REFERENCE_CHANGED');
 const providerOptions={rpcUrl:credentials.ALPHA_HELIUS_RPC_URL,quoteKey:credentials.ALPHA_JUPITER_API_KEY,jupiter};credentials=null;
 const universe=new FixedFileWalletUniverseProvider({file:absolute(config.walletUniverse.file),sha256:config.walletUniverse.sha256}).snapshot({maxAgeMs:config.walletUniverse.maxAgeMs});
 const owners=await loadSealedResearchOwner(),clock=owners.systemClock,stateDir=absolute(config.stateDirectory);
 const identity={wallet:config.wallet,releaseDigest:authorization.candidateDigest,policyDigest:authorization.policyDigest};
 const previous=inspectAutonomousRuntime(stateDir);
 const bindings=openLocalRuntimeBindings({stageDirectory:absolute(config.stageDirectory),owners,stateDirectory:stateDir,identity});
 const {stage,runtime}=bindings;
 let service,facts,observationStarted=false;
 try{
  if(functionTest){
   const {runFunctionTestComposition}=await import('./function-test.mjs');
   const result=await runFunctionTestComposition({root,config,configPath,authorizationFile,authorization,providerOptions,universe,owners,bindings,opening,quotaReference,fx,absolute});
   console.log(JSON.stringify(result));return;
  }
  const capital=new StageCapitalControls({store:stage,sourceStageWallet:config.sourceStageWallet,claimDirectory:absolute(config.claimDirectory),identity:{...identity,authorizationDigest:authorization.authorizationDigest},
   experiment:{maxClosedOutcomes:config.policy.maxClosedOutcomes,maxRealizedLossMicroCny:config.policy.maxExperimentLossMicroCny??Number.MAX_SAFE_INTEGER}});
  const signer=new UnixPolicySignerClient(absolute(config.signer.socket),{uid:config.signer.uid,gid:config.signer.gid});
  const observerFactory=config.eventFirst?(await import('../../reports/smart-wallet-pilot-20260930/first-funded-event-first-pilot-20261002/funded-observer.mjs')).fundedEventFirstObserverFactory({root,operatorConfig:config,configFile:configPath,authorizationFile:absolute(authorizationFile),authorization,runtime}):undefined;
  service=await createAutonomousService({directory:path.join(stateDir,'research'),config:{observer:{...config.resources,serviceId:config.serviceId,followerWallet:config.wallet,walletUniverse:universe,ticketRaw:config.policy.buyLamports,token2022MetadataOnly:true},admission:config.admission,exitAfterMs:config.policy.exitAfterMs},providerOptions,runtime,capital,signer,
   ...(observerFactory?{observerFactory}:{}),
   networkFactory:(protocol,journal)=>{
    const subject=journal.status().attempts.find(a=>a.state==='SIGNED'||protocol.deliveryPolicy&&a.state==='UNKNOWN');
    const submissionDeadlineMs=subject?Math.min(subject.data.quoteExpiresAtMs,subject.data.reviewedAtMs+protocol.maxReviewAgeMs,subject.side==='BUY'?protocol.entryUntilMs:protocol.exitUntilMs):undefined;
    const network=createExecutionNetwork({protocol,journal,rpcUrl:providerOptions.rpcUrl,apiKey:providerOptions.quoteKey,evidenceDirectory:path.join(stateDir,'execution-requests'),fundsAuthorized:true,buildProvider:config.executionBuildProvider,...(submissionDeadlineMs===undefined?{}:{submissionDeadlineMs}),
     beforeRequest:record=>service.observer.reserveExternalRequest(record),beforeTransport:record=>service.observer.awaitExternalTransport(record),afterRequest:record=>service.observer.completeExternalRequest(record),
     assertBeforeSend:()=>{verifyOperatorAuthorization({root,config,configFile:configPath,authorizationFile:absolute(authorizationFile)});capital.assertReserved(runtime.recoverActive().descriptor.episodeId);if(subject?.side==='BUY')need(!fs.existsSync(absolute(config.killFile)),'OPERATOR_KILL_ENTRY');assertSubmissionBoundary({protocol,journal,subject});}});
    return recordExecutionDomainRefusals(network,{protocol,record:e=>service.observer.store.event('AUTONOMOUS_EXECUTION_UNQUALIFIED',e)});
   },
   protocolFactory:(decision,f)=>protocolForDecision({decision,facts:f,config,authorization}),policy:{...identity,authorizationDigest:authorization.authorizationDigest,killFile:absolute(config.killFile),maxClosedOutcomes:config.policy.maxClosedOutcomes,feeBudgetLamports:config.policy.totalFeeBudgetLamports,rentCapLamports:config.policy.accountRentCapLamports,
    maxRealizedLossMicroCny:config.policy.maxExperimentLossMicroCny??Number.MAX_SAFE_INTEGER},factsProvider:()=>facts.current(),clock});
  facts=createReadonlyFactsProvider({directory:path.join(stateDir,'facts'),store:service.observer.store,accountProvider:service.observer.accountProvider,providerOptions,runtimeDirectory:stateDir,identity,openingReference:opening,quotaReference,fxReference:fx,clock,refreshIntervalMs:config.facts.refreshIntervalMs,freshnessMs:config.facts.freshnessMs,beforeRead:options=>service.observer.assertResearchBudget('RPC',options),
   stageContext:{stageDatabase:path.join(absolute(config.stageDirectory),'collector.sqlite'),sourceStageWallet:config.sourceStageWallet,claimDirectory:absolute(config.claimDirectory)},
   onContextLag:async()=>{
    if(runtime.recoverActive()||!observationStarted)return;
    const result=await service.step({entryPaused:true});
    need(!['ATTENTION','CLOSED'].includes(result.state),'FACT_RECOVERY_OBSERVER_ATTENTION');
   }});
  if(command==='resume-unsigned-exit'){
   // Same canonical funded binding/network/decision gates, but no observer
   // start or entry loop. One explicit invocation, one bounded preparation.
   if(facts.providerRefreshDue())await facts.refreshProviderForResponsibility();
   verifyOperatorAuthorization({root,config,configFile:configPath,authorizationFile:absolute(authorizationFile)});
   await service.execution.resumeUnsignedExit();
   console.log(JSON.stringify(await service.execution.tick({allowNewExit:false})));return;
  }
  // No network is performed before all local authorization/binding/state checks.
  // A resumed liability reconciles first; it does not demand an unchanged old
  // wallet opening while a real transaction is settling.
  if(!runtime.recoverActive()){
   const disposition=authorizedStartupDisposition(previous,capital.inspect(),config.policy.maxClosedOutcomes,config.policy.maxExperimentLossMicroCny??Number.MAX_SAFE_INTEGER);
   if(disposition==='COMPLETE'){console.log(JSON.stringify({state:'AUTONOMOUS_EXPERIMENT_LIMIT_REACHED',wallet:config.wallet,candidateDigest:authorization.candidateDigest}));return;}
   await facts.refresh();runtime.resumeEntry('EXACT_OPERATOR_AUTHORIZATION:'+authorization.authorizationDigest);
  }
  service.start();observationStarted=true;const stop=new AbortController();process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
  console.log(JSON.stringify({state:'AUTONOMOUS_SERVICE_STARTED',wallet:config.wallet,candidateDigest:authorization.candidateDigest,policyDigest:authorization.policyDigest}));
  while(!stop.signal.aborted){
   const release=verifyRelease(root,config.releaseManifest);need(!release.mismatches.length,'AUTONOMOUS_RELEASE_CHANGED');
   const active=runtime.recoverActive();
   await refreshEntryFactsBeforeStep(facts,active);
   // Fresh facts and account-window drain occur BEFORE starting a new SELL
   // quote. UNKNOWN reads bypass both; no economic deadline is reset.
   if(active&&BigInt(active.status.positionRaw)>0n&&!active.status.obligations.length){
    if(facts.providerRefreshDue())await facts.refreshProviderForResponsibility();
    const wait=Math.max(0,service.observer.status().providerReadyAtMs-Date.now());
    if(wait){try{await sleep(Math.min(wait,1000),undefined,{signal:stop.signal})}catch{break;}continue;}
   }
   const result=await service.step();
   console.log(JSON.stringify({atMs:Date.now(),state:result.state??result.status?.state??'STEP',activeEpisode:runtime.recoverActive()?.descriptor.episodeId??null}));
   if(result.state==='CLOSED'||result.state==='ATTENTION'||runtime.recoverActive()?.status.closed)break;
   if(!runtime.recoverActive()&&inspectAutonomousRuntime(stateDir).entryHalt==='CLOSED_OUTCOME_REVIEW_REQUIRED')break;
   // refresh while OPEN is outside an execution step; finalized facts include
   // current Journal deltas. UNKNOWN proceeds through reconcile without it.
   const current=runtime.recoverActive();
   if(current&&current.status.positionRaw!=='0'&&current.status.obligations.length===0&&facts.providerRefreshDue())await facts.refreshProviderForResponsibility();
   try{await sleep(1000,undefined,{signal:stop.signal})}catch{break;}
  }
 }catch(error){runtime.haltEntry(safe(error));throw error;}
 finally{try{service?.close()}finally{bindings.close()}}
}
