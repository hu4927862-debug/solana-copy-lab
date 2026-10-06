import type { TransactionSender } from "../domain/ports.js";
import type { ExecutionIntent, ExecutionResult } from "../domain/execution.js";
import { StateStore } from "../persistence/state-store.js";
import { RiskEngine } from "../risk/risk-engine.js";
import type { PreQuoteRiskDecision } from "../risk/risk-engine.js";

export interface RecoveryReport {
  readonly committed: number;
  readonly safelyRetried: number;
  readonly uncertain: number;
}

export class RecoveryManager {
  private readonly riskEngine: RiskEngine;

  constructor(
    private readonly store: StateStore,
    private readonly sender: TransactionSender,
  ) {
    if (sender.mode !== "PAPER" && sender.mode !== "SHADOW")
      throw new Error("PAPER_RECOVERY_ONLY");
    if (!store.riskPolicy) throw new Error("RISK_ENGINE_REQUIRED_FOR_RECOVERY");
    this.riskEngine = new RiskEngine(store.riskPolicy);
  }

  async recover(): Promise<RecoveryReport> {
    await this.store.recoverOrphanRiskBuyReservations();
    let committed = await this.store.recoverUnappliedPaperFills();
    let safelyRetried = 0;
    let uncertain = 0;
    for (const entry of this.store.listRecoverable()) {
      let preDecision: PreQuoteRiskDecision | undefined;
      try {
        preDecision = this.store.getRiskDecisionForIntent(
          "PRE_QUOTE",
          entry.intent.executionKey,
        ) as PreQuoteRiskDecision | undefined;
      } catch {
        await this.failBeforeNetwork(
          entry.intent,
          entry.intent.executionKey,
          "RISK_PRE_DECISION_UNREADABLE",
        );
        uncertain += 1;
        continue;
      }
      if (!preDecision) {
        await this.failBeforeNetwork(
          entry.intent,
          entry.intent.executionKey,
          "RISK_PRE_DECISION_UNAVAILABLE",
        );
        uncertain += 1;
        continue;
      }
      if (
        (preDecision.decision !== "ALLOW" &&
          preDecision.decision !== "RESIZE") ||
        preDecision.approvedAmountRaw <= 0n ||
        preDecision.intentId !== entry.intent.executionKey ||
        preDecision.leaderTradeId !== entry.intent.leaderTradeId ||
        preDecision.leaderWallet !== entry.intent.leaderWallet ||
        preDecision.followerWallet !== entry.intent.followerWallet ||
        preDecision.side !== entry.intent.side ||
        preDecision.tokenMint !== entry.intent.tokenMint ||
        preDecision.quoteMint !== entry.intent.quoteMint ||
        preDecision.policyVersion !== this.store.riskPolicy.policyVersion ||
        preDecision.approvedTokenRaw < 0n ||
        preDecision.approvedQuoteRaw < 0n ||
        preDecision.approvedTokenRaw > preDecision.requestedTokenRaw ||
        preDecision.approvedQuoteRaw > preDecision.requestedQuoteRaw ||
        preDecision.approvedAmountRaw !==
          (entry.intent.side === "BUY"
            ? preDecision.approvedQuoteRaw
            : preDecision.approvedTokenRaw) ||
        preDecision.requestedAmountRaw !==
          (entry.intent.side === "BUY"
            ? preDecision.requestedQuoteRaw
            : preDecision.requestedTokenRaw) ||
        (preDecision.decision === "ALLOW" &&
          preDecision.approvedAmountRaw !== preDecision.requestedAmountRaw) ||
        (preDecision.decision === "RESIZE" &&
          preDecision.approvedAmountRaw >= preDecision.requestedAmountRaw)
      ) {
        await this.failBeforeNetwork(
          entry.intent,
          entry.intent.executionKey,
          "RISK_PRE_AUTHORIZATION_INVALID",
        );
        uncertain += 1;
        continue;
      }
      const authorizedIntent: ExecutionIntent = {
        ...entry.intent,
        theoreticalTokenRaw: preDecision.approvedTokenRaw,
        theoreticalQuoteRaw: preDecision.approvedQuoteRaw,
      };
      if (entry.persistedResult) {
        if (
          await this.persistRecovered(
            authorizedIntent,
            preDecision,
            entry.persistedResult,
          )
        )
          committed += 1;
        else uncertain += 1;
        continue;
      }
      const known = await this.sender.lookup(authorizedIntent.executionKey);
      if (known) {
        if (await this.persistRecovered(authorizedIntent, preDecision, known))
          committed += 1;
        else uncertain += 1;
        continue;
      }
      if (!entry.attemptStarted) {
        const rejection = this.store.revalidateBeforeQuote(authorizedIntent);
        if (rejection !== undefined) {
          await this.failBeforeNetwork(
            authorizedIntent,
            authorizedIntent.executionKey,
            rejection,
          );
          uncertain += 1;
          continue;
        }
        await this.store.markAttemptStarted(authorizedIntent.executionKey);
        const result = await this.sender.send(authorizedIntent);
        if (await this.persistRecovered(authorizedIntent, preDecision, result))
          safelyRetried += 1;
        else uncertain += 1;
        continue;
      }
      await this.store.markUncertain(
        entry.intent.executionKey,
        "SEND_STARTED_BUT_PROVIDER_HAS_NO_RESULT",
      );
      uncertain += 1;
    }
    return { committed, safelyRetried, uncertain };
  }

  private async failBeforeNetwork(
    intent: ExecutionIntent,
    executionKey: string,
    reason: string,
  ): Promise<void> {
    await this.store.releaseRiskBuyReservation(executionKey);
    const result: ExecutionResult = {
      executionKey,
      state: "FAILED",
      executedTokenRaw: 0n,
      executedQuoteRaw: 0n,
      reason,
    };
    await this.store.saveExecutionResult(result);
    await this.store.commitPosition(intent, result);
  }

  private async persistRecovered(
    intent: ExecutionIntent,
    preDecision: PreQuoteRiskDecision,
    result: ExecutionResult,
  ): Promise<boolean> {
    if (result.state === "PAPER_EXECUTED") {
      if (result.paperQuoteEvidence === undefined) {
        await this.store.markUncertain(
          intent.executionKey,
          "PAPER_FILL_QUOTE_EVIDENCE_UNAVAILABLE",
        );
        return false;
      }
      const postDecision = this.riskEngine.evaluatePostQuote({
        phase: "POST_QUOTE",
        nowMs: Date.now(),
        intent: {
          intentId: intent.executionKey,
          leaderTradeId: intent.leaderTradeId,
          leaderWallet: intent.leaderWallet,
          followerWallet: intent.followerWallet,
          side: intent.side,
          tokenMint: intent.tokenMint,
          quoteMint: intent.quoteMint,
          requestedTokenRaw: intent.theoreticalTokenRaw,
          requestedQuoteRaw: intent.theoreticalQuoteRaw,
          createdAtMs: intent.createdAtMs,
          ...(intent.authoritativeSourceTimestamp === undefined
            ? {}
            : {
                authoritativeSourceTimestamp:
                  intent.authoritativeSourceTimestamp,
              }),
        },
        preDecision,
        quoteEvidence: result.paperQuoteEvidence,
      });
      await this.store.saveRiskDecision(postDecision);
      if (postDecision.decision !== "ALLOW") {
        await this.store.releaseRiskBuyReservation(intent.executionKey);
        const rejected: ExecutionResult = {
          executionKey: intent.executionKey,
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
        await this.store.commitPosition(intent, rejected);
        return true;
      }
      const fillId = await this.store.savePaperFillFromExecutionResult(result);
      await this.store.saveExecutionResult(result);
      await this.store.applyPaperFill(fillId);
      return true;
    }
    await this.store.saveExecutionResult(result);
    await this.store.commitPosition(intent, result);
    return true;
  }
}
