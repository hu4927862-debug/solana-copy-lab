/** Narrow independent DAMM v2 account proof. Layout/PDAs from pinned official
 * program source; deliberately not the builder SDK's decoded role assertions. */
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import bs58 from 'bs58';
import {address,getProgramDerivedAddress} from '@solana/kit';
import {digest,type ExecutionAsset} from './protocol.js';
import type {AccountBatch,RawAccount,CpiSemanticEvidence,SemanticMessage} from './cpi-semantic-evidence.js';
import type {ProgramProof} from './program-attestation.js';
import {WSOL_MINT} from '../domain/assets.js';
import {PROGRAM_IDS as P} from '../decoder/program-registry.js';
export const DAMM='cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const DAMM_PD='AUh8bm2XsMfex3KjYGcM3G4uBqUNSDw6HEhWaWMYnyPH';
export const CLOCK='SysvarC1ock11111111111111111111111111111111';
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111';
const FULL_HASH='3e7d5bfea71fc05ccb915df4b2faf11f97aa8d6b99894e0dce9444f30e640f62';
const need=(c:unknown,e:string)=>{if(!c)throw Error(e)};
const pub=(b:Buffer,n:number)=>bs58.encode(b.subarray(n,n+32));
export const dammPda=async(...seeds:Buffer[])=>(await getProgramDerivedAddress({programAddress:address(DAMM),seeds}))[0];
const key=(s:string)=>Buffer.from(bs58.decode(s));
export function dammData(a:RawAccount|null|undefined,owner:string,length:number):Buffer{
 need(a&&a.owner===owner&&!a.executable&&a.data?.[1]==='base64','DAMM_ACCOUNT_OWNER');
 const b=Buffer.from(a!.data[0],'base64');need(b.length===length&&a!.space===length&&b.toString('base64')===a!.data[0],'DAMM_ACCOUNT_LAYOUT');return b;
}
export async function validateDammPool(pool:string,a:RawAccount|null,tokenMint:string){
 const b=dammData(a,DAMM,1112);need(b.subarray(0,8).toString('hex')==='f19a6d0411b16dbc','DAMM_POOL_DISCRIMINATOR');
 const mintA=pub(b,168),mintB=pub(b,200),vaultA=pub(b,232),vaultB=pub(b,264);
 need(mintA!==mintB&&tokenMint!==WSOL_MINT&&[mintA,mintB].includes(tokenMint)&&[mintA,mintB].includes(WSOL_MINT),'DAMM_POOL_MINT');
 // Only the observed customizable, static time-fee, non-compounding layout.
 // No silently unreviewed rate limiter, dynamic fee, market-cap fee or extensions.
 need(b[481]===0&&b[482]===0&&b[483]===0&&b[484]===1&&b[485]===1&&b[486]===1&&b[696]===1&&b[480]===1,'DAMM_POOL_MODE_UNQUALIFIED');
 need(b.subarray(16,40).every(x=>x===0)&&b[56]===0&&b.readUInt16LE(54)===0&&b.readBigUInt64LE(8)>0n&&b.readBigUInt64LE(8)<=100000000n,'DAMM_FEE_MODE_UNQUALIFIED');
 // Customizable type also includes dynamic-config creation. Config is not stored
 // in Pool and swap does not require its PDA. Bind exact requested pool, owner,
 // discriminator, canonical vault PDAs and mint relations; never invent config.
 need(await dammPda(Buffer.from('token_vault'),key(mintA),key(pool))===vaultA&&await dammPda(Buffer.from('token_vault'),key(mintB),key(pool))===vaultB,'DAMM_VAULT_PDA');
 need(b.subarray(360,376).some(x=>x!==0),'DAMM_NO_LIQUIDITY');
 return {mintA,mintB,vaultA,vaultB,activationPoint:b.readBigUInt64LE(472),feeNumerator:b.readBigUInt64LE(8)};
}
export function dammAttestation(){
 const raw=JSON.parse(gunzipSync(readFileSync(new URL('../autonomous/damm-program-attestation.full.json.gz',import.meta.url))).toString());
 need(raw.version==='DIRECT_DAMM_FINALIZED_PROGRAM_V1'&&raw.commitment==='finalized'&&raw.program===DAMM&&raw.programData===DAMM_PD&&raw.slot===451308438,'DAMM_ATTESTATION_PROVENANCE');
 const b=dammData(raw.programDataAccount,LOADER,2174397);
 need(b.readUInt32LE(0)===3&&digest(b)===FULL_HASH&&b[12]===1&&b.readBigUInt64LE(4)<=BigInt(raw.slot),'DAMM_FULL_HASH');
 const p=raw.programAccount;need(p.owner===LOADER&&p.executable&&p.space===36,'DAMM_PROGRAM_IDENTITY');
 const pb=Buffer.from(p.data[0],'base64');need(pb.length===36&&pb.readUInt32LE(0)===2&&pub(pb,4)===DAMM_PD,'DAMM_PROGRAM_POINTER');
 return {slot:raw.slot as number,digest:digest(JSON.stringify(raw)),header:b.subarray(0,45).toString('base64'),program:p.data[0] as string};
}
export function validateDammProgram(batch:AccountBatch,requiredSlot:number):ProgramProof{
 const a=dammAttestation();need(Number.isSafeInteger(batch.slot)&&batch.slot>=Math.max(requiredSlot,a.slot)&&batch.keys.join(',')===[DAMM,DAMM_PD].join(',')&&batch.values.length===2,'PROGRAM_ATTESTATION_STALE');
 for(let i=0;i<2;i++){const v=batch.values[i];need(v&&v.owner===LOADER&&v.executable===(i===0)&&v.space===(i===0?36:2174397)&&BigInt(v.lamports??0)>0n&&v.data[1]==='base64'&&v.data[0]===(i===0?a.program:a.header),'PROGRAM_ATTESTATION_STALE');}
 return {attestationDigest:a.digest,slot:batch.slot,batch};
}
export async function validateDammEvidence(e:CpiSemanticEvidence|undefined,bytes:Buffer,message:SemanticMessage,keys:readonly string[],route:readonly string[],scope:{wallet:string;side:'BUY'|'SELL';asset?:ExecutionAsset;poolAddress?:string;requestId?:string},wsol:string,token:string){
 need(e?.schema==='DIRECT_DAMM_V2_V1'&&!!scope.asset&&e.requestId===scope.requestId&&e.transactionDigest===digest(bytes),'DAMM_EVIDENCE_BINDING');const x=e!;
 need(message.version===0&&(message.addressTableLookups?.length??0)===0&&Object.keys(x.alt).length===0,'DAMM_UNEXPECTED_ALT');
 const a=x.accounts;need(Number.isSafeInteger(x.quoteContextSlot)&&x.quoteContextSlot>0&&a.slot>=x.quoteContextSlot&&a.keys.length===a.values.length&&new Set(a.keys).size===a.keys.length,'DAMM_CONTEXT');
 const expected=[...new Set([...keys,WSOL_MINT,scope.asset!.tokenMint,CLOCK])];need(expected.length===a.keys.length&&a.keys.every(k=>expected.includes(k)),'DAMM_ACCOUNT_SET');
 const map=new Map(a.keys.map((k,i)=>[k,a.values[i]]));
 const p=await validateDammPool(scope.poolAddress!,map.get(scope.poolAddress!)??null,scope.asset!.tokenMint);
 const authority=await dammPda(Buffer.from('pool_authority')),event=await dammPda(Buffer.from('__event_authority'));
 const r=[authority,scope.poolAddress,scope.side==='BUY'?wsol:token,scope.side==='BUY'?token:wsol,p.vaultA,p.vaultB,p.mintA,p.mintB,scope.wallet,P.TOKEN,P.TOKEN,DAMM,event,DAMM];
 need(route.length===14&&route.every((v,i)=>v===r[i]),'DAMM_ROUTE_ACCOUNTS');
 const writable=message.staticAccounts.slice(0,message.staticAccounts.length-message.header.numReadonlyNonSignerAccounts);
 const want=[scope.wallet,scope.poolAddress!,wsol,token,p.vaultA,p.vaultB];need(writable.length===want.length&&writable.every(k=>want.includes(k)),'DAMM_WRITABLE_SCOPE');
 const clock=dammData(map.get(CLOCK),'Sysvar1111111111111111111111111111111111111',40);need(clock.readBigInt64LE(32)>=p.activationPoint,'DAMM_NOT_ACTIVE');
 for(const [mint,decimals] of [[WSOL_MINT,9],[scope.asset!.tokenMint,scope.asset!.tokenDecimals]] as const){const m=dammData(map.get(mint),P.TOKEN,82);need(m[44]===decimals&&m[45]===1,'DAMM_MINT_STATE');if(mint!==WSOL_MINT)need(m.readUInt32LE(0)===0&&m.readUInt32LE(46)===0,'DAMM_MINT_AUTHORITY');}
 for(const [v,m] of [[p.vaultA,p.mintA],[p.vaultB,p.mintB]]){const b=dammData(map.get(v!),P.TOKEN,165);need(pub(b,0)===m&&pub(b,32)===authority&&b[108]===1&&b.readUInt32LE(72)===0&&b.readUInt32LE(129)===0,'DAMM_VAULT_STATE');}
 for(const [v,m] of [[wsol,WSOL_MINT],[token,scope.asset!.tokenMint]]){const raw=map.get(v!);if(raw){const b=dammData(raw,P.TOKEN,165);need(pub(b,0)===m&&pub(b,32)===scope.wallet&&b[108]===1&&b.readUInt32LE(72)===0&&b.readUInt32LE(129)===0,'DAMM_USER_TOKEN_STATE');}}
 const wallet=map.get(scope.wallet);need(wallet&&wallet.owner===P.SYSTEM&&!wallet.executable&&wallet.space===0,'DAMM_WALLET_STATE');
 for(const k of [P.SYSTEM,P.TOKEN,'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL','ComputeBudget111111111111111111111111111111'])need(map.get(k)?.executable,'DAMM_BUILTIN_PROGRAM');
 const proof=validateDammProgram(x.programData,a.slot);need(x.programAttestationDigest===proof.attestationDigest,'PROGRAM_ATTESTATION_STALE');
 // Program account in the complete account batch must match the lightweight proof.
 need(JSON.stringify(map.get(DAMM)?.data)===JSON.stringify(x.programData.values[0]?.data)&&map.get(DAMM)?.owner===LOADER&&map.get(DAMM)?.executable,'DAMM_PROGRAM_IDENTITY');
}
