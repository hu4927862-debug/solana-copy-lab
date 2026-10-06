import { describe, expect, it } from "vitest";
import { NATIVE_SOL, USDC_MINT, WSOL_MINT } from "../../src/domain/assets.js";
import type { PaperFeeEvidence } from "../../src/domain/paper-trading.js";
import {
  evaluateCompletedRoundTripCostCompleteness,
  evaluatePaperFillCostCompleteness,
  type PaperFillCostEvidence,
} from "../../src/strategy-evaluation/cost-completeness.js";
import type { CompletedFollowerRoundTrip } from "../../src/strategy-evaluation/round-trips.js";
import {
  matchFollowerRoundTrips,
  type FollowerFillApplicationEvidence,
} from "../../src/strategy-evaluation/round-trips.js";

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
      feeBps: 5,
      feeMint: NATIVE_SOL,
      feeAmountRaw: 7n,
    },
    provider: "JUPITER_SWAP_V2_ORDER",
    fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
    ...overrides,
  };
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

function lifecycleApplication(
  overrides: Partial<FollowerFillApplicationEvidence>,
): FollowerFillApplicationEvidence {
  return {
    fillId: "fill-open",
    followerWallet: "follower-wallet",
    leaderWallet: "leader-wallet",
    tokenMint: TOKEN_MINT,
    quoteMint: NATIVE_SOL,
    side: "BUY",
    transition: "OPEN",
    inputAmountRaw: 100n,
    outputAmountRaw: 10n,
    quantityBeforeRaw: 0n,
    quantityAfterRaw: 10n,
    allocatedCostBasisRaw: 0n,
    proceedsRaw: 0n,
    realizedPnlDeltaRaw: 0n,
    positionVersionAfter: 1,
    quoteTimestampMs: 1_000,
    ...overrides,
  };
}

function fourFillRoundTrip(): CompletedFollowerRoundTrip {
  const result = matchFollowerRoundTrips([
    lifecycleApplication({}),
    lifecycleApplication({
      fillId: "fill-add",
      transition: "ADD",
      inputAmountRaw: 50n,
      outputAmountRaw: 5n,
      quantityBeforeRaw: 10n,
      quantityAfterRaw: 15n,
      positionVersionAfter: 2,
      quoteTimestampMs: 2_000,
    }),
    lifecycleApplication({
      fillId: "fill-reduce",
      side: "SELL",
      transition: "REDUCE",
      inputAmountRaw: 5n,
      outputAmountRaw: 60n,
      quantityBeforeRaw: 15n,
      quantityAfterRaw: 10n,
      allocatedCostBasisRaw: 50n,
      proceedsRaw: 60n,
      realizedPnlDeltaRaw: 10n,
      positionVersionAfter: 3,
      quoteTimestampMs: 3_000,
    }),
    lifecycleApplication({
      fillId: "fill-close",
      side: "SELL",
      transition: "CLOSE",
      inputAmountRaw: 10n,
      outputAmountRaw: 125n,
      quantityBeforeRaw: 10n,
      quantityAfterRaw: 0n,
      allocatedCostBasisRaw: 100n,
      proceedsRaw: 125n,
      realizedPnlDeltaRaw: 25n,
      positionVersionAfter: 4,
      quoteTimestampMs: 4_000,
    }),
  ]);
  return result.completed[0]!;
}

function lifecycleFill(fillId: string): PaperFillCostEvidence {
  const sell = fillId === "fill-reduce" || fillId === "fill-close";
  return fill({
    id: fillId,
    intentId: `intent-${fillId}`,
    side: sell ? "SELL" : "BUY",
    inputMint: sell ? TOKEN_MINT : NATIVE_SOL,
    outputMint: sell ? NATIVE_SOL : TOKEN_MINT,
  });
}

describe("paper fill cost completeness", () => {
  it("is complete for available positive quote-denominated fee evidence", () => {
    expect(evaluatePaperFillCostCompleteness(fill())).toEqual({
      definitionVersion: "COST_COMPLETENESS_V1",
      status: "COST_COMPLETE",
      reasons: [],
      reference: { fillId: "fill-buy" },
    });
  });

  it("treats an exact zero fee amount as available evidence", () => {
    expect(
      evaluatePaperFillCostCompleteness(
        fill({
          feeEvidence: {
            status: "AVAILABLE",
            feeBps: 0,
            feeMint: NATIVE_SOL,
            feeAmountRaw: 0n,
          },
        }),
      ).status,
    ).toBe("COST_COMPLETE");
  });

  it("does not infer a zero amount from zero fee bps", () => {
    expect(
      evaluatePaperFillCostCompleteness(
        fill({
          feeEvidence: {
            status: "AMOUNT_UNAVAILABLE",
            feeBps: 0,
            feeMint: NATIVE_SOL,
          },
        }),
      ),
    ).toMatchObject({
      status: "COST_INCOMPLETE",
      reasons: ["FEE_AMOUNT_UNAVAILABLE"],
    });
  });

  it.each([
    [
      "amount",
      { status: "AVAILABLE", feeMint: NATIVE_SOL } as PaperFeeEvidence,
      ["FEE_AMOUNT_UNAVAILABLE", "FEE_EVIDENCE_CONFLICT"],
    ],
    [
      "mint",
      { status: "AVAILABLE", feeAmountRaw: 1n } as PaperFeeEvidence,
      ["FEE_EVIDENCE_CONFLICT", "FEE_MINT_UNAVAILABLE"],
    ],
  ])(
    "fails closed when AVAILABLE omits its %s",
    (_field, feeEvidence, reasons) => {
      expect(
        evaluatePaperFillCostCompleteness(fill({ feeEvidence })),
      ).toMatchObject({
        status: "COST_INCOMPLETE",
        reasons,
      });
    },
  );

  it("rejects a fee amount denominated in a different mint", () => {
    expect(
      evaluatePaperFillCostCompleteness(
        fill({
          feeEvidence: {
            status: "AVAILABLE",
            feeMint: USDC_MINT,
            feeAmountRaw: 1n,
          },
        }),
      ).reasons,
    ).toEqual(["FEE_MINT_NOT_QUOTE_DENOMINATED"]);
  });

  it("treats WSOL fee evidence as noncanonical domain evidence", () => {
    expect(
      evaluatePaperFillCostCompleteness(
        fill({
          feeEvidence: {
            status: "AVAILABLE",
            feeMint: WSOL_MINT,
            feeAmountRaw: 1n,
          },
        }),
      ).reasons,
    ).toEqual(["FEE_EVIDENCE_CONFLICT"]);
  });

  it("accepts positive fee bps as informational evidence", () => {
    expect(evaluatePaperFillCostCompleteness(fill()).status).toBe(
      "COST_COMPLETE",
    );
  });

  it("fails closed for invalid fee bps and a negative fee amount", () => {
    const negativeAmount = {
      status: "AVAILABLE",
      feeBps: -1,
      feeMint: NATIVE_SOL,
      feeAmountRaw: -1n,
    } as PaperFeeEvidence;

    expect(
      evaluatePaperFillCostCompleteness(fill({ feeEvidence: negativeAmount })),
    ).toMatchObject({
      status: "COST_INCOMPLETE",
      reasons: ["FEE_EVIDENCE_CONFLICT"],
    });
  });

  it("uses the same completeness rule for SELL evidence", () => {
    const result = evaluatePaperFillCostCompleteness(
      fill({
        id: "fill-sell",
        side: "SELL",
        inputMint: TOKEN_MINT,
        outputMint: NATIVE_SOL,
      }),
    );

    expect(result).toMatchObject({
      status: "COST_COMPLETE",
      reasons: [],
      reference: { fillId: "fill-sell" },
    });
  });

  it("preserves very large bigint fee evidence exactly", () => {
    const feeAmountRaw = 9_223_372_036_854_775_807n;
    const evidence = fill({
      feeEvidence: {
        status: "AVAILABLE",
        feeMint: NATIVE_SOL,
        feeAmountRaw,
      },
    });

    expect(evaluatePaperFillCostCompleteness(evidence).status).toBe(
      "COST_COMPLETE",
    );
    expect(evidence.feeEvidence.feeAmountRaw).toBe(feeAmountRaw);
  });

  it("fails closed for unknown provider and fill policy semantics", () => {
    expect(
      evaluatePaperFillCostCompleteness(
        fill({ provider: "UNKNOWN", fillPolicyVersion: "FILL_V2" }),
      ).reasons,
    ).toEqual(["FILL_POLICY_UNSUPPORTED", "FILL_PROVIDER_UNSUPPORTED"]);
  });

  it("returns defensive result arrays and references", () => {
    const evidence = fill();
    const first = evaluatePaperFillCostCompleteness(evidence);
    (first.reasons as string[]).push("FEE_EVIDENCE_CONFLICT");
    (first.reference as { fillId: string }).fillId = "mutated";

    expect(evaluatePaperFillCostCompleteness(evidence)).toEqual({
      definitionVersion: "COST_COMPLETENESS_V1",
      status: "COST_COMPLETE",
      reasons: [],
      reference: { fillId: "fill-buy" },
    });
    expect(evidence.id).toBe("fill-buy");
  });
});

describe("completed lifecycle cost completeness", () => {
  it("is complete only when every referenced fill is complete", () => {
    const open = fill();
    const close = fill({
      id: "fill-sell",
      intentId: "intent-sell",
      side: "SELL",
      inputMint: TOKEN_MINT,
      outputMint: NATIVE_SOL,
    });

    expect(
      evaluateCompletedRoundTripCostCompleteness(roundTrip(), [open, close]),
    ).toEqual({
      definitionVersion: "COST_COMPLETENESS_V1",
      status: "COST_COMPLETE",
      reasons: [],
      reference: {
        followerWallet: "follower-wallet",
        leaderWallet: "leader-wallet",
        tokenMint: TOKEN_MINT,
        quoteMint: NATIVE_SOL,
        openFillId: "fill-buy",
        closeFillId: "fill-sell",
        fillIds: ["fill-buy", "fill-sell"],
      },
    });
  });

  it("is incomplete when one referenced fill is incomplete", () => {
    const open = fill();
    const close = fill({
      id: "fill-sell",
      side: "SELL",
      inputMint: TOKEN_MINT,
      outputMint: NATIVE_SOL,
      feeEvidence: {
        status: "AMOUNT_UNAVAILABLE",
        feeMint: NATIVE_SOL,
      },
    });

    expect(
      evaluateCompletedRoundTripCostCompleteness(roundTrip(), [open, close]),
    ).toMatchObject({
      status: "COST_INCOMPLETE",
      reasons: ["FEE_AMOUNT_UNAVAILABLE"],
    });
  });

  it.each(["fill-add", "fill-reduce"])(
    "requires complete %s evidence instead of checking only OPEN/CLOSE",
    (incompleteFillId) => {
      const cycle = fourFillRoundTrip();
      const evidence = cycle.fillIds.map((fillId) =>
        lifecycleFill(fillId === "fill-open" ? "fill-open" : fillId),
      );
      const target = evidence.find(({ id }) => id === incompleteFillId)!;
      const incomplete = {
        ...target,
        feeEvidence: {
          status: "AMOUNT_UNAVAILABLE" as const,
          feeMint: NATIVE_SOL,
        },
      };

      expect(
        evaluateCompletedRoundTripCostCompleteness(cycle, [
          ...evidence.filter(({ id }) => id !== incompleteFillId),
          incomplete,
        ]),
      ).toMatchObject({
        status: "COST_INCOMPLETE",
        reasons: ["FEE_AMOUNT_UNAVAILABLE"],
      });
    },
  );

  it("fails closed when a referenced fill is missing", () => {
    expect(
      evaluateCompletedRoundTripCostCompleteness(roundTrip(), [fill()]),
    ).toMatchObject({
      status: "COST_INCOMPLETE",
      reasons: ["FILL_EVIDENCE_UNAVAILABLE"],
    });
  });

  it("collapses exact duplicate fill evidence", () => {
    const open = fill();
    const close = fill({
      id: "fill-sell",
      side: "SELL",
      inputMint: TOKEN_MINT,
      outputMint: NATIVE_SOL,
    });

    expect(
      evaluateCompletedRoundTripCostCompleteness(roundTrip(), [
        open,
        { ...open, feeEvidence: { ...open.feeEvidence } },
        close,
      ]).status,
    ).toBe("COST_COMPLETE");
  });

  it("rejects conflicting duplicate fill evidence", () => {
    const open = fill();
    const close = fill({
      id: "fill-sell",
      side: "SELL",
      inputMint: TOKEN_MINT,
      outputMint: NATIVE_SOL,
    });

    expect(
      evaluateCompletedRoundTripCostCompleteness(roundTrip(), [
        open,
        {
          ...open,
          feeEvidence: { ...open.feeEvidence, feeAmountRaw: 8n },
        },
        close,
      ]),
    ).toMatchObject({
      status: "COST_INCOMPLETE",
      reasons: ["FEE_EVIDENCE_CONFLICT"],
    });
  });

  it("does not bind cross-quote fee evidence to a lifecycle", () => {
    const crossQuoteOpen = fill({
      inputMint: USDC_MINT,
      feeEvidence: {
        status: "AVAILABLE",
        feeMint: USDC_MINT,
        feeAmountRaw: 1n,
      },
    });
    const close = fill({
      id: "fill-sell",
      side: "SELL",
      inputMint: TOKEN_MINT,
      outputMint: NATIVE_SOL,
    });

    expect(
      evaluateCompletedRoundTripCostCompleteness(roundTrip(), [
        crossQuoteOpen,
        close,
      ]).reasons,
    ).toEqual(["FEE_EVIDENCE_CONFLICT"]);
  });

  it("is deterministic when fill evidence input order is reversed", () => {
    const evidence = [
      fill(),
      fill({
        id: "fill-sell",
        side: "SELL",
        inputMint: TOKEN_MINT,
        outputMint: NATIVE_SOL,
        feeEvidence: {
          status: "AMOUNT_UNAVAILABLE",
          feeMint: NATIVE_SOL,
        },
      }),
    ];

    expect(
      evaluateCompletedRoundTripCostCompleteness(roundTrip(), evidence),
    ).toEqual(
      evaluateCompletedRoundTripCostCompleteness(
        roundTrip(),
        [...evidence].reverse(),
      ),
    );
  });

  it("returns defensive lifecycle reasons and references", () => {
    const cycle = roundTrip();
    const evidence = [
      fill(),
      fill({
        id: "fill-sell",
        side: "SELL",
        inputMint: TOKEN_MINT,
        outputMint: NATIVE_SOL,
      }),
    ];
    const first = evaluateCompletedRoundTripCostCompleteness(cycle, evidence);
    (first.reasons as string[]).push("FEE_EVIDENCE_CONFLICT");
    (first.reference.fillIds as string[]).push("mutated");

    expect(
      evaluateCompletedRoundTripCostCompleteness(cycle, evidence),
    ).toMatchObject({
      status: "COST_COMPLETE",
      reasons: [],
      reference: { fillIds: ["fill-buy", "fill-sell"] },
    });
    expect(cycle.fillIds).toEqual(["fill-buy", "fill-sell"]);
  });
});
