import type { PaperFeeEvidence, PaperFill } from "../domain/paper-trading.js";
import { canonicalDomainQuoteMint } from "../domain/assets.js";
import { PAPER_FILL_POLICY_VERSION } from "../domain/paper-trading.js";
import type { CompletedFollowerRoundTrip } from "./round-trips.js";

export const COST_COMPLETENESS_DEFINITION_VERSION =
  "COST_COMPLETENESS_V1" as const;

export interface PaperFillCostEvidence {
  readonly id: string;
  readonly intentId: string;
  readonly leaderWallet: string;
  readonly followerWallet: string;
  readonly side: PaperFill["side"];
  readonly inputMint: string;
  readonly outputMint: string;
  readonly feeEvidence: PaperFeeEvidence;
  readonly provider: string;
  readonly fillPolicyVersion: string;
}

export interface PaperFillCostCompletenessResult {
  readonly definitionVersion: typeof COST_COMPLETENESS_DEFINITION_VERSION;
  readonly status: "COST_COMPLETE" | "COST_INCOMPLETE";
  readonly reasons: readonly CostCompletenessReason[];
  readonly reference: {
    readonly fillId: string;
  };
}

export type CostCompletenessReason =
  | "FEE_AMOUNT_UNAVAILABLE"
  | "FEE_MINT_UNAVAILABLE"
  | "FEE_MINT_NOT_QUOTE_DENOMINATED"
  | "FEE_EVIDENCE_CONFLICT"
  | "FILL_EVIDENCE_UNAVAILABLE"
  | "FILL_PROVIDER_UNSUPPORTED"
  | "FILL_POLICY_UNSUPPORTED";

export interface CompletedRoundTripCostCompletenessResult {
  readonly definitionVersion: typeof COST_COMPLETENESS_DEFINITION_VERSION;
  readonly status: "COST_COMPLETE" | "COST_INCOMPLETE";
  readonly reasons: readonly CostCompletenessReason[];
  readonly reference: {
    readonly followerWallet: string;
    readonly leaderWallet: string;
    readonly tokenMint: string;
    readonly quoteMint: string;
    readonly openFillId: string;
    readonly closeFillId: string;
    readonly fillIds: readonly string[];
  };
}

const SUPPORTED_PROVIDER = "JUPITER_SWAP_V2_ORDER";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function evaluatePaperFillCostCompleteness(
  fill: PaperFillCostEvidence,
): PaperFillCostCompletenessResult {
  const reasons = new Set<CostCompletenessReason>();
  if (fill.provider !== SUPPORTED_PROVIDER) {
    reasons.add("FILL_PROVIDER_UNSUPPORTED");
  }
  if (fill.fillPolicyVersion !== PAPER_FILL_POLICY_VERSION) {
    reasons.add("FILL_POLICY_UNSUPPORTED");
  }

  const quoteMint =
    fill.side === "BUY"
      ? fill.inputMint
      : fill.side === "SELL"
        ? fill.outputMint
        : undefined;
  if (
    quoteMint === undefined ||
    canonicalDomainQuoteMint(quoteMint) !== quoteMint
  ) {
    reasons.add("FEE_EVIDENCE_CONFLICT");
  }

  const { feeEvidence } = fill;
  if (
    feeEvidence.feeBps !== undefined &&
    (!Number.isSafeInteger(feeEvidence.feeBps) || feeEvidence.feeBps < 0)
  ) {
    reasons.add("FEE_EVIDENCE_CONFLICT");
  }
  if (feeEvidence.feeMint === undefined) {
    reasons.add("FEE_MINT_UNAVAILABLE");
  } else if (
    canonicalDomainQuoteMint(feeEvidence.feeMint) !== feeEvidence.feeMint
  ) {
    reasons.add("FEE_EVIDENCE_CONFLICT");
  } else if (quoteMint !== undefined && feeEvidence.feeMint !== quoteMint) {
    reasons.add("FEE_MINT_NOT_QUOTE_DENOMINATED");
  }

  if (feeEvidence.status === "AMOUNT_UNAVAILABLE") {
    reasons.add("FEE_AMOUNT_UNAVAILABLE");
    if (feeEvidence.feeAmountRaw !== undefined) {
      reasons.add("FEE_EVIDENCE_CONFLICT");
    }
  } else if (feeEvidence.status === "AVAILABLE") {
    if (feeEvidence.feeAmountRaw === undefined) {
      reasons.add("FEE_AMOUNT_UNAVAILABLE");
      reasons.add("FEE_EVIDENCE_CONFLICT");
    } else if (
      typeof feeEvidence.feeAmountRaw !== "bigint" ||
      feeEvidence.feeAmountRaw < 0n
    ) {
      reasons.add("FEE_EVIDENCE_CONFLICT");
    }
    if (feeEvidence.feeMint === undefined) {
      reasons.add("FEE_EVIDENCE_CONFLICT");
    }
  } else {
    reasons.add("FEE_EVIDENCE_CONFLICT");
  }

  const sortedReasons = [...reasons].sort(compareText);
  return {
    definitionVersion: COST_COMPLETENESS_DEFINITION_VERSION,
    status: sortedReasons.length === 0 ? "COST_COMPLETE" : "COST_INCOMPLETE",
    reasons: sortedReasons,
    reference: { fillId: fill.id },
  };
}

function sameFillEvidence(
  left: PaperFillCostEvidence,
  right: PaperFillCostEvidence,
): boolean {
  return (
    left.id === right.id &&
    left.intentId === right.intentId &&
    left.leaderWallet === right.leaderWallet &&
    left.followerWallet === right.followerWallet &&
    left.side === right.side &&
    left.inputMint === right.inputMint &&
    left.outputMint === right.outputMint &&
    left.provider === right.provider &&
    left.fillPolicyVersion === right.fillPolicyVersion &&
    left.feeEvidence.status === right.feeEvidence.status &&
    left.feeEvidence.feeBps === right.feeEvidence.feeBps &&
    left.feeEvidence.feeMint === right.feeEvidence.feeMint &&
    left.feeEvidence.feeAmountRaw === right.feeEvidence.feeAmountRaw
  );
}

function matchesLifecycleIdentity(
  cycle: CompletedFollowerRoundTrip,
  fill: PaperFillCostEvidence,
): boolean {
  const tokenMint = fill.side === "BUY" ? fill.outputMint : fill.inputMint;
  const quoteMint = fill.side === "BUY" ? fill.inputMint : fill.outputMint;
  return (
    fill.followerWallet === cycle.followerWallet &&
    fill.leaderWallet === cycle.leaderWallet &&
    tokenMint === cycle.tokenMint &&
    quoteMint === cycle.quoteMint
  );
}

export function evaluateCompletedRoundTripCostCompleteness(
  cycle: CompletedFollowerRoundTrip,
  fillEvidence: readonly PaperFillCostEvidence[],
): CompletedRoundTripCostCompletenessResult {
  const reasons = new Set<CostCompletenessReason>();
  const fillsById = new Map<string, PaperFillCostEvidence>();
  const conflictingFillIds = new Set<string>();

  for (const fill of fillEvidence) {
    const existing = fillsById.get(fill.id);
    if (existing === undefined) {
      fillsById.set(fill.id, fill);
    } else if (!sameFillEvidence(existing, fill)) {
      conflictingFillIds.add(fill.id);
    }
  }

  if (
    !cycle.fillIds.includes(cycle.openFillId) ||
    !cycle.fillIds.includes(cycle.closeFillId) ||
    canonicalDomainQuoteMint(cycle.quoteMint) !== cycle.quoteMint
  ) {
    reasons.add("FEE_EVIDENCE_CONFLICT");
  }

  for (const fillId of cycle.fillIds) {
    if (conflictingFillIds.has(fillId)) {
      reasons.add("FEE_EVIDENCE_CONFLICT");
      continue;
    }
    const fill = fillsById.get(fillId);
    if (fill === undefined) {
      reasons.add("FILL_EVIDENCE_UNAVAILABLE");
      continue;
    }
    if (!matchesLifecycleIdentity(cycle, fill)) {
      reasons.add("FEE_EVIDENCE_CONFLICT");
      continue;
    }
    for (const reason of evaluatePaperFillCostCompleteness(fill).reasons) {
      reasons.add(reason);
    }
  }

  const sortedReasons = [...reasons].sort(compareText);
  return {
    definitionVersion: COST_COMPLETENESS_DEFINITION_VERSION,
    status: sortedReasons.length === 0 ? "COST_COMPLETE" : "COST_INCOMPLETE",
    reasons: sortedReasons,
    reference: {
      followerWallet: cycle.followerWallet,
      leaderWallet: cycle.leaderWallet,
      tokenMint: cycle.tokenMint,
      quoteMint: cycle.quoteMint,
      openFillId: cycle.openFillId,
      closeFillId: cycle.closeFillId,
      fillIds: [...cycle.fillIds],
    },
  };
}
