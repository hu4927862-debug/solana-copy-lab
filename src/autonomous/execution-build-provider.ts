import type {ExecutionAsset,DeliveryPolicy} from '../live/protocol.js';
import type {LiveOrder} from '../live/adapters.js';
import type {ProgramProof,ClmmProgramAttestationReference} from '../live/program-attestation.js';
import type {FinalityReceipt} from '../live/quote-finality.js';
/** Builder has no signing, submission, position or accounting authority.
 * Every read uses the same bounded/audited transport supplied by LiveNetwork. */
export interface ExecutionBuildContext {
 asset:ExecutionAsset;
 executionPurpose?:"EXECUTION_FUNCTION_TEST";
 deliveryPolicy?:DeliveryPolicy;
 preparationCommitment?:"confirmed";
 executionScope?:string;
 executionPool?:string;
 /** Explicit full-byte successor reference; no default/history replacement. */
 clmmProgramAttestationReference?:ClmmProgramAttestationReference;
 rpc(method:string,params:unknown[]):Promise<any>;
 beginQuote(side:'BUY'|'SELL'):number;
 assertCurrent():void;
 /** Optional capabilities for a Jupiter builder; both preserve the original
  * network reservation/pacing and quote clock, never an unmetered fetch. */
 jupiter?(path:string,method:'GET'|'POST',body?:unknown,version?:string):Promise<unknown>;
 synchronizeQuote?(side:'BUY'|'SELL',contextSlot:unknown):Promise<FinalityReceipt>;
}
export interface ExecutionBuildProvider {
 readonly id:string;
 build(side:'BUY'|'SELL',wallet:string,amount:string,slippageBps:number,context:ExecutionBuildContext):Promise<LiveOrder>;
 verifyProgramIdentity(requiredSlot:number,context:ExecutionBuildContext):Promise<ProgramProof>;
}
