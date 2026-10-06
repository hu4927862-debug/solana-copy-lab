import type { PaperPosition } from "../domain/paper-trading.js";
import type { PaperQuoteEvidence } from "../domain/execution.js";
import type { AuthoritativeSourceTimestamp } from "../domain/time.js";
import { stableId } from "../domain/ids.js";
import { Decimal } from "decimal.js";

export type RiskGlobalState = "RUNNING" | "HALT_NEW_RISK";
export type RiskQuoteState = "RUNNING" | "HALT_NEW_RISK";
export type ProviderHealth = "HEALTHY" | "DEGRADED" | "COOLDOWN";

export interface RiskPolicy {
  readonly policyVersion: string;
  readonly maxSingleTradeRawByQuoteMint: Readonly<Record<string, bigint>>;
  readonly maxTokenExposureRawByQuoteMint: Readonly<Record<string, bigint>>;
  readonly maxPortfolioExposureRawByQuoteMint: Readonly<Record<string, bigint>>;
  readonly dailyRealizedLossLimitRawByQuoteMint: Readonly<
    Record<string, bigint>
  >;
  readonly maxIntentAgeMs: number;
  readonly maxQuoteAgeMs: number;
  readonly maxBuyPriceImpactPctByQuoteMint: Readonly<Record<string, string>>;
  readonly maxSellPriceImpactPctByQuoteMint: Readonly<Record<string, string>>;
  readonly requireRouteEvidence: boolean;
  readonly provider429BurstThreshold: number;
  readonly providerBurstWindowMs: number;
  readonly providerCooldownMs: number;
  readonly halfOpenProbe: number;
}

export interface ProposedRiskIntent {
  readonly intentId: string;
  readonly leaderTradeId: string;
  readonly leaderWallet: string;
  readonly followerWallet: string;
  readonly side: "BUY" | "SELL";
  readonly tokenMint: string;
  readonly quoteMint: string;
  readonly requestedTokenRaw: bigint;
  readonly requestedQuoteRaw: bigint;
  readonly createdAtMs: number;
  readonly authoritativeSourceTimestamp?: AuthoritativeSourceTimestamp;
}

export interface PreQuoteRiskContext {
  readonly phase: "PRE_QUOTE";
  readonly nowMs: number;
  readonly intent: ProposedRiskIntent;
  readonly currentPosition?: PaperPosition;
  readonly portfolioPositions: readonly PaperPosition[];
  readonly pendingApprovedBuyQuoteRawByQuoteMint: Readonly<
    Record<string, bigint>
  >;
  readonly pendingApprovedBuyQuoteRawForToken: bigint;
  readonly dailyRealizedPnlRawByQuoteMint: Readonly<Record<string, bigint>>;
  readonly quoteState: RiskQuoteState;
  readonly globalState: RiskGlobalState;
  readonly providerHealth: ProviderHealth;
}

export interface PostQuoteRiskContext {
  readonly phase: "POST_QUOTE";
  readonly nowMs: number;
  readonly intent: ProposedRiskIntent;
  readonly preDecision: PreQuoteRiskDecision;
  readonly quoteEvidence: PaperQuoteEvidence;
}

export type RiskDecisionKind = "ALLOW" | "RESIZE" | "REJECT" | "HALT";
export type RiskReasonCode =
  | "ALLOW"
  | "SINGLE_TRADE_LIMIT"
  | "RISK_POLICY_FOR_QUOTE_UNAVAILABLE"
  | "GLOBAL_HALT_NEW_RISK"
  | "INTENT_TIMESTAMP_UNAVAILABLE"
  | "INTENT_TIMESTAMP_PROVENANCE_INVALID"
  | "STALE_INTENT"
  | "FUTURE_SOURCE_TIMESTAMP"
  | "TOKEN_COST_EXPOSURE_LIMIT"
  | "PORTFOLIO_COST_EXPOSURE_LIMIT"
  | "DAILY_REALIZED_LOSS_LIMIT"
  | "PROVIDER_DEGRADED"
  | "QUOTE_AMOUNT_MISMATCH"
  | "PRICE_IMPACT_TOO_HIGH"
  | "PRICE_IMPACT_UNAVAILABLE"
  | "STALE_QUOTE"
  | "ROUTE_INVALID"
  | "SELL_NOT_RISK_REDUCING";

interface BaseRiskDecision {
  readonly decision: RiskDecisionKind;
  readonly decisionId: string;
  readonly intentId: string;
  readonly leaderTradeId: string;
  readonly leaderWallet: string;
  readonly followerWallet: string;
  readonly side: "BUY" | "SELL";
  readonly tokenMint: string;
  readonly quoteMint: string;
  readonly requestedAmountRaw: bigint;
  readonly approvedAmountRaw: bigint;
  readonly requestedTokenRaw: bigint;
  readonly approvedTokenRaw: bigint;
  readonly requestedQuoteRaw: bigint;
  readonly approvedQuoteRaw: bigint;
  readonly reasonCode: RiskReasonCode;
  readonly policyVersion: string;
  readonly decidedAtMs: number;
  readonly relevantLimitRaw?: bigint;
  readonly relevantEvidence?: Readonly<
    Record<string, string | number | boolean>
  >;
}

export interface PreQuoteRiskDecision extends BaseRiskDecision {
  readonly phase: "PRE_QUOTE";
}

export interface PostQuoteRiskDecision extends BaseRiskDecision {
  readonly phase: "POST_QUOTE";
  readonly preDecisionId: string;
  readonly quoteRequestId: string;
}

export type RiskDecision = PreQuoteRiskDecision | PostQuoteRiskDecision;

export class RiskEngine {
  constructor(private readonly policy: RiskPolicy) {}

  get riskPolicy(): RiskPolicy {
    return this.policy;
  }

  evaluatePreQuote(context: PreQuoteRiskContext): PreQuoteRiskDecision {
    const { intent } = context;
    const requestedAmountRaw =
      intent.side === "BUY"
        ? intent.requestedQuoteRaw
        : intent.requestedTokenRaw;
    if (intent.side === "BUY" && context.globalState === "HALT_NEW_RISK") {
      return this.zeroDecision(context, "HALT", "GLOBAL_HALT_NEW_RISK");
    }
    const singleLimit =
      this.policy.maxSingleTradeRawByQuoteMint[intent.quoteMint];
    const tokenLimit =
      this.policy.maxTokenExposureRawByQuoteMint[intent.quoteMint];
    const portfolioLimit =
      this.policy.maxPortfolioExposureRawByQuoteMint[intent.quoteMint];
    const dailyLossLimit =
      this.policy.dailyRealizedLossLimitRawByQuoteMint[intent.quoteMint];
    const maxBuyImpact =
      this.policy.maxBuyPriceImpactPctByQuoteMint[intent.quoteMint];
    const maxSellImpact =
      this.policy.maxSellPriceImpactPctByQuoteMint[intent.quoteMint];
    if (
      singleLimit === undefined ||
      tokenLimit === undefined ||
      portfolioLimit === undefined ||
      dailyLossLimit === undefined ||
      maxBuyImpact === undefined ||
      maxSellImpact === undefined
    ) {
      return this.zeroDecision(
        context,
        "REJECT",
        "RISK_POLICY_FOR_QUOTE_UNAVAILABLE",
      );
    }
    if (
      intent.side === "SELL" &&
      (!context.currentPosition ||
        context.currentPosition.tokenMint !== intent.tokenMint ||
        context.currentPosition.quoteMint !== intent.quoteMint ||
        context.currentPosition.status !== "OPEN" ||
        intent.requestedTokenRaw <= 0n ||
        intent.requestedTokenRaw > context.currentPosition.quantityRaw)
    ) {
      return this.zeroDecision(context, "REJECT", "SELL_NOT_RISK_REDUCING");
    }
    if (intent.side === "BUY" && context.quoteState === "HALT_NEW_RISK") {
      return this.zeroDecision(context, "HALT", "DAILY_REALIZED_LOSS_LIMIT");
    }
    if (intent.side === "BUY" && context.providerHealth !== "HEALTHY") {
      return this.zeroDecision(context, "REJECT", "PROVIDER_DEGRADED");
    }
    if (intent.authoritativeSourceTimestamp === undefined) {
      return this.zeroDecision(
        context,
        "REJECT",
        "INTENT_TIMESTAMP_UNAVAILABLE",
      );
    }
    const sourceTimestamp = intent.authoritativeSourceTimestamp;
    if (
      sourceTimestamp.provenance !== "CHAIN_BLOCK_TIME" ||
      (sourceTimestamp.precision !== "MILLISECOND" &&
        sourceTimestamp.precision !== "SECOND") ||
      !Number.isSafeInteger(sourceTimestamp.valueMs) ||
      sourceTimestamp.valueMs < 0
    ) {
      return this.zeroDecision(
        context,
        "REJECT",
        "INTENT_TIMESTAMP_PROVENANCE_INVALID",
      );
    }
    // Operational clock allowance: one source tick for SECOND chain time.
    // This is not a substitution of receive time for authoritative provenance.
    const futureAllowanceMs =
      sourceTimestamp.precision === "SECOND" ? 1_000 : 0;
    if (sourceTimestamp.valueMs - context.nowMs > futureAllowanceMs) {
      return {
        ...this.zeroDecision(context, "REJECT", "FUTURE_SOURCE_TIMESTAMP"),
        relevantEvidence: {
          sourceTimestampMs: sourceTimestamp.valueMs,
          futureAllowanceMs,
        },
      };
    }
    if (context.nowMs - sourceTimestamp.valueMs > this.policy.maxIntentAgeMs) {
      return this.zeroDecision(context, "REJECT", "STALE_INTENT");
    }
    if (intent.side === "BUY") {
      const realizedPnlRaw =
        context.dailyRealizedPnlRawByQuoteMint[intent.quoteMint] ?? 0n;
      if (realizedPnlRaw <= -dailyLossLimit) {
        return this.zeroDecision(context, "HALT", "DAILY_REALIZED_LOSS_LIMIT");
      }
      const pendingQuoteRaw =
        context.pendingApprovedBuyQuoteRawByQuoteMint[intent.quoteMint] ?? 0n;
      const tokenCostExposureRaw =
        context.portfolioPositions
          .filter(
            (position) =>
              position.quoteMint === intent.quoteMint &&
              position.tokenMint === intent.tokenMint,
          )
          .reduce((total, position) => total + position.totalCostQuoteRaw, 0n) +
        context.pendingApprovedBuyQuoteRawForToken;
      const portfolioCostExposureRaw =
        context.portfolioPositions
          .filter((position) => position.quoteMint === intent.quoteMint)
          .reduce((total, position) => total + position.totalCostQuoteRaw, 0n) +
        pendingQuoteRaw;
      const capacities = [
        {
          remainingRaw: singleLimit,
          reasonCode: "SINGLE_TRADE_LIMIT" as const,
          relevantLimitRaw: singleLimit,
        },
        {
          remainingRaw:
            tokenLimit > tokenCostExposureRaw
              ? tokenLimit - tokenCostExposureRaw
              : 0n,
          reasonCode: "TOKEN_COST_EXPOSURE_LIMIT" as const,
          relevantLimitRaw: tokenLimit,
        },
        {
          remainingRaw:
            portfolioLimit > portfolioCostExposureRaw
              ? portfolioLimit - portfolioCostExposureRaw
              : 0n,
          reasonCode: "PORTFOLIO_COST_EXPOSURE_LIMIT" as const,
          relevantLimitRaw: portfolioLimit,
        },
      ];
      const bindingCapacity = capacities.reduce((binding, capacity) =>
        capacity.remainingRaw < binding.remainingRaw ? capacity : binding,
      );
      if (bindingCapacity.remainingRaw < intent.requestedQuoteRaw) {
        const triggeredHardCeilings = capacities
          .filter(
            (capacity) => capacity.remainingRaw < intent.requestedQuoteRaw,
          )
          .map((capacity) => capacity.reasonCode)
          .join(",");
        return this.resizeOrReject(
          context,
          bindingCapacity.remainingRaw,
          bindingCapacity.reasonCode,
          bindingCapacity.relevantLimitRaw,
          {
            singleTradeRemainingCapacityRaw:
              capacities[0]!.remainingRaw.toString(),
            tokenCostExposureRemainingCapacityRaw:
              capacities[1]!.remainingRaw.toString(),
            portfolioCostExposureRemainingCapacityRaw:
              capacities[2]!.remainingRaw.toString(),
            triggeredHardCeilings,
          },
        );
      }
    }
    return {
      phase: "PRE_QUOTE",
      decisionId: this.preDecisionId(intent.intentId),
      decision: "ALLOW",
      intentId: intent.intentId,
      leaderTradeId: intent.leaderTradeId,
      leaderWallet: intent.leaderWallet,
      followerWallet: intent.followerWallet,
      side: intent.side,
      tokenMint: intent.tokenMint,
      quoteMint: intent.quoteMint,
      requestedAmountRaw,
      approvedAmountRaw: requestedAmountRaw,
      requestedTokenRaw: intent.requestedTokenRaw,
      approvedTokenRaw: intent.requestedTokenRaw,
      requestedQuoteRaw: intent.requestedQuoteRaw,
      approvedQuoteRaw: intent.requestedQuoteRaw,
      reasonCode: "ALLOW",
      policyVersion: this.policy.policyVersion,
      decidedAtMs: context.nowMs,
    };
  }

  evaluatePostQuote(context: PostQuoteRiskContext): PostQuoteRiskDecision {
    const { intent, preDecision, quoteEvidence } = context;
    const approvedAmountRaw =
      intent.side === "BUY"
        ? preDecision.approvedQuoteRaw
        : preDecision.approvedTokenRaw;
    const requestedInputMint =
      intent.side === "BUY" ? intent.quoteMint : intent.tokenMint;
    const requestedOutputMint =
      intent.side === "BUY" ? intent.tokenMint : intent.quoteMint;
    const relevantEvidence = {
      provider: quoteEvidence.provider,
      quoteRequestId: quoteEvidence.requestId,
      inputMint: quoteEvidence.inputMint,
      outputMint: quoteEvidence.outputMint,
      inputAmountRaw: quoteEvidence.inputAmountRaw.toString(),
      outputAmountRaw: quoteEvidence.outputAmountRaw.toString(),
      requestTimestampMs: quoteEvidence.requestTimestampMs,
      responseTimestampMs: quoteEvidence.responseTimestampMs,
      httpStatus: quoteEvidence.httpStatus,
      routeCount: quoteEvidence.route.length,
      ...(quoteEvidence.priceImpactPct === undefined
        ? {}
        : { priceImpactPct: quoteEvidence.priceImpactPct }),
      priceImpactUnit: "PERCENTAGE_POINTS",
      priceImpactComparison: "ABSOLUTE_MAGNITUDE",
      ...(quoteEvidence.priceImpactEvidence === undefined
        ? {}
        : {
            priceImpactContract:
              quoteEvidence.priceImpactEvidence.contractVersion,
            priceImpactStatus: quoteEvidence.priceImpactEvidence.status,
            priceImpactRaw: JSON.stringify(
              quoteEvidence.priceImpactEvidence.raw,
            ),
          }),
    } as const;
    const reject = (reasonCode: RiskReasonCode): PostQuoteRiskDecision => ({
      phase: "POST_QUOTE",
      decisionId: stableId(
        "risk_decision",
        "POST_QUOTE",
        intent.intentId,
        this.policy.policyVersion,
        quoteEvidence.requestId,
        reasonCode,
      ),
      decision: "REJECT",
      intentId: intent.intentId,
      leaderTradeId: intent.leaderTradeId,
      leaderWallet: intent.leaderWallet,
      followerWallet: intent.followerWallet,
      side: intent.side,
      tokenMint: intent.tokenMint,
      quoteMint: intent.quoteMint,
      requestedAmountRaw: approvedAmountRaw,
      approvedAmountRaw: 0n,
      requestedTokenRaw: preDecision.approvedTokenRaw,
      approvedTokenRaw: 0n,
      requestedQuoteRaw: preDecision.approvedQuoteRaw,
      approvedQuoteRaw: 0n,
      reasonCode,
      policyVersion: this.policy.policyVersion,
      decidedAtMs: context.nowMs,
      preDecisionId: preDecision.decisionId,
      quoteRequestId: quoteEvidence.requestId,
      relevantEvidence,
    });
    if (
      preDecision.phase !== "PRE_QUOTE" ||
      (preDecision.decision !== "ALLOW" && preDecision.decision !== "RESIZE") ||
      approvedAmountRaw <= 0n ||
      preDecision.intentId !== intent.intentId ||
      preDecision.leaderTradeId !== intent.leaderTradeId ||
      preDecision.leaderWallet !== intent.leaderWallet ||
      preDecision.followerWallet !== intent.followerWallet ||
      preDecision.side !== intent.side ||
      preDecision.tokenMint !== intent.tokenMint ||
      preDecision.quoteMint !== intent.quoteMint ||
      preDecision.policyVersion !== this.policy.policyVersion
    ) {
      return reject("QUOTE_AMOUNT_MISMATCH");
    }
    if (
      quoteEvidence.inputMint !== requestedInputMint ||
      quoteEvidence.outputMint !== requestedOutputMint ||
      quoteEvidence.inputAmountRaw !== approvedAmountRaw ||
      quoteEvidence.outputAmountRaw <= 0n ||
      quoteEvidence.httpStatus < 200 ||
      quoteEvidence.httpStatus >= 300 ||
      quoteEvidence.schemaValid !== true
    ) {
      return reject("QUOTE_AMOUNT_MISMATCH");
    }
    if (
      context.nowMs < quoteEvidence.responseTimestampMs ||
      context.nowMs - quoteEvidence.responseTimestampMs >
        this.policy.maxQuoteAgeMs
    ) {
      return reject("STALE_QUOTE");
    }
    if (this.policy.requireRouteEvidence && quoteEvidence.route.length === 0) {
      return reject("ROUTE_INVALID");
    }
    if (quoteEvidence.priceImpactPct === undefined) {
      return reject("PRICE_IMPACT_UNAVAILABLE");
    }
    let impact: Decimal;
    try {
      impact = new Decimal(quoteEvidence.priceImpactPct);
    } catch {
      return reject("PRICE_IMPACT_UNAVAILABLE");
    }
    const configuredImpactValue =
      intent.side === "BUY"
        ? this.policy.maxBuyPriceImpactPctByQuoteMint[intent.quoteMint]
        : this.policy.maxSellPriceImpactPctByQuoteMint[intent.quoteMint];
    if (configuredImpactValue === undefined) {
      return reject("RISK_POLICY_FOR_QUOTE_UNAVAILABLE");
    }
    let configuredImpact: Decimal;
    try {
      configuredImpact = new Decimal(configuredImpactValue);
    } catch {
      return reject("RISK_POLICY_FOR_QUOTE_UNAVAILABLE");
    }
    if (!impact.isFinite()) return reject("PRICE_IMPACT_UNAVAILABLE");
    if (!configuredImpact.isFinite() || configuredImpact.isNegative())
      return reject("RISK_POLICY_FOR_QUOTE_UNAVAILABLE");
    if (impact.abs().gt(configuredImpact)) {
      return reject("PRICE_IMPACT_TOO_HIGH");
    }
    return {
      phase: "POST_QUOTE",
      decisionId: stableId(
        "risk_decision",
        "POST_QUOTE",
        intent.intentId,
        this.policy.policyVersion,
        quoteEvidence.requestId,
      ),
      decision: "ALLOW",
      intentId: intent.intentId,
      leaderTradeId: intent.leaderTradeId,
      leaderWallet: intent.leaderWallet,
      followerWallet: intent.followerWallet,
      side: intent.side,
      tokenMint: intent.tokenMint,
      quoteMint: intent.quoteMint,
      requestedAmountRaw: approvedAmountRaw,
      approvedAmountRaw,
      requestedTokenRaw: preDecision.approvedTokenRaw,
      approvedTokenRaw: preDecision.approvedTokenRaw,
      requestedQuoteRaw: preDecision.approvedQuoteRaw,
      approvedQuoteRaw: preDecision.approvedQuoteRaw,
      reasonCode: "ALLOW",
      policyVersion: this.policy.policyVersion,
      decidedAtMs: context.nowMs,
      preDecisionId: preDecision.decisionId,
      quoteRequestId: quoteEvidence.requestId,
      relevantEvidence,
    };
  }

  private zeroDecision(
    context: PreQuoteRiskContext,
    decision: "REJECT" | "HALT",
    reasonCode: RiskReasonCode,
  ): PreQuoteRiskDecision {
    const { intent } = context;
    return {
      phase: "PRE_QUOTE",
      decisionId: this.preDecisionId(intent.intentId),
      decision,
      intentId: intent.intentId,
      leaderTradeId: intent.leaderTradeId,
      leaderWallet: intent.leaderWallet,
      followerWallet: intent.followerWallet,
      side: intent.side,
      tokenMint: intent.tokenMint,
      quoteMint: intent.quoteMint,
      requestedAmountRaw:
        intent.side === "BUY"
          ? intent.requestedQuoteRaw
          : intent.requestedTokenRaw,
      approvedAmountRaw: 0n,
      requestedTokenRaw: intent.requestedTokenRaw,
      approvedTokenRaw: 0n,
      requestedQuoteRaw: intent.requestedQuoteRaw,
      approvedQuoteRaw: 0n,
      reasonCode,
      policyVersion: this.policy.policyVersion,
      decidedAtMs: context.nowMs,
    };
  }

  private resizeOrReject(
    context: PreQuoteRiskContext,
    capacityRaw: bigint,
    reasonCode: RiskReasonCode,
    relevantLimitRaw: bigint,
    relevantEvidence?: Readonly<Record<string, string | number | boolean>>,
  ): PreQuoteRiskDecision {
    if (capacityRaw <= 0n) {
      return {
        ...this.zeroDecision(context, "REJECT", reasonCode),
        relevantLimitRaw,
        ...(relevantEvidence === undefined ? {} : { relevantEvidence }),
      };
    }
    const { intent } = context;
    return {
      phase: "PRE_QUOTE",
      decisionId: this.preDecisionId(intent.intentId),
      decision: "RESIZE",
      intentId: intent.intentId,
      leaderTradeId: intent.leaderTradeId,
      leaderWallet: intent.leaderWallet,
      followerWallet: intent.followerWallet,
      side: intent.side,
      tokenMint: intent.tokenMint,
      quoteMint: intent.quoteMint,
      requestedAmountRaw: intent.requestedQuoteRaw,
      approvedAmountRaw: capacityRaw,
      requestedTokenRaw: intent.requestedTokenRaw,
      approvedTokenRaw:
        intent.requestedQuoteRaw === 0n
          ? 0n
          : (intent.requestedTokenRaw * capacityRaw) / intent.requestedQuoteRaw,
      requestedQuoteRaw: intent.requestedQuoteRaw,
      approvedQuoteRaw: capacityRaw,
      reasonCode,
      policyVersion: this.policy.policyVersion,
      decidedAtMs: context.nowMs,
      relevantLimitRaw,
      ...(relevantEvidence === undefined ? {} : { relevantEvidence }),
    };
  }

  private preDecisionId(intentId: string): string {
    return stableId(
      "risk_decision",
      "PRE_QUOTE",
      intentId,
      this.policy.policyVersion,
    );
  }
}
