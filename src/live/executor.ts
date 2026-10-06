import { signatureSubmissionPolicy } from "./protocol.js";
import { assessExpiredRecovery, type RecoveryEvidence } from "./expired-recovery.js";
import { decodeIndependentAlt } from "./cpi-semantic-evidence.js";
import { Decimal } from "decimal.js";
import { normalizeJupiterPriceImpact } from "../execution/jupiter-price-impact.js";
import { USDC_MINT, WSOL_MINT } from "../domain/assets.js";
import { LiveJournal, type LiveAttempt } from "./journal.js";
import {
  assertAuthority,
  protocolDigest,
  parseExecutionProtocol,
  executionAsset,
  isDynamicExecutionProtocol,
  digest,
  ExitAuthoritySchema,
  AutonomousLinkedExitAuthoritySchema,
  assertLinkedExitProtocol,
  type AutonomousLinkedExitAuthority,
  type ExitAuthority,
  type ExecutionProtocol,
  type ExecutionAsset,
} from "./protocol.js";
import {
  associatedAccount,
  reviewTransaction,
  verifyExternalSignature,
  type TransactionReview,
} from "./transaction-review.js";
import { settleChainTransaction } from "./chain-accounting.js";
import { snapshotToken, type LiveNetwork, type WalletSnapshot, type Simulation } from "./adapters.js";

/** Bounded supervised commands; no intake stream, timer trading loop or secret key. */
export class LiveExecutor {
  private readonly asset: ExecutionAsset;
  constructor(
    readonly journal: LiveJournal,
    readonly protocol: ExecutionProtocol,
    private readonly network: LiveNetwork,
    private readonly now: () => number = Date.now,
  ) {
    this.protocol = Object.freeze(parseExecutionProtocol(protocol));
    this.asset = Object.freeze(executionAsset(this.protocol));
    if (journal.status().protocolDigest !== protocolDigest(protocol))
      throw new Error("EXECUTOR_PROTOCOL_BINDING_MISMATCH");
    const exit = journal.exitAuthority();
    if (exit && this.protocol.version === "AUTONOMOUS_SINGLE_POSITION_V1")
      assertLinkedExitProtocol(this.protocol, AutonomousLinkedExitAuthoritySchema.parse(exit));
    if (
      exit &&
      ExitAuthoritySchema.parse(exit).parentProtocolDigest !==
        protocolDigest(protocol)
    )
      throw new Error("EXECUTOR_EXIT_AUTHORITY_BINDING_MISMATCH");
  }
  private attempt(id: string): LiveAttempt {
    const a = this.journal.get(id);
    if (!a) throw new Error("ATTEMPT_NOT_FOUND");
    return a;
  }
  private authority(
    side: "BUY" | "SELL",
    funds: boolean,
    existingSubmission = false,
  ): void {
    const exit = this.journal.exitAuthority() as ExitAuthority | null;
    if (exit?.version === "AUTONOMOUS_LINKED_EXIT_ONLY_V1") {
      assertLinkedExitProtocol(this.protocol, exit);
      if (side !== "SELL") throw Error("LINKED_EXIT_BUY_FORBIDDEN");
      if (existingSubmission) throw Error("LINKED_EXIT_REBROADCAST_FORBIDDEN");
    }
    if (side === "SELL" && exit) {
      if (this.now() < exit.validFromMs || this.now() >= exit.exitUntilMs)
        throw new Error("AUTHORIZATION_EXPIRED_OR_NOT_STARTED");
      if (funds && exit.approval !== "FUNDS_AUTHORIZED")
        throw new Error("FUNDS_NOT_AUTHORIZED");
    } else assertAuthority(this.protocol, side, this.now(), funds);
    const status = this.journal.status();
    if (status.takeover) throw new Error("MANUAL_TAKEOVER_ACTIVE");
    if (side === "BUY" && status.entryStopped && !existingSubmission)
      throw new Error("ENTRY_STOPPED");
  }
  private review(a: LiveAttempt): TransactionReview {
    if (!a.data.review) throw new Error("NO_TRANSACTION_REVIEW");
    return a.data.review as unknown as TransactionReview;
  }
  private checkSnapshot(side: "BUY" | "SELL", snapshot: WalletSnapshot): void {
    const status = this.journal.status(),
      p = this.protocol;
    if (!snapshot.wsolAbsent) throw new Error("PREEXISTING_WSOL_UNSUPPORTED");
    if (snapshotToken(snapshot, this.asset).raw !== status.positionRaw)
      throw new Error("WALLET_POSITION_DRIFT");
    if (BigInt(snapshot.walletLamports) > BigInt(p.fundingCapLamports))
      throw new Error("DEDICATED_WALLET_FUNDING_CAP");
    const last = [...status.attempts].reverse().find((a) => a.data.settlement)
      ?.data.settlement as Record<string, unknown> | undefined;
    if (last && snapshot.walletLamports !== last.walletPostRaw)
      throw new Error("WALLET_NATIVE_BALANCE_DRIFT");
    if (
      side === "BUY" &&
      BigInt(snapshot.walletLamports) <
        BigInt(p.buyLamports) +
          BigInt(p.networkFeeCapLamports) +
          BigInt(p.accountRentCapLamports) +
          BigInt(p.exitReserveLamports)
    )
      throw new Error("INSUFFICIENT_BUY_AND_EXIT_RESERVE");
    if (
      side === "SELL" &&
      BigInt(snapshot.walletLamports) <
        BigInt(p.networkFeeCapLamports) + BigInt(p.accountRentCapLamports)
    )
      throw new Error("INSUFFICIENT_EXIT_GAS");
  }
  private checkSimulation(
    side: "BUY" | "SELL",
    review: TransactionReview,
    before: WalletSnapshot,
    sim: Simulation,
  ): void {
    const p = this.protocol,
      fee = BigInt(sim.feeLamports),
      tip = BigInt(review.tipLamports ?? "0"),
      rent = BigInt(sim.rentAfterLamports) - BigInt(snapshotToken(before, this.asset).rent);
    if (
      !sim.wsolClosed ||
      rent < 0n ||
      rent > BigInt(p.accountRentCapLamports) ||
      fee + tip > BigInt(p.networkFeeCapLamports) ||
      fee + tip + BigInt(this.journal.status().networkFeeRaw) +
        BigInt(this.journal.status().deliveryTipRaw ?? "0") >
        BigInt(p.totalFeeBudgetLamports)
    )
      throw new Error("SIMULATION_FEE_RENT_SCOPE");
    const tokenDelta = BigInt(sim.tokenAfterRaw) - BigInt(snapshotToken(before, this.asset).raw),
      nativeDelta =
        BigInt(sim.walletAfterLamports) -
        BigInt(before.walletLamports) +
        fee +
        tip +
        rent;
    if (
      side === "BUY"
        ? tokenDelta < BigInt(review.minimumOutputRaw) ||
          nativeDelta >= 0n ||
          -nativeDelta > BigInt(review.inputRaw)
        : tokenDelta !== -BigInt(review.inputRaw) ||
          nativeDelta < BigInt(review.minimumOutputRaw)
    )
      throw new Error("SIMULATION_ECONOMIC_SCOPE");
    if (
      side === "BUY" &&
      BigInt(sim.walletAfterLamports) < BigInt(p.exitReserveLamports)
    )
      throw new Error("SIMULATION_EXIT_RESERVE");
  }
  async prepare(side: "BUY" | "SELL"): Promise<LiveAttempt> {
    this.authority(side, false);
    const id = this.journal.atomic(() => {
      const linked = this.journal.exitAuthority();
      if (linked?.version === "AUTONOMOUS_LINKED_EXIT_ONLY_V1")
        this.assertLinkedUnsignedExit(AutonomousLinkedExitAuthoritySchema.parse(linked));
      const s = this.journal.status();
      const expired = s.attempts.filter(a=>["ABANDONED_EXPIRED_UNSIGNED","ABANDONED_EXPIRED_SIGNED_UNSENT","EXPIRED_SUBMITTED_NOT_LANDED"].includes(a.state));
      if (side==="SELL" && expired.length) {
        const grant=this.journal.exitAuthority() as ExitAuthority | null;
        if (!grant || expired.some(a=>grant.validFromMs<=Number((a.data.recoveryReceipt as {createdAtMs:number}).createdAtMs)))
          throw Error("RECOVERED_SELL_REQUIRES_NEW_EXIT_AUTHORITY");
      }
      const cancelledBuy = side === "BUY" ? this.journal.get("BUY") : undefined;
      if (cancelledBuy?.state === "UNSIGNED_CANCELLED") {
        this.journal.transition("BUY", "UNSIGNED_CANCELLED", "CREATED", {
          unsignedPreparationCount: 1,
        });
        return "BUY";
      }
      if (s.obligations.length) {
        const pending = s.obligations[0]!;
        if (
          s.obligations.length === 1 &&
          pending.side === side &&
          pending.state === "ATTENTION" &&
          pending.data.signatureNeverRequested === true &&
          !pending.data.signingRequestIssued &&
          !pending.data.signature &&
          Number(pending.data.unsignedPreparationCount ?? 1) < 3
        ) {
          this.journal.transition(pending.id, "ATTENTION", "CREATED", {
            unsignedPreparationCount:
              Number(pending.data.unsignedPreparationCount ?? 1) + 1,
          });
          return pending.id;
        }
        throw new Error("UNRESOLVED_TRANSACTION_BLOCKS_PREPARE");
      }
      const exit = this.journal.exitAuthority() as ExitAuthority | null;
      const maximumSellAttempts = exit
        ? exit.baseSellAttemptCount + exit.maxAdditionalSellAttempts
        : this.protocol.maxSellAttempts;
      if (
        side === "SELL" &&
        (BigInt(s.positionRaw) <= 0n ||
          s.attempts.filter((a) => a.side === "SELL" && a.data.signature)
            .length >= maximumSellAttempts)
      )
        throw new Error("NO_POSITION_OR_EXIT_ATTEMPTS_EXHAUSTED");
      const id =
        side === "BUY"
          ? "BUY"
          : `SELL-${s.attempts.filter((a) => a.side === "SELL").length + 1}`;
      this.journal.create(
        id,
        side,
        side === "BUY" ? this.protocol.buyLamports : s.positionRaw,
      );
      return id;
    });
    const a = this.attempt(id),
      wallet = this.protocol.wallet;
    try {
      const exit = this.journal.exitAuthority() as ExitAuthority | null;
      this.network.beginPreparation?.(Math.min(this.now() + 300000, side === "BUY"
        ? this.protocol.entryUntilMs : (exit?.exitUntilMs ?? this.protocol.exitUntilMs)));
      const accounts = {
        wallet,
        usdcAccount: !isDynamicExecutionProtocol(this.protocol) ? await associatedAccount(wallet, USDC_MINT) : "",
        ...(isDynamicExecutionProtocol(this.protocol) ? {
          asset: this.asset, tokenAccount: await associatedAccount(wallet, this.asset.tokenMint) } : {}),
        wsolAccount: await associatedAccount(wallet, WSOL_MINT),
      };
      const before = await this.network.snapshot(accounts);
      this.checkSnapshot(side, before);
      this.authority(side, false);
      const order = await this.network.order(
        side,
        wallet,
        a.amount,
        this.protocol.maxSlippageBps,
      );
      if (
        order.router !== (this.protocol.transport === "DIRECT_DAMM_V2_SELF_RPC" ? "meteora-damm-v2" : "metis") ||
        order.inAmount !== a.amount ||
        order.inputMint !== (side === "BUY" ? WSOL_MINT : this.asset.tokenMint) ||
        order.outputMint !== (side === "BUY" ? this.asset.tokenMint : WSOL_MINT) ||
        order.feeBps > this.protocol.maxPlatformFeeBps
      )
        throw new Error("ORDER_SCOPE_MISMATCH");
      const impact = normalizeJupiterPriceImpact(order);
      if (
        impact.status !== "AVAILABLE" ||
        !new Decimal(impact.normalizedPct!)
          .abs()
          .lte(this.protocol.maxPriceImpactPct)
      )
        throw new Error("LIVE_PRICE_IMPACT_GATE");
      const review = await reviewTransaction(
        order.transaction,
        {
          wallet,
          ...(this.protocol.version === "AUTONOMOUS_SINGLE_POSITION_V1"?{executionScope:this.protocol.executionScope}:{}),
          ...(this.protocol.version === "AUTONOMOUS_SINGLE_POSITION_V1" && this.protocol.executionPurpose ? {executionPurpose:this.protocol.executionPurpose} : {}),
          ...(this.protocol.version === "AUTONOMOUS_SINGLE_POSITION_V1" && this.protocol.deliveryPolicy ? {deliveryPolicy:this.protocol.deliveryPolicy} : {}),
          ...(isDynamicExecutionProtocol(this.protocol) ? { asset: this.asset } : {}),
          side,
          inputRaw: a.amount,
          quotedOutputRaw: order.outAmount,
          maxSlippageBps: this.protocol.maxSlippageBps,
          maxPlatformFeeBps: this.protocol.maxPlatformFeeBps,
          networkFeeCapLamports: this.protocol.networkFeeCapLamports,
          ...(order.poolAddress ? { poolAddress: order.poolAddress } : {}),
          requestId: order.requestId,
        },
        async (key) => {
          if (this.protocol.transport !== "JUPITER_V1_SELF_RPC") return this.network.resolveLookup(key);
          const fact = order.cpiEvidence?.alt[key];
          if (!fact) throw Error("CPI_ALT_EVIDENCE");
          return decodeIndependentAlt(fact.account);
        },
        order.cpiEvidence,
      );
      if (
        this.protocol.transport === "JUPITER_V1_SELF_RPC" &&
        (review.abiEvidence !== (this.protocol.version==="AUTONOMOUS_SINGLE_POSITION_V1"&&this.protocol.executionScope==="CLASSIC_SOL_EXACT_JUPITER_V1_METEORA_DLMM"?"OFFICIAL_V1_SINGLE_METEORA_DLMM":"OFFICIAL_V1_SINGLE_RAYDIUM_CLMM") ||
          !order.poolAddress || this.protocol.version==="AUTONOMOUS_SINGLE_POSITION_V1"&&this.protocol.executionScope==="CLASSIC_SOL_EXACT_JUPITER_V1_METEORA_DLMM"&&order.poolAddress!==this.protocol.executionPool)
      )
        throw new Error("V1_FIXED_ABI_REQUIRED");
      if (this.protocol.transport === "DIRECT_DAMM_V2_SELF_RPC" &&
        (review.abiEvidence !== "OFFICIAL_DIRECT_DAMM_V2_EXACT_IN" || this.protocol.version !== "AUTONOMOUS_SINGLE_POSITION_V1" || order.poolAddress !== this.protocol.executionPool))
        throw Error("DAMM_FIXED_ABI_REQUIRED");
      this.network.assertCurrentEvidence?.();
      const simulation = await this.network.simulate(order.transaction, review);
      this.checkSimulation(side, review, before, simulation);
      if (!(await this.network.blockhashValid(review.blockhash)))
        throw new Error("BLOCKHASH_EXPIRED");
      this.authority(side, false);
      this.network.assertCurrentEvidence?.();
      this.journal.transition(id, "CREATED", "REVIEWED", {
        ...(this.protocol.version === "AUTONOMOUS_SINGLE_POSITION_V1" ? {
          independentEvidence: { cpiEvidence: order.cpiEvidence, poolAddress: order.poolAddress } } : {}),
        programIdentityProof: order.programIdentityProof,
        unsignedTransaction: order.transaction,
        requestId: order.requestId,
        review,
        before,
        simulation,
        reviewedAtMs: this.now(),
        ...(order.quoteExpiresAtMs !== undefined ? { quoteExpiresAtMs: order.quoteExpiresAtMs } : {}),
        finalitySync: order.finalitySync,
        requestEvidence: this.network.requestEvidence?.(),
        orderEvidence: {
          inAmount: order.inAmount,
          outAmount: order.outAmount,
          feeBps: order.feeBps,
          router: order.router,
          ...(order.blockhashContextSlot !== undefined ? {blockhashContextSlot:order.blockhashContextSlot} : {}),
          ...(order.lastValidBlockHeight !== undefined ? {lastValidBlockHeight:order.lastValidBlockHeight} : {}),
          impact,
        },
      });
      return this.attempt(id);
    } catch (error) {
      const reason =
        error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "PREPARATION_FAILED";
      this.journal.transition(id, "CREATED", "ATTENTION", {
        reason,
        signatureNeverRequested: true,
        finalitySync: this.network.finalityEvidence?.(),
        requestEvidence: this.network.requestEvidence?.(),
      });
      throw new Error(reason);
    } finally { this.network.finishPreparation?.(); }
  }
  signingRequest(id: string): Record<string, unknown> {
    const a = this.attempt(id);
    this.authority(a.side, true);
    const linked = this.journal.exitAuthority();
    if (linked?.version === "AUTONOMOUS_LINKED_EXIT_ONLY_V1" &&
        (id !== linked.attemptId || a.amount !== linked.remainingRaw || a.data.signingRequestIssued))
      throw Error("LINKED_EXIT_SIGNATURE_ALREADY_REQUESTED_OR_WRONG_AMOUNT");
    if (
      a.state !== "REVIEWED" ||
      this.now() >= Number(a.data.quoteExpiresAtMs ?? Infinity) ||
      this.now() - Number(a.data.reviewedAtMs) > this.protocol.maxReviewAgeMs
    )
      throw new Error("SIGNING_REVIEW_EXPIRED_OR_WRONG_STATE");
    this.journal.transition(id, "REVIEWED", "REVIEWED", {
      signingRequestIssued: true,
    });
    const exit = this.journal.exitAuthority() as ExitAuthority | null;
    return {
      version: "LIVE_SIGNING_REQUEST_V1",
      submissionPolicy: signatureSubmissionPolicy(this.protocol),
      experimentId: this.protocol.experimentId,
      attemptId: id,
      protocolDigest: this.journal.status().protocolDigest,
      wallet: this.protocol.wallet,
      review: this.review(a),
      unsignedTransaction: a.data.unsignedTransaction,
      fundsAuthorized: true,
      authorization: this.protocol,
      exitAuthority: exit,
      exitAuthorityDigest: exit ? digest(JSON.stringify(exit)) : null,
      expiresAtMs: Math.min(
        Number(a.data.reviewedAtMs) + this.protocol.maxReviewAgeMs,
        Number(a.data.quoteExpiresAtMs ?? Infinity),
        a.side === "BUY"
          ? this.protocol.entryUntilMs
          : (exit?.exitUntilMs ?? this.protocol.exitUntilMs),
      ),
      signOnly: true,
      ...(this.protocol.version === "AUTONOMOUS_SINGLE_POSITION_V1" ? {
        independentEvidence: a.data.independentEvidence } : {}),
    };
  }
  async importSignature(id: string, signed: string): Promise<void> {
    const a = this.attempt(id);
    if (this.protocol.approval !== "FUNDS_AUTHORIZED" || a.state !== "REVIEWED")
      throw new Error("SIGNATURE_INTAKE_NOT_AUTHORIZED_OR_WRONG_STATE");
    const verified = verifyExternalSignature(
      String(a.data.unsignedTransaction),
      signed,
      this.protocol.wallet,
    );
    // Save even if current authority expires while the wallet is signing. A valid
    // signature is a responsibility, not something expiry permits us to forget.
    let authorityAtSignatureIntake = "VALID";
    try {
      this.authority(a.side, true);
    } catch {
      authorityAtSignatureIntake = "EXPIRED";
    }
    this.journal.transition(id, "REVIEWED", "SIGNED", {
      ...verified,
      signedTransaction: signed,
      signedAtMs: this.now(),
      authorityAtSignatureIntake,
    });
    if (authorityAtSignatureIntake !== "VALID")
      this.journal.stopEntry("SIGNATURE_RECEIVED_WITHOUT_CURRENT_AUTHORITY");
  }
  async submit(id: string, rebroadcast = false): Promise<void> {
    const a = this.attempt(id);
    const delivery = this.protocol.version === "AUTONOMOUS_SINGLE_POSITION_V1" ? this.protocol.deliveryPolicy : undefined;
    this.authority(a.side, true, rebroadcast);
    if (rebroadcast ? a.state !== "UNKNOWN" : a.state !== "SIGNED")
      throw new Error("SUBMIT_STATE_REQUIRES_EXPLICIT_SAME_BYTES_REBROADCAST");
    // A late valid signature remains a responsibility. Reject its FIRST send if
    // quote evidence expired; do not alter UNKNOWN/same-byte recovery semantics.
    const assertQuoteCurrent = () => {
      if ((!rebroadcast || delivery) && this.now() >= Number(a.data.quoteExpiresAtMs ?? Infinity))
        throw Error("PREFLIGHT_QUOTE_EXPIRED");
      if (delivery && (!Number.isSafeInteger(a.data.quoteExpiresAtMs) ||
          this.now() - Number(a.data.reviewedAtMs) >= this.protocol.maxReviewAgeMs))
        throw Error("SIGNING_REVIEW_EXPIRED_OR_WRONG_STATE");
    };
    const assertDeliveryBound = (current: LiveAttempt) => {
      if (!delivery) return;
      const count = Number(current.data.submissionCount ?? 0);
      if (!Number.isSafeInteger(count) || count < 0 || count >= delivery.maxBroadcasts)
        throw Error("DELIVERY_BROADCAST_BOUND_EXHAUSTED");
      if (rebroadcast && (!Number.isSafeInteger(current.data.lastDeliveryAtMs) ||
          this.now() - Number(current.data.lastDeliveryAtMs) < delivery.broadcastIntervalMs))
        throw Error("DELIVERY_INTERVAL_NOT_REACHED");
    };
    assertQuoteCurrent();
    assertDeliveryBound(a);
    const review = this.review(a);
    if (!(await this.network.blockhashValid(review.blockhash))) {
      this.journal.transition(id, a.state, "UNKNOWN", {
        reason: "BLOCKHASH_EXPIRED_TAKEOVER_NO_RESIGN",
      });
      this.journal.stopEntry("EXPIRED_SIGNED_TRANSACTION");
      throw new Error("BLOCKHASH_EXPIRED_TAKEOVER_NO_RESIGN");
    }
    const verifyPrograms = async (snapshotSlot?: string) => {
      if (this.protocol.transport !== "JUPITER_V1_SELF_RPC" && this.protocol.transport !== "DIRECT_DAMM_V2_SELF_RPC") return;
      try {
        const prior = a.data.programIdentityProof as {slot?:number;attestationDigest?:string} | undefined;
        if (!prior || !this.network.verifyProgramIdentity || !Number.isSafeInteger(prior.slot))
          throw Error("PROGRAM_ATTESTATION_MISSING");
        const proof = await this.network.verifyProgramIdentity(Math.max(prior.slot!, Number(snapshotSlot ?? prior.slot)));
        if (proof.attestationDigest !== prior.attestationDigest) throw Error("PROGRAM_ATTESTATION_STALE");
        this.journal.transition(id, a.state, a.state, {preSubmitProgramProof:proof,
          preSubmitRequestEvidence:this.network.requestEvidence?.()});
      } catch (error) {
        this.journal.transition(id, a.state, a.state, {preSubmitProgramIdentityFailed:true,
          preSubmitProgramIdentityError:error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "PROGRAM_IDENTITY_PRECHECK_FAILED",
          preSubmitRequestEvidence:this.network.requestEvidence?.()});
        this.journal.stopEntry("PRE_SUBMIT_PROGRAM_IDENTITY_FAILED");
        throw error;
      }
    };
    if (!rebroadcast) {
      const before = await this.network.snapshot(review);
      this.checkSnapshot(a.side, before);
      await verifyPrograms(before.slot);
      assertQuoteCurrent();
      const sim = await this.network.simulate(
        String(a.data.signedTransaction),
        review,
      );
      this.checkSimulation(a.side, review, before, sim);
    }
    if (rebroadcast) await verifyPrograms();
    this.authority(a.side, true, rebroadcast);
    assertQuoteCurrent();
    // Durable commit precedes the first byte sent to Jupiter. Crash here is UNKNOWN.
    this.journal.atomic(() => {
      const current = this.attempt(id);
      if (delivery) {
        if (current.state !== a.state || current.data.submissionCount !== a.data.submissionCount ||
            current.data.signature !== a.data.signature || current.data.signedTransaction !== a.data.signedTransaction)
          throw Error("DELIVERY_ATTEMPT_CHANGED");
        assertQuoteCurrent();
        assertDeliveryBound(current);
      }
      this.journal.transition(id, a.state, "UNKNOWN", {
        submissionStartedAtMs: delivery && rebroadcast ? a.data.submissionStartedAtMs : this.now(),
        submissionCount: Number(a.data.submissionCount ?? 0) + 1,
        ...(delivery ? {lastDeliveryAtMs:this.now()} : {}),
        lastSubmissionKind: rebroadcast
          ? "SAME_SIGNED_BYTES_REBROADCAST"
          : "FIRST_SUBMISSION",
      });
    });
    try {
      const response = (await this.network.execute(
        String(a.data.signedTransaction),
        String(a.data.requestId),
      )) as Record<string, unknown>;
      if (response?.signature && response.signature !== a.data.signature) {
        this.journal.takeover("PROVIDER_SIGNATURE_MISMATCH");
        throw new Error("PROVIDER_SIGNATURE_MISMATCH");
      }
      // A provider Success/Failed is diagnostic only, never a fill or absence proof.
      this.journal.transition(id, "UNKNOWN", "UNKNOWN", {
        providerReceipt: {
          status: response?.status,
          code: response?.code,
          signature: response?.signature,
        },
      });
    } catch {
      this.journal.transition(id, "UNKNOWN", "UNKNOWN", {
        reason: "SUBMISSION_RESPONSE_UNKNOWN",
      });
      this.journal.stopEntry("SUBMISSION_RESPONSE_UNKNOWN");
    }
  }
  async reconcile(id: string): Promise<void> {
    const a = this.attempt(id);
    if (["ABANDONED_EXPIRED_UNSIGNED", "ABANDONED_EXPIRED_SIGNED_UNSENT", "EXPIRED_SUBMITTED_NOT_LANDED"].includes(a.state))
      throw Error("RECOVERY_TERMINAL_NO_RECONCILE");
    if (!a.data.signature) return;
    const raw = await this.network.finalizedTransaction(
      String(a.data.signature),
    );
    if (raw === null) {
      if (["SETTLED", "CHAIN_FAILED"].includes(a.state))
        throw new Error("FINALIZED_EVIDENCE_TEMPORARILY_UNAVAILABLE");
      const status = await this.network.signatureStatus(
        String(a.data.signature),
      );
      const valid = await this.network.blockhashValid(this.review(a).blockhash);
      this.journal.transition(id, a.state, "UNKNOWN", {
        recovery: {
          observedAtMs: this.now(),
          signatureStatus: status,
          blockhashValid: valid,
          action: valid
            ? "RECONCILE_OR_EXPLICIT_SAME_BYTES_REBROADCAST"
            : "TAKEOVER_NO_RESIGN",
        },
      });
      this.journal.stopEntry("UNRESOLVED_SIGNED_TRANSACTION");
      return;
    }
    let evidence: Record<string, unknown>;
    try {
      evidence = settleChainTransaction(raw, {
        review: this.review(a),
        signedTransaction: String(a.data.signedTransaction),
        signature: String(a.data.signature),
        side: a.side,
        networkFeeCapLamports: this.protocol.networkFeeCapLamports,
      });
    } catch (error) {
      this.journal.transition(id, a.state, "ATTENTION", {
        unreconciledFinalizedEvidence: raw,
        reason:
          error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "CHAIN_EVIDENCE_INVALID",
      });
      this.journal.takeover("FINALIZED_TRANSACTION_NEEDS_ACCOUNTING_TAKEOVER");
      throw error;
    }
    this.journal.settle(
      id,
      String(a.data.signature),
      evidence,
      Boolean(evidence.failed),
    );
    if ((evidence.violations as unknown[]).length)
      this.journal.takeover("CHAIN_ACCOUNTING_OR_AUTHORIZATION_VIOLATION");
    const current = await this.network.snapshot(
      this.review(a),
      String(evidence.slot),
    );
    const latest = [...this.journal.attempts()]
      .reverse()
      .find((a) => a.data.settlement)?.data.settlement as Record<
      string,
      unknown
    >;
    if (
      snapshotToken(current, this.asset).raw !== this.journal.status().positionRaw ||
      current.walletLamports !== latest.walletPostRaw ||
      !current.wsolAbsent
    ) {
      this.journal.takeover("POST_FINALIZATION_BALANCE_DRIFT");
      throw new Error("POST_FINALIZATION_BALANCE_DRIFT");
    }
    const settled = this.attempt(id);
    this.journal.transition(id, settled.state, settled.state, {
      balanceReconciled: true,
      balanceSnapshot: current,
    });
  }
  async reconcileAll(): Promise<void> {
    for (const a of this.journal.attempts())
      if (
        a.data.signature &&
        !["ABANDONED_EXPIRED_UNSIGNED", "ABANDONED_EXPIRED_SIGNED_UNSENT", "EXPIRED_SUBMITTED_NOT_LANDED"].includes(a.state) &&
        (!a.data.balanceReconciled ||
          !["SETTLED", "CHAIN_FAILED"].includes(a.state))
      )
        await this.reconcile(a.id);
  }
  async authorizeExit(raw: unknown): Promise<void> {
    if (this.protocol.version === "AUTONOMOUS_SINGLE_POSITION_V1") {
      const exit = AutonomousLinkedExitAuthoritySchema.parse(raw);
      assertLinkedExitProtocol(this.protocol, exit);
      if (exit.approval !== "FUNDS_AUTHORIZED" || this.protocol.approval !== "FUNDS_AUTHORIZED") throw Error("FUNDS_NOT_AUTHORIZED");
      if (this.now() < exit.validFromMs || this.now() >= exit.exitUntilMs) throw Error("AUTHORIZATION_EXPIRED_OR_NOT_STARTED");
      const check = () => {
        if (this.now() < exit.validFromMs || this.now() >= exit.exitUntilMs) throw Error("AUTHORIZATION_EXPIRED_OR_NOT_STARTED");
        const existing = this.journal.exitAuthority();
        if (existing && JSON.stringify(existing) !== JSON.stringify(exit)) throw Error("LINKED_EXIT_AUTHORITY_ALREADY_BOUND");
        this.assertLinkedUnsignedExit(exit);
        if (!existing && (digest(JSON.stringify(this.journal.get(exit.attemptId))) !== exit.baseAttemptDigest ||
            Number(this.journal.get(exit.attemptId)!.data.unsignedPreparationCount ?? 1) !== exit.baseUnsignedPreparationCount))
          throw Error("LINKED_EXIT_BASE_ATTEMPT_CHANGED");
        const s = this.journal.status();
        if (BigInt(s.networkFeeRaw) + BigInt(s.deliveryTipRaw) + BigInt(this.protocol.networkFeeCapLamports) > BigInt(this.protocol.totalFeeBudgetLamports))
          throw Error("EXIT_AUTHORITY_EXCEEDS_ORIGINAL_FEE_BUDGET");
        return existing;
      };
      check();
      this.checkSnapshot("SELL", await this.network.snapshot({wallet:this.protocol.wallet,
        asset:this.asset,
        tokenAccount:await associatedAccount(this.protocol.wallet,this.asset.tokenMint),
        wsolAccount:await associatedAccount(this.protocol.wallet,WSOL_MINT),usdcAccount:""}));
      this.journal.atomic(() => { if (!check()) this.journal.authorizeExit(exit); });
      return; // An identical unsigned resume never replenishes request budget.
    }
    const exit = ExitAuthoritySchema.parse(raw),
      p = this.protocol;
    if (
      exit.parentProtocolDigest !== protocolDigest(p) ||
      exit.wallet !== p.wallet ||
      exit.tokenMint !== p.tokenMint ||
      this.now() < exit.validFromMs ||
      this.now() >= exit.exitUntilMs ||
      exit.exitUntilMs - exit.validFromMs > 1800000
    )
      throw new Error("EXIT_AUTHORITY_BINDING_OR_WINDOW");
    if (p.approval !== "FUNDS_AUTHORIZED")
      throw new Error("FUNDS_NOT_AUTHORIZED");
    const snapshot = await this.network.snapshot({
      wallet: p.wallet,
      usdcAccount: await associatedAccount(p.wallet, USDC_MINT),
      wsolAccount: await associatedAccount(p.wallet, WSOL_MINT),
    });
    this.checkSnapshot("SELL", snapshot);
    this.journal.atomic(() => {
      const s = this.journal.status();
      if (
        s.obligations.length ||
        s.attempts.some(
          (a) => !["UNSIGNED_CANCELLED", "ABANDONED_EXPIRED_UNSIGNED", "ABANDONED_EXPIRED_SIGNED_UNSENT", "EXPIRED_SUBMITTED_NOT_LANDED"].includes(a.state) && !a.data.balanceReconciled,
        ) ||
        s.positionRaw !== exit.remainingRaw ||
        BigInt(exit.remainingRaw) <= 0n ||
        s.attempts.filter((a) => a.side === "SELL" && a.data.signature)
          .length !== exit.baseSellAttemptCount
      )
        throw new Error("UNRESOLVED_OR_CHANGED_POSITION_NO_NEW_EXIT_AUTHORITY");
      if (
        BigInt(s.networkFeeRaw) +
          BigInt(exit.maxAdditionalSellAttempts) *
            BigInt(p.networkFeeCapLamports) >
        BigInt(p.totalFeeBudgetLamports)
      )
        throw new Error("EXIT_AUTHORITY_EXCEEDS_ORIGINAL_FEE_BUDGET");
      this.journal.authorizeExit(exit);
    });
  }
  private assertLinkedUnsignedExit(exit: AutonomousLinkedExitAuthority): void {
    const s = this.journal.status(), buy = this.journal.get("BUY"), sell = this.journal.get(exit.attemptId);
    if (s.takeover || !s.entryStopped || s.closed || s.positionRaw !== exit.remainingRaw ||
        s.attempts.length !== 2 || s.obligations.length !== 1 || s.obligations[0]?.id !== exit.attemptId ||
        buy?.state !== "SETTLED" || buy.data.balanceReconciled !== true || buy.data.signature !== exit.buySignature ||
        (buy.data.settlement as {chainEvidenceDigest?:string;commitment?:string})?.chainEvidenceDigest !== exit.buySettlementDigest ||
        (buy.data.settlement as {commitment?:string})?.commitment !== "finalized" ||
        sell?.side !== "SELL" || sell.state !== "ATTENTION" || sell.amount !== exit.remainingRaw ||
        sell.data.signatureNeverRequested !== true || sell.data.signingRequestIssued ||
        ["signature","signedTransaction","settlement","submissionStartedAtMs","exportedArtifact","signedArtifact"].some(k=>Object.hasOwn(sell.data,k)) ||
        Number(sell.data.submissionCount ?? 0) !== 0 || Number(sell.data.unsignedPreparationCount ?? 1) < exit.baseUnsignedPreparationCount ||
        Number(sell.data.unsignedPreparationCount ?? 1) >= 3)
      throw Error("LINKED_EXIT_UNSIGNED_POSITION_REQUIRED");
    this.journal.assertNoSignedHistory(exit.attemptId);
  }
  abandonExpiredUnsigned(id: string, evidence: RecoveryEvidence) {
    return this.journal.atomic(() => {
      this.journal.assertNoSignedHistory(id);
      const a=this.attempt(id), status=this.journal.status();
      if (status.obligations.length!==1 || status.obligations[0]!.id!==id)
        throw Error("RECOVERY_OTHER_OBLIGATIONS");
      const receipt=assessExpiredRecovery(this.protocol,a,status.positionRaw,evidence,this.now());
      this.journal.stopEntry("ABANDONED_EXPIRED_UNSIGNED_NO_NEW_ENTRY");
      this.journal.transition(id,"REVIEWED","ABANDONED_EXPIRED_UNSIGNED",{recoveryReceipt:receipt});
      return receipt;
    });
  }
  abandonExpiredSignedUnsent(id: string, evidence: RecoveryEvidence) {
    return this.journal.atomic(() => {
      this.journal.assertSignedUnsentHistory(id);
      const a=this.attempt(id), status=this.journal.status();
      if(status.obligations.length!==1 || status.obligations[0]!.id!==id) throw Error("RECOVERY_OTHER_OBLIGATIONS");
      const receipt=assessExpiredRecovery(this.protocol,a,status.positionRaw,evidence,this.now(),"SIGNED_UNSENT");
      this.journal.stopEntry("ABANDONED_EXPIRED_SIGNED_UNSENT_NO_NEW_ENTRY");
      this.journal.transition(id,"SIGNED","ABANDONED_EXPIRED_SIGNED_UNSENT",{recoveryReceipt:receipt});
      return receipt;
    });
  }
  expireSubmittedNotLanded(id: string, evidence: RecoveryEvidence) {
    return this.journal.atomic(() => {
      const delivery = this.protocol.version === "AUTONOMOUS_SINGLE_POSITION_V1" ? this.protocol.deliveryPolicy : undefined;
      this.journal.assertSubmittedHistory(id, delivery?.maxBroadcasts ?? 1, delivery?.broadcastIntervalMs ?? 0);
      const a = this.attempt(id), status = this.journal.status();
      if (status.obligations.length !== 1 || status.obligations[0]!.id !== id) throw Error("RECOVERY_OTHER_OBLIGATIONS");
      const receipt = assessExpiredRecovery(this.protocol, a, status.positionRaw, evidence, this.now(), "SUBMITTED");
      this.journal.stopEntry("EXPIRED_SUBMITTED_NOT_LANDED_NO_NEW_ENTRY");
      this.journal.transition(id, "UNKNOWN", "EXPIRED_SUBMITTED_NOT_LANDED", { recoveryReceipt: receipt });
      return receipt;
    });
  }
  cancelUnsigned(id: string, reason: string): void {
    this.journal.atomic(() => {
      const a = this.attempt(id);
      if (
        a.data.signature ||
        a.data.signingRequestIssued ||
        !["ATTENTION", "CREATED", "REVIEWED"].includes(a.state) ||
        !reason.trim()
      )
        throw new Error("CANNOT_CANCEL_POSSIBLY_SIGNED_TRANSACTION");
      this.journal.transition(id, a.state, "UNSIGNED_CANCELLED", {
        cancellationReason: reason,
        cancelledAtMs: this.now(),
        signatureNeverRequested: true,
      });
    });
  }
  handoffPacket(): Record<string, unknown> {
    const status = this.journal.status();
    return {
      version: "LIVE_TAKEOVER_PACKET_V1",
      createdAtMs: this.now(),
      experimentId: this.protocol.experimentId,
      wallet: this.protocol.wallet,
      protocol: this.protocol,
      status,
      responsibility: "OPEN_UNTIL_CHAIN_RECONCILIATION_AND_OPERATOR_RESOLUTION",
      pending: status.obligations.map((a) => ({
        attemptId: a.id,
        state: a.state,
        signature: a.data.signature ?? null,
        signedTransaction: a.data.signedTransaction ?? null,
        requestId: a.data.requestId ?? null,
        review: a.data.review ?? null,
        recovery: a.data.recovery ?? null,
      })),
      instructions: [
        "Stop entry and retain the original database including WAL/SHM; do not reset or initialize a replacement experiment.",
        "Query every persisted signature at finalized with searchTransactionHistory=true; null, cached-order failure and expired blockhash do not prove absence.",
        "If an authorized transaction is unresolved, only identical signed bytes may be rebroadcast; never obtain a fresh quote/signature as a retry.",
        "If exit authority expired or SELL attempts are exhausted, run reconcile all first. Only after old signatures and balances resolve, approve a LIVE_EXIT_ONLY_AUTHORIZATION_V1 linked to this protocol digest and exact remaining quantity; run authorize-exit PROTOCOL.json EXIT-GRANT.json --enable-funded-actions. It keeps entry stopped and permits bounded SELL preparation in the same journal.",
        "A stale request may be cancelled with cancel-unsigned only when no signing request was ever exported. An exported request or unknown signature cannot be cancelled on elapsed time alone.",
        "No handoff acknowledgement is manufactured by this export. Operator must retain timestamp, public wallet, observed balances, old/new signatures and cost/rent evidence.",
      ],
    };
  }
}
