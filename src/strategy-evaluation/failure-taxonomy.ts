import type { ExecutionState } from "../domain/execution.js";
import { jsonStringify } from "../domain/json.js";
import type { RiskDecisionKind, RiskReasonCode } from "../risk/risk-engine.js";
import type { ValidationClassification } from "../validation/types.js";

export type OpportunityFailureCategory =
  | "EXECUTION_FAILURE"
  | "MARKET_FAILURE"
  | "RISK_REJECTION"
  | "COPYABILITY_FAILURE"
  | "DATA_LIMITATION"
  | "POLICY_EXCLUSION";

export type OpportunityFailureStage =
  | "OBSERVATION_CLASSIFICATION"
  | "OBSERVATION_POLICY"
  | "COPY_DECISION"
  | "PRE_QUOTE_RISK"
  | "JUPITER_ORDER"
  | "POST_QUOTE_RISK"
  | "PAPER_APPLICATION";

export interface FailureTaxonomyPolicy {
  readonly definitionVersion: string;
}

export interface NormalizedJupiterAttemptEvidence {
  readonly executionKey: string;
  readonly httpStatus: number | null;
  readonly schemaValid: boolean;
  readonly expectedOutputRaw?: bigint | null;
  readonly route?: readonly unknown[] | null;
}

export interface NormalizedRiskDecisionEvidence {
  readonly intentId: string;
  readonly phase: "PRE_QUOTE" | "POST_QUOTE";
  readonly decision: RiskDecisionKind;
  readonly reasonCode: RiskReasonCode;
}

export interface NormalizedFollowerTradeEvidence {
  readonly executionKey: string;
  readonly state: ExecutionState;
  readonly structuredReasonCode?: string;
}

export interface NormalizedPaperFillEvidence {
  readonly id: string;
  readonly intentId: string;
}

export interface NormalizedPaperFillApplicationEvidence {
  readonly fillId: string;
}

export interface NormalizedOpportunityEvidence {
  readonly executionKey: string;
  readonly observationClassification?: ValidationClassification;
  readonly observationReasonCode?: string;
  readonly followerTrade?: NormalizedFollowerTradeEvidence;
  readonly jupiterAttempts?: readonly NormalizedJupiterAttemptEvidence[];
  readonly riskDecisions?: readonly NormalizedRiskDecisionEvidence[];
  /** Singular after caller-owned dedupe by PaperFill.id. */
  readonly paperFill?: NormalizedPaperFillEvidence;
  /** Singular after caller-owned dedupe by PaperFillApplication.fillId. */
  readonly paperFillApplication?: NormalizedPaperFillApplicationEvidence;
  readonly policyExclusionReasonCode?: string;
  readonly unstructuredFailureReasons?: readonly string[];
}

export interface FailureClassification {
  readonly classificationStatus: "CLASSIFIED" | "UNAVAILABLE" | "NOT_A_FAILURE";
  readonly primaryCategory: OpportunityFailureCategory | null;
  readonly stage: OpportunityFailureStage | null;
  readonly reasonCode: string | null;
  readonly definitionVersion: string;
}

const TERMINAL_OPPORTUNITY_FAILURE_CATEGORIES =
  new Set<OpportunityFailureCategory>([
    "EXECUTION_FAILURE",
    "MARKET_FAILURE",
    "RISK_REJECTION",
    "COPYABILITY_FAILURE",
  ]);

export function isTerminalOpportunityFailure(
  classification: FailureClassification,
): boolean {
  return (
    classification.classificationStatus === "CLASSIFIED" &&
    classification.primaryCategory !== null &&
    TERMINAL_OPPORTUNITY_FAILURE_CATEGORIES.has(classification.primaryCategory)
  );
}

export type PostQuoteFreshnessAnalyticalOutcome =
  "PASS" | "STALE" | "BEFORE_FRESHNESS" | "UNAVAILABLE";

export interface PostQuoteFreshnessAnalyticalProjection {
  readonly executionKey: string;
  readonly followerWallet: string;
  readonly leaderWallet: string;
  readonly quoteMint: string;
  readonly outcome: PostQuoteFreshnessAnalyticalOutcome;
}

const COPYABILITY_FOLLOWER_REASON_CODES = new Set([
  "SIZE_ROUNDED_TO_ZERO",
  "NO_MAPPED_POSITION",
  "INSUFFICIENT_MAPPED_POSITION",
]);

const PRE_REJECT_RISK_REASON_CODES = new Set<RiskReasonCode>([
  "SINGLE_TRADE_LIMIT",
  "RISK_POLICY_FOR_QUOTE_UNAVAILABLE",
  "INTENT_TIMESTAMP_UNAVAILABLE",
  "INTENT_TIMESTAMP_PROVENANCE_INVALID",
  "STALE_INTENT",
  "TOKEN_COST_EXPOSURE_LIMIT",
  "PORTFOLIO_COST_EXPOSURE_LIMIT",
  "PROVIDER_DEGRADED",
  "SELL_NOT_RISK_REDUCING",
]);

const PRE_HALT_RISK_REASON_CODES = new Set<RiskReasonCode>([
  "GLOBAL_HALT_NEW_RISK",
  "DAILY_REALIZED_LOSS_LIMIT",
]);

const PRE_RESIZE_RISK_REASON_CODES = new Set<RiskReasonCode>([
  "SINGLE_TRADE_LIMIT",
  "TOKEN_COST_EXPOSURE_LIMIT",
  "PORTFOLIO_COST_EXPOSURE_LIMIT",
]);

export function isBuyCapacityRiskReasonCode(
  reasonCode: RiskReasonCode,
): boolean {
  return PRE_RESIZE_RISK_REASON_CODES.has(reasonCode);
}

const POST_REJECT_RISK_REASON_CODES = new Set<RiskReasonCode>([
  "ROUTE_INVALID",
  "PRICE_IMPACT_TOO_HIGH",
  "PRICE_IMPACT_UNAVAILABLE",
  "QUOTE_AMOUNT_MISMATCH",
  "STALE_QUOTE",
  "RISK_POLICY_FOR_QUOTE_UNAVAILABLE",
]);

const POST_FRESHNESS_PASS_REASON_CODES = new Set<RiskReasonCode>([
  "ROUTE_INVALID",
  "PRICE_IMPACT_UNAVAILABLE",
  "RISK_POLICY_FOR_QUOTE_UNAVAILABLE",
  "PRICE_IMPACT_TOO_HIGH",
]);

export function projectPostQuoteFreshnessOutcome(
  evidence: NormalizedRiskDecisionEvidence,
): PostQuoteFreshnessAnalyticalOutcome {
  if (evidence.phase !== "POST_QUOTE") return "UNAVAILABLE";
  if (evidence.decision === "ALLOW" && evidence.reasonCode === "ALLOW") {
    return "PASS";
  }
  if (evidence.decision !== "REJECT") return "UNAVAILABLE";
  if (evidence.reasonCode === "QUOTE_AMOUNT_MISMATCH") {
    return "BEFORE_FRESHNESS";
  }
  if (evidence.reasonCode === "STALE_QUOTE") return "STALE";
  if (POST_FRESHNESS_PASS_REASON_CODES.has(evidence.reasonCode)) return "PASS";
  return "UNAVAILABLE";
}

const DATA_LIMITATION_FOLLOWER_REASON_CODES = new Set([
  "LEADER_PRE_BALANCE_ZERO",
  "LEADER_SELL_EXCEEDS_PRE_BALANCE",
  "LEGACY_POSITION_COST_BASIS_UNAVAILABLE",
  "POSITION_QUOTE_MISMATCH",
]);

const DATA_LIMITATION_OBSERVATION_REASON_CODES = new Set([
  "PARSER_FAILURE",
  "AMBIGUOUS_OWNERSHIP",
  "NO_ASSET_DELTA",
  "UNKNOWN_SWAP_PROGRAM",
  "NO_SWAP_EVIDENCE",
  "NO_QUOTE_ASSET",
  "TOKEN_TO_TOKEN",
  "MISSING_DECIMALS",
  "UNSUPPORTED_TOKEN_2022",
  "AMBIGUOUS_DIRECTION",
]);

const NON_SWAP_OBSERVATION_REASON_CODES = new Set([
  "ORDINARY_TRANSFER",
  "LIQUIDITY_OPERATION",
  "STAKE_OR_LENDING",
]);

const NON_SWAP_OBSERVATION_CLASSIFICATIONS = new Set([
  "TRANSFER",
  "LP",
  "STAKE",
  "LENDING",
]);

const NON_SWAP_CLASSIFICATION_BY_REASON: Readonly<
  Record<string, ValidationClassification>
> = {
  ORDINARY_TRANSFER: "TRANSFER",
  LIQUIDITY_OPERATION: "LP",
  STAKE_OR_LENDING: "LENDING",
};

function unavailable(
  policy: FailureTaxonomyPolicy,
  reasonCode: string | null = null,
): FailureClassification {
  return {
    classificationStatus: "UNAVAILABLE",
    primaryCategory: null,
    stage: null,
    reasonCode,
    definitionVersion: policy.definitionVersion,
  };
}

function jupiterFingerprint(attempt: NormalizedJupiterAttemptEvidence): string {
  const routeFingerprint =
    attempt.route === null || attempt.route === undefined
      ? "NO_ROUTE"
      : jsonStringify(attempt.route);
  return [
    attempt.executionKey,
    attempt.httpStatus ?? "NO_HTTP_STATUS",
    attempt.schemaValid,
    attempt.expectedOutputRaw?.toString() ?? "NO_OUTPUT",
    routeFingerprint,
  ].join("\u0000");
}

function isSupportedRiskDecision(
  evidence: NormalizedRiskDecisionEvidence,
): boolean {
  if (evidence.phase === "PRE_QUOTE") {
    if (evidence.decision === "ALLOW") return evidence.reasonCode === "ALLOW";
    if (evidence.decision === "RESIZE") {
      return isBuyCapacityRiskReasonCode(evidence.reasonCode);
    }
    if (evidence.decision === "REJECT") {
      return PRE_REJECT_RISK_REASON_CODES.has(evidence.reasonCode);
    }
    return PRE_HALT_RISK_REASON_CODES.has(evidence.reasonCode);
  }
  if (evidence.decision === "ALLOW") return evidence.reasonCode === "ALLOW";
  return (
    evidence.decision === "REJECT" &&
    POST_REJECT_RISK_REASON_CODES.has(evidence.reasonCode)
  );
}

export function classifyOpportunityFailure(
  evidence: NormalizedOpportunityEvidence,
  policy: FailureTaxonomyPolicy,
): FailureClassification {
  const jupiterAttempts = evidence.jupiterAttempts ?? [];
  const riskDecisions = evidence.riskDecisions ?? [];
  const preDecision = riskDecisions.find(
    (decision) => decision.phase === "PRE_QUOTE",
  );
  const postDecision = riskDecisions.find(
    (decision) => decision.phase === "POST_QUOTE",
  );
  const jupiterAttempt = jupiterAttempts[0];
  const jupiterStructuredSuccess =
    jupiterAttempt !== undefined &&
    jupiterAttempt.httpStatus !== null &&
    jupiterAttempt.httpStatus >= 200 &&
    jupiterAttempt.httpStatus < 300 &&
    jupiterAttempt.schemaValid === true &&
    jupiterAttempt.expectedOutputRaw !== null &&
    jupiterAttempt.expectedOutputRaw !== undefined &&
    jupiterAttempt.expectedOutputRaw > 0n &&
    jupiterAttempt.route !== null &&
    jupiterAttempt.route !== undefined &&
    jupiterAttempt.route.length > 0;
  const crossOpportunityIdentity =
    jupiterAttempts.some(
      (attempt) => attempt.executionKey !== evidence.executionKey,
    ) ||
    riskDecisions.some(
      (decision) => decision.intentId !== evidence.executionKey,
    ) ||
    (evidence.followerTrade !== undefined &&
      evidence.followerTrade.executionKey !== evidence.executionKey) ||
    (evidence.paperFill !== undefined &&
      evidence.paperFill.intentId !== evidence.executionKey);
  const conflictingPaperIdentity =
    evidence.paperFill !== undefined &&
    evidence.paperFillApplication !== undefined &&
    evidence.paperFillApplication.fillId !== evidence.paperFill.id;
  const structuredFollowerSkip =
    evidence.followerTrade?.state === "SKIPPED" &&
    evidence.followerTrade.structuredReasonCode !== undefined &&
    (COPYABILITY_FOLLOWER_REASON_CODES.has(
      evidence.followerTrade.structuredReasonCode,
    ) ||
      DATA_LIMITATION_FOLLOWER_REASON_CODES.has(
        evidence.followerTrade.structuredReasonCode,
      ));
  const terminalObservation =
    evidence.observationReasonCode !== undefined ||
    (evidence.observationClassification !== undefined &&
      (NON_SWAP_OBSERVATION_CLASSIFICATIONS.has(
        evidence.observationClassification,
      ) ||
        evidence.observationClassification === "UNSUPPORTED"));
  const observationOutcomes = new Set<string>();
  const expectedNonSwapClassification =
    evidence.observationReasonCode === undefined
      ? undefined
      : NON_SWAP_CLASSIFICATION_BY_REASON[evidence.observationReasonCode];
  const conflictingNonSwapObservation =
    expectedNonSwapClassification !== undefined &&
    evidence.observationClassification !== undefined &&
    evidence.observationClassification !== expectedNonSwapClassification;
  if (evidence.policyExclusionReasonCode === "QUOTE_ASSET_NOT_ALLOWED") {
    observationOutcomes.add("POLICY_EXCLUSION");
  }
  if (
    (evidence.observationReasonCode !== undefined &&
      DATA_LIMITATION_OBSERVATION_REASON_CODES.has(
        evidence.observationReasonCode,
      )) ||
    evidence.observationClassification === "UNSUPPORTED"
  ) {
    observationOutcomes.add("DATA_LIMITATION");
  }
  if (
    (evidence.observationReasonCode !== undefined &&
      NON_SWAP_OBSERVATION_REASON_CODES.has(evidence.observationReasonCode)) ||
    (evidence.observationClassification !== undefined &&
      NON_SWAP_OBSERVATION_CLASSIFICATIONS.has(
        evidence.observationClassification,
      ))
  ) {
    observationOutcomes.add("NOT_A_FAILURE");
  }
  const supportedObservationReason =
    evidence.observationReasonCode !== undefined &&
    (DATA_LIMITATION_OBSERVATION_REASON_CODES.has(
      evidence.observationReasonCode,
    ) ||
      NON_SWAP_OBSERVATION_REASON_CODES.has(evidence.observationReasonCode));
  const conflictingUnsupportedObservation =
    evidence.observationReasonCode !== undefined &&
    !supportedObservationReason &&
    observationOutcomes.size > 0;
  const jupiterFingerprints = new Set(jupiterAttempts.map(jupiterFingerprint));
  const conflictingRiskPhase = (["PRE_QUOTE", "POST_QUOTE"] as const).some(
    (phase) =>
      new Set(
        riskDecisions
          .filter((decision) => decision.phase === phase)
          .map(
            (decision) =>
              `${decision.intentId}\u0000${decision.decision}\u0000${decision.reasonCode}`,
          ),
      ).size > 1,
  );
  const unsupportedRiskEvidence = riskDecisions.some(
    (decision) => !isSupportedRiskDecision(decision),
  );
  if (
    crossOpportunityIdentity ||
    conflictingPaperIdentity ||
    jupiterFingerprints.size > 1 ||
    conflictingRiskPhase ||
    observationOutcomes.size > 1 ||
    conflictingNonSwapObservation ||
    conflictingUnsupportedObservation
  ) {
    return unavailable(policy, "CONFLICTING_EVIDENCE");
  }
  if (unsupportedRiskEvidence) return unavailable(policy);
  if (
    preDecision !== undefined &&
    (preDecision.decision === "REJECT" || preDecision.decision === "HALT") &&
    (jupiterAttempts.length > 0 ||
      postDecision !== undefined ||
      evidence.paperFill !== undefined ||
      evidence.paperFillApplication !== undefined)
  ) {
    return unavailable(policy, "CONFLICTING_EVIDENCE");
  }
  const jupiterCannotSupportDownstream =
    jupiterAttempt !== undefined && !jupiterStructuredSuccess;
  if (
    jupiterCannotSupportDownstream &&
    (postDecision !== undefined ||
      evidence.paperFill !== undefined ||
      evidence.paperFillApplication !== undefined)
  ) {
    return unavailable(policy, "CONFLICTING_EVIDENCE");
  }
  if (
    postDecision !== undefined &&
    (postDecision.decision === "REJECT" || postDecision.decision === "HALT") &&
    (evidence.paperFill !== undefined ||
      evidence.paperFillApplication !== undefined)
  ) {
    return unavailable(policy, "CONFLICTING_EVIDENCE");
  }
  if (
    evidence.followerTrade !== undefined &&
    (evidence.followerTrade.state === "FAILED" ||
      evidence.followerTrade.state === "SKIPPED" ||
      evidence.followerTrade.state === "UNCERTAIN") &&
    (evidence.paperFill !== undefined ||
      evidence.paperFillApplication !== undefined)
  ) {
    return unavailable(policy, "CONFLICTING_EVIDENCE");
  }
  if (
    structuredFollowerSkip &&
    (jupiterAttempts.length > 0 ||
      riskDecisions.length > 0 ||
      evidence.paperFill !== undefined ||
      evidence.paperFillApplication !== undefined)
  ) {
    return unavailable(policy, "CONFLICTING_EVIDENCE");
  }
  if (
    evidence.policyExclusionReasonCode !== undefined &&
    (evidence.followerTrade !== undefined ||
      jupiterAttempts.length > 0 ||
      riskDecisions.length > 0 ||
      evidence.paperFill !== undefined ||
      evidence.paperFillApplication !== undefined)
  ) {
    return unavailable(policy, "CONFLICTING_EVIDENCE");
  }
  if (
    terminalObservation &&
    (evidence.followerTrade !== undefined ||
      jupiterAttempts.length > 0 ||
      riskDecisions.length > 0 ||
      evidence.paperFill !== undefined ||
      evidence.paperFillApplication !== undefined)
  ) {
    return unavailable(policy, "CONFLICTING_EVIDENCE");
  }
  if (evidence.policyExclusionReasonCode === "QUOTE_ASSET_NOT_ALLOWED") {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "POLICY_EXCLUSION",
      stage: "OBSERVATION_POLICY",
      reasonCode: evidence.policyExclusionReasonCode,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    evidence.observationReasonCode !== undefined &&
    DATA_LIMITATION_OBSERVATION_REASON_CODES.has(evidence.observationReasonCode)
  ) {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "DATA_LIMITATION",
      stage: "OBSERVATION_CLASSIFICATION",
      reasonCode: evidence.observationReasonCode,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (evidence.observationClassification === "UNSUPPORTED") {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "DATA_LIMITATION",
      stage: "OBSERVATION_CLASSIFICATION",
      reasonCode: evidence.observationClassification,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    evidence.observationReasonCode !== undefined &&
    NON_SWAP_OBSERVATION_REASON_CODES.has(evidence.observationReasonCode)
  ) {
    return {
      classificationStatus: "NOT_A_FAILURE",
      primaryCategory: null,
      stage: "OBSERVATION_CLASSIFICATION",
      reasonCode: evidence.observationReasonCode,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    evidence.observationClassification !== undefined &&
    NON_SWAP_OBSERVATION_CLASSIFICATIONS.has(evidence.observationClassification)
  ) {
    return {
      classificationStatus: "NOT_A_FAILURE",
      primaryCategory: null,
      stage: "OBSERVATION_CLASSIFICATION",
      reasonCode: evidence.observationClassification,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    evidence.paperFill !== undefined &&
    evidence.paperFillApplication?.fillId === evidence.paperFill.id
  ) {
    return {
      classificationStatus: "NOT_A_FAILURE",
      primaryCategory: null,
      stage: "PAPER_APPLICATION",
      reasonCode: null,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    preDecision !== undefined &&
    ((preDecision.decision === "REJECT" &&
      PRE_REJECT_RISK_REASON_CODES.has(preDecision.reasonCode)) ||
      (preDecision.decision === "HALT" &&
        PRE_HALT_RISK_REASON_CODES.has(preDecision.reasonCode)))
  ) {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "RISK_REJECTION",
      stage: "PRE_QUOTE_RISK",
      reasonCode: preDecision.reasonCode,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (jupiterAttempts[0]?.httpStatus === 429) {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "EXECUTION_FAILURE",
      stage: "JUPITER_ORDER",
      reasonCode: "JUPITER_HTTP_429",
      definitionVersion: policy.definitionVersion,
    };
  }
  const httpStatus = jupiterAttempts[0]?.httpStatus;
  if (httpStatus === null) {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "EXECUTION_FAILURE",
      stage: "JUPITER_ORDER",
      reasonCode: "JUPITER_NO_HTTP_STATUS",
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    httpStatus !== null &&
    httpStatus !== undefined &&
    httpStatus >= 500 &&
    httpStatus <= 599
  ) {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "EXECUTION_FAILURE",
      stage: "JUPITER_ORDER",
      reasonCode: "JUPITER_HTTP_5XX",
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    httpStatus !== null &&
    httpStatus !== undefined &&
    httpStatus >= 200 &&
    httpStatus < 300 &&
    jupiterAttempt?.schemaValid === false
  ) {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "EXECUTION_FAILURE",
      stage: "JUPITER_ORDER",
      reasonCode: "JUPITER_SCHEMA_INVALID",
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    httpStatus !== null &&
    httpStatus !== undefined &&
    (httpStatus < 200 || httpStatus >= 300)
  ) {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "EXECUTION_FAILURE",
      stage: "JUPITER_ORDER",
      reasonCode: `JUPITER_HTTP_${httpStatus}`,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    postDecision?.decision === "REJECT" &&
    (postDecision.reasonCode === "ROUTE_INVALID" ||
      postDecision.reasonCode === "PRICE_IMPACT_TOO_HIGH")
  ) {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "MARKET_FAILURE",
      stage: "POST_QUOTE_RISK",
      reasonCode: postDecision.reasonCode,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    postDecision?.decision === "REJECT" &&
    (postDecision.reasonCode === "PRICE_IMPACT_UNAVAILABLE" ||
      postDecision.reasonCode === "QUOTE_AMOUNT_MISMATCH")
  ) {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "DATA_LIMITATION",
      stage: "POST_QUOTE_RISK",
      reasonCode: postDecision.reasonCode,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    postDecision?.decision === "REJECT" &&
    postDecision.reasonCode === "RISK_POLICY_FOR_QUOTE_UNAVAILABLE"
  ) {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "RISK_REJECTION",
      stage: "POST_QUOTE_RISK",
      reasonCode: postDecision.reasonCode,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    postDecision?.decision === "REJECT" &&
    postDecision.reasonCode === "STALE_QUOTE"
  ) {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "COPYABILITY_FAILURE",
      stage: "POST_QUOTE_RISK",
      reasonCode: postDecision.reasonCode,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    evidence.followerTrade?.state === "SKIPPED" &&
    evidence.followerTrade.structuredReasonCode !== undefined &&
    COPYABILITY_FOLLOWER_REASON_CODES.has(
      evidence.followerTrade.structuredReasonCode,
    )
  ) {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "COPYABILITY_FAILURE",
      stage: "COPY_DECISION",
      reasonCode: evidence.followerTrade.structuredReasonCode,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    evidence.followerTrade?.state === "SKIPPED" &&
    evidence.followerTrade.structuredReasonCode !== undefined &&
    DATA_LIMITATION_FOLLOWER_REASON_CODES.has(
      evidence.followerTrade.structuredReasonCode,
    )
  ) {
    return {
      classificationStatus: "CLASSIFIED",
      primaryCategory: "DATA_LIMITATION",
      stage: "COPY_DECISION",
      reasonCode: evidence.followerTrade.structuredReasonCode,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    evidence.followerTrade !== undefined &&
    (evidence.followerTrade.state === "FAILED" ||
      evidence.followerTrade.state === "SKIPPED" ||
      evidence.followerTrade.state === "UNCERTAIN")
  ) {
    return unavailable(policy);
  }
  if (
    (evidence.paperFill === undefined) !==
    (evidence.paperFillApplication === undefined)
  ) {
    return unavailable(policy);
  }
  if (jupiterStructuredSuccess) {
    return {
      classificationStatus: "NOT_A_FAILURE",
      primaryCategory: null,
      stage: "JUPITER_ORDER",
      reasonCode: null,
      definitionVersion: policy.definitionVersion,
    };
  }
  if (
    preDecision?.decision === "RESIZE" &&
    isBuyCapacityRiskReasonCode(preDecision.reasonCode)
  ) {
    return {
      classificationStatus: "NOT_A_FAILURE",
      primaryCategory: null,
      stage: "PRE_QUOTE_RISK",
      reasonCode: preDecision.reasonCode,
      definitionVersion: policy.definitionVersion,
    };
  }

  return unavailable(policy);
}
