import type { ExecutionMode } from "../domain/execution.js";
import type { TradeSide } from "../domain/trades.js";
import type { RiskDecision } from "../risk/risk-engine.js";
import type {
  FollowerScopedJupiterSuccessRateResult,
  PostRiskDistributionResult,
  PriceImpactRejectRateResult,
} from "./execution-quality.js";
import {
  isBuyCapacityRiskReasonCode,
  isTerminalOpportunityFailure,
} from "./failure-taxonomy.js";
import type {
  FailureClassification,
  NormalizedRiskDecisionEvidence,
  PostQuoteFreshnessAnalyticalProjection,
} from "./failure-taxonomy.js";

export interface CopyabilityBucket {
  readonly followerWallet: string;
  readonly leaderWallet: string;
  readonly quoteMint: string;
}

export interface CopyabilityEvaluationContext {
  readonly window: {
    readonly fromMs: number;
    readonly toMs: number;
  };
  readonly source: string;
  readonly mode: ExecutionMode;
  readonly copyRatioBps: number;
  readonly riskPolicyVersion: string;
  readonly fillPolicyVersion: string;
  readonly accountingPolicyVersion: string;
  readonly copyabilityDefinitionVersion: string;
}

export interface ClassifiedCopyabilityOpportunity extends CopyabilityBucket {
  readonly executionKey: string;
  readonly side: TradeSide;
  readonly failureClassification: FailureClassification;
}

export interface NormalizedPreRiskSizingEvidence
  extends CopyabilityBucket, NormalizedRiskDecisionEvidence {
  readonly phase: "PRE_QUOTE";
  readonly side: TradeSide;
  readonly requestedAmountRaw: bigint;
  readonly approvedAmountRaw: bigint;
  readonly requestedTokenRaw: bigint;
  readonly approvedTokenRaw: bigint;
  readonly requestedQuoteRaw: bigint;
  readonly approvedQuoteRaw: bigint;
}

export function projectNormalizedPreRiskSizingEvidence(
  decision: RiskDecision,
): NormalizedPreRiskSizingEvidence | undefined {
  if (decision.phase !== "PRE_QUOTE") return undefined;
  return {
    followerWallet: decision.followerWallet,
    leaderWallet: decision.leaderWallet,
    quoteMint: decision.quoteMint,
    intentId: decision.intentId,
    phase: "PRE_QUOTE",
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    side: decision.side,
    requestedAmountRaw: decision.requestedAmountRaw,
    approvedAmountRaw: decision.approvedAmountRaw,
    requestedTokenRaw: decision.requestedTokenRaw,
    approvedTokenRaw: decision.approvedTokenRaw,
    requestedQuoteRaw: decision.requestedQuoteRaw,
    approvedQuoteRaw: decision.approvedQuoteRaw,
  };
}

export interface SizeGranularityOpportunityEvidence extends ClassifiedCopyabilityOpportunity {
  readonly preRiskSizingEvidence?: NormalizedPreRiskSizingEvidence;
}

export type BuyCapacityOpportunityEvidence = SizeGranularityOpportunityEvidence;

export interface PositionMappingCompatibilityResult extends CopyabilityBucket {
  readonly mappingOpportunityCount: number;
  readonly mappedOpportunityCount: number;
  readonly mappingFailureCount: number;
  readonly mappingCompatibilityRate: string | null;
  readonly preconditionCount: number;
  readonly evaluableCount: number;
  readonly dataLimitationCount: number;
  readonly unavailableCount: number;
  readonly coverageRate: string | null;
  readonly status:
    "AVAILABLE" | "NO_SELL_OPPORTUNITIES" | "NO_EVALUABLE_MAPPING_OUTCOMES";
  readonly definitionVersion: string;
}

export interface SizeGranularityCompatibilityResult extends CopyabilityBucket {
  readonly granularityOpportunityCount: number;
  readonly granularOpportunityCount: number;
  readonly roundedToZeroCount: number;
  readonly granularityCompatibilityRate: string | null;
  readonly preconditionCount: number;
  readonly evaluableCount: number;
  readonly dataLimitationCount: number;
  readonly unavailableCount: number;
  readonly coverageRate: string | null;
  readonly status:
    | "AVAILABLE"
    | "NO_SIZING_OPPORTUNITIES"
    | "NO_EVALUABLE_GRANULARITY_OUTCOMES";
  readonly definitionVersion: string;
}

export interface BuyCapacityCompatibilityResult extends CopyabilityBucket {
  readonly capacityOpportunityCount: number;
  readonly fullSizeCount: number;
  readonly resizedCount: number;
  readonly capacityRejectCount: number;
  readonly fullSizeCompatibilityRate: string | null;
  readonly requestedQuoteRawTotal: bigint;
  readonly approvedQuoteRawTotal: bigint;
  readonly amountCompatibilityRate: string | null;
  readonly preconditionCount: number;
  readonly evaluableCount: number;
  readonly nonCapacityRiskExclusionCount: number;
  readonly dataLimitationCount: number;
  readonly unavailableCount: number;
  readonly coverageRate: string | null;
  readonly status:
    | "AVAILABLE"
    | "NO_BUY_CAPACITY_OPPORTUNITIES"
    | "NO_EVALUABLE_BUY_CAPACITY_OUTCOMES";
  readonly definitionVersion: string;
}

export interface PriceImpactCompatibilityAnalyticalInput {
  readonly postRiskDistribution: PostRiskDistributionResult;
  readonly priceImpactRejectRate: PriceImpactRejectRateResult;
}

export interface PriceImpactCompatibilityResult extends CopyabilityBucket {
  readonly priceImpactOpportunityCount: number;
  readonly priceImpactCompatibleCount: number;
  readonly priceImpactRejectedCount: number;
  readonly priceImpactCompatibilityRate: string | null;
  readonly status: "AVAILABLE" | "NO_PRICE_IMPACT_OPPORTUNITIES";
  readonly definitionVersion: string;
}

export interface PostQuoteFreshnessCompatibilityResult extends CopyabilityBucket {
  readonly freshnessOpportunityCount: number;
  readonly freshnessCompatibleCount: number;
  readonly staleQuoteCount: number;
  readonly freshnessCompatibilityRate: string | null;
  readonly preconditionCount: number;
  readonly evaluableCount: number;
  readonly beforeFreshnessCount: number;
  readonly unavailableCount: number;
  readonly coverageRate: string | null;
  readonly status: "AVAILABLE" | "NO_EVALUABLE_FRESHNESS_OUTCOMES";
  readonly definitionVersion: string;
}

export interface JupiterQuoteUsabilityResult extends CopyabilityBucket {
  readonly jupiterQuoteOpportunityCount: number;
  readonly usableJupiterQuoteCount: number;
  readonly jupiterQuoteUsabilityRate: string | null;
  readonly status: "AVAILABLE" | "NO_JUPITER_QUOTE_OPPORTUNITIES";
  readonly definitionVersion: string;
}

export interface EndToEndApplicationCompatibilityResult extends CopyabilityBucket {
  readonly endToEndOpportunityCount: number;
  readonly applicationSuccessCount: number;
  readonly terminalFailureCount: number;
  readonly endToEndApplicationCompatibilityRate: string | null;
  readonly preconditionCount: number;
  readonly evaluableCount: number;
  readonly dataLimitationCount: number;
  readonly unavailableCount: number;
  readonly coverageRate: string | null;
  readonly status:
    | "AVAILABLE"
    | "NO_END_TO_END_OPPORTUNITIES"
    | "NO_EVALUABLE_END_TO_END_OUTCOMES";
  readonly definitionVersion: string;
}

export interface CopyabilityAggregateComponents {
  readonly positionMapping: PositionMappingCompatibilityResult;
  readonly sizeGranularity: SizeGranularityCompatibilityResult;
  readonly buyCapacity: BuyCapacityCompatibilityResult;
  readonly jupiterQuoteUsability: JupiterQuoteUsabilityResult;
  readonly postQuoteFreshness: PostQuoteFreshnessCompatibilityResult;
  readonly priceImpact: PriceImpactCompatibilityResult;
  readonly endToEndApplication: EndToEndApplicationCompatibilityResult;
}

export interface CopyabilityAggregateResult
  extends CopyabilityBucket, CopyabilityAggregateComponents {
  readonly evaluationContext: CopyabilityEvaluationContext;
  readonly definitionVersion: string;
}

function divideToDecimalString(
  numerator: number | bigint,
  denominator: number | bigint,
): string {
  const numeratorRaw = BigInt(numerator);
  const denominatorRaw = BigInt(denominator);
  let remainder = numeratorRaw % denominatorRaw;
  const integerPart = numeratorRaw / denominatorRaw;
  if (remainder === 0n) return integerPart.toString();

  let fractionalPart = "";
  for (let digit = 0; digit < 18 && remainder !== 0n; digit += 1) {
    remainder *= 10n;
    fractionalPart += (remainder / denominatorRaw).toString();
    remainder %= denominatorRaw;
  }

  return `${integerPart}.${fractionalPart.replace(/0+$/, "")}`;
}

type BuyCapacityOutcome =
  "FULL_SIZE" | "RESIZED" | "CAPACITY_REJECTED" | "NON_CAPACITY_RISK_EXCLUSION";

function buyCapacityOutcome(
  opportunity: BuyCapacityOpportunityEvidence,
): BuyCapacityOutcome | null {
  const decision = opportunity.preRiskSizingEvidence;
  if (decision === undefined) return null;
  if (
    decision.intentId !== opportunity.executionKey ||
    decision.phase !== "PRE_QUOTE" ||
    decision.side !== "BUY"
  ) {
    throw new Error("CONFLICTING_BUY_CAPACITY_OPPORTUNITY_EVIDENCE");
  }
  if (decision.followerWallet !== opportunity.followerWallet) {
    throw new Error("CROSS_FOLLOWER_COPYABILITY_BUCKET");
  }
  if (decision.leaderWallet !== opportunity.leaderWallet) {
    throw new Error("CROSS_LEADER_COPYABILITY_BUCKET");
  }
  if (decision.quoteMint !== opportunity.quoteMint) {
    throw new Error("CROSS_QUOTE_COPYABILITY_BUCKET");
  }
  if (
    decision.requestedQuoteRaw <= 0n ||
    decision.requestedAmountRaw !== decision.requestedQuoteRaw ||
    decision.approvedAmountRaw !== decision.approvedQuoteRaw ||
    decision.approvedQuoteRaw < 0n ||
    decision.approvedQuoteRaw > decision.requestedQuoteRaw
  ) {
    throw new Error("CONFLICTING_BUY_CAPACITY_OPPORTUNITY_EVIDENCE");
  }

  if (decision.decision === "ALLOW") {
    if (
      decision.reasonCode !== "ALLOW" ||
      decision.approvedQuoteRaw !== decision.requestedQuoteRaw
    ) {
      throw new Error("CONFLICTING_BUY_CAPACITY_OPPORTUNITY_EVIDENCE");
    }
    return "FULL_SIZE";
  }

  if (isBuyCapacityRiskReasonCode(decision.reasonCode)) {
    if (
      decision.decision === "RESIZE" &&
      decision.approvedQuoteRaw > 0n &&
      decision.approvedQuoteRaw < decision.requestedQuoteRaw
    ) {
      return "RESIZED";
    }
    if (decision.decision === "REJECT" && decision.approvedQuoteRaw === 0n) {
      return "CAPACITY_REJECTED";
    }
    throw new Error("CONFLICTING_BUY_CAPACITY_OPPORTUNITY_EVIDENCE");
  }

  if (
    (decision.decision === "REJECT" || decision.decision === "HALT") &&
    decision.approvedQuoteRaw === 0n
  ) {
    return "NON_CAPACITY_RISK_EXCLUSION";
  }
  throw new Error("CONFLICTING_BUY_CAPACITY_OPPORTUNITY_EVIDENCE");
}

function opportunityFingerprint(
  opportunity: ClassifiedCopyabilityOpportunity,
): string {
  const classification = opportunity.failureClassification;
  return [
    opportunity.followerWallet,
    opportunity.leaderWallet,
    opportunity.quoteMint,
    opportunity.side,
    classification.classificationStatus,
    classification.primaryCategory ?? "NO_CATEGORY",
    classification.stage ?? "NO_STAGE",
    classification.reasonCode ?? "NO_REASON",
    classification.definitionVersion,
  ].join("\u0000");
}

function sizeGranularityOpportunityFingerprint(
  opportunity: SizeGranularityOpportunityEvidence,
): string {
  const sizing = opportunity.preRiskSizingEvidence;
  return [
    opportunityFingerprint(opportunity),
    sizing?.followerWallet ?? "NO_PRE_RISK_SIZING",
    sizing?.leaderWallet ?? "NO_PRE_RISK_SIZING",
    sizing?.quoteMint ?? "NO_PRE_RISK_SIZING",
    sizing?.intentId ?? "NO_PRE_RISK_SIZING",
    sizing?.phase ?? "NO_PRE_RISK_SIZING",
    sizing?.side ?? "NO_PRE_RISK_SIZING",
    sizing?.decision ?? "NO_PRE_RISK_SIZING",
    sizing?.reasonCode ?? "NO_PRE_RISK_SIZING",
    sizing?.requestedAmountRaw.toString() ?? "NO_PRE_RISK_SIZING",
    sizing?.approvedAmountRaw.toString() ?? "NO_PRE_RISK_SIZING",
    sizing?.requestedTokenRaw.toString() ?? "NO_PRE_RISK_SIZING",
    sizing?.approvedTokenRaw.toString() ?? "NO_PRE_RISK_SIZING",
    sizing?.requestedQuoteRaw.toString() ?? "NO_PRE_RISK_SIZING",
    sizing?.approvedQuoteRaw.toString() ?? "NO_PRE_RISK_SIZING",
  ].join("\u0000");
}

function isMappingFailure(classification: FailureClassification): boolean {
  return (
    classification.classificationStatus === "CLASSIFIED" &&
    classification.primaryCategory === "COPYABILITY_FAILURE" &&
    classification.stage === "COPY_DECISION" &&
    (classification.reasonCode === "NO_MAPPED_POSITION" ||
      classification.reasonCode === "INSUFFICIENT_MAPPED_POSITION")
  );
}

function isRoundedToZero(classification: FailureClassification): boolean {
  return (
    classification.classificationStatus === "CLASSIFIED" &&
    classification.primaryCategory === "COPYABILITY_FAILURE" &&
    classification.stage === "COPY_DECISION" &&
    classification.reasonCode === "SIZE_ROUNDED_TO_ZERO"
  );
}

function isPositiveSizingEvidence(
  opportunity: SizeGranularityOpportunityEvidence,
): boolean {
  const sizing = opportunity.preRiskSizingEvidence;
  if (sizing === undefined) return false;
  if (
    sizing.intentId !== opportunity.executionKey ||
    sizing.phase !== "PRE_QUOTE" ||
    sizing.side !== opportunity.side
  ) {
    throw new Error("CONFLICTING_SIZE_GRANULARITY_OPPORTUNITY_EVIDENCE");
  }
  if (sizing.followerWallet !== opportunity.followerWallet) {
    throw new Error("CROSS_FOLLOWER_COPYABILITY_BUCKET");
  }
  if (sizing.leaderWallet !== opportunity.leaderWallet) {
    throw new Error("CROSS_LEADER_COPYABILITY_BUCKET");
  }
  if (sizing.quoteMint !== opportunity.quoteMint) {
    throw new Error("CROSS_QUOTE_COPYABILITY_BUCKET");
  }
  const sideSpecificRequestedAmountRaw =
    sizing.side === "BUY" ? sizing.requestedQuoteRaw : sizing.requestedTokenRaw;
  return (
    sizing.requestedAmountRaw === sideSpecificRequestedAmountRaw &&
    sideSpecificRequestedAmountRaw > 0n
  );
}

type PositionMappingOutcome =
  "MAPPED" | "MAPPING_FAILURE" | "DATA_LIMITATION" | "UNAVAILABLE";

function positionMappingOutcome(
  classification: FailureClassification,
): PositionMappingOutcome {
  if (classification.classificationStatus === "UNAVAILABLE") {
    return "UNAVAILABLE";
  }
  if (isMappingFailure(classification)) {
    return "MAPPING_FAILURE";
  }
  if (
    classification.classificationStatus === "CLASSIFIED" &&
    classification.primaryCategory === "COPYABILITY_FAILURE" &&
    classification.stage === "COPY_DECISION"
  ) {
    if (classification.reasonCode === "SIZE_ROUNDED_TO_ZERO") {
      return "MAPPED";
    }
    return "UNAVAILABLE";
  }
  if (
    classification.stage === "PRE_QUOTE_RISK" ||
    classification.stage === "JUPITER_ORDER" ||
    classification.stage === "POST_QUOTE_RISK" ||
    classification.stage === "PAPER_APPLICATION"
  ) {
    return "MAPPED";
  }
  if (classification.primaryCategory === "DATA_LIMITATION") {
    return "DATA_LIMITATION";
  }
  return "UNAVAILABLE";
}

export function calculatePositionMappingCompatibility(
  bucket: CopyabilityBucket,
  opportunities: readonly ClassifiedCopyabilityOpportunity[],
  context: CopyabilityEvaluationContext,
): PositionMappingCompatibilityResult {
  const sellOpportunitiesByExecutionKey = new Map<
    string,
    ClassifiedCopyabilityOpportunity
  >();
  for (const opportunity of opportunities) {
    if (opportunity.side === "SELL") {
      if (opportunity.followerWallet !== bucket.followerWallet) {
        throw new Error("CROSS_FOLLOWER_COPYABILITY_BUCKET");
      }
      if (opportunity.leaderWallet !== bucket.leaderWallet) {
        throw new Error("CROSS_LEADER_COPYABILITY_BUCKET");
      }
      if (opportunity.quoteMint !== bucket.quoteMint) {
        throw new Error("CROSS_QUOTE_COPYABILITY_BUCKET");
      }
      const existing = sellOpportunitiesByExecutionKey.get(
        opportunity.executionKey,
      );
      if (
        existing !== undefined &&
        opportunityFingerprint(existing) !== opportunityFingerprint(opportunity)
      ) {
        throw new Error("CONFLICTING_POSITION_MAPPING_OPPORTUNITY_EVIDENCE");
      }
      sellOpportunitiesByExecutionKey.set(
        opportunity.executionKey,
        opportunity,
      );
    }
  }
  const sellOpportunities = [...sellOpportunitiesByExecutionKey.values()];
  let mappedOpportunityCount = 0;
  let mappingFailureCount = 0;
  let dataLimitationCount = 0;
  let unavailableCount = 0;

  for (const opportunity of sellOpportunities) {
    switch (positionMappingOutcome(opportunity.failureClassification)) {
      case "MAPPED":
        mappedOpportunityCount += 1;
        break;
      case "MAPPING_FAILURE":
        mappingFailureCount += 1;
        break;
      case "DATA_LIMITATION":
        dataLimitationCount += 1;
        break;
      case "UNAVAILABLE":
        unavailableCount += 1;
        break;
    }
  }

  const mappingOpportunityCount = mappedOpportunityCount + mappingFailureCount;
  const preconditionCount = sellOpportunities.length;

  return {
    followerWallet: bucket.followerWallet,
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    mappingOpportunityCount,
    mappedOpportunityCount,
    mappingFailureCount,
    mappingCompatibilityRate:
      mappingOpportunityCount === 0
        ? null
        : divideToDecimalString(
            mappedOpportunityCount,
            mappingOpportunityCount,
          ),
    preconditionCount,
    evaluableCount: mappingOpportunityCount,
    dataLimitationCount,
    unavailableCount,
    coverageRate:
      preconditionCount === 0
        ? null
        : divideToDecimalString(mappingOpportunityCount, preconditionCount),
    status:
      preconditionCount === 0
        ? "NO_SELL_OPPORTUNITIES"
        : mappingOpportunityCount === 0
          ? "NO_EVALUABLE_MAPPING_OUTCOMES"
          : "AVAILABLE",
    definitionVersion: context.copyabilityDefinitionVersion,
  };
}

export function calculateSizeGranularityCompatibility(
  bucket: CopyabilityBucket,
  opportunities: readonly SizeGranularityOpportunityEvidence[],
  context: CopyabilityEvaluationContext,
): SizeGranularityCompatibilityResult {
  const opportunitiesByExecutionKey = new Map<
    string,
    SizeGranularityOpportunityEvidence
  >();
  for (const opportunity of opportunities) {
    if (opportunity.followerWallet !== bucket.followerWallet) {
      throw new Error("CROSS_FOLLOWER_COPYABILITY_BUCKET");
    }
    if (opportunity.leaderWallet !== bucket.leaderWallet) {
      throw new Error("CROSS_LEADER_COPYABILITY_BUCKET");
    }
    if (opportunity.quoteMint !== bucket.quoteMint) {
      throw new Error("CROSS_QUOTE_COPYABILITY_BUCKET");
    }
    const existing = opportunitiesByExecutionKey.get(opportunity.executionKey);
    if (
      existing !== undefined &&
      sizeGranularityOpportunityFingerprint(existing) !==
        sizeGranularityOpportunityFingerprint(opportunity)
    ) {
      throw new Error("CONFLICTING_SIZE_GRANULARITY_OPPORTUNITY_EVIDENCE");
    }
    opportunitiesByExecutionKey.set(opportunity.executionKey, opportunity);
  }

  let granularOpportunityCount = 0;
  let roundedToZeroCount = 0;
  let preconditionCount = 0;
  let dataLimitationCount = 0;
  let unavailableCount = 0;

  for (const opportunity of opportunitiesByExecutionKey.values()) {
    const classification = opportunity.failureClassification;
    if (classification.primaryCategory === "POLICY_EXCLUSION") {
      continue;
    }
    const hasPositiveSizing = isPositiveSizingEvidence(opportunity);
    if (isMappingFailure(classification)) {
      if (!hasPositiveSizing) continue;
      if (classification.reasonCode === "NO_MAPPED_POSITION") {
        throw new Error("CONFLICTING_SIZE_GRANULARITY_OPPORTUNITY_EVIDENCE");
      }
    }
    preconditionCount += 1;

    if (isRoundedToZero(classification)) {
      if (hasPositiveSizing) {
        throw new Error("CONFLICTING_SIZE_GRANULARITY_OPPORTUNITY_EVIDENCE");
      }
      roundedToZeroCount += 1;
    } else if (classification.classificationStatus === "UNAVAILABLE") {
      unavailableCount += 1;
    } else if (hasPositiveSizing) {
      granularOpportunityCount += 1;
    } else if (classification.primaryCategory === "DATA_LIMITATION") {
      dataLimitationCount += 1;
    } else {
      unavailableCount += 1;
    }
  }

  const granularityOpportunityCount =
    granularOpportunityCount + roundedToZeroCount;

  return {
    followerWallet: bucket.followerWallet,
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    granularityOpportunityCount,
    granularOpportunityCount,
    roundedToZeroCount,
    granularityCompatibilityRate:
      granularityOpportunityCount === 0
        ? null
        : divideToDecimalString(
            granularOpportunityCount,
            granularityOpportunityCount,
          ),
    preconditionCount,
    evaluableCount: granularityOpportunityCount,
    dataLimitationCount,
    unavailableCount,
    coverageRate:
      preconditionCount === 0
        ? null
        : divideToDecimalString(granularityOpportunityCount, preconditionCount),
    status:
      preconditionCount === 0
        ? "NO_SIZING_OPPORTUNITIES"
        : granularityOpportunityCount === 0
          ? "NO_EVALUABLE_GRANULARITY_OUTCOMES"
          : "AVAILABLE",
    definitionVersion: context.copyabilityDefinitionVersion,
  };
}

export function calculateBuyCapacityCompatibility(
  bucket: CopyabilityBucket,
  opportunities: readonly BuyCapacityOpportunityEvidence[],
  context: CopyabilityEvaluationContext,
): BuyCapacityCompatibilityResult {
  const opportunitiesByExecutionKey = new Map<
    string,
    BuyCapacityOpportunityEvidence
  >();
  for (const opportunity of opportunities) {
    if (opportunity.side !== "BUY") continue;
    if (opportunity.followerWallet !== bucket.followerWallet) {
      throw new Error("CROSS_FOLLOWER_COPYABILITY_BUCKET");
    }
    if (opportunity.leaderWallet !== bucket.leaderWallet) {
      throw new Error("CROSS_LEADER_COPYABILITY_BUCKET");
    }
    if (opportunity.quoteMint !== bucket.quoteMint) {
      throw new Error("CROSS_QUOTE_COPYABILITY_BUCKET");
    }
    const existing = opportunitiesByExecutionKey.get(opportunity.executionKey);
    if (
      existing !== undefined &&
      sizeGranularityOpportunityFingerprint(existing) !==
        sizeGranularityOpportunityFingerprint(opportunity)
    ) {
      throw new Error("CONFLICTING_BUY_CAPACITY_OPPORTUNITY_EVIDENCE");
    }
    opportunitiesByExecutionKey.set(opportunity.executionKey, opportunity);
  }

  let fullSizeCount = 0;
  let resizedCount = 0;
  let capacityRejectCount = 0;
  let requestedQuoteRawTotal = 0n;
  let approvedQuoteRawTotal = 0n;
  let preconditionCount = 0;
  let nonCapacityRiskExclusionCount = 0;
  let dataLimitationCount = 0;
  let unavailableCount = 0;

  for (const opportunity of opportunitiesByExecutionKey.values()) {
    const classification = opportunity.failureClassification;
    if (
      classification.classificationStatus === "CLASSIFIED" &&
      classification.primaryCategory === "POLICY_EXCLUSION"
    ) {
      continue;
    }
    if (
      isRoundedToZero(classification) &&
      opportunity.preRiskSizingEvidence === undefined
    ) {
      continue;
    }
    if (classification.classificationStatus === "UNAVAILABLE") {
      preconditionCount += 1;
      unavailableCount += 1;
      continue;
    }

    const outcome = buyCapacityOutcome(opportunity);
    if (outcome === "NON_CAPACITY_RISK_EXCLUSION") {
      nonCapacityRiskExclusionCount += 1;
      continue;
    }
    if (outcome === null) {
      preconditionCount += 1;
      if (classification.primaryCategory === "DATA_LIMITATION") {
        dataLimitationCount += 1;
      } else {
        unavailableCount += 1;
      }
      continue;
    }

    const decision = opportunity.preRiskSizingEvidence!;
    preconditionCount += 1;
    requestedQuoteRawTotal += decision.requestedQuoteRaw;
    approvedQuoteRawTotal += decision.approvedQuoteRaw;
    switch (outcome) {
      case "FULL_SIZE":
        fullSizeCount += 1;
        break;
      case "RESIZED":
        resizedCount += 1;
        break;
      case "CAPACITY_REJECTED":
        capacityRejectCount += 1;
        break;
    }
  }

  const capacityOpportunityCount =
    fullSizeCount + resizedCount + capacityRejectCount;

  return {
    followerWallet: bucket.followerWallet,
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    capacityOpportunityCount,
    fullSizeCount,
    resizedCount,
    capacityRejectCount,
    fullSizeCompatibilityRate:
      capacityOpportunityCount === 0
        ? null
        : divideToDecimalString(fullSizeCount, capacityOpportunityCount),
    requestedQuoteRawTotal,
    approvedQuoteRawTotal,
    amountCompatibilityRate:
      requestedQuoteRawTotal === 0n
        ? null
        : divideToDecimalString(approvedQuoteRawTotal, requestedQuoteRawTotal),
    preconditionCount,
    evaluableCount: capacityOpportunityCount,
    nonCapacityRiskExclusionCount,
    dataLimitationCount,
    unavailableCount,
    coverageRate:
      preconditionCount === 0
        ? null
        : divideToDecimalString(capacityOpportunityCount, preconditionCount),
    status:
      preconditionCount === 0
        ? "NO_BUY_CAPACITY_OPPORTUNITIES"
        : capacityOpportunityCount === 0
          ? "NO_EVALUABLE_BUY_CAPACITY_OUTCOMES"
          : "AVAILABLE",
    definitionVersion: context.copyabilityDefinitionVersion,
  };
}

function assertCopyabilityAnalyticalBucket(
  bucket: CopyabilityBucket,
  analyticalBucket: {
    readonly followerWallet: string;
    readonly leaderWallet: string;
    readonly quoteMint: string;
  },
): void {
  if (analyticalBucket.followerWallet !== bucket.followerWallet) {
    throw new Error("CROSS_FOLLOWER_COPYABILITY_BUCKET");
  }
  if (analyticalBucket.leaderWallet !== bucket.leaderWallet) {
    throw new Error("CROSS_LEADER_COPYABILITY_BUCKET");
  }
  if (analyticalBucket.quoteMint !== bucket.quoteMint) {
    throw new Error("CROSS_QUOTE_COPYABILITY_BUCKET");
  }
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function calculatePriceImpactCompatibility(
  bucket: CopyabilityBucket,
  input: PriceImpactCompatibilityAnalyticalInput,
  context: CopyabilityEvaluationContext,
): PriceImpactCompatibilityResult {
  const { postRiskDistribution, priceImpactRejectRate } = input;
  assertCopyabilityAnalyticalBucket(bucket, postRiskDistribution);
  assertCopyabilityAnalyticalBucket(bucket, priceImpactRejectRate);

  const distributionCounts = [
    postRiskDistribution.postRiskDecisionCount,
    postRiskDistribution.postRiskAllowCount,
    postRiskDistribution.postRiskResizeCount,
    postRiskDistribution.postRiskRejectCount,
    postRiskDistribution.postRiskHaltCount,
    priceImpactRejectRate.postRiskDecisionCount,
    priceImpactRejectRate.priceImpactRejectCount,
  ];
  const distributionTotal =
    postRiskDistribution.postRiskAllowCount +
    postRiskDistribution.postRiskResizeCount +
    postRiskDistribution.postRiskRejectCount +
    postRiskDistribution.postRiskHaltCount;
  const expectedStatus =
    postRiskDistribution.postRiskDecisionCount === 0
      ? "NO_POST_RISK_DECISIONS"
      : "AVAILABLE";
  if (
    distributionCounts.some((count) => !isNonNegativeInteger(count)) ||
    distributionTotal !== postRiskDistribution.postRiskDecisionCount ||
    priceImpactRejectRate.postRiskDecisionCount !==
      postRiskDistribution.postRiskDecisionCount ||
    priceImpactRejectRate.priceImpactRejectCount >
      postRiskDistribution.postRiskRejectCount ||
    postRiskDistribution.status !== expectedStatus ||
    priceImpactRejectRate.status !== expectedStatus
  ) {
    throw new Error("CONFLICTING_PRICE_IMPACT_ANALYTICAL_RESULTS");
  }

  const expectedRate = (count: number): string | null =>
    postRiskDistribution.postRiskDecisionCount === 0
      ? null
      : divideToDecimalString(
          count,
          postRiskDistribution.postRiskDecisionCount,
        );
  if (
    postRiskDistribution.allowRate !==
      expectedRate(postRiskDistribution.postRiskAllowCount) ||
    postRiskDistribution.resizeRate !==
      expectedRate(postRiskDistribution.postRiskResizeCount) ||
    postRiskDistribution.rejectRate !==
      expectedRate(postRiskDistribution.postRiskRejectCount) ||
    postRiskDistribution.haltRate !==
      expectedRate(postRiskDistribution.postRiskHaltCount) ||
    priceImpactRejectRate.priceImpactRejectRate !==
      expectedRate(priceImpactRejectRate.priceImpactRejectCount)
  ) {
    throw new Error("CONFLICTING_PRICE_IMPACT_ANALYTICAL_RESULTS");
  }

  const priceImpactCompatibleCount = postRiskDistribution.postRiskAllowCount;
  const priceImpactRejectedCount = priceImpactRejectRate.priceImpactRejectCount;
  const priceImpactOpportunityCount =
    priceImpactCompatibleCount + priceImpactRejectedCount;

  return {
    followerWallet: bucket.followerWallet,
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    priceImpactOpportunityCount,
    priceImpactCompatibleCount,
    priceImpactRejectedCount,
    priceImpactCompatibilityRate:
      priceImpactOpportunityCount === 0
        ? null
        : divideToDecimalString(
            priceImpactCompatibleCount,
            priceImpactOpportunityCount,
          ),
    status:
      priceImpactOpportunityCount === 0
        ? "NO_PRICE_IMPACT_OPPORTUNITIES"
        : "AVAILABLE",
    definitionVersion: context.copyabilityDefinitionVersion,
  };
}

function freshnessProjectionFingerprint(
  projection: PostQuoteFreshnessAnalyticalProjection,
): string {
  return [
    projection.followerWallet,
    projection.leaderWallet,
    projection.quoteMint,
    projection.outcome,
  ].join("\u0000");
}

export function calculatePostQuoteFreshnessCompatibility(
  bucket: CopyabilityBucket,
  projections: readonly PostQuoteFreshnessAnalyticalProjection[],
  context: CopyabilityEvaluationContext,
): PostQuoteFreshnessCompatibilityResult {
  const projectionsByExecutionKey = new Map<
    string,
    PostQuoteFreshnessAnalyticalProjection
  >();
  for (const projection of projections) {
    if (projection.followerWallet !== bucket.followerWallet) {
      throw new Error("CROSS_FOLLOWER_COPYABILITY_BUCKET");
    }
    if (projection.leaderWallet !== bucket.leaderWallet) {
      throw new Error("CROSS_LEADER_COPYABILITY_BUCKET");
    }
    if (projection.quoteMint !== bucket.quoteMint) {
      throw new Error("CROSS_QUOTE_COPYABILITY_BUCKET");
    }
    if (
      projection.outcome !== "PASS" &&
      projection.outcome !== "STALE" &&
      projection.outcome !== "BEFORE_FRESHNESS" &&
      projection.outcome !== "UNAVAILABLE"
    ) {
      throw new Error("CONFLICTING_FRESHNESS_ANALYTICAL_RESULTS");
    }
    const existing = projectionsByExecutionKey.get(projection.executionKey);
    if (
      existing !== undefined &&
      freshnessProjectionFingerprint(existing) !==
        freshnessProjectionFingerprint(projection)
    ) {
      throw new Error("CONFLICTING_FRESHNESS_ANALYTICAL_RESULTS");
    }
    projectionsByExecutionKey.set(projection.executionKey, projection);
  }

  let freshnessCompatibleCount = 0;
  let staleQuoteCount = 0;
  let beforeFreshnessCount = 0;
  let unavailableCount = 0;
  for (const projection of projectionsByExecutionKey.values()) {
    switch (projection.outcome) {
      case "PASS":
        freshnessCompatibleCount += 1;
        break;
      case "STALE":
        staleQuoteCount += 1;
        break;
      case "BEFORE_FRESHNESS":
        beforeFreshnessCount += 1;
        break;
      case "UNAVAILABLE":
        unavailableCount += 1;
        break;
    }
  }

  const freshnessOpportunityCount = freshnessCompatibleCount + staleQuoteCount;
  const preconditionCount = projectionsByExecutionKey.size;

  return {
    followerWallet: bucket.followerWallet,
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    freshnessOpportunityCount,
    freshnessCompatibleCount,
    staleQuoteCount,
    freshnessCompatibilityRate:
      freshnessOpportunityCount === 0
        ? null
        : divideToDecimalString(
            freshnessCompatibleCount,
            freshnessOpportunityCount,
          ),
    preconditionCount,
    evaluableCount: freshnessOpportunityCount,
    beforeFreshnessCount,
    unavailableCount,
    coverageRate:
      preconditionCount === 0
        ? null
        : divideToDecimalString(freshnessOpportunityCount, preconditionCount),
    status:
      freshnessOpportunityCount === 0
        ? "NO_EVALUABLE_FRESHNESS_OUTCOMES"
        : "AVAILABLE",
    definitionVersion: context.copyabilityDefinitionVersion,
  };
}

export function calculateJupiterQuoteUsability(
  bucket: CopyabilityBucket,
  analyticalResult: FollowerScopedJupiterSuccessRateResult,
  context: CopyabilityEvaluationContext,
): JupiterQuoteUsabilityResult {
  assertCopyabilityAnalyticalBucket(bucket, analyticalResult);

  const { attemptCount, successCount, successRate, status } = analyticalResult;
  if (
    !isNonNegativeInteger(attemptCount) ||
    !isNonNegativeInteger(successCount) ||
    successCount > attemptCount
  ) {
    throw new Error("CONFLICTING_JUPITER_USABILITY_ANALYTICAL_RESULT");
  }
  const expectedStatus = attemptCount === 0 ? "NO_ATTEMPTS" : "AVAILABLE";
  const expectedRate =
    attemptCount === 0
      ? null
      : divideToDecimalString(successCount, attemptCount);
  if (status !== expectedStatus || successRate !== expectedRate) {
    throw new Error("CONFLICTING_JUPITER_USABILITY_ANALYTICAL_RESULT");
  }

  return {
    followerWallet: bucket.followerWallet,
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    jupiterQuoteOpportunityCount: attemptCount,
    usableJupiterQuoteCount: successCount,
    jupiterQuoteUsabilityRate: successRate,
    status:
      status === "NO_ATTEMPTS" ? "NO_JUPITER_QUOTE_OPPORTUNITIES" : "AVAILABLE",
    definitionVersion: context.copyabilityDefinitionVersion,
  };
}

export function calculateEndToEndApplicationCompatibility(
  bucket: CopyabilityBucket,
  opportunities: readonly ClassifiedCopyabilityOpportunity[],
  context: CopyabilityEvaluationContext,
): EndToEndApplicationCompatibilityResult {
  const opportunitiesByExecutionKey = new Map<
    string,
    ClassifiedCopyabilityOpportunity
  >();
  for (const opportunity of opportunities) {
    if (opportunity.followerWallet !== bucket.followerWallet) {
      throw new Error("CROSS_FOLLOWER_COPYABILITY_BUCKET");
    }
    if (opportunity.leaderWallet !== bucket.leaderWallet) {
      throw new Error("CROSS_LEADER_COPYABILITY_BUCKET");
    }
    if (opportunity.quoteMint !== bucket.quoteMint) {
      throw new Error("CROSS_QUOTE_COPYABILITY_BUCKET");
    }
    const existing = opportunitiesByExecutionKey.get(opportunity.executionKey);
    if (
      existing !== undefined &&
      opportunityFingerprint(existing) !== opportunityFingerprint(opportunity)
    ) {
      throw new Error("CONFLICTING_END_TO_END_APPLICATION_ANALYTICAL_RESULTS");
    }
    opportunitiesByExecutionKey.set(opportunity.executionKey, opportunity);
  }

  let applicationSuccessCount = 0;
  let terminalFailureCount = 0;
  let preconditionCount = 0;
  let dataLimitationCount = 0;
  let unavailableCount = 0;
  for (const opportunity of opportunitiesByExecutionKey.values()) {
    const classification = opportunity.failureClassification;
    if (
      classification.classificationStatus === "CLASSIFIED" &&
      classification.primaryCategory === "POLICY_EXCLUSION"
    ) {
      continue;
    }
    if (
      classification.classificationStatus === "NOT_A_FAILURE" &&
      classification.stage === "OBSERVATION_CLASSIFICATION"
    ) {
      continue;
    }

    preconditionCount += 1;
    if (
      classification.classificationStatus === "NOT_A_FAILURE" &&
      classification.stage === "PAPER_APPLICATION" &&
      classification.primaryCategory === null
    ) {
      applicationSuccessCount += 1;
    } else if (isTerminalOpportunityFailure(classification)) {
      terminalFailureCount += 1;
    } else if (
      classification.classificationStatus === "CLASSIFIED" &&
      classification.primaryCategory === "DATA_LIMITATION"
    ) {
      dataLimitationCount += 1;
    } else {
      unavailableCount += 1;
    }
  }

  const endToEndOpportunityCount =
    applicationSuccessCount + terminalFailureCount;

  return {
    followerWallet: bucket.followerWallet,
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    endToEndOpportunityCount,
    applicationSuccessCount,
    terminalFailureCount,
    endToEndApplicationCompatibilityRate:
      endToEndOpportunityCount === 0
        ? null
        : divideToDecimalString(
            applicationSuccessCount,
            endToEndOpportunityCount,
          ),
    preconditionCount,
    evaluableCount: endToEndOpportunityCount,
    dataLimitationCount,
    unavailableCount,
    coverageRate:
      preconditionCount === 0
        ? null
        : divideToDecimalString(endToEndOpportunityCount, preconditionCount),
    status:
      preconditionCount === 0
        ? "NO_END_TO_END_OPPORTUNITIES"
        : endToEndOpportunityCount === 0
          ? "NO_EVALUABLE_END_TO_END_OUTCOMES"
          : "AVAILABLE",
    definitionVersion: context.copyabilityDefinitionVersion,
  };
}

export function calculateCopyabilityAggregate(
  bucket: CopyabilityBucket,
  components: CopyabilityAggregateComponents,
  context: CopyabilityEvaluationContext,
): CopyabilityAggregateResult {
  const componentResults = [
    components.positionMapping,
    components.sizeGranularity,
    components.buyCapacity,
    components.jupiterQuoteUsability,
    components.postQuoteFreshness,
    components.priceImpact,
    components.endToEndApplication,
  ];
  if (
    componentResults.some(
      (component) =>
        component.followerWallet !== bucket.followerWallet ||
        component.leaderWallet !== bucket.leaderWallet ||
        component.quoteMint !== bucket.quoteMint,
    )
  ) {
    throw new Error("CONFLICTING_COPYABILITY_COMPONENT_BUCKETS");
  }

  return {
    followerWallet: bucket.followerWallet,
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    evaluationContext: {
      window: { ...context.window },
      source: context.source,
      mode: context.mode,
      copyRatioBps: context.copyRatioBps,
      riskPolicyVersion: context.riskPolicyVersion,
      fillPolicyVersion: context.fillPolicyVersion,
      accountingPolicyVersion: context.accountingPolicyVersion,
      copyabilityDefinitionVersion: context.copyabilityDefinitionVersion,
    },
    positionMapping: { ...components.positionMapping },
    sizeGranularity: { ...components.sizeGranularity },
    buyCapacity: { ...components.buyCapacity },
    jupiterQuoteUsability: { ...components.jupiterQuoteUsability },
    postQuoteFreshness: { ...components.postQuoteFreshness },
    priceImpact: { ...components.priceImpact },
    endToEndApplication: { ...components.endToEndApplication },
    definitionVersion: context.copyabilityDefinitionVersion,
  };
}
