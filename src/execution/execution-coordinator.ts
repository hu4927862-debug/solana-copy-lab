import { RecoveryManager } from "../recovery/recovery-manager.js";
import type { ExecutionIntent, ExecutionResult } from "../domain/execution.js";
import type { TransactionSender } from "../domain/ports.js";
import { RiskEngine } from "../risk/risk-engine.js";
import type {
  PostQuoteRiskContext,
  PreQuoteRiskDecision,
} from "../risk/risk-engine.js";
import { ProviderHealthTracker } from "../risk/provider-health.js";
import { StateStore } from "../persistence/state-store.js";

export type CrashPoint =
  "AFTER_RESERVE" | "AFTER_SEND" | "AFTER_FILL" | "AFTER_RESULT";

export class InjectedCrashError extends Error {
  constructor(readonly point: CrashPoint) {
    super(`Injected crash at ${point}`);
  }
}

export class ExecutionCoordinator {
  private static readonly JUPITER_PROVIDER = "JUPITER_SWAP_V2_ORDER";
  private readonly riskEngine: RiskEngine;
  private readonly providerHealth: ProviderHealthTracker;

  constructor(
    private readonly store: StateStore,
    private readonly sender: TransactionSender,
    private readonly crashPoint?: CrashPoint,
  ) {
    if (sender.mode !== "PAPER" && sender.mode !== "SHADOW") {
      throw new Error("Phase 1 only accepts PAPER/SHADOW senders");
    }
    if (!store.riskPolicy) {
      throw new Error("RISK_BOUNDARY_REQUIRED");
    }
    this.riskEngine = new RiskEngine(store.riskPolicy);
    this.providerHealth = new ProviderHealthTracker(
      {
        burstThreshold: store.riskPolicy.provider429BurstThreshold,
        burstWindowMs: store.riskPolicy.providerBurstWindowMs,
        cooldownMs: store.riskPolicy.providerCooldownMs,
        halfOpenProbe: store.riskPolicy.halfOpenProbe,
      },
      store.getProviderHealthState(ExecutionCoordinator.JUPITER_PROVIDER),
    );
  }

  async execute(intent: ExecutionIntent): Promise<ExecutionResult | undefined> {
    if (this.store.followerTradeState(intent.executionKey) !== undefined) {
      return undefined;
    }
    if (intent.skipReason) {
      const skipped = await this.store.reserveIntent(intent);
      if (!skipped.created) return undefined;
      return this.sender.send(intent);
    }
    let executableIntent = intent;
    const providerCheckAtMs = Date.now();
    const providerAvailable = this.providerHealth.canAttempt(
      intent.side,
      providerCheckAtMs,
    );
    await this.store.saveProviderHealthState(
      ExecutionCoordinator.JUPITER_PROVIDER,
      this.providerHealth.exportState(),
    );
    const preDecision: PreQuoteRiskDecision =
      await this.store.evaluateAndReserveExecutionIntent(
        intent,
        this.riskEngine,
        providerAvailable ? "HEALTHY" : "COOLDOWN",
      );
    if (
      preDecision.decision === "REJECT" ||
      preDecision.decision === "HALT" ||
      preDecision.approvedAmountRaw === 0n
    ) {
      executableIntent = {
        ...intent,
        theoreticalTokenRaw: 0n,
        theoreticalQuoteRaw: 0n,
        skipReason: preDecision.reasonCode,
      };
    } else {
      executableIntent = {
        ...intent,
        theoreticalTokenRaw: preDecision.approvedTokenRaw,
        theoreticalQuoteRaw: preDecision.approvedQuoteRaw,
      };
    }
    const reservation = await this.store.reserveIntent(executableIntent);
    if (!reservation.created) return undefined;
    if (reservation.state === "SKIPPED") {
      return this.sender.send({
        ...executableIntent,
        skipReason: executableIntent.skipReason ?? "PERSISTENCE_POLICY_SKIP",
      });
    }
    this.crash("AFTER_RESERVE");
    await this.store.markAttemptStarted(executableIntent.executionKey);
    const result = await this.sender.send(executableIntent);
    if (result.state === "PAPER_EXECUTED") {
      this.providerHealth.recordSuccess(Date.now());
    } else if (
      result.reason === "JUPITER_ORDER_FAILED" &&
      result.metadata?.failureCategory !== "LOCAL_PACING_REJECT"
    ) {
      const status = result.metadata?.httpStatus;
      this.providerHealth.recordFailure(
        Date.now(),
        typeof status === "number" ? status : undefined,
      );
    }
    await this.store.saveProviderHealthState(
      ExecutionCoordinator.JUPITER_PROVIDER,
      this.providerHealth.exportState(),
    );
    this.crash("AFTER_SEND");
    if (result.state !== "PAPER_EXECUTED" || !result.paperQuoteEvidence) {
      await this.store.releaseRiskBuyReservation(intent.executionKey);
    } else {
      const postContext: PostQuoteRiskContext = {
        phase: "POST_QUOTE",
        nowMs: Date.now(),
        intent: {
          intentId: executableIntent.executionKey,
          leaderTradeId: executableIntent.leaderTradeId,
          leaderWallet: executableIntent.leaderWallet,
          followerWallet: executableIntent.followerWallet,
          side: executableIntent.side,
          tokenMint: executableIntent.tokenMint,
          quoteMint: executableIntent.quoteMint,
          requestedTokenRaw: executableIntent.theoreticalTokenRaw,
          requestedQuoteRaw: executableIntent.theoreticalQuoteRaw,
          createdAtMs: executableIntent.createdAtMs,
          ...(executableIntent.authoritativeSourceTimestamp === undefined
            ? {}
            : {
                authoritativeSourceTimestamp:
                  executableIntent.authoritativeSourceTimestamp,
              }),
        },
        preDecision,
        quoteEvidence: result.paperQuoteEvidence,
      };
      const postDecision = this.riskEngine.evaluatePostQuote(postContext);
      await this.store.saveRiskDecision(postDecision);
      if (postDecision.decision !== "ALLOW") {
        await this.store.releaseRiskBuyReservation(intent.executionKey);
        const rejected: ExecutionResult = {
          executionKey: result.executionKey,
          state: "FAILED",
          executedTokenRaw: 0n,
          executedQuoteRaw: 0n,
          reason: postDecision.reasonCode,
          ...(result.metadata === undefined
            ? {}
            : { metadata: result.metadata }),
          paperQuoteEvidence: result.paperQuoteEvidence,
        };
        await this.store.saveExecutionResult(rejected);
        await this.store.commitPosition(executableIntent, rejected);
        return rejected;
      }
    }
    const fillId =
      result.state === "PAPER_EXECUTED"
        ? await this.store.savePaperFillFromExecutionResult(result)
        : undefined;
    this.crash("AFTER_FILL");
    await this.store.saveExecutionResult(result);
    this.crash("AFTER_RESULT");
    if (fillId === undefined)
      await this.store.commitPosition(executableIntent, result);
    else await this.store.applyPaperFill(fillId);
    return result;
  }

  async recoverPending(): Promise<void> {
    await new RecoveryManager(this.store, this.sender).recover();
  }

  private crash(point: CrashPoint): void {
    if (this.crashPoint === point) throw new InjectedCrashError(point);
  }
}
