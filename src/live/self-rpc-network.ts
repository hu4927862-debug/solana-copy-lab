import type {ExecutionBuildProvider,ExecutionBuildContext} from "../autonomous/execution-build-provider.js";
import type {ProgramProof} from "./program-attestation.js";
import {buildJupiterV1Order,verifyJupiterProgramIdentity} from "../autonomous/jupiter-v1-build-provider.js";
import { QuoteFinality, FINALITY_SYNC_POLICY } from "./quote-finality.js";
import { JupiterManagedNetwork, type LiveOrder } from "./adapters.js";
import { DeliveryPolicySchema, type DeliveryPolicy } from "./protocol.js";
import { HELIUS_SWQOS_ENDPOINT, heliusSwqosSendParams } from "./helius-swqos-delivery.js";
import bs58 from "bs58";
/** Deliberately small alternate path chosen after actual V2 Metis-only failure.
 * Official V1 single-hop Raydium CLMM, own exact ATA lifecycle, ordinary RPC.
 * SWQOS Sender is an explicit delivery policy, never automatic fallback or re-sign. */
export class JupiterSelfRpcNetwork extends JupiterManagedNetwork {
  private readonly quoteClock = new QuoteFinality();
  private deliveryPolicy: DeliveryPolicy | undefined;
  configureDelivery(policy?: DeliveryPolicy): void {
    this.deliveryPolicy = policy === undefined ? undefined : Object.freeze(DeliveryPolicySchema.parse(policy));
  }
  protected override rpcEndpoint(method: string): string {
    return method === "sendTransaction" && this.deliveryPolicy ? HELIUS_SWQOS_ENDPOINT : super.rpcEndpoint(method);
  }
  rpcCommitment(): "confirmed" | "finalized" {
    return this.deliveryPolicy?.preparationCommitment ?? "finalized";
  }
  protected executionBuilder: ExecutionBuildProvider | undefined;
  protected buildContext(): ExecutionBuildContext {
    return {asset:this.asset, ...(this.deliveryPolicy ? {deliveryPolicy:this.deliveryPolicy,
      preparationCommitment:this.deliveryPolicy.preparationCommitment} : {}),
      rpc:(method,params)=>this.rpc(method,params),
      beginQuote:(side)=>{this.quoteClock.begin();this.requestAudit?.quoteStarted?.(side,this.quoteClock.quoteExpiresAtMs!);return this.quoteClock.quoteExpiresAtMs!;},
      assertCurrent:()=>this.assertCurrentEvidence(),
      jupiter:(path,method,body,version)=>this.jupiter(path,method,body,version),
      synchronizeQuote:async(side,slot)=>{await this.synchronizeQuote(side,slot);return this.quoteClock.receipt!;}};
  }
  protected override requestPurpose(): string { return this.quoteClock.synchronizing() ? "FINALITY_SYNC" : "LIVE_COMMAND"; }
  beginPreparation(deadline: number): void { this.quoteClock.prepare(deadline); }
  finishPreparation(): void { this.quoteClock.finish(); }
  finalityEvidence() { return this.quoteClock.receipt; }
  assertCurrentEvidence(): void { this.assertRequestCurrent(); }
  protected override assertRequestCurrent(): void {
    super.assertRequestCurrent(); this.quoteClock.assertCurrent();
  }
  protected override requestDeadlineSignal(): AbortSignal | undefined {
    const signals = [super.requestDeadlineSignal(), this.quoteClock.signal()].filter(Boolean) as AbortSignal[];
    return signals.length ? AbortSignal.any(signals) : undefined;
  }
  private async synchronizeQuote(side: "BUY" | "SELL", contextSlot: unknown): Promise<void> {
    this.requestAudit?.finalityStarted?.(Date.now() + FINALITY_SYNC_POLICY.maxWaitMs);
    try {
      await this.quoteClock.synchronize(contextSlot, async () => ({
        slot: (await this.rpc("getLatestBlockhash", [{ commitment: this.rpcCommitment() }])).context?.slot,
        requestId: this.lastRequestId,
      }), () => super.assertRequestCurrent(), () => super.requestDeadlineSignal(), this.rpcCommitment());
    } finally { this.requestAudit?.finalityFinished?.(side, this.quoteClock.receipt); }
  }
  async verifyProgramIdentity(requiredSlot: number): Promise<ProgramProof> {
    if (this.executionBuilder) return this.executionBuilder.verifyProgramIdentity(requiredSlot,this.buildContext());
    return verifyJupiterProgramIdentity(requiredSlot,this.buildContext());
  }
  override async order(
    side: "BUY" | "SELL",
    wallet: string,
    amount: string,
    slippageBps: number,
  ): Promise<LiveOrder> {
    if (this.executionBuilder) return this.executionBuilder.build(side,wallet,amount,slippageBps,this.buildContext());
    return buildJupiterV1Order(side,wallet,amount,slippageBps,this.buildContext());
  }
  override async execute(
    signedTransaction: string,
    _requestId: string,
  ): Promise<unknown> {
    const signature = await this.rpc("sendTransaction", this.deliveryPolicy
      ? heliusSwqosSendParams(signedTransaction, this.deliveryPolicy) : [
      signedTransaction,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 0,
      },
    ]);
    if (this.deliveryPolicy) {
      try {
        if(typeof signature!=="string"||bs58.decode(signature).length!==64)
          throw Error("DELIVERY_RESPONSE_UNCERTAIN");
      } catch { throw Error("DELIVERY_RESPONSE_UNCERTAIN"); }
    }
    return { status: "SUBMITTED_NOT_CONFIRMED", signature };
  }
}
