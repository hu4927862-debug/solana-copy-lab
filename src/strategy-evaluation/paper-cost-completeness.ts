import { FEE_EVIDENCE_CONTRACT_V1 } from "../domain/execution.js";
import type { CompletedFollowerRoundTrip } from "./round-trips.js";
import {
  evaluateCompletedRoundTripCostCompleteness,
  evaluatePaperFillCostCompleteness,
  type CostCompletenessReason,
  type PaperFillCostEvidence,
} from "./cost-completeness.js";

export const PAPER_COST_COMPLETENESS_CONTRACT_V1 =
  "PAPER_COST_COMPLETENESS_CONTRACT_V1" as const;
export const EXECUTABLE_AND_LIVE_COST_COMPLETENESS_NOT_ESTABLISHED =
  "EXECUTABLE_AND_LIVE_COST_COMPLETENESS_NOT_ESTABLISHED" as const;

export type PaperCostCompletenessReason =
  | CostCompletenessReason
  | "FEE_EVIDENCE_CONTRACT_UNAVAILABLE"
  | "FEE_EVIDENCE_CONTRACT_UNSUPPORTED";

type PaperCostCompletenessStatus =
  | "COST_COMPLETE_FOR_QUOTE_AS_FILL_PAPER"
  | "COST_INCOMPLETE_FOR_QUOTE_AS_FILL_PAPER";

interface PaperCostCompletenessResultBase {
  readonly contractId: typeof PAPER_COST_COMPLETENESS_CONTRACT_V1;
  readonly status: PaperCostCompletenessStatus;
  readonly reasons: readonly PaperCostCompletenessReason[];
  readonly limitation: typeof EXECUTABLE_AND_LIVE_COST_COMPLETENESS_NOT_ESTABLISHED;
}

export interface PaperFillPaperCostCompletenessResult extends PaperCostCompletenessResultBase {
  readonly reference: { readonly fillId: string };
}

export interface CompletedRoundTripPaperCostCompletenessResult extends PaperCostCompletenessResultBase {
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resultStatus(
  reasons: readonly PaperCostCompletenessReason[],
): PaperCostCompletenessStatus {
  return reasons.length === 0
    ? "COST_COMPLETE_FOR_QUOTE_AS_FILL_PAPER"
    : "COST_INCOMPLETE_FOR_QUOTE_AS_FILL_PAPER";
}

export function evaluatePaperFillPaperCostCompleteness(
  fill: PaperFillCostEvidence,
): PaperFillPaperCostCompletenessResult {
  const reasons = new Set<PaperCostCompletenessReason>(
    evaluatePaperFillCostCompleteness(fill).reasons,
  );
  const { feeEvidence } = fill;

  if (feeEvidence.feeEvidenceContractId === undefined) {
    reasons.add("FEE_EVIDENCE_CONTRACT_UNAVAILABLE");
  } else if (feeEvidence.feeEvidenceContractId !== FEE_EVIDENCE_CONTRACT_V1) {
    reasons.add("FEE_EVIDENCE_CONTRACT_UNSUPPORTED");
  }
  if (
    feeEvidence.feeBps === undefined ||
    !Number.isSafeInteger(feeEvidence.feeBps) ||
    feeEvidence.feeBps < 0
  ) {
    reasons.add("FEE_EVIDENCE_CONFLICT");
  }

  const sortedReasons = [...reasons].sort(compareText);
  return {
    contractId: PAPER_COST_COMPLETENESS_CONTRACT_V1,
    status: resultStatus(sortedReasons),
    reasons: sortedReasons,
    limitation: EXECUTABLE_AND_LIVE_COST_COMPLETENESS_NOT_ESTABLISHED,
    reference: { fillId: fill.id },
  };
}

function sameProspectiveFillEvidence(
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
    left.feeEvidence.feeEvidenceContractId ===
      right.feeEvidence.feeEvidenceContractId &&
    left.feeEvidence.feeBps === right.feeEvidence.feeBps &&
    left.feeEvidence.feeMint === right.feeEvidence.feeMint &&
    left.feeEvidence.feeAmountRaw === right.feeEvidence.feeAmountRaw
  );
}

export function evaluateCompletedRoundTripPaperCostCompleteness(
  cycle: CompletedFollowerRoundTrip,
  fillEvidence: readonly PaperFillCostEvidence[],
): CompletedRoundTripPaperCostCompletenessResult {
  const structural = evaluateCompletedRoundTripCostCompleteness(
    cycle,
    fillEvidence,
  );
  const reasons = new Set<PaperCostCompletenessReason>(structural.reasons);
  const fillsById = new Map<string, PaperFillCostEvidence>();
  const conflictingFillIds = new Set<string>();

  for (const fill of fillEvidence) {
    const existing = fillsById.get(fill.id);
    if (existing === undefined) {
      fillsById.set(fill.id, fill);
    } else if (!sameProspectiveFillEvidence(existing, fill)) {
      conflictingFillIds.add(fill.id);
    }
  }

  for (const fillId of cycle.fillIds) {
    if (conflictingFillIds.has(fillId)) {
      reasons.add("FEE_EVIDENCE_CONFLICT");
      continue;
    }
    const fill = fillsById.get(fillId);
    if (fill === undefined) continue;
    for (const reason of evaluatePaperFillPaperCostCompleteness(fill).reasons) {
      reasons.add(reason);
    }
  }

  const sortedReasons = [...reasons].sort(compareText);
  return {
    contractId: PAPER_COST_COMPLETENESS_CONTRACT_V1,
    status: resultStatus(sortedReasons),
    reasons: sortedReasons,
    limitation: EXECUTABLE_AND_LIVE_COST_COMPLETENESS_NOT_ESTABLISHED,
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
