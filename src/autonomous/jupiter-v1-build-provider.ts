import type {ExecutionBuildProvider,ExecutionBuildContext} from "./execution-build-provider.js";
import {sealedProgramAttestation,sealedCurrentClmmProgramAttestation,sealedDlmmProgramAttestation,DLMM_PROGRAM_PINS,DLMM_PROGRAM_METADATA_KEYS,validateProgramMetadata,PROGRAM_METADATA_KEYS,type ProgramProof,type AttestationPurpose} from "../live/program-attestation.js";
import {DLMM} from "../live/dlmm-evidence.js";
import {z} from "zod";
import {address,blockhash,AccountRole,createTransactionMessage,setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,appendTransactionMessageInstructions,compressTransactionMessageUsingAddressLookupTables,compileTransaction,getTransactionEncoder,type Instruction} from "@solana/kit";
import {JupiterLiveHttpError,type LiveOrder} from "../live/adapters.js";
import {associatedAccount,ATA,COMPUTE,decodeWire} from "../live/transaction-review.js";
import {decodeIndependentAlt,type CpiSemanticEvidence,type RawAccount} from "../live/cpi-semantic-evidence.js";
import {digest,DeliveryPolicySchema,ExecutionAssetSchema,executionUnqualified,DLMM_EXECUTION_SCOPE,DLMM_QUALIFIED_MINT,DLMM_QUALIFIED_POOL} from "../live/protocol.js";
import {PROGRAM_IDS as P} from "../decoder/program-registry.js";
import {WSOL_MINT} from "../domain/assets.js";
const need:(ok:unknown,code:string)=>asserts ok=(ok,code)=>{if(!ok)throw Error(code);};
function exactDlmm(context:ExecutionBuildContext){
 if(context.executionScope!==DLMM_EXECUTION_SCOPE)return false;
 need(context.asset.tokenMint===DLMM_QUALIFIED_MINT&&context.asset.tokenProgram===P.TOKEN&&context.asset.tokenDecimals===9&&context.executionPool===DLMM_QUALIFIED_POOL&&context.executionPurpose===undefined,"DLMM_EXACT_PAIR_SCOPE_BINDING");
 return true;
}
function qualifiedDelivery(context:ExecutionBuildContext,purpose?:AttestationPurpose){
 const delivery=context.deliveryPolicy?DeliveryPolicySchema.parse(context.deliveryPolicy):undefined;
 const eligible=purpose===undefined||purpose==="EXECUTION_FUNCTION_TEST";
 const classic=ExecutionAssetSchema.safeParse(context.asset).success;
 need(!context.preparationCommitment||delivery&&eligible&&classic&&context.preparationCommitment===delivery.preparationCommitment,"PREPARATION_COMMITMENT_SCOPE");
 need(!delivery||eligible&&classic&&context.preparationCommitment==="confirmed","DELIVERY_EXECUTION_SCOPE");
 return delivery;
}
function scopedAttestation(context:ExecutionBuildContext,purpose?:AttestationPurpose){
 if(context.clmmProgramAttestationReference!==undefined)
  need(purpose===undefined&&context.executionScope!==DLMM_EXECUTION_SCOPE&&!!qualifiedDelivery(context,purpose),"PROGRAM_ATTESTATION_REFERENCE_SCOPE");
 if(exactDlmm(context)){need(!purpose,"DLMM_FOLLOWER_PURPOSE_REQUIRED");qualifiedDelivery(context,purpose);return sealedDlmmProgramAttestation();}
 return qualifiedDelivery(context,purpose)&&purpose===undefined
  ? sealedCurrentClmmProgramAttestation(context.clmmProgramAttestationReference) : sealedProgramAttestation(purpose);
}
function noRouteCode(value:unknown){
 if(!value||typeof value!=="object")return undefined;
 const diagnostic=value as Record<string,unknown>,code=diagnostic.errorCode??diagnostic.code;
 if(code==="COULD_NOT_FIND_ANY_ROUTE"||code==="NO_ROUTES_FOUND")return code;
 // The retained production publicDiagnostic drops errorCode but preserves this
 // exact saved HTTP400 business error. Unknown explicit codes never use it.
 return diagnostic.errorCode===undefined&&diagnostic.code===undefined&&diagnostic.error==="No routes found"
  ? "NO_ROUTES_FOUND" : undefined;
}
async function readV1Quote(context:ExecutionBuildContext,query:URLSearchParams){
 let result:unknown;
 try{result=await context.jupiter!(`quote?${query}`,"GET",undefined,"v1");}
 catch(error){
  const code=error instanceof JupiterLiveHttpError&&error.status===400?noRouteCode(error.publicDiagnostic):undefined;
  if(code)throw executionUnqualified(`V1_QUOTE_${code}`);
  throw error;
 }
 const code=noRouteCode(result);
 if(code)throw executionUnqualified(`V1_QUOTE_${code}`);
 return result;
}

/** Reuses the qualified V1 owner. Full-swap is explicitly selected, never a
 * fallback. Canonical unsigned bytes provide only the router instruction;
 * the inherited exact WSOL lifecycle and independent review remain decisive. */
export class JupiterV1FullSwapBuilder implements ExecutionBuildProvider {
 readonly id="JUPITER_V1_FULL_SWAP_SELF_RPC_V1";
 constructor(private readonly purpose?:AttestationPurpose){}
 build(side:"BUY"|"SELL",wallet:string,amount:string,slippageBps:number,context:ExecutionBuildContext):Promise<LiveOrder>{
  return buildJupiterV1Order(side,wallet,amount,slippageBps,context,"full-swap",this.purpose);
 }
 verifyProgramIdentity(requiredSlot:number,context:ExecutionBuildContext):Promise<ProgramProof>{
  return verifyJupiterProgramIdentity(requiredSlot,context,this.purpose);
 }
}
export async function verifyJupiterProgramIdentity(requiredSlot:number,context:ExecutionBuildContext,purpose?:AttestationPurpose):Promise<ProgramProof>{
 const attestation=scopedAttestation(context,purpose);
 const dlmm=exactDlmm(context),metadataKeys=dlmm?DLMM_PROGRAM_METADATA_KEYS:PROGRAM_METADATA_KEYS;
 const required=Math.max(requiredSlot,attestation.slot);
 need(Number.isSafeInteger(requiredSlot)&&requiredSlot>0,"PROGRAM_ATTESTATION_STALE");
 const read=await context.rpc("getMultipleAccounts",[metadataKeys,{encoding:"base64",commitment:context.preparationCommitment??"finalized",minContextSlot:required,dataSlice:{offset:0,length:45}}]);
 return validateProgramMetadata(attestation,{slot:read.context?.slot,keys:[...metadataKeys],values:read.value},required,dlmm?DLMM_PROGRAM_PINS:undefined);
}
async function extractV1FullSwap(context:ExecutionBuildContext,quote:{contextSlot?:number}&Record<string,unknown>,wallet:string){
 const result=z.object({swapTransaction:z.string(),lastValidBlockHeight:z.number().int().positive()}).passthrough().parse(await context.jupiter!("swap","POST",{
  quoteResponse:quote,userPublicKey:wallet,useSharedAccounts:false,wrapAndUnwrapSol:true,dynamicComputeUnitLimit:false,dynamicSlippage:false,prioritizationFeeLamports:400,
 },"v1"));
 const {message,transaction}=decodeWire(result.swapTransaction);
 need(message.staticAccounts[0]===wallet&&Object.values(transaction.signatures).every(s=>!s||!s.some(b=>b!==0)),"V1_FULL_SWAP_SIGNER_SCOPE");
 const lookups=message.version===0?message.addressTableLookups??[]:[];
 need(lookups.length<=1,"PREFLIGHT_ALT_TABLE_LIMIT");
 const alt:CpiSemanticEvidence["alt"]={},tables:Record<string,string[]>={};
 const writable:string[]=[],readonly:string[]=[];
 for(const table of lookups){
  const key=table.lookupTableAddress;
  const read=await context.rpc("getAccountInfo",[key,{encoding:"base64",commitment:exactDlmm(context)?"finalized":context.preparationCommitment??"finalized",minContextSlot:Number(quote.contextSlot)}]);
  need(read.value,"CPI_ALT_EVIDENCE_MISSING");
  tables[key]=decodeIndependentAlt(read.value as RawAccount);
  alt[key]={slot:Number(read.context.slot),account:read.value as RawAccount};
  for(const i of table.writableIndexes){need(tables[key][i],"LOOKUP_INDEX_UNRESOLVED");writable.push(tables[key][i]);}
  for(const i of table.readonlyIndexes){need(tables[key][i],"LOOKUP_INDEX_UNRESOLVED");readonly.push(tables[key][i]);}
 }
 const keys=[...message.staticAccounts,...writable,...readonly];
 need(new Set(keys).size===keys.length,"DUPLICATE_ACCOUNT_KEYS");
 const writableKeys=new Set([...message.staticAccounts.filter((_,i)=>i<message.staticAccounts.length-message.header.numReadonlyNonSignerAccounts),...writable]);
 const routed=message.instructions.filter(i=>keys[i.programAddressIndex]===P.JUPITER_V6);
 need(routed.length===1,"V1_FULL_SWAP_ROUTER_COUNT");
 const route=routed[0]!,data=Buffer.from(route.data??[]);
 need(data.length===35&&data.subarray(0,8).toString("hex")==="e517cb977ae3ad2a","V1_FULL_SWAP_ABI_UNSUPPORTED");
 const dlmm=exactDlmm(context);
 // Bounded extraction only. Independent raw pool/role/PDA review decides
 // whether the one/two-array Token0Only variant is actually in scope.
 need(route.accountIndices && (dlmm?route.accountIndices.length===29:
   route.accountIndices.length>=22&&route.accountIndices.length<=24),"V1_FULL_SWAP_ACCOUNT_SCOPE");
 const accounts=route.accountIndices!.map(i=>{const pubkey=keys[i];need(pubkey,"LOOKUP_INDEX_UNRESOLVED");return {pubkey,isSigner:pubkey===wallet,isWritable:writableKeys.has(pubkey)};});
 if(dlmm){
  need(data.readUInt32LE(8)===1&&data[12]===38&&data[13]===100&&data[14]===0&&data[15]===1&&
    accounts[10]!.pubkey===DLMM_QUALIFIED_POOL&&[9,11,19,24].every(i=>accounts[i]!.pubkey===DLMM),"DLMM_V1_FULL_SWAP_SCOPE");
  // Anchor Optional(None) is the readonly program-id sentinel, not a writable
  // pool/extension/host account. Canonical least privilege BEFORE recompile,
  // independent review and simulation. No signed/provider message is reused.
  for(const a of accounts)if(a.pubkey===DLMM)a.isWritable=false;
 }
 return {assembled:{swapInstruction:{programId:P.JUPITER_V6,accounts,data:data.toString("base64")},addressLookupTableAddresses:lookups.map(x=>String(x.lookupTableAddress))},alt};
}

/** The former JupiterSelfRpcNetwork V1 order body, shared without changing its
 * quote/source clocks, principal, fee, finalized context or review evidence. */
export async function buildJupiterV1Order(side:"BUY"|"SELL",wallet:string,amount:string,slippageBps:number,context:ExecutionBuildContext,source:"swap-instructions"|"full-swap"="swap-instructions",purpose?:AttestationPurpose):Promise<LiveOrder>{
 need(context.jupiter&&context.synchronizeQuote,"JUPITER_BUILD_CONTEXT_MISSING");
 const dlmm=exactDlmm(context);
 need(!dlmm||source==="full-swap","DLMM_FULL_SWAP_PROVIDER_REQUIRED");
 const delivery=qualifiedDelivery(context,purpose);
    scopedAttestation(context,purpose); // Full scoped sealed bytes verified locally before starting the quote clock.
    const quoteExpiresAtMs = context.beginQuote(side);
    const query = new URLSearchParams({
      inputMint: side === "BUY" ? WSOL_MINT : context.asset.tokenMint,
      outputMint: side === "BUY" ? context.asset.tokenMint : WSOL_MINT,
      amount,
      slippageBps: String(slippageBps),
      instructionVersion: "V1",
      dexes: dlmm?"Meteora DLMM":"Raydium CLMM",
      onlyDirectRoutes: "true",
      restrictIntermediateTokens: "true",
    });
    const quote = z
      .object({
        inputMint: z.string(),
        outputMint: z.string(),
        inAmount: z.string(),
        outAmount: z.string().regex(/^[1-9]\d*$/),
        swapMode: z.literal("ExactIn"),
        slippageBps: z.number().int(),
        platformFee: z.unknown().optional(),
        priceImpactPct: z.string(),
        routePlan: z
          .array(
            z
              .object({
                percent: z.number(),
                swapInfo: z
                  .object({
                    label: z.string(),
                    ammKey: z.string(),
                    inputMint: z.string(),
                    outputMint: z.string(),
                    inAmount: z.string(),
                    outAmount: z.string(),
                  })
                  .passthrough(),
              })
              .passthrough(),
          ),
      })
      .passthrough()
      .parse(await readV1Quote(context,query));
    if (
      quote.platformFee != null ||
      quote.inputMint !== query.get("inputMint") ||
      quote.outputMint !== query.get("outputMint") ||
      quote.inAmount !== amount ||
      quote.slippageBps !== slippageBps
    )
      throw new Error("V1_QUOTE_SCOPE");
    // Explicit capability refusal, not a malformed-response/identity catch-all.
    // All original economic/identity fields above remain exact before dispatch.
    if(quote.routePlan.length!==1)throw executionUnqualified(quote.routePlan.length===0?"V1_ROUTE_UNAVAILABLE":"V1_ROUTE_NOT_SINGLE");
    if(quote.routePlan[0]!.percent!==100)throw executionUnqualified("V1_ROUTE_SPLIT_UNSUPPORTED");
    if(quote.routePlan[0]!.swapInfo.label!==(dlmm?"Meteora DLMM":"Raydium CLMM"))throw executionUnqualified("V1_ROUTE_DEX_UNSUPPORTED");
    const swapInfo = quote.routePlan[0]!.swapInfo;
    if(dlmm&&swapInfo.ammKey!==DLMM_QUALIFIED_POOL)throw executionUnqualified("DLMM_EXACT_POOL_UNQUALIFIED");
    if (
      swapInfo.inputMint !== quote.inputMint ||
      swapInfo.outputMint !== quote.outputMint ||
      swapInfo.inAmount !== amount ||
      swapInfo.outAmount !== quote.outAmount
    )
      throw new Error("V1_ROUTE_PLAN_SCOPE");
    const finalitySync = await context.synchronizeQuote!(side, quote.contextSlot);
    const fullSwap = source === "full-swap" ? await extractV1FullSwap(context, quote, wallet) : undefined;
    const assembled = fullSwap?.assembled ?? z
      .object({
        swapInstruction: z.object({
          programId: z.literal(P.JUPITER_V6),
          accounts: z.array(
            z.object({
              pubkey: z.string(),
              isSigner: z.boolean(),
              isWritable: z.boolean(),
            }),
          ),
          data: z.string(),
        }),
        addressLookupTableAddresses: z.array(z.string()),
      })
      .passthrough()
      .parse(
        await context.jupiter!(
          "swap-instructions",
          "POST",
          {
            quoteResponse: quote,
            userPublicKey: wallet,
            useSharedAccounts: false,
            wrapAndUnwrapSol: false,
            dynamicComputeUnitLimit: false,
            dynamicSlippage: false,
          },
          "v1",
        ),
      );
    if (assembled.addressLookupTableAddresses.length > 1)
      throw new Error("PREFLIGHT_ALT_TABLE_LIMIT");
    const wsol = await associatedAccount(wallet, WSOL_MINT),
      usdc = await associatedAccount(wallet, context.asset.tokenMint);
    const ix = (
      program: string,
      accounts: { key: string; role: AccountRole }[],
      data: Buffer,
    ): Instruction => ({
      programAddress: address(program),
      accounts: accounts.map((a) => ({
        address: address(a.key),
        role: a.role,
      })),
      data,
    });
    const ro = (key: string) => ({ key, role: AccountRole.READONLY }),
      rw = (key: string) => ({ key, role: AccountRole.WRITABLE }),
      payer = { key: wallet, role: AccountRole.WRITABLE_SIGNER };
    const limit = Buffer.alloc(5);
    limit[0] = 2;
    limit.writeUInt32LE(400000, 1);
    const price = Buffer.alloc(9);
    price[0] = 3;
    price.writeBigUInt64LE(1000n, 1);
    const instructions: Instruction[] = [
      ix(COMPUTE, [], limit),
      ix(COMPUTE, [], price),
      ix(
        ATA,
        [payer, rw(wsol), ro(wallet), ro(WSOL_MINT), ro(P.SYSTEM), ro(P.TOKEN)],
        Buffer.from([1]),
      ),
    ];
    if (side === "BUY") {
      instructions.push(
        ix(
          ATA,
          [
            payer,
            rw(usdc),
            ro(wallet),
            ro(context.asset.tokenMint),
            ro(P.SYSTEM),
            ro(P.TOKEN),
          ],
          Buffer.from([1]),
        ),
      );
      const transfer = Buffer.alloc(12);
      transfer.writeUInt32LE(2);
      transfer.writeBigUInt64LE(BigInt(amount), 4);
      instructions.push(
        ix(P.SYSTEM, [payer, rw(wsol)], transfer),
        ix(P.TOKEN, [rw(wsol)], Buffer.from([17])),
      );
    }
    const s = assembled.swapInstruction;
    instructions.push({
      programAddress: address(s.programId),
      accounts: s.accounts.map((a) => ({
        address: address(a.pubkey),
        role: a.isSigner
          ? a.isWritable
            ? AccountRole.WRITABLE_SIGNER
            : AccountRole.READONLY_SIGNER
          : a.isWritable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY,
      })),
      data: Buffer.from(s.data, "base64"),
    });
    instructions.push(
      ix(P.TOKEN, [rw(wsol), rw(wallet), payer], Buffer.from([9])),
    );
    // Tip is fixed before compression, sizing, independent review, simulation
    // and signing. It is never appended to an already reviewed/signed message.
    if(delivery){
      const tip=Buffer.alloc(12);tip.writeUInt32LE(2);tip.writeBigUInt64LE(BigInt(delivery.tipLamports),4);
      instructions.push(ix(P.SYSTEM,[payer,rw(delivery.tipAccount)],tip));
    }
    const latest = await context.rpc("getLatestBlockhash", [
      { commitment: "confirmed" },
    ]);
    const message = appendTransactionMessageInstructions(
      instructions,
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(latest.value.blockhash),
          lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
        },
        setTransactionMessageFeePayer(
          address(wallet),
          createTransactionMessage({ version: 0 }),
        ),
      ),
    );
    const tables: Record<string, ReturnType<typeof address>[]> = {};
    const alt: CpiSemanticEvidence["alt"] = {};
    for (const key of assembled.addressLookupTableAddresses) {
      const retained = fullSwap?.alt[key];
      const read = retained ? {context:{slot:retained.slot},value:retained.account} : await context.rpc("getAccountInfo", [key,
        { encoding: "base64", commitment: context.preparationCommitment??"finalized", minContextSlot: Number(quote.contextSlot ?? 0) }]);
      if (!read.value) throw new Error("CPI_ALT_EVIDENCE_MISSING");
      alt[key] = { slot: Number(read.context.slot), account: read.value as RawAccount };
      tables[key] = decodeIndependentAlt(read.value as RawAccount).map(address);
    }
    const transaction = compileTransaction(
      compressTransactionMessageUsingAddressLookupTables(message, tables),
    );
    const encoded = Buffer.from(getTransactionEncoder().encode(transaction));
    const decoded = decodeWire(encoded.toString("base64")).message;
    const loadedWritable: string[] = [], loadedReadonly: string[] = [];
    for (const lookup of decoded.version === 0 ? decoded.addressTableLookups ?? [] : []) {
      const addresses = tables[lookup.lookupTableAddress];
      if (!addresses) throw new Error("CPI_ALT_EVIDENCE_MISSING");
      loadedWritable.push(...lookup.writableIndexes.map((i: number) => addresses[i]!));
      loadedReadonly.push(...lookup.readonlyIndexes.map((i: number) => addresses[i]!));
    }
    const keys = [...new Set([...decoded.staticAccounts, ...loadedWritable, ...loadedReadonly,
      WSOL_MINT, context.asset.tokenMint])]
      .filter(k => k !== wallet);
    const accountRead = await context.rpc("getMultipleAccounts", [keys,
      { encoding: "base64", commitment: context.preparationCommitment??"finalized", minContextSlot: Number(quote.contextSlot ?? 0) }]);
    if (accountRead.value?.length !== keys.length) throw new Error("CPI_ACCOUNT_READ_INCOMPLETE");
    const accountMap = new Map(keys.map((k, i) => [k, accountRead.value[i] as RawAccount | null]));
    const programProof = await verifyJupiterProgramIdentity(Number(accountRead.context.slot), context,purpose);
    const requestId = `SELF_RPC_${latest.value.blockhash}`;
    const cpiEvidence: CpiSemanticEvidence = {
      schema: dlmm?"EXACT_METEORA_DLMM_V1":"NARROW_RAYDIUM_CLMM_V1",
      transactionDigest: digest(encoded), requestId,
      quoteContextSlot: Number(quote.contextSlot), alt,
      ...(delivery?{preparationCommitment:delivery.preparationCommitment}:{}),
      accounts: { slot: Number(accountRead.context.slot), keys, values: accountRead.value },
      programData: programProof.batch,
      programAttestationDigest: programProof.attestationDigest,
      ...(context.clmmProgramAttestationReference ? {clmmProgramAttestationReference:context.clmmProgramAttestationReference} : {}),
    };
    context.assertCurrent();
    return {
      programIdentityProof: programProof,
      finalitySync: finalitySync,
      quoteExpiresAtMs: quoteExpiresAtMs,
      blockhashContextSlot:Number(latest.context.slot),
      lastValidBlockHeight:String(latest.value.lastValidBlockHeight),
      transaction: encoded.toString("base64"),
      requestId,
      cpiEvidence,
      inAmount: amount,
      outAmount: quote.outAmount,
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      router: "metis",
      poolAddress: swapInfo.ammKey,
      feeBps: 0,
      priceImpactPct: quote.priceImpactPct,
    };
}
