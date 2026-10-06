// One separately authorized execution calibration. No leader event is invented,
// no Research polling is resumed, and its receipt is not a follower-alpha sample.
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {AutonomousProtocolSchema,protocolDigest,DeliveryPolicySchema} from '../live/protocol.ts';
import {USDC_MINT} from '../domain/assets.ts';
import {PROGRAM_IDS} from '../decoder/program-registry.ts';
import {AutonomousFollowerRuntime} from './follower-runtime.ts';
import {inspectAutonomousRuntime} from './journal-runtime.ts';
import {createSealedRealtimeObserver} from './observer.mjs';
import {createReadonlyFactsProvider} from './facts-provider.mjs';
import {validateServiceFacts} from './service.mjs';
import {StageCapitalControls} from './capital-controls.ts';
import {createExecutionNetwork} from './execution-network.ts';
import {UnixPolicySignerClient} from './policy-signer.ts';
import {sha256,verifyOperatorAuthorization,verifyRelease} from './release.mjs';
import {assertSubmissionBoundary,authorizedStartupDisposition} from './configured-service.mjs';

const need=(v,code)=>{if(!v)throw Error(code)};
const publicResult=r=>({schema:'EXECUTION_FUNCTION_TEST_STATUS_V1',state:r.state,strategySample:false,
 ...(r.reason?{reason:r.reason}:{}),
 ...(r.outcome?{outcome:{schema:r.outcome.schema,executionPurpose:r.outcome.executionPurpose,strategySample:false,
  positionRaw:r.outcome.positionRaw,roundtripCompleted:r.outcome.roundtripCompleted,walletNetCashflowLamports:r.outcome.walletNetCashflowLamports,
  networkFeeLamports:r.outcome.networkFeeLamports,recoverableRentDeltaLamports:r.outcome.recoverableRentDeltaLamports,
  tradingPnlExcludingRent:r.outcome.tradingPnlExcludingRent,unknownCosts:r.outcome.unknownCosts,
  signatures:r.outcome.settlements.map(x=>({side:x.side,signature:x.signature}))}}:{})});
export function validateFunctionTestConfig(config){
 if(config.deliveryPolicy)DeliveryPolicySchema.parse(config.deliveryPolicy);
 const p=config.policy;
 need(config.executionPurpose==='EXECUTION_FUNCTION_TEST'&&config.executionBuildProvider?.id==='JUPITER_V1_FULL_SWAP_SELF_RPC_V1'&&
  config.functionTest?.tokenMint===USDC_MINT&&config.functionTest?.tokenDecimals===6&&config.functionTest?.exit==='IMMEDIATELY_AFTER_FINALIZED_BUY'&&
  config.functionTest?.strategySample===false&&p.executionScope==='CLASSIC_SOL_DYNAMIC_JUPITER_V1_RAYDIUM_CLMM'&&
  p.maxConcurrentPositions===1&&p.maxClosedOutcomes===1&&p.maxSellAttempts===1&&p.buyLamports==='10000000'&&p.walletCapLamports==='20000000'&&
  p.networkFeeCapLamports==='100000'&&p.totalFeeBudgetLamports==='200000'&&p.accountRentCapLamports==='3000000'&&p.exitReserveLamports==='5000000'&&
  p.maxSlippageBps===50&&p.maxPlatformFeeBps===0&&p.maxPriceImpactPct==='1.25'&&p.maxReviewAgeMs===60000,
  'FUNCTION_TEST_CONFIG_SCOPE');
 return config;
}

/** A locally authorized functional intent, not a synthetic SOURCE/FOLLOW. The
 * same 60s quote/first-submit clock remains owned by QuoteFinality/Executor. */
export function protocolForFunctionTest({config,authorization,nowMs=Date.now()}){
 validateFunctionTestConfig(config);
 const p=config.policy,entryUntilMs=Math.min(authorization.entryUntilMs??authorization.expiresAtMs,nowMs+60000);
 need(nowMs>=authorization.validFromMs&&nowMs<entryUntilMs&&authorization.expiresAtMs-nowMs>=p.exitGraceMs,'FUNCTION_TEST_AUTHORITY_WINDOW');
 const id='function-test:'+sha256(Buffer.from(authorization.authorizationDigest+':'+config.serviceId));
 const protocol=AutonomousProtocolSchema.parse({version:'AUTONOMOUS_SINGLE_POSITION_V1',executionPurpose:'EXECUTION_FUNCTION_TEST',
  experimentId:'autonomous-function-test-'+sha256(Buffer.from(id)).slice(0,24),approval:'FUNDS_AUTHORIZED',wallet:config.wallet,
  cluster:'mainnet-beta',quoteMint:'SOL_NATIVE',tokenMint:USDC_MINT,tokenProgram:PROGRAM_IDS.TOKEN,tokenDecimals:6,
  transport:'JUPITER_V1_SELF_RPC',signer:'AUTOMATED_POLICY_SIGNER_V1',executionScope:p.executionScope,sourceEventId:id,
  validFromMs:nowMs,entryUntilMs,exitUntilMs:authorization.expiresAtMs,fundingCapLamports:p.walletCapLamports,buyLamports:p.buyLamports,
  networkFeeCapLamports:p.networkFeeCapLamports,totalFeeBudgetLamports:p.totalFeeBudgetLamports,accountRentCapLamports:p.accountRentCapLamports,
  exitReserveLamports:p.exitReserveLamports,maxSlippageBps:p.maxSlippageBps,maxPlatformFeeBps:p.maxPlatformFeeBps,maxPriceImpactPct:p.maxPriceImpactPct,
  maxSellAttempts:1,maxReviewAgeMs:p.maxReviewAgeMs,operator:'EXPLICIT_EXECUTION_FUNCTION_TEST_AUTHORIZATION:'+authorization.authorizationDigest,
  takeoverInstructions:'Preserve responsibility; reconcile UNKNOWN; no replacement signature; full finalized position only.',candidateDigest:authorization.candidateDigest,
  ...(config.deliveryPolicy?{deliveryPolicy:DeliveryPolicySchema.parse(config.deliveryPolicy)}:{})});
 const decision={id,decision:'EXECUTION_FUNCTION_TEST',executionPurpose:'EXECUTION_FUNCTION_TEST',strategySample:false,sourceId:id,
  source:{wallet:config.wallet,token:USDC_MINT,event_time_ms:nowMs,provenance:'OPERATOR_EXECUTION_FUNCTION_TEST_NOT_LEADER'},
  sourceExpiresAtMs:entryUntilMs,minimumOutputRaw:'0',inputRaw:p.buyLamports,followerWallet:config.wallet};
 return{protocol,decision};
}

/** DI seam for exact formal-entry acceptance without network, private key or
 * production authorization. All lifecycle transitions remain existing owners. */
export function createExecutionFunctionTestLifecycle(dependencies){
 return new AutonomousFollowerRuntime({...dependencies,executionPurpose:'EXECUTION_FUNCTION_TEST',leaderSold:()=>false,exitAfterMs:1});
}

/** Called only after configured-service has verified exact release/config/
 * authorization/policy and real OS isolation. The observer is used solely as the
 * existing shared Provider request ledger/pacing owner: never start or step it. */
export async function runFunctionTestComposition({root,config,configPath,authorizationFile,authorization,providerOptions,universe,owners,bindings,opening,quotaReference,fx,absolute}){
 validateFunctionTestConfig(config);
 const {stage,runtime}=bindings,stateDir=absolute(config.stateDirectory),clock=owners.systemClock;
 const identity={wallet:config.wallet,releaseDigest:authorization.candidateDigest,policyDigest:authorization.policyDigest};
 const capital=new StageCapitalControls({store:stage,sourceStageWallet:config.sourceStageWallet,claimDirectory:absolute(config.claimDirectory),
  identity:{...identity,authorizationDigest:authorization.authorizationDigest},experiment:{maxClosedOutcomes:1,maxRealizedLossMicroCny:Number.MAX_SAFE_INTEGER}});
 let requestOwner,facts,lifecycle;
 const now=()=>clock.nowMs();
 const authorizationCurrent=()=>verifyOperatorAuthorization({root,config,configFile:configPath,authorizationFile:absolute(authorizationFile)});
 const checkedFacts=(forExit=false)=>validateServiceFacts(facts.current(),{nowMs:now(),wallet:config.wallet,forExit});
 try{
  requestOwner=await createSealedRealtimeObserver({directory:path.join(stateDir,'requests'),config:{...config.resources,serviceId:config.serviceId,followerWallet:config.wallet,
   walletUniverse:universe,ticketRaw:config.policy.buyLamports,token2022MetadataOnly:false,executionReserve:{rpc:0,quote:0}},providerOptions,clock,
   actualRiskContext:()=>{throw Error('FUNCTION_TEST_RESEARCH_FORBIDDEN')},admission:()=>{throw Error('FUNCTION_TEST_RESEARCH_FORBIDDEN')},hasObligation:()=>Boolean(runtime.recoverActive())});
  requestOwner.store.event('EXECUTION_FUNCTION_TEST_SCOPE',{strategySample:false,researchPolling:false,buildProvider:config.executionBuildProvider.id,
   authorizationDigest:authorization.authorizationDigest,policyDigest:authorization.policyDigest});
  facts=createReadonlyFactsProvider({directory:path.join(stateDir,'facts'),store:requestOwner.store,accountProvider:requestOwner.accountProvider,providerOptions,
   runtimeDirectory:stateDir,identity,openingReference:opening,quotaReference,fxReference:fx,clock,refreshIntervalMs:config.facts.refreshIntervalMs,
   freshnessMs:config.facts.freshnessMs,beforeRead:options=>requestOwner.assertResearchBudget('RPC',options)});
  const network=(protocol,journal)=>{
   const subject=journal.status().attempts.find(a=>a.state==='SIGNED'||protocol.deliveryPolicy&&a.state==='UNKNOWN');
   const submissionDeadlineMs=subject?Math.min(subject.data.quoteExpiresAtMs,subject.data.reviewedAtMs+protocol.maxReviewAgeMs,
    subject.side==='BUY'?protocol.entryUntilMs:protocol.exitUntilMs):undefined;
   return createExecutionNetwork({protocol,journal,rpcUrl:providerOptions.rpcUrl,apiKey:providerOptions.quoteKey,evidenceDirectory:path.join(stateDir,'execution-requests'),
    fundsAuthorized:true,buildProvider:config.executionBuildProvider,...(submissionDeadlineMs===undefined?{}:{submissionDeadlineMs}),
    beforeRequest:r=>requestOwner.reserveExternalRequest(r),beforeTransport:r=>requestOwner.awaitExternalTransport(r),afterRequest:r=>requestOwner.completeExternalRequest(r),
    assertBeforeSend:()=>{authorizationCurrent();capital.assertReserved(runtime.recoverActive().descriptor.episodeId);
     if(subject?.side==='BUY')need(!fs.existsSync(absolute(config.killFile)),'OPERATOR_KILL_ENTRY');assertSubmissionBoundary({protocol,journal,subject});}});
  };
  lifecycle=createExecutionFunctionTestLifecycle({runtime,capital,signer:new UnixPolicySignerClient(absolute(config.signer.socket),{uid:config.signer.uid,gid:config.signer.gid}),
   network,policyDigest:authorization.policyDigest,authorizationDigest:authorization.authorizationDigest,now,
   revalidate:async(phase,{side,protocol,decision,attempt})=>{
    authorizationCurrent();need(protocol.executionPurpose==='EXECUTION_FUNCTION_TEST'&&protocol.wallet===config.wallet&&protocol.tokenMint===USDC_MINT&&
     protocol.candidateDigest===authorization.candidateDigest&&protocol.sourceEventId===decision.sourceId&&decision.executionPurpose==='EXECUTION_FUNCTION_TEST','FUNCTION_TEST_IDENTITY');
    const f=checkedFacts(side==='SELL'),active=runtime.recoverActive();
    if(side==='BUY'){
     need(now()<decision.sourceExpiresAtMs&&!fs.existsSync(absolute(config.killFile)),'FUNCTION_TEST_ENTRY_EXPIRED_OR_STOPPED');
     if(phase==='BEFORE_PREPARE'){
      const c=capital.inspect();need(!active&&!c.active&&!c.actualReviewRequired&&!c.walletClaimPresent&&c.remainingAfterHeldMicroCny>0,'FUNCTION_TEST_EXISTING_RESPONSIBILITY');
      need(!f.wallet.unexpectedAssets&&!f.wallet.unexplainedActivity&&!f.accounting.unknownCosts.length&&f.provider.health==='HEALTHY','FUNCTION_TEST_FACTS_REQUIRE_REVIEW');
      const p=config.policy;need(BigInt(f.wallet.balanceLamports)>=BigInt(p.buyLamports)+BigInt(p.totalFeeBudgetLamports)+BigInt(p.accountRentCapLamports)+BigInt(p.exitReserveLamports),'FUNCTION_TEST_CAPITAL_HEADROOM');
     }else need(active?.descriptor.episodeId===decision.id&&active.status.positionRaw==='0'&&!active.status.takeover,'FUNCTION_TEST_BUY_RESPONSIBILITY');
    }else need(active?.descriptor.episodeId===decision.id&&BigInt(active.status.positionRaw)>0n&&!active.status.takeover,'FUNCTION_TEST_FINALIZED_POSITION_REQUIRED');
    if(phase!=='BEFORE_PREPARE')need(attempt?.side===side,'FUNCTION_TEST_ATTEMPT_BINDING');
    requestOwner.store.event('EXECUTION_FUNCTION_TEST_GATE',{phase,side,decisionId:decision.id,atMs:now(),protocolDigest:protocolDigest(protocol)});
   }});
  if(!runtime.recoverActive()){
   const disposition=authorizedStartupDisposition(inspectAutonomousRuntime(stateDir),capital.inspect(),1,Number.MAX_SAFE_INTEGER);
   if(disposition==='COMPLETE')return{state:'FUNCTION_TEST_ALREADY_COMPLETE',strategySample:false};
   await facts.refresh();
   // Include the existing Provider quiet/pacing wait BEFORE creating this local
   // intent clock. This is not a refreshed source or quote.
   while(now()<requestOwner.status().providerReadyAtMs){authorizationCurrent();await sleep(Math.min(1000,requestOwner.status().providerReadyAtMs-now()));}
   checkedFacts();runtime.resumeEntry('EXACT_EXECUTION_FUNCTION_TEST_AUTHORIZATION:'+authorization.authorizationDigest);
   const {protocol,decision}=protocolForFunctionTest({config,authorization,nowMs:now()}),f=checkedFacts();
   requestOwner.store.event('EXECUTION_FUNCTION_TEST_INTENT',{protocol,decision,strategySample:false});
   await lifecycle.acceptFunctionTest(decision,protocol,{cnyPerSolMicro:f.valuation.cnyPerSolMicro,valuationAtMs:f.valuation.observedAtMs,valuationExpiresAtMs:f.valuation.expiresAtMs});
  }
  const stop=new AbortController();process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
  while(!stop.signal.aborted){
   need(!verifyRelease(root,config.releaseManifest).mismatches.length,'AUTONOMOUS_RELEASE_CHANGED');
   const active=runtime.recoverActive();
   if(active&&BigInt(active.status.positionRaw)>0n&&!active.status.obligations.length&&facts.providerRefreshDue())await facts.refreshProviderForResponsibility();
   const result=await lifecycle.tick();
   console.log(JSON.stringify(publicResult(result)));
   if(['CLOSED','ATTENTION','SIGNED_UNSENT_RESPONSIBILITY','EXPORTED_RESPONSIBILITY'].includes(result.state))return publicResult(result);
   try{await sleep(1000,undefined,{signal:stop.signal})}catch{break;}
  }
  lifecycle.halt('OPERATOR_FUNCTION_TEST_STOPPED');return{state:'STOPPED',strategySample:false,responsibilityRetained:Boolean(runtime.recoverActive())};
 }catch(error){runtime.haltEntry(/^[A-Z0-9_:.-]+$/.test(error?.message??'')?error.message:'FUNCTION_TEST_ATTENTION');throw error;}
 finally{requestOwner?.close();}
}
