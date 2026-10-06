import { describe, expect, it } from "vitest";
import { NATIVE_SOL, USDC_MINT } from "../../src/domain/assets.js";
import { FEE_EVIDENCE_CONTRACT_V1 } from "../../src/domain/execution.js";
import type { PaperFillCostEvidence } from "../../src/strategy-evaluation/cost-completeness.js";
import {
  EXECUTABLE_AND_LIVE_COST_COMPLETENESS_NOT_ESTABLISHED,
  PAPER_COST_COMPLETENESS_CONTRACT_V1,
  evaluateCompletedRoundTripPaperCostCompleteness,
  evaluatePaperFillPaperCostCompleteness,
} from "../../src/strategy-evaluation/paper-cost-completeness.js";
import type { CompletedFollowerRoundTrip } from "../../src/strategy-evaluation/round-trips.js";

const TOKEN_MINT = "token-mint";

function fill(
  overrides: Partial<PaperFillCostEvidence> = {},
): PaperFillCostEvidence {
  return {
    id: "fill-buy",
    intentId: "intent-buy",
    leaderWallet: "leader-wallet",
    followerWallet: "follower-wallet",
    side: "BUY",
    inputMint: NATIVE_SOL,
    outputMint: TOKEN_MINT,
    feeEvidence: {
      status: "AVAILABLE",
      feeEvidenceContractId: FEE_EVIDENCE_CONTRACT_V1,
      feeBps: 5,
      feeMint: NATIVE_SOL,
      feeAmountRaw: 7n,
    },
    provider: "JUPITER_SWAP_V2_ORDER",
    fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
    ...overrides,
  };
}

function sellFill(
  overrides: Partial<PaperFillCostEvidence> = {},
): PaperFillCostEvidence {
  return fill({
    id: "fill-sell",
    intentId: "intent-sell",
    side: "SELL",
    inputMint: TOKEN_MINT,
    outputMint: NATIVE_SOL,
    ...overrides,
  });
}

function roundTrip(
  overrides: Partial<CompletedFollowerRoundTrip> = {},
): CompletedFollowerRoundTrip {
  return {
    followerWallet: "follower-wallet",
    leaderWallet: "leader-wallet",
    tokenMint: TOKEN_MINT,
    quoteMint: NATIVE_SOL,
    openFillId: "fill-buy",
    closeFillId: "fill-sell",
    fillIds: ["fill-buy", "fill-sell"],
    entryCostQuoteRaw: 100n,
    proceedsQuoteRaw: 125n,
    realizedPnlQuoteRaw: 25n,
    openedAtMs: 1_000,
    closedAtMs: 2_000,
    holdingTimeMs: 1_000,
    ...overrides,
  };
}

const limitation = EXECUTABLE_AND_LIVE_COST_COMPLETENESS_NOT_ESTABLISHED;

describe("prospective quote-as-fill Paper cost completeness", () => {
  it("exports stable contract identifiers and completes recognized evidence", () => {
    expect(PAPER_COST_COMPLETENESS_CONTRACT_V1).toBe(
      "PAPER_COST_COMPLETENESS_CONTRACT_V1",
    );
    expect(FEE_EVIDENCE_CONTRACT_V1).toBe("FEE_EVIDENCE_CONTRACT_V1");
    expect(evaluatePaperFillPaperCostCompleteness(fill())).toEqual({
      contractId: PAPER_COST_COMPLETENESS_CONTRACT_V1,
      status: "COST_COMPLETE_FOR_QUOTE_AS_FILL_PAPER",
      reasons: [],
      limitation,
      reference: { fillId: "fill-buy" },
    });
  });

  it.each([
    ["missing contract", undefined, "FEE_EVIDENCE_CONTRACT_UNAVAILABLE"],
    [
      "unknown contract",
      "FEE_EVIDENCE_CONTRACT_V2",
      "FEE_EVIDENCE_CONTRACT_UNSUPPORTED",
    ],
  ])("fails closed for %s", (_name, feeEvidenceContractId, reason) => {
    expect(
      evaluatePaperFillPaperCostCompleteness(
        fill({
          feeEvidence: {
            status: "AVAILABLE",
            ...(feeEvidenceContractId === undefined
              ? {}
              : { feeEvidenceContractId }),
            feeBps: 5,
            feeMint: NATIVE_SOL,
            feeAmountRaw: 7n,
          },
        }),
      ),
    ).toMatchObject({
      status: "COST_INCOMPLETE_FOR_QUOTE_AS_FILL_PAPER",
      reasons: [reason],
      limitation,
    });
  });

  it("fails closed when the fee amount is unavailable under V1", () => {
    expect(
      evaluatePaperFillPaperCostCompleteness(
        fill({
          feeEvidence: {
            status: "AMOUNT_UNAVAILABLE",
            feeEvidenceContractId: FEE_EVIDENCE_CONTRACT_V1,
            feeBps: 5,
            feeMint: NATIVE_SOL,
          },
        }),
      ),
    ).toMatchObject({
      status: "COST_INCOMPLETE_FOR_QUOTE_AS_FILL_PAPER",
      reasons: ["FEE_AMOUNT_UNAVAILABLE"],
      limitation,
    });
  });

  it("requires safe BPS and an exact non-negative amount", () => {
    expect(
      evaluatePaperFillPaperCostCompleteness(
        fill({
          feeEvidence: {
            status: "AVAILABLE",
            feeEvidenceContractId: FEE_EVIDENCE_CONTRACT_V1,
            feeBps: Number.MAX_SAFE_INTEGER + 1,
            feeMint: NATIVE_SOL,
            feeAmountRaw: -1n,
          },
        }),
      ).reasons,
    ).toEqual(["FEE_EVIDENCE_CONFLICT"]);
  });

  it("rejects non-quote-denominated evidence", () => {
    expect(
      evaluatePaperFillPaperCostCompleteness(
        fill({
          feeEvidence: {
            status: "AVAILABLE",
            feeEvidenceContractId: FEE_EVIDENCE_CONTRACT_V1,
            feeBps: 5,
            feeMint: USDC_MINT,
            feeAmountRaw: 7n,
          },
        }),
      ).reasons,
    ).toEqual(["FEE_MINT_NOT_QUOTE_DENOMINATED"]);
  });

  it("orders unique reasons deterministically", () => {
    expect(
      evaluatePaperFillPaperCostCompleteness(
        fill({
          provider: "UNKNOWN",
          fillPolicyVersion: "UNKNOWN",
          feeEvidence: {
            status: "AMOUNT_UNAVAILABLE",
            feeBps: -1,
          },
        }),
      ).reasons,
    ).toEqual([
      "FEE_AMOUNT_UNAVAILABLE",
      "FEE_EVIDENCE_CONFLICT",
      "FEE_EVIDENCE_CONTRACT_UNAVAILABLE",
      "FEE_MINT_UNAVAILABLE",
      "FILL_POLICY_UNSUPPORTED",
      "FILL_PROVIDER_UNSUPPORTED",
    ]);
  });

  it("completes a lifecycle only when every constituent fill passes", () => {
    expect(
      evaluateCompletedRoundTripPaperCostCompleteness(roundTrip(), [
        fill(),
        sellFill(),
      ]),
    ).toMatchObject({
      contractId: PAPER_COST_COMPLETENESS_CONTRACT_V1,
      status: "COST_COMPLETE_FOR_QUOTE_AS_FILL_PAPER",
      reasons: [],
      limitation,
    });
  });

  it("fails closed for mixed legacy and prospective lifecycle evidence", () => {
    const legacy = sellFill({
      feeEvidence: {
        status: "AVAILABLE",
        feeBps: 5,
        feeMint: NATIVE_SOL,
        feeAmountRaw: 7n,
      },
    });
    expect(
      evaluateCompletedRoundTripPaperCostCompleteness(roundTrip(), [
        fill(),
        legacy,
      ]),
    ).toMatchObject({
      status: "COST_INCOMPLETE_FOR_QUOTE_AS_FILL_PAPER",
      reasons: ["FEE_EVIDENCE_CONTRACT_UNAVAILABLE"],
      limitation,
    });
  });

  it("accepts identical duplicate evidence deterministically", () => {
    const open = fill();
    const result = evaluateCompletedRoundTripPaperCostCompleteness(
      roundTrip(),
      [open, { ...open, feeEvidence: { ...open.feeEvidence } }, sellFill()],
    );
    expect(result.status).toBe("COST_COMPLETE_FOR_QUOTE_AS_FILL_PAPER");
    expect(result.reasons).toEqual([]);
  });

  it("fails closed for duplicate conflicting provenance", () => {
    const open = fill();
    expect(
      evaluateCompletedRoundTripPaperCostCompleteness(roundTrip(), [
        open,
        {
          ...open,
          feeEvidence: {
            ...open.feeEvidence,
            feeEvidenceContractId: "FEE_EVIDENCE_CONTRACT_V2",
          },
        },
        sellFill(),
      ]),
    ).toMatchObject({
      status: "COST_INCOMPLETE_FOR_QUOTE_AS_FILL_PAPER",
      reasons: ["FEE_EVIDENCE_CONFLICT"],
      limitation,
    });
  });

  it("fails closed when required lifecycle evidence is absent", () => {
    expect(
      evaluateCompletedRoundTripPaperCostCompleteness(roundTrip(), [fill()]),
    ).toMatchObject({
      status: "COST_INCOMPLETE_FOR_QUOTE_AS_FILL_PAPER",
      reasons: ["FILL_EVIDENCE_UNAVAILABLE"],
      limitation,
    });
  });
});
