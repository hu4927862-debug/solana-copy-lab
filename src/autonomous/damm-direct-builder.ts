import {CpAmm,SwapMode,type PoolState} from '@meteora-ag/cp-amm-sdk';
import {Connection,PublicKey,TransactionMessage,VersionedTransaction,TransactionInstruction,ComputeBudgetProgram,SystemProgram} from '@solana/web3.js';
import BN from 'bn.js';
import {randomUUID} from 'node:crypto';
import {DAMM,DAMM_PD,CLOCK,dammAttestation,dammPda,validateDammPool,validateDammProgram} from '../live/damm-v2-evidence.js';
import {associatedAccount,ATA,decodeWire} from '../live/transaction-review.js';
import {WSOL_MINT} from '../domain/assets.js';
import {PROGRAM_IDS as P} from '../decoder/program-registry.js';
import {digest} from '../live/protocol.js';
import type {CpiSemanticEvidence} from '../live/cpi-semantic-evidence.js';
import type {ExecutionBuildProvider,ExecutionBuildContext} from './execution-build-provider.js';
const pk=(s:string)=>new PublicKey(s);
const need=(x:unknown,c:string)=>{if(!x)throw Error(c)};
/** Official pinned client encodes swap2; no SDK network is permitted. */
export class DirectDammV2Builder implements ExecutionBuildProvider {
 readonly id='DIRECT_DAMM_V2_EXACT_IN_V1';
 private readonly sdk=new CpAmm(new Connection('https://sdk-network-disabled.invalid',{fetch:async()=>{throw Error('DAMM_SDK_NETWORK_FORBIDDEN')}}));
 constructor(readonly poolAddress:string){pk(poolAddress);}
 async verifyProgramIdentity(slot:number,c:ExecutionBuildContext){
 const att=dammAttestation(),keys=[DAMM,DAMM_PD];
 const r=await c.rpc('getMultipleAccounts',[keys,{encoding:'base64',commitment:'finalized',minContextSlot:Math.max(slot,att.slot),dataSlice:{offset:0,length:45}}]);
 c.assertCurrent();return validateDammProgram({slot:r.context?.slot,keys,values:r.value},slot);
 }
 async build(side:'BUY'|'SELL',wallet:string,amount:string,slippageBps:number,c:ExecutionBuildContext){
 const att=dammAttestation();need(/^[1-9]\d*$/.test(amount)&&Number.isInteger(slippageBps)&&slippageBps>=0&&slippageBps<=50,'DAMM_INPUT_BOUND');
 const expiry=c.beginQuote(side); // before state fetch; never reset after waiting/building
 const r=await c.rpc('getMultipleAccounts',[[this.poolAddress,CLOCK],{encoding:'base64',commitment:'finalized',minContextSlot:att.slot}]);
 need(r.value?.length===2,'DAMM_STATE_MISSING');const decoded=await validateDammPool(this.poolAddress,r.value[0],c.asset.tokenMint);
 const pool=this.sdk._program.coder.accounts.decode<PoolState>('pool',Buffer.from(r.value[0].data[0],'base64'));
 const clock=Buffer.from(r.value[1]?.data?.[0]??'','base64');need(clock.length===40&&r.value[1].owner==='Sysvar1111111111111111111111111111111111111','DAMM_CLOCK');
 need(clock.readBigInt64LE(32)>=decoded.activationPoint,'DAMM_NOT_ACTIVE');
 const inputMint=side==='BUY'?WSOL_MINT:c.asset.tokenMint,outputMint=side==='BUY'?c.asset.tokenMint:WSOL_MINT;
 const q=this.sdk.getQuote2({inputTokenMint:pk(inputMint),slippage:slippageBps,currentPoint:new BN(clock.readBigInt64LE(32).toString()),poolState:pool,
 tokenADecimal:decoded.mintA===WSOL_MINT?9:c.asset.tokenDecimals,tokenBDecimal:decoded.mintB===WSOL_MINT?9:c.asset.tokenDecimals,hasReferral:false,swapMode:SwapMode.ExactIn,amountIn:new BN(amount)});
 need(q.amountLeft.isZero()&&q.includedFeeInputAmount.toString()===amount&&q.minimumAmountOut&&q.minimumAmountOut.gt(new BN(0)),'DAMM_QUOTE_NOT_EXACT_IN');
 const wsol=await associatedAccount(wallet,WSOL_MINT),token=await associatedAccount(wallet,c.asset.tokenMint);
 const authority=await dammPda(Buffer.from('pool_authority')),event=await dammPda(Buffer.from('__event_authority'));
 const route=await this.sdk._program.methods.swap2({amount0:new BN(amount),amount1:q.minimumAmountOut!,swapMode:0}).accountsStrict({poolAuthority:pk(authority),pool:pk(this.poolAddress),inputTokenAccount:pk(side==='BUY'?wsol:token),outputTokenAccount:pk(side==='BUY'?token:wsol),tokenAVault:pk(decoded.vaultA),tokenBVault:pk(decoded.vaultB),tokenAMint:pk(decoded.mintA),tokenBMint:pk(decoded.mintB),payer:pk(wallet),tokenAProgram:pk(P.TOKEN),tokenBProgram:pk(P.TOKEN),referralTokenAccount:null,eventAuthority:pk(event),program:pk(DAMM)}).instruction();
 const meta=(k:string,w=false,s=false)=>({pubkey:pk(k),isWritable:w,isSigner:s});
 const ata=(a:string,m:string)=>new TransactionInstruction({programId:pk(ATA),keys:[meta(wallet,true,true),meta(a,true),meta(wallet),meta(m),meta(P.SYSTEM),meta(P.TOKEN)],data:Buffer.from([1])});
 const ix=[ComputeBudgetProgram.setComputeUnitLimit({units:400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000}),ata(wsol,WSOL_MINT)];
 if(side==='BUY')ix.push(ata(token,c.asset.tokenMint),SystemProgram.transfer({fromPubkey:pk(wallet),toPubkey:pk(wsol),lamports:BigInt(amount)}),new TransactionInstruction({programId:pk(P.TOKEN),keys:[meta(wsol,true)],data:Buffer.from([17])}));
 ix.push(route,new TransactionInstruction({programId:pk(P.TOKEN),keys:[meta(wsol,true),meta(wallet,true),meta(wallet,false,true)],data:Buffer.from([9])}));
 const bh=await c.rpc('getLatestBlockhash',[{commitment:'confirmed',minContextSlot:r.context.slot}]);
 const wire=new VersionedTransaction(new TransactionMessage({payerKey:pk(wallet),recentBlockhash:bh.value.blockhash,instructions:ix}).compileToV0Message()).serialize();
 const transaction=Buffer.from(wire).toString('base64'),msg=decodeWire(transaction).message;
 const keys=[...new Set([...msg.staticAccounts,WSOL_MINT,c.asset.tokenMint,CLOCK])];
 const facts=await c.rpc('getMultipleAccounts',[keys,{encoding:'base64',commitment:'finalized',minContextSlot:r.context.slot}]);
 const proof=await this.verifyProgramIdentity(facts.context.slot,c);
 const requestId=`DIRECT_DAMM_${randomUUID()}`;
 const evidence:CpiSemanticEvidence={schema:'DIRECT_DAMM_V2_V1',transactionDigest:digest(Buffer.from(wire)),requestId,quoteContextSlot:r.context.slot,alt:{},accounts:{slot:facts.context.slot,keys,values:facts.value},programData:proof.batch,programAttestationDigest:proof.attestationDigest};
 c.assertCurrent();need(Date.now()<expiry,'PREFLIGHT_QUOTE_EXPIRED');
 return {transaction,requestId,cpiEvidence:evidence,programIdentityProof:proof,quoteExpiresAtMs:expiry,poolAddress:this.poolAddress,inAmount:amount,outAmount:q.outputAmount.toString(),inputMint,outputMint,router:'meteora-damm-v2',priceImpact:q.priceImpact.toString(),feeBps:0};
 }
}
