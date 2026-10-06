/** One exact classic-SPL DLMM pool and legacy Jupiter enum38. Independent raw
 * RPC proof, not SDK account-role claims. Pinned IDLs/SDK/Anchor sources:
 * reports/meteora-dlmm-nonfunded-20261001/OFFICIAL-SEMANTICS.md.
 * No bitmap-extension traversal, limit-order inventory, transfer hooks or V2. */
import bs58 from 'bs58';
import {address,getProgramDerivedAddress} from '@solana/kit';
import {digest,DLMM_EXECUTION_SCOPE,DLMM_QUALIFIED_MINT,DLMM_QUALIFIED_POOL,executionUnqualified,type ExecutionAsset,type DeliveryPolicy} from './protocol.js';
import {decodeIndependentAlt,type RawAccount,type CpiSemanticEvidence,type SemanticMessage} from './cpi-semantic-evidence.js';
import {sealedDlmmProgramAttestation,validateProgramMetadata,DLMM_PROGRAM_PINS} from './program-attestation.js';
import {PROGRAM_IDS as P} from '../decoder/program-registry.js';
import {WSOL_MINT} from '../domain/assets.js';
export const DLMM='LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',COMPUTE='ComputeBudget111111111111111111111111111111';
const need:(ok:unknown,code:string)=>asserts ok=(ok,code)=>{if(!ok)throw Error(code);};
const supported=(ok:unknown,code:string)=>{if(!ok)throw executionUnqualified(code);};
const key=(s:string)=>Buffer.from(bs58.decode(s));
const pub=(b:Buffer,n:number)=>bs58.encode(b.subarray(n,n+32));
const discr=(name:string)=>digest(Buffer.from('account:'+name)).slice(0,16);
export const dlmmPda=async(...seeds:Buffer[])=>(await getProgramDerivedAddress({programAddress:address(DLMM),seeds}))[0];
function data(a:RawAccount|null|undefined,owner:string,length:number,name?:string){
 need(a&&a.owner===owner&&!a.executable&&a.space===length&&a.data?.[1]==='base64','DLMM_ACCOUNT_OWNER_OR_LAYOUT');
 const b=Buffer.from(a.data[0],'base64');need(b.length===length&&b.toString('base64')===a.data[0]&&(!name||b.subarray(0,8).toString('hex')===discr(name)),'DLMM_ACCOUNT_LAYOUT');return b;
}
export async function validateDlmmPool(pool:string,a:RawAccount|null|undefined,asset:ExecutionAsset){
 need(pool===DLMM_QUALIFIED_POOL&&asset.tokenMint===DLMM_QUALIFIED_MINT&&asset.tokenProgram===P.TOKEN&&asset.tokenDecimals===9,'DLMM_EXACT_PAIR_BINDING');
 const b=data(a,DLMM,904,'LbPair'),mintX=pub(b,88),mintY=pub(b,120),reserveX=pub(b,152),reserveY=pub(b,184),oracle=pub(b,552);
 need(mintX===asset.tokenMint&&mintY===WSOL_MINT,'DLMM_POOL_MINT');
 // Creation uses an unstored presetParameter2 address. Do not invent its index
 // or claim a reproduced creation PDA: exact pool identity + program ownership
 // and canonical child PDAs define this qualification (as for custom DAMM).
 supported(b[75]===3&&b[82]===0&&b[87]===0&&b[35]===0&&b[36]===0&&b[880]===0&&b[881]===0&&b[882]===1&&b.readBigUInt64LE(816)===0n,'DLMM_POOL_MODE_UNQUALIFIED');
 supported(digest(b.subarray(8,40))==='2199631ee1276ff7bc65dc56c66cbb1a1bb30c53ee6007e5ffbd1178d1ae0798','DLMM_POOL_FEE_CONFIGURATION_CHANGED');
 supported(b.subarray(264,296).every(x=>x===0)&&b.subarray(408,440).every(x=>x===0),'DLMM_REWARD_MODE_UNQUALIFIED');
 need(await dlmmPda(key(pool),key(mintX))===reserveX&&await dlmmPda(key(pool),key(mintY))===reserveY&&await dlmmPda(Buffer.from('oracle'),key(pool))===oracle,'DLMM_CHILD_PDA');
 const binStep=b.readUInt16LE(80);need(binStep===80,'DLMM_BIN_STEP');
 return{mintX,mintY,reserveX,reserveY,oracle,activeId:b.readInt32LE(76),bitmap:b.subarray(584,712)};
}
export function firstDlmmArrayIndices(activeId:number,bitmap:Buffer,inputIsX:boolean):number[]{
 const initialized=(i:number)=>Boolean(bitmap[Math.floor((i+512)/8)]!&(1<<((i+512)%8)));
 const inRange=(i:number)=>Number.isSafeInteger(i)&&i>=-512&&i<=511;
 const step=inputIsX?-1:1,current=Math.floor(activeId/70);
 supported(inRange(current),'DLMM_BITMAP_EXTENSION_REQUIRED');
 const next=(i:number)=>{for(let n=i+step;inRange(n);n+=step)if(initialized(n))return n;throw executionUnqualified('DLMM_BITMAP_EXTENSION_REQUIRED');};
 const first=initialized(current)?current:next(current),second=next(first);return[first,second,next(second)];
}
export async function validateDlmmEvidence(e:CpiSemanticEvidence|undefined,bytes:Buffer,message:SemanticMessage,keys:readonly string[],route:readonly string[],scope:{wallet:string;side:'BUY'|'SELL';asset?:ExecutionAsset;poolAddress?:string;requestId?:string;executionScope?:string;deliveryPolicy?:DeliveryPolicy},wsol:string,token:string){
 need(e?.schema==='EXACT_METEORA_DLMM_V1'&&e.transactionDigest===digest(bytes)&&e.requestId===scope.requestId&&scope.executionScope===DLMM_EXECUTION_SCOPE&&scope.asset,'DLMM_EVIDENCE_BINDING');
 const x=e,asset=scope.asset;
 need(message.version===0&&(message.addressTableLookups?.length??0)<=1&&route.length===29,'DLMM_ROUTE_SHAPE');
 const w:string[]=[],r:string[]=[];
 for(const l of message.addressTableLookups??[]){const f=x.alt[l.lookupTableAddress];need(f&&f.slot>=x.quoteContextSlot,'DLMM_ALT_EVIDENCE');const a=decodeIndependentAlt(f.account);
  for(const i of l.writableIndexes){need(a[i],'DLMM_ALT_INDEX');w.push(a[i]);}for(const i of l.readonlyIndexes){need(a[i],'DLMM_ALT_INDEX');r.push(a[i]);}}
 need(Object.keys(x.alt).length===(message.addressTableLookups?.length??0)&&JSON.stringify(keys)===JSON.stringify([...message.staticAccounts,...w,...r]),'DLMM_ALT_BINDING');
 const a=x.accounts;need(Number.isSafeInteger(x.quoteContextSlot)&&x.quoteContextSlot>0&&Number.isSafeInteger(a.slot)&&a.slot>=x.quoteContextSlot&&a.keys.length===a.values.length&&new Set(a.keys).size===a.keys.length,'DLMM_CONTEXT');
 const expected=[...new Set([...keys,WSOL_MINT,asset.tokenMint])].filter(k=>k!==scope.wallet);need(expected.length===a.keys.length&&a.keys.every(k=>expected.includes(k)),'DLMM_ACCOUNT_SET');
 const map=new Map(a.keys.map((k,i)=>[k,a.values[i]])),p=await validateDlmmPool(scope.poolAddress!,map.get(scope.poolAddress!),asset);
 const jupEvent=(await getProgramDerivedAddress({programAddress:address(P.JUPITER_V6),seeds:[Buffer.from('__event_authority')]}))[0],event=await dlmmPda(Buffer.from('__event_authority'));
 const input=scope.side==='BUY'?wsol:token,output=scope.side==='BUY'?token:wsol;
 const fixed=[P.TOKEN,scope.wallet,input,output,P.JUPITER_V6,scope.side==='BUY'?asset.tokenMint:WSOL_MINT,P.JUPITER_V6,jupEvent,P.JUPITER_V6,
  DLMM,scope.poolAddress,DLMM,p.reserveX,p.reserveY,input,output,p.mintX,p.mintY,p.oracle,DLMM,scope.wallet,P.TOKEN,P.TOKEN,event,DLMM];
 need(route.slice(0,25).every((k,i)=>k===fixed[i])&&route[28]===P.JUPITER_V6,'DLMM_ROUTE_ACCOUNTS');
 const indices=firstDlmmArrayIndices(p.activeId,p.bitmap,scope.side==='SELL');
 for(let i=0;i<3;i++){
  const k=route[25+i]!,b=data(map.get(k),DLMM,10136,'BinArray'),index=Number(b.readBigInt64LE(8));
  need(index===indices[i]&&pub(b,24)===scope.poolAddress,'DLMM_BIN_DIRECTION_OR_BITMAP');
  supported(b[16]===2,'DLMM_BIN_ARRAY_VERSION_UNQUALIFIED');
  const seed=Buffer.alloc(8);seed.writeBigInt64LE(BigInt(index));need(await dlmmPda(Buffer.from('bin_array'),key(scope.poolAddress!),seed)===k,'DLMM_BIN_PDA');
  for(let j=0;j<70;j++){const off=56+j*144;supported(b.subarray(off+112,off+136).every(v=>v===0),'DLMM_LIMIT_ORDER_INVENTORY_UNQUALIFIED');}
 }
 const oracle=data(map.get(p.oracle),DLMM,3232,'Oracle');need(oracle.readBigUInt64LE(24)===100n&&oracle.readBigUInt64LE(16)>0n&&oracle.readBigUInt64LE(16)<=100n&&oracle.readBigUInt64LE(8)<100n,'DLMM_ORACLE_STATE');
 for(const [m,n]of [[WSOL_MINT,9],[asset.tokenMint,asset.tokenDecimals]]as const){const b=data(map.get(m),P.TOKEN,82);need(b[44]===n&&b[45]===1,'DLMM_MINT_STATE');if(m!==WSOL_MINT)need(b.readUInt32LE(0)===0&&b.readUInt32LE(46)===0,'DLMM_MINT_AUTHORITY');}
 for(const [k,m]of [[p.reserveX,p.mintX],[p.reserveY,p.mintY]]as const){const b=data(map.get(k),P.TOKEN,165);need(pub(b,0)===m&&pub(b,32)===scope.poolAddress&&b[108]===1&&b.readUInt32LE(72)===0&&b.readUInt32LE(129)===0&&b.readBigUInt64LE(64)>0n,'DLMM_RESERVE_STATE');}
 for(const [k,m]of [[wsol,WSOL_MINT],[token,asset.tokenMint]]as const){const v=map.get(k);if(v){const b=data(v,P.TOKEN,165);need(pub(b,0)===m&&pub(b,32)===scope.wallet&&b[108]===1&&b.readUInt32LE(72)===0&&b.readUInt32LE(129)===0,'DLMM_USER_TOKEN_STATE');}}
 for(const k of [jupEvent,event]){const v=map.get(k);need(v&&v.owner===P.SYSTEM&&!v.executable&&v.data[0]==='','DLMM_EVENT_AUTHORITY_STATE');}
 const delivery=scope.deliveryPolicy;if(delivery){const v=map.get(delivery.tipAccount);need(v&&v.owner===P.SYSTEM&&!v.executable&&v.data[0]===''&&!route.includes(delivery.tipAccount),'DLMM_TIP_ACCOUNT_STATE');}
 const programs=[P.SYSTEM,P.TOKEN,ATA,COMPUTE,P.JUPITER_V6,DLMM];for(const k of programs)need(map.get(k)?.executable,'DLMM_EXECUTABLE_PROGRAM');
 const allowed=new Set([...fixed,...route.slice(25,28),...programs,WSOL_MINT,asset.tokenMint,...(delivery?[delivery.tipAccount]:[])]);need(keys.every(k=>allowed.has(k)),'DLMM_UNKNOWN_MESSAGE_ACCOUNT');
 const actualW=new Set([...message.staticAccounts.slice(0,message.staticAccounts.length-message.header.numReadonlyNonSignerAccounts),...w]);
 const wantW=new Set([scope.wallet,wsol,token,scope.poolAddress,p.reserveX,p.reserveY,p.oracle,...route.slice(25,28),...(delivery?[delivery.tipAccount]:[])]);
 need(keys.every(k=>actualW.has(k)===wantW.has(k))&&message.header.numSignerAccounts===1&&message.staticAccounts[0]===scope.wallet,'DLMM_FINAL_MESSAGE_PRIVILEGES');
 const attestation=sealedDlmmProgramAttestation(),proof=validateProgramMetadata(attestation,x.programData,a.slot,DLMM_PROGRAM_PINS);need(x.programAttestationDigest===proof.attestationDigest,'PROGRAM_ATTESTATION_STALE');
 for(const pin of DLMM_PROGRAM_PINS){const v=map.get(pin.program),q=x.programData.values[x.programData.keys.indexOf(pin.program)];need(v&&q&&JSON.stringify(v.data)===JSON.stringify(q.data)&&v.owner===q.owner&&v.executable===true&&v.space===36,'DLMM_PROGRAM_IDENTITY');}
}
