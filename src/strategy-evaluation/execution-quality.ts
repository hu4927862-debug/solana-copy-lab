import type {
  RiskDecision,
  RiskDecisionKind,
  RiskReasonCode,
} from "../risk/risk-engine.js";
import type { PositionTransition } from "../domain/positions.js";
import type { PaperFillCostEvidence } from "./cost-completeness.js";

export interface ExecutionQualityBucket {
  readonly leaderWallet: string;
  readonly quoteMint: string;
}

export interface FollowerExecutionQualityBucket extends ExecutionQualityBucket {
  readonly followerWallet: string;
}

export interface PostRiskExecutionQualityBucket extends FollowerExecutionQualityBucket {}

export interface JupiterAttemptEvidence extends ExecutionQualityBucket {
  readonly executionKey: string;
  readonly httpStatus: number | null;
  readonly schemaValid: boolean;
  readonly expectedOutputRaw: bigint | null;
  readonly route: readonly unknown[] | null;
}

export interface FollowerScopedJupiterAttemptEvidence
  extends JupiterAttemptEvidence, FollowerExecutionQualityBucket {
  readonly validationEventId: string;
}

export interface JupiterSuccessRateResult extends ExecutionQualityBucket {
  readonly attemptCount: number;
  readonly successCount: number;
  readonly successRate: string | null;
  readonly status: "AVAILABLE" | "NO_ATTEMPTS";
}

export interface FollowerScopedJupiterSuccessRateResult
  extends JupiterSuccessRateResult, FollowerExecutionQualityBucket {}

export interface Provider429RateResult extends ExecutionQualityBucket {
  readonly attemptCount: number;
  readonly provider429Count: number;
  readonly provider429Rate: string | null;
  readonly status: "AVAILABLE" | "NO_ATTEMPTS";
}

export interface Provider5xxRateResult extends ExecutionQualityBucket {
  readonly attemptCount: number;
  readonly provider5xxCount: number;
  readonly provider5xxRate: string | null;
  readonly status: "AVAILABLE" | "NO_ATTEMPTS";
}

export interface RiskDecisionEvidence extends PostRiskExecutionQualityBucket {
  readonly phase: RiskDecision["phase"];
  readonly intentId: string;
  readonly decision: RiskDecisionKind;
  readonly reasonCode: RiskReasonCode;
}

export interface PostRiskDistributionResult extends PostRiskExecutionQualityBucket {
  readonly postRiskDecisionCount: number;
  readonly postRiskAllowCount: number;
  readonly postRiskResizeCount: number;
  readonly postRiskRejectCount: number;
  readonly postRiskHaltCount: number;
  readonly allowRate: string | null;
  readonly resizeRate: string | null;
  readonly rejectRate: string | null;
  readonly haltRate: string | null;
  readonly status: "AVAILABLE" | "NO_POST_RISK_DECISIONS";
}

export interface PriceImpactRejectRateResult extends PostRiskExecutionQualityBucket {
  readonly postRiskDecisionCount: number;
  readonly priceImpactRejectCount: number;
  readonly priceImpactRejectRate: string | null;
  readonly status: "AVAILABLE" | "NO_POST_RISK_DECISIONS";
}

export interface PaperFillOutcomeEvidence extends PaperFillCostEvidence {}

export interface PaperFillApplicationOutcomeEvidence {
  readonly fillId: string;
  readonly positionId: number;
  readonly transition: PositionTransition;
  readonly positionVersionAfter: number;
  readonly appliedAtMs: number;
}

export interface PaperFillOutcomeResult extends ExecutionQualityBucket {
  readonly paperFillCount: number;
  readonly paperFillApplicationCount: number;
  readonly paperFillApplicationRate: string | null;
  readonly status: "AVAILABLE" | "NO_PAPER_FILLS";
}

function divideToDecimalString(numerator: number, denominator: number): string {
  let remainder = BigInt(numerator) % BigInt(denominator);
  const integerPart = BigInt(numerator) / BigInt(denominator);
  if (remainder === 0n) return integerPart.toString();

  let fractionalPart = "";
  for (let digit = 0; digit < 18 && remainder !== 0n; digit += 1) {
    remainder *= 10n;
    fractionalPart += (remainder / BigInt(denominator)).toString();
    remainder %= BigInt(denominator);
  }

  return `${integerPart}.${fractionalPart.replace(/0+$/, "")}`;
}

function outcomeFingerprint(attempt: JupiterAttemptEvidence): string {
  return [
    attempt.httpStatus ?? "NO_RESPONSE",
    attempt.schemaValid,
    attempt.expectedOutputRaw?.toString() ?? "NO_OUTPUT",
    attempt.route !== null && attempt.route.length > 0,
  ].join("\u0000");
}

function isSuccessful(attempt: JupiterAttemptEvidence): boolean {
  return (
    attempt.httpStatus !== null &&
    attempt.httpStatus >= 200 &&
    attempt.httpStatus < 300 &&
    attempt.schemaValid &&
    attempt.expectedOutputRaw !== null &&
    attempt.expectedOutputRaw > 0n &&
    attempt.route !== null &&
    attempt.route.length > 0
  );
}

function isFollowerScopedBucket(
  bucket: ExecutionQualityBucket,
): bucket is FollowerExecutionQualityBucket {
  return (
    "followerWallet" in bucket && typeof bucket.followerWallet === "string"
  );
}

function uniqueJupiterAttempts(
  bucket: ExecutionQualityBucket,
  evidence: readonly JupiterAttemptEvidence[],
): readonly JupiterAttemptEvidence[] {
  if (
    evidence.some((attempt) => attempt.leaderWallet !== bucket.leaderWallet)
  ) {
    throw new Error("CROSS_LEADER_EXECUTION_QUALITY_BUCKET");
  }
  if (evidence.some((attempt) => attempt.quoteMint !== bucket.quoteMint)) {
    throw new Error("CROSS_QUOTE_EXECUTION_QUALITY_BUCKET");
  }

  const attemptsByExecutionKey = new Map<string, JupiterAttemptEvidence>();
  for (const attempt of evidence) {
    const existing = attemptsByExecutionKey.get(attempt.executionKey);
    if (
      existing !== undefined &&
      outcomeFingerprint(existing) !== outcomeFingerprint(attempt)
    ) {
      throw new Error("CONFLICTING_JUPITER_ATTEMPT_EVIDENCE");
    }
    attemptsByExecutionKey.set(attempt.executionKey, attempt);
  }

  return [...attemptsByExecutionKey.values()];
}

function isRiskDecisionKind(value: unknown): value is RiskDecisionKind {
  return (
    value === "ALLOW" ||
    value === "RESIZE" ||
    value === "REJECT" ||
    value === "HALT"
  );
}

function uniquePostRiskDecisions(
  bucket: PostRiskExecutionQualityBucket,
  evidence: readonly RiskDecisionEvidence[],
): readonly RiskDecisionEvidence[] {
  if (
    evidence.some(
      (riskDecision) =>
        riskDecision.phase !== "PRE_QUOTE" &&
        riskDecision.phase !== "POST_QUOTE",
    )
  ) {
    throw new Error("INVALID_RISK_DECISION_PHASE");
  }
  if (evidence.some(({ decision }) => !isRiskDecisionKind(decision))) {
    throw new Error("INVALID_RISK_DECISION_KIND");
  }

  const postDecisions = evidence.filter(
    (riskDecision) => riskDecision.phase === "POST_QUOTE",
  );
  if (
    postDecisions.some(
      (riskDecision) => riskDecision.followerWallet !== bucket.followerWallet,
    )
  ) {
    throw new Error("CROSS_FOLLOWER_EXECUTION_QUALITY_BUCKET");
  }
  if (
    postDecisions.some(
      (riskDecision) => riskDecision.leaderWallet !== bucket.leaderWallet,
    )
  ) {
    throw new Error("CROSS_LEADER_EXECUTION_QUALITY_BUCKET");
  }
  if (
    postDecisions.some(
      (riskDecision) => riskDecision.quoteMint !== bucket.quoteMint,
    )
  ) {
    throw new Error("CROSS_QUOTE_EXECUTION_QUALITY_BUCKET");
  }

  const decisionsByIdentity = new Map<string, RiskDecisionEvidence>();
  for (const riskDecision of postDecisions) {
    const identity = `${riskDecision.phase}\u0000${riskDecision.intentId}`;
    const existing = decisionsByIdentity.get(identity);
    if (
      existing !== undefined &&
      (existing.decision !== riskDecision.decision ||
        existing.reasonCode !== riskDecision.reasonCode)
    ) {
      throw new Error("CONFLICTING_RISK_DECISION_EVIDENCE");
    }
    decisionsByIdentity.set(identity, riskDecision);
  }

  return [...decisionsByIdentity.values()];
}

function paperFillFingerprint(fill: PaperFillOutcomeEvidence): string {
  return [
    fill.intentId,
    fill.leaderWallet,
    fill.side,
    fill.inputMint,
    fill.outputMint,
  ].join("\u0000");
}

function uniquePaperFills(
  evidence: readonly PaperFillOutcomeEvidence[],
): readonly PaperFillOutcomeEvidence[] {
  const fillsById = new Map<string, PaperFillOutcomeEvidence>();
  const fillIdByIntentId = new Map<string, string>();
  for (const fill of evidence) {
    const existing = fillsById.get(fill.id);
    if (
      existing !== undefined &&
      paperFillFingerprint(existing) !== paperFillFingerprint(fill)
    ) {
      throw new Error("CONFLICTING_PAPER_FILL_EVIDENCE");
    }

    const existingFillId = fillIdByIntentId.get(fill.intentId);
    if (existingFillId !== undefined && existingFillId !== fill.id) {
      throw new Error("CONFLICTING_PAPER_FILL_EVIDENCE");
    }
    fillsById.set(fill.id, fill);
    fillIdByIntentId.set(fill.intentId, fill.id);
  }
  return [...fillsById.values()];
}

function paperFillApplicationFingerprint(
  application: PaperFillApplicationOutcomeEvidence,
): string {
  return [
    application.positionId,
    application.transition,
    application.positionVersionAfter,
    application.appliedAtMs,
  ].join("\u0000");
}

function uniquePaperFillApplications(
  evidence: readonly PaperFillApplicationOutcomeEvidence[],
): readonly PaperFillApplicationOutcomeEvidence[] {
  const applicationsByFillId = new Map<
    string,
    PaperFillApplicationOutcomeEvidence
  >();
  for (const application of evidence) {
    const existing = applicationsByFillId.get(application.fillId);
    if (
      existing !== undefined &&
      paperFillApplicationFingerprint(existing) !==
        paperFillApplicationFingerprint(application)
    ) {
      throw new Error("CONFLICTING_PAPER_FILL_APPLICATION_EVIDENCE");
    }
    applicationsByFillId.set(application.fillId, application);
  }
  return [...applicationsByFillId.values()];
}

function paperFillQuoteMint(fill: PaperFillOutcomeEvidence): string {
  return fill.side === "BUY" ? fill.inputMint : fill.outputMint;
}

export function calculateJupiterSuccessRate(
  bucket: FollowerExecutionQualityBucket,
  evidence: readonly JupiterAttemptEvidence[],
): FollowerScopedJupiterSuccessRateResult;
export function calculateJupiterSuccessRate(
  bucket: ExecutionQualityBucket,
  evidence: readonly JupiterAttemptEvidence[],
): JupiterSuccessRateResult;
export function calculateJupiterSuccessRate(
  bucket: ExecutionQualityBucket,
  evidence: readonly JupiterAttemptEvidence[],
): JupiterSuccessRateResult | FollowerScopedJupiterSuccessRateResult {
  const uniqueAttempts = uniqueJupiterAttempts(bucket, evidence);

  const attemptCount = uniqueAttempts.length;
  const successCount = uniqueAttempts.filter(isSuccessful).length;

  return {
    ...(isFollowerScopedBucket(bucket)
      ? { followerWallet: bucket.followerWallet }
      : {}),
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    attemptCount,
    successCount,
    successRate:
      attemptCount === 0
        ? null
        : divideToDecimalString(successCount, attemptCount),
    status: attemptCount === 0 ? "NO_ATTEMPTS" : "AVAILABLE",
  };
}

export function calculateProvider429Rate(
  bucket: ExecutionQualityBucket,
  evidence: readonly JupiterAttemptEvidence[],
): Provider429RateResult {
  const uniqueAttempts = uniqueJupiterAttempts(bucket, evidence);
  const attemptCount = uniqueAttempts.length;
  const provider429Count = uniqueAttempts.filter(
    (attempt) => attempt.httpStatus === 429,
  ).length;

  return {
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    attemptCount,
    provider429Count,
    provider429Rate:
      attemptCount === 0
        ? null
        : divideToDecimalString(provider429Count, attemptCount),
    status: attemptCount === 0 ? "NO_ATTEMPTS" : "AVAILABLE",
  };
}

export function calculateProvider5xxRate(
  bucket: ExecutionQualityBucket,
  evidence: readonly JupiterAttemptEvidence[],
): Provider5xxRateResult {
  const uniqueAttempts = uniqueJupiterAttempts(bucket, evidence);
  const attemptCount = uniqueAttempts.length;
  const provider5xxCount = uniqueAttempts.filter(
    (attempt) =>
      attempt.httpStatus !== null &&
      attempt.httpStatus >= 500 &&
      attempt.httpStatus <= 599,
  ).length;

  return {
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    attemptCount,
    provider5xxCount,
    provider5xxRate:
      attemptCount === 0
        ? null
        : divideToDecimalString(provider5xxCount, attemptCount),
    status: attemptCount === 0 ? "NO_ATTEMPTS" : "AVAILABLE",
  };
}

export function calculatePostRiskDistribution(
  bucket: PostRiskExecutionQualityBucket,
  evidence: readonly RiskDecisionEvidence[],
): PostRiskDistributionResult {
  const postDecisions = uniquePostRiskDecisions(bucket, evidence);
  const postRiskDecisionCount = postDecisions.length;
  const count = (decision: RiskDecisionKind) =>
    postDecisions.filter((riskDecision) => riskDecision.decision === decision)
      .length;
  const postRiskAllowCount = count("ALLOW");
  const postRiskResizeCount = count("RESIZE");
  const postRiskRejectCount = count("REJECT");
  const postRiskHaltCount = count("HALT");
  const rate = (decisionCount: number) =>
    postRiskDecisionCount === 0
      ? null
      : divideToDecimalString(decisionCount, postRiskDecisionCount);

  return {
    followerWallet: bucket.followerWallet,
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    postRiskDecisionCount,
    postRiskAllowCount,
    postRiskResizeCount,
    postRiskRejectCount,
    postRiskHaltCount,
    allowRate: rate(postRiskAllowCount),
    resizeRate: rate(postRiskResizeCount),
    rejectRate: rate(postRiskRejectCount),
    haltRate: rate(postRiskHaltCount),
    status:
      postRiskDecisionCount === 0 ? "NO_POST_RISK_DECISIONS" : "AVAILABLE",
  };
}

export function calculatePriceImpactRejectRate(
  bucket: PostRiskExecutionQualityBucket,
  evidence: readonly RiskDecisionEvidence[],
): PriceImpactRejectRateResult {
  const postDecisions = uniquePostRiskDecisions(bucket, evidence);
  if (
    postDecisions.some(
      (riskDecision) =>
        riskDecision.reasonCode === "PRICE_IMPACT_TOO_HIGH" &&
        riskDecision.decision !== "REJECT",
    )
  ) {
    throw new Error("INCONSISTENT_PRICE_IMPACT_RISK_DECISION");
  }

  const postRiskDecisionCount = postDecisions.length;
  const priceImpactRejectCount = postDecisions.filter(
    (riskDecision) =>
      riskDecision.decision === "REJECT" &&
      riskDecision.reasonCode === "PRICE_IMPACT_TOO_HIGH",
  ).length;

  return {
    followerWallet: bucket.followerWallet,
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    postRiskDecisionCount,
    priceImpactRejectCount,
    priceImpactRejectRate:
      postRiskDecisionCount === 0
        ? null
        : divideToDecimalString(priceImpactRejectCount, postRiskDecisionCount),
    status:
      postRiskDecisionCount === 0 ? "NO_POST_RISK_DECISIONS" : "AVAILABLE",
  };
}

export function calculatePaperFillOutcome(
  bucket: ExecutionQualityBucket,
  fillEvidence: readonly PaperFillOutcomeEvidence[],
  applicationEvidence: readonly PaperFillApplicationOutcomeEvidence[],
): PaperFillOutcomeResult {
  const fills = uniquePaperFills(fillEvidence);
  const applications = uniquePaperFillApplications(applicationEvidence);
  const fillIds = new Set(fills.map((fill) => fill.id));
  if (applications.some((application) => !fillIds.has(application.fillId))) {
    throw new Error("ORPHAN_PAPER_FILL_APPLICATION_EVIDENCE");
  }

  const bucketFills = fills.filter(
    (fill) =>
      fill.leaderWallet === bucket.leaderWallet &&
      paperFillQuoteMint(fill) === bucket.quoteMint,
  );
  const appliedFillIds = new Set(
    applications.map((application) => application.fillId),
  );
  const paperFillCount = bucketFills.length;
  const paperFillApplicationCount = bucketFills.filter((fill) =>
    appliedFillIds.has(fill.id),
  ).length;

  return {
    leaderWallet: bucket.leaderWallet,
    quoteMint: bucket.quoteMint,
    paperFillCount,
    paperFillApplicationCount,
    paperFillApplicationRate:
      paperFillCount === 0
        ? null
        : divideToDecimalString(paperFillApplicationCount, paperFillCount),
    status: paperFillCount === 0 ? "NO_PAPER_FILLS" : "AVAILABLE",
  };
}
