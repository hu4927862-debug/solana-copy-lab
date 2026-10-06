import { describe, expect, it } from "vitest";
import { calculateStrategyMetrics } from "../../src/strategy-evaluation/metrics.js";
import {
  matchFollowerRoundTrips,
  matchFollowerRoundTripsDetailed,
  type DetailedFollowerFillApplicationEvidence,
  type FollowerFillApplicationEvidence,
  type FollowerRoundTripDetailedResult,
  type FollowerRoundTripUnevaluableLimitation,
} from "../../src/strategy-evaluation/round-trips.js";

function application(
  overrides: Partial<FollowerFillApplicationEvidence>,
): FollowerFillApplicationEvidence {
  return {
    fillId: "fill-open",
    followerWallet: "follower-wallet",
    leaderWallet: "leader-wallet",
    tokenMint: "token-mint",
    quoteMint: "SOL_NATIVE",
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

function closeApplication(
  overrides: Partial<FollowerFillApplicationEvidence> = {},
): FollowerFillApplicationEvidence {
  return application({
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
    positionVersionAfter: 2,
    quoteTimestampMs: 4_000,
    ...overrides,
  });
}

function detailedApplication(
  overrides: Partial<DetailedFollowerFillApplicationEvidence> = {},
): DetailedFollowerFillApplicationEvidence {
  return {
    ...application({}),
    positionId: 10,
    ...overrides,
  };
}

describe("matchFollowerRoundTripsDetailed", () => {
  it("accepts quantity-continuous fill applications across legitimate position-version jumps", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication({ positionVersionAfter: 8 }),
      detailedApplication({
        fillId: "fill-add",
        transition: "ADD",
        inputAmountRaw: 40n,
        outputAmountRaw: 4n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 14n,
        positionVersionAfter: 12,
      }),
    ]);

    expect(result.limitations).toEqual([]);
    expect(result.incomplete).toEqual([
      expect.objectContaining({
        fillIds: ["fill-open", "fill-add"],
        remainingQuantityRaw: 14n,
      }),
    ]);
  });

  it("fails closed when a missing fill application breaks the immutable quantity chain", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication({ positionVersionAfter: 8 }),
      detailedApplication({
        ...closeApplication({
          quantityBeforeRaw: 14n,
          inputAmountRaw: 14n,
          allocatedCostBasisRaw: 140n,
          positionVersionAfter: 12,
        }),
        positionId: 10,
      }),
    ]);

    expect(result.completed).toEqual([]);
    expect(result.incomplete).toEqual([]);
    expect(result.limitations).toEqual([
      expect.objectContaining({
        reason: "LIFECYCLE_CONTINUITY_VIOLATION",
        affectedFillIds: ["fill-open", "fill-close"],
        evidence: [
          {
            field: "quantityBeforeRaw",
            expected: "10",
            observed: "14",
          },
        ],
      }),
    ]);
  });

  it("matches a valid OPEN ADD REDUCE CLOSE lifecycle without limitations", () => {
    const evidence = [
      detailedApplication(),
      detailedApplication({
        fillId: "fill-add",
        transition: "ADD",
        inputAmountRaw: 40n,
        outputAmountRaw: 4n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 14n,
        positionVersionAfter: 2,
      }),
      detailedApplication({
        fillId: "fill-reduce",
        side: "SELL",
        transition: "REDUCE",
        inputAmountRaw: 4n,
        outputAmountRaw: 50n,
        quantityBeforeRaw: 14n,
        quantityAfterRaw: 10n,
        allocatedCostBasisRaw: 40n,
        proceedsRaw: 50n,
        realizedPnlDeltaRaw: 10n,
        positionVersionAfter: 3,
      }),
      detailedApplication({
        ...closeApplication({ positionVersionAfter: 4 }),
        positionId: 10,
      }),
    ] as const;

    const detailed = matchFollowerRoundTripsDetailed(evidence);
    expect(detailed.limitations).toEqual([]);
    expect(detailed.completed).toEqual([
      expect.objectContaining({
        fillIds: ["fill-open", "fill-add", "fill-reduce", "fill-close"],
        entryCostQuoteRaw: 140n,
        proceedsQuoteRaw: 175n,
        realizedPnlQuoteRaw: 35n,
      }),
    ]);
    expect(matchFollowerRoundTrips(evidence)).toEqual({
      completed: detailed.completed,
      incomplete: detailed.incomplete,
    });
  });

  it("keeps a valid unfinished OPEN incomplete without limitations", () => {
    const result = matchFollowerRoundTripsDetailed([detailedApplication()]);

    expect(result).toMatchObject({
      definitionVersion: "FOLLOWER_ROUND_TRIPS_V2",
      completed: [],
      incomplete: [{ openFillId: "fill-open" }],
      limitations: [],
    });
  });

  it("reports actual quantity continuity evidence and removes the corrupt lifecycle", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication(),
      detailedApplication({
        ...closeApplication({ quantityBeforeRaw: 9n }),
        positionId: 10,
      }),
    ]);

    expect(result.completed).toEqual([]);
    expect(result.incomplete).toEqual([]);
    expect(result.limitations).toEqual([
      expect.objectContaining({
        reason: "LIFECYCLE_CONTINUITY_VIOLATION",
        stage: "CONTINUATION",
        openFillId: "fill-open",
        affectedFillIds: ["fill-open", "fill-close"],
        evidence: [
          {
            field: "quantityBeforeRaw",
            expected: "10",
            observed: "9",
          },
        ],
      }),
    ]);
  });

  it("uses position provenance to isolate identity drift from same-shape lifecycles", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication({
        fillId: "token-a-open",
        tokenMint: "token-a",
        positionId: 10,
      }),
      detailedApplication({
        fillId: "token-b-open",
        tokenMint: "token-b",
        positionId: 11,
      }),
      detailedApplication({
        fillId: "token-a-drift",
        tokenMint: "drifted-token",
        positionId: 10,
        transition: "ADD",
        inputAmountRaw: 40n,
        outputAmountRaw: 4n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 14n,
        positionVersionAfter: 2,
      }),
      detailedApplication({
        ...closeApplication(),
        fillId: "token-b-close",
        tokenMint: "token-b",
        positionId: 11,
      }),
    ]);

    expect(result.completed).toEqual([
      expect.objectContaining({
        tokenMint: "token-b",
        fillIds: ["token-b-open", "token-b-close"],
      }),
    ]);
    expect(result.incomplete).toEqual([]);
    expect(result.limitations).toEqual([
      expect.objectContaining({
        scope: "LIFECYCLE",
        reason: "LIFECYCLE_IDENTITY_UNPROVEN",
        stage: "CONTINUATION",
        lifecycleIdentity: {
          followerWallet: "follower-wallet",
          leaderWallet: "leader-wallet",
          tokenMint: "token-a",
          quoteMint: "SOL_NATIVE",
        },
        openFillId: "token-a-open",
        affectedFillIds: ["token-a-open", "token-a-drift"],
        evidence: [
          {
            field: "tokenMint",
            expected: "token-a",
            observed: "drifted-token",
          },
        ],
      }),
    ]);
  });

  it("gives position provenance precedence over a drifted active identity", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication({
        fillId: "token-a-open",
        tokenMint: "token-a",
        positionId: 10,
      }),
      detailedApplication({
        fillId: "token-b-open",
        tokenMint: "token-b",
        positionId: 11,
      }),
      detailedApplication({
        ...closeApplication(),
        fillId: "drifted-close",
        tokenMint: "token-b",
        positionId: 10,
      }),
      detailedApplication({
        ...closeApplication(),
        fillId: "token-b-close",
        tokenMint: "token-b",
        positionId: 11,
      }),
    ]);

    expect(result.completed).toEqual([
      expect.objectContaining({
        tokenMint: "token-b",
        fillIds: ["token-b-open", "token-b-close"],
      }),
    ]);
    expect(result.incomplete).toEqual([]);
    expect(result.limitations).toEqual([
      expect.objectContaining({
        reason: "LIFECYCLE_IDENTITY_UNPROVEN",
        lifecycleIdentity: expect.objectContaining({ tokenMint: "token-a" }),
        openFillId: "token-a-open",
        affectedFillIds: ["token-a-open", "drifted-close"],
        evidence: [
          {
            field: "tokenMint",
            expected: "token-a",
            observed: "token-b",
          },
        ],
      }),
    ]);
  });

  it("rejects a same-identity continuation with different position provenance", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication({ positionId: 10 }),
      detailedApplication({ ...closeApplication(), positionId: 11 }),
    ]);

    expect(result).toMatchObject({ completed: [], incomplete: [] });
    expect(result.limitations).toEqual([
      expect.objectContaining({
        reason: "LIFECYCLE_IDENTITY_UNPROVEN",
        openFillId: "fill-open",
        evidence: [
          {
            field: "positionId",
            expected: "10",
            observed: "11",
          },
        ],
      }),
    ]);
  });

  it("rejects concurrent canonical identities sharing one position provenance", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication({
        fillId: "token-a-open",
        tokenMint: "token-a",
        positionId: 10,
      }),
      detailedApplication({
        fillId: "token-b-open",
        tokenMint: "token-b",
        positionId: 10,
      }),
    ]);

    expect(result).toMatchObject({ completed: [], incomplete: [] });
    expect(result.limitations).toEqual([
      expect.objectContaining({
        reason: "LIFECYCLE_IDENTITY_UNPROVEN",
        lifecycleIdentity: expect.objectContaining({ tokenMint: "token-a" }),
        openFillId: "token-a-open",
        affectedFillIds: ["token-a-open", "token-b-open"],
        evidence: [
          {
            field: "tokenMint",
            expected: "token-a",
            observed: "token-b",
          },
        ],
      }),
    ]);
  });

  it("reports malformed typed application identity instead of silently dropping it", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication({ followerWallet: "" }),
    ]);

    expect(result).toMatchObject({ completed: [], incomplete: [] });
    expect(result.limitations).toEqual([
      {
        kind: "LIFECYCLE_UNEVALUABLE",
        scope: "APPLICATION",
        reason: "LIFECYCLE_IDENTITY_UNPROVEN",
        stage: "APPLICATION",
        lifecycleIdentity: {
          followerWallet: "",
          leaderWallet: "leader-wallet",
          tokenMint: "token-mint",
          quoteMint: "SOL_NATIVE",
        },
        openFillId: null,
        affectedFillIds: ["fill-open"],
        evidence: [
          {
            field: "followerWallet",
            expected: "NON_EMPTY",
            observed: "",
          },
        ],
      },
    ]);
  });

  it("reports a typed matcher-level negative economic contradiction", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication(),
      detailedApplication({
        fillId: "fill-invalid-reduce",
        side: "SELL",
        transition: "REDUCE",
        inputAmountRaw: -4n,
        outputAmountRaw: 50n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 6n,
        allocatedCostBasisRaw: 40n,
        proceedsRaw: 50n,
        realizedPnlDeltaRaw: 10n,
        positionVersionAfter: 2,
      }),
    ]);

    expect(result).toMatchObject({ completed: [], incomplete: [] });
    expect(result.limitations).toEqual([
      expect.objectContaining({
        reason: "ECONOMIC_EVIDENCE_INVALID",
        stage: "CONTINUATION",
        openFillId: "fill-open",
        affectedFillIds: ["fill-open", "fill-invalid-reduce"],
        evidence: [
          {
            field: "inputAmountRaw",
            expected: "4",
            observed: "-4",
          },
        ],
      }),
    ]);
  });

  it("reports a negative typed OPEN as application economic corruption", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication({ inputAmountRaw: -1n }),
    ]);

    expect(result).toMatchObject({ completed: [], incomplete: [] });
    expect(result.limitations).toEqual([
      expect.objectContaining({
        scope: "APPLICATION",
        reason: "ECONOMIC_EVIDENCE_INVALID",
        stage: "OPEN",
        openFillId: null,
        affectedFillIds: ["fill-open"],
        evidence: [
          {
            field: "inputAmountRaw",
            expected: "> 0",
            observed: "-1",
          },
        ],
      }),
    ]);
  });

  it("reports over-allocated cost basis without retaining the active lifecycle", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication({ quantityAfterRaw: 100n, outputAmountRaw: 100n }),
      detailedApplication({
        fillId: "fill-reduce",
        side: "SELL",
        transition: "REDUCE",
        inputAmountRaw: 40n,
        outputAmountRaw: 1_000n,
        quantityBeforeRaw: 100n,
        quantityAfterRaw: 60n,
        allocatedCostBasisRaw: 1_000n,
        proceedsRaw: 1_000n,
        realizedPnlDeltaRaw: 0n,
        positionVersionAfter: 2,
      }),
    ]);

    expect(result).toMatchObject({ completed: [], incomplete: [] });
    expect(result.limitations).toEqual([
      expect.objectContaining({
        reason: "COST_BASIS_OVER_ALLOCATED",
        stage: "CONTINUATION",
        openFillId: "fill-open",
        affectedFillIds: ["fill-open", "fill-reduce"],
        evidence: [
          {
            field: "cumulativeAllocatedCostBasisRaw",
            expected: "100",
            observed: "1000",
          },
        ],
      }),
    ]);
  });

  it("reports an enum-valid but impossible lifecycle transition", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication(),
      detailedApplication({
        fillId: "fill-invalid-add",
        side: "SELL",
        transition: "ADD",
        inputAmountRaw: 4n,
        outputAmountRaw: 4n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 14n,
        positionVersionAfter: 2,
      }),
    ]);

    expect(result).toMatchObject({ completed: [], incomplete: [] });
    expect(result.limitations).toEqual([
      expect.objectContaining({
        reason: "LIFECYCLE_TRANSITION_INVALID",
        stage: "CONTINUATION",
        evidence: [
          {
            field: "transitionSide",
            expected: "BUY:ADD|SELL:REDUCE|SELL:CLOSE",
            observed: "SELL:ADD",
          },
        ],
      }),
    ]);
  });

  it("reports a second OPEN before flat as an invalid transition", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication(),
      detailedApplication({
        fillId: "fill-second-open",
        positionVersionAfter: 2,
      }),
    ]);

    expect(result).toMatchObject({ completed: [], incomplete: [] });
    expect(result.limitations).toEqual([
      expect.objectContaining({
        reason: "LIFECYCLE_TRANSITION_INVALID",
        stage: "CONTINUATION",
        openFillId: "fill-open",
        affectedFillIds: ["fill-open", "fill-second-open"],
        evidence: [
          {
            field: "transitionSide",
            expected: "BUY:ADD|SELL:REDUCE|SELL:CLOSE",
            observed: "BUY:OPEN",
          },
        ],
      }),
    ]);
  });

  it("reports a final cycle PnL invariant violation instead of completing it", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication(),
      detailedApplication({
        ...closeApplication({
          allocatedCostBasisRaw: 90n,
          realizedPnlDeltaRaw: 35n,
        }),
        positionId: 10,
      }),
    ]);

    expect(result).toMatchObject({ completed: [], incomplete: [] });
    expect(result.limitations).toEqual([
      expect.objectContaining({
        reason: "CYCLE_PNL_INVARIANT_VIOLATION",
        stage: "FINALIZATION",
        openFillId: "fill-open",
        affectedFillIds: ["fill-open", "fill-close"],
        evidence: [
          {
            field: "realizedPnlQuoteRaw",
            expected: "25",
            observed: "35",
          },
        ],
      }),
    ]);
  });

  it("reports conflicting evidence that reuses one fill identity", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication(),
      detailedApplication({ quantityAfterRaw: 11n }),
    ]);

    expect(result).toMatchObject({ completed: [], incomplete: [] });
    expect(result.limitations).toEqual([
      {
        kind: "LIFECYCLE_UNEVALUABLE",
        scope: "APPLICATION",
        reason: "APPLICATION_EVIDENCE_CONFLICT",
        stage: "APPLICATION",
        lifecycleIdentity: {
          followerWallet: "follower-wallet",
          leaderWallet: "leader-wallet",
          tokenMint: "token-mint",
          quoteMint: "SOL_NATIVE",
        },
        openFillId: null,
        affectedFillIds: ["fill-open"],
        evidence: [
          {
            field: "quantityAfterRaw",
            expected: "10",
            observed: "11",
          },
        ],
      },
    ]);
  });

  it("invalidates every proven lifecycle for one multi-provenance conflicting fill", () => {
    const openA = detailedApplication({
      fillId: "open-a",
      tokenMint: "token-a",
      positionId: 10,
    });
    const openB = detailedApplication({
      fillId: "open-b",
      tokenMint: "token-b",
      positionId: 11,
    });
    const openC = detailedApplication({
      fillId: "open-c",
      tokenMint: "token-c",
      positionId: 12,
    });
    const conflictA = detailedApplication({
      fillId: "conflict-fill",
      tokenMint: "token-a",
      positionId: 10,
      side: "SELL",
      transition: "REDUCE",
      inputAmountRaw: 4n,
      outputAmountRaw: 50n,
      quantityBeforeRaw: 10n,
      quantityAfterRaw: 6n,
      allocatedCostBasisRaw: 40n,
      proceedsRaw: 50n,
      realizedPnlDeltaRaw: 10n,
      positionVersionAfter: 2,
    });
    const conflictB = { ...conflictA, tokenMint: "token-b", positionId: 11 };
    const closeC = detailedApplication({
      ...closeApplication(),
      fillId: "close-c",
      tokenMint: "token-c",
      positionId: 12,
    });
    const evidence = [openA, openB, openC, conflictA, conflictB, closeC];

    const result = matchFollowerRoundTripsDetailed(evidence);

    expect(result.completed).toEqual([
      expect.objectContaining({
        tokenMint: "token-c",
        fillIds: ["open-c", "close-c"],
        realizedPnlQuoteRaw: 25n,
      }),
    ]);
    expect(result.incomplete).toEqual([]);
    expect(result.limitations).toEqual([
      expect.objectContaining({
        kind: "LIFECYCLE_UNEVALUABLE",
        scope: "APPLICATION",
        reason: "APPLICATION_EVIDENCE_CONFLICT",
        lifecycleIdentity: expect.objectContaining({ tokenMint: "token-a" }),
        openFillId: null,
        affectedFillIds: ["conflict-fill"],
      }),
      expect.objectContaining({
        kind: "LIFECYCLE_UNEVALUABLE",
        scope: "APPLICATION",
        reason: "APPLICATION_EVIDENCE_CONFLICT",
        lifecycleIdentity: expect.objectContaining({ tokenMint: "token-b" }),
        openFillId: null,
        affectedFillIds: ["conflict-fill"],
      }),
    ]);
    expect(
      matchFollowerRoundTripsDetailed([
        openA,
        openB,
        openC,
        conflictB,
        conflictA,
        closeC,
      ]),
    ).toEqual(result);
    expect(matchFollowerRoundTrips(evidence)).toEqual({
      completed: result.completed,
      incomplete: result.incomplete,
    });
  });

  it("isolates conflicting fill evidence from an unrelated valid lifecycle", () => {
    const conflict = detailedApplication({
      fillId: "token-a-open",
      tokenMint: "token-a",
      positionId: 10,
    });
    const result = matchFollowerRoundTripsDetailed([
      conflict,
      { ...conflict, quantityAfterRaw: 11n },
      detailedApplication({
        fillId: "token-b-open",
        tokenMint: "token-b",
        positionId: 11,
      }),
      detailedApplication({
        ...closeApplication(),
        fillId: "token-b-close",
        tokenMint: "token-b",
        positionId: 11,
      }),
    ]);

    expect(result.completed).toEqual([
      expect.objectContaining({
        tokenMint: "token-b",
        fillIds: ["token-b-open", "token-b-close"],
      }),
    ]);
    expect(result.limitations).toEqual([
      expect.objectContaining({
        reason: "APPLICATION_EVIDENCE_CONFLICT",
        lifecycleIdentity: expect.objectContaining({ tokenMint: "token-a" }),
      }),
    ]);
  });

  it("retains an earlier completed cycle when a later reopened fill conflicts", () => {
    const laterClose = detailedApplication({
      ...closeApplication({
        fillId: "later-close",
        inputAmountRaw: 8n,
        quantityBeforeRaw: 8n,
        allocatedCostBasisRaw: 80n,
        proceedsRaw: 90n,
        outputAmountRaw: 90n,
        realizedPnlDeltaRaw: 10n,
        positionVersionAfter: 4,
      }),
      positionId: 10,
    });
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication(),
      detailedApplication({ ...closeApplication(), positionId: 10 }),
      detailedApplication({
        fillId: "fill-reopen",
        positionId: 10,
        inputAmountRaw: 80n,
        outputAmountRaw: 8n,
        quantityAfterRaw: 8n,
        positionVersionAfter: 3,
      }),
      laterClose,
      { ...laterClose, proceedsRaw: 91n, outputAmountRaw: 91n },
    ]);

    expect(result.completed).toEqual([
      expect.objectContaining({
        fillIds: ["fill-open", "fill-close"],
      }),
    ]);
    expect(result.incomplete).toEqual([]);
    expect(result.limitations).toEqual([
      expect.objectContaining({
        scope: "APPLICATION",
        reason: "APPLICATION_EVIDENCE_CONFLICT",
        affectedFillIds: ["later-close"],
      }),
    ]);
  });

  it("treats an exact duplicate application as benign deduplication", () => {
    const open = detailedApplication();
    const close = detailedApplication({
      ...closeApplication(),
      positionId: 10,
    });
    const result = matchFollowerRoundTripsDetailed([
      open,
      { ...open },
      close,
      { ...close },
    ]);

    expect(result.completed).toHaveLength(1);
    expect(result.incomplete).toEqual([]);
    expect(result.limitations).toEqual([]);
  });

  it.each([
    ["followerWallet", "other-follower"],
    ["leaderWallet", "other-leader"],
    ["tokenMint", "other-token"],
    ["quoteMint", "USDC"],
  ] as const)(
    "keeps a valid lifecycle when corrupt evidence differs by %s",
    (identityField, differentValue) => {
      const result = matchFollowerRoundTripsDetailed([
        detailedApplication({ fillId: "corrupt-open", positionId: 10 }),
        detailedApplication({
          fillId: "valid-open",
          positionId: 11,
          [identityField]: differentValue,
        }),
        detailedApplication({
          ...closeApplication({ positionVersionAfter: 1 }),
          fillId: "corrupt-close",
          positionId: 10,
        }),
        detailedApplication({
          ...closeApplication(),
          fillId: "valid-close",
          positionId: 11,
          [identityField]: differentValue,
        }),
      ]);

      expect(result.completed).toEqual([
        expect.objectContaining({
          [identityField]: differentValue,
          fillIds: ["valid-open", "valid-close"],
        }),
      ]);
      expect(result.incomplete).toEqual([]);
      expect(result.limitations).toEqual([
        expect.objectContaining({
          reason: "LIFECYCLE_CONTINUITY_VIOLATION",
          openFillId: "corrupt-open",
        }),
      ]);
    },
  );

  it("retains an earlier completed cycle when a reopened cycle later corrupts", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication(),
      detailedApplication({ ...closeApplication(), positionId: 10 }),
      detailedApplication({
        fillId: "fill-reopen",
        positionId: 10,
        inputAmountRaw: 80n,
        outputAmountRaw: 8n,
        quantityAfterRaw: 8n,
        positionVersionAfter: 3,
      }),
      detailedApplication({
        ...closeApplication({
          fillId: "fill-corrupt-close",
          inputAmountRaw: 8n,
          quantityBeforeRaw: 8n,
          allocatedCostBasisRaw: 80n,
          proceedsRaw: 90n,
          outputAmountRaw: 90n,
          realizedPnlDeltaRaw: 10n,
          positionVersionAfter: 3,
        }),
        positionId: 10,
      }),
    ]);

    expect(result.completed).toEqual([
      expect.objectContaining({
        fillIds: ["fill-open", "fill-close"],
      }),
    ]);
    expect(result.incomplete).toEqual([]);
    expect(result.limitations).toEqual([
      expect.objectContaining({
        openFillId: "fill-reopen",
        affectedFillIds: ["fill-reopen", "fill-corrupt-close"],
      }),
    ]);
  });

  it("canonically orders limitations independently of corruption encounter order", () => {
    const result = matchFollowerRoundTripsDetailed([
      detailedApplication({
        fillId: "z-open",
        tokenMint: "token-z",
        positionId: 10,
      }),
      detailedApplication({
        fillId: "a-open",
        tokenMint: "token-a",
        positionId: 11,
      }),
      detailedApplication({
        ...closeApplication({ positionVersionAfter: 1 }),
        fillId: "z-close",
        tokenMint: "token-z",
        positionId: 10,
      }),
      detailedApplication({
        ...closeApplication({ positionVersionAfter: 1 }),
        fillId: "a-close",
        tokenMint: "token-a",
        positionId: 11,
      }),
    ]);

    expect(
      result.limitations.map(
        (limitation) => limitation.lifecycleIdentity.tokenMint,
      ),
    ).toEqual(["token-a", "token-z"]);
    expect(
      matchFollowerRoundTripsDetailed([
        detailedApplication({
          fillId: "z-open",
          tokenMint: "token-z",
          positionId: 10,
        }),
        detailedApplication({
          fillId: "a-open",
          tokenMint: "token-a",
          positionId: 11,
        }),
        detailedApplication({
          ...closeApplication({ positionVersionAfter: 1 }),
          fillId: "z-close",
          tokenMint: "token-z",
          positionId: 10,
        }),
        detailedApplication({
          ...closeApplication({ positionVersionAfter: 1 }),
          fillId: "a-close",
          tokenMint: "token-a",
          positionId: 11,
        }),
      ]),
    ).toEqual(result);
  });

  it("defensively copies detailed results and nested limitation evidence", () => {
    const evidence = [
      detailedApplication(),
      detailedApplication({
        ...closeApplication({ positionVersionAfter: 1 }),
        positionId: 10,
      }),
    ];
    const first = matchFollowerRoundTripsDetailed(evidence);
    const second = matchFollowerRoundTripsDetailed(evidence);
    const secondSnapshot = structuredClone(second);

    (evidence[0] as { tokenMint: string }).tokenMint = "mutated-input";
    expect(first.limitations[0]!.lifecycleIdentity.tokenMint).toBe(
      "token-mint",
    );

    (
      first.limitations[0]!.lifecycleIdentity as { tokenMint: string }
    ).tokenMint = "mutated-result";
    (first.limitations[0]!.affectedFillIds as string[]).push("late-fill");
    (
      first.limitations[0]!.evidence[0] as {
        observed: string;
      }
    ).observed = "999";
    (
      first.limitations as FollowerRoundTripDetailedResult["limitations"] &
        FollowerRoundTripUnevaluableLimitation[]
    ).push(first.limitations[0]!);

    expect(second).toEqual(secondSnapshot);
  });
});

describe("matchFollowerRoundTrips", () => {
  it("returns no lifecycles for empty evidence", () => {
    expect(matchFollowerRoundTrips([])).toEqual({
      completed: [],
      incomplete: [],
    });
  });

  it("projects one exact BUY-to-SELL follower cycle", () => {
    const applications: readonly FollowerFillApplicationEvidence[] = [
      {
        fillId: "fill-buy",
        followerWallet: "follower-wallet",
        leaderWallet: "leader-wallet",
        tokenMint: "token-mint",
        quoteMint: "SOL_NATIVE",
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
      },
      {
        fillId: "fill-sell",
        followerWallet: "follower-wallet",
        leaderWallet: "leader-wallet",
        tokenMint: "token-mint",
        quoteMint: "SOL_NATIVE",
        side: "SELL",
        transition: "CLOSE",
        inputAmountRaw: 10n,
        outputAmountRaw: 125n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 0n,
        allocatedCostBasisRaw: 100n,
        proceedsRaw: 125n,
        realizedPnlDeltaRaw: 25n,
        positionVersionAfter: 2,
        quoteTimestampMs: 4_000,
      },
    ];

    expect(matchFollowerRoundTrips(applications)).toEqual({
      completed: [
        {
          followerWallet: "follower-wallet",
          leaderWallet: "leader-wallet",
          tokenMint: "token-mint",
          quoteMint: "SOL_NATIVE",
          openFillId: "fill-buy",
          closeFillId: "fill-sell",
          fillIds: ["fill-buy", "fill-sell"],
          entryCostQuoteRaw: 100n,
          proceedsQuoteRaw: 125n,
          realizedPnlQuoteRaw: 25n,
          openedAtMs: 1_000,
          closedAtMs: 4_000,
          holdingTimeMs: 3_000,
        },
      ],
      incomplete: [],
    });
  });

  it("keeps an ADD inside one lifecycle until CLOSE", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      application({
        fillId: "fill-add",
        transition: "ADD",
        inputAmountRaw: 60n,
        outputAmountRaw: 4n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 14n,
        positionVersionAfter: 2,
        quoteTimestampMs: 2_000,
      }),
      application({
        fillId: "fill-close",
        side: "SELL",
        transition: "CLOSE",
        inputAmountRaw: 14n,
        outputAmountRaw: 190n,
        quantityBeforeRaw: 14n,
        quantityAfterRaw: 0n,
        allocatedCostBasisRaw: 160n,
        proceedsRaw: 190n,
        realizedPnlDeltaRaw: 30n,
        positionVersionAfter: 3,
        quoteTimestampMs: 5_000,
      }),
    ]);

    expect(result.completed).toEqual([
      {
        followerWallet: "follower-wallet",
        leaderWallet: "leader-wallet",
        tokenMint: "token-mint",
        quoteMint: "SOL_NATIVE",
        openFillId: "fill-open",
        closeFillId: "fill-close",
        fillIds: ["fill-open", "fill-add", "fill-close"],
        entryCostQuoteRaw: 160n,
        proceedsQuoteRaw: 190n,
        realizedPnlQuoteRaw: 30n,
        openedAtMs: 1_000,
        closedAtMs: 5_000,
        holdingTimeMs: 4_000,
      },
    ]);
  });

  it("does not complete a lifecycle at a partial REDUCE", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      application({
        fillId: "fill-add",
        transition: "ADD",
        inputAmountRaw: 40n,
        outputAmountRaw: 4n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 14n,
        positionVersionAfter: 2,
        quoteTimestampMs: 2_000,
      }),
      application({
        fillId: "fill-reduce",
        side: "SELL",
        transition: "REDUCE",
        inputAmountRaw: 5n,
        outputAmountRaw: 60n,
        quantityBeforeRaw: 14n,
        quantityAfterRaw: 9n,
        allocatedCostBasisRaw: 50n,
        proceedsRaw: 60n,
        realizedPnlDeltaRaw: 10n,
        positionVersionAfter: 3,
        quoteTimestampMs: 3_000,
      }),
      application({
        fillId: "fill-close",
        side: "SELL",
        transition: "CLOSE",
        inputAmountRaw: 9n,
        outputAmountRaw: 110n,
        quantityBeforeRaw: 9n,
        quantityAfterRaw: 0n,
        allocatedCostBasisRaw: 90n,
        proceedsRaw: 110n,
        realizedPnlDeltaRaw: 20n,
        positionVersionAfter: 4,
        quoteTimestampMs: 6_000,
      }),
    ]);

    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]).toMatchObject({
      openFillId: "fill-open",
      closeFillId: "fill-close",
      fillIds: ["fill-open", "fill-add", "fill-reduce", "fill-close"],
      entryCostQuoteRaw: 140n,
      proceedsQuoteRaw: 170n,
      realizedPnlQuoteRaw: 30n,
    });
  });

  it("excludes an unfinished OPEN from completed round trips", () => {
    const result = matchFollowerRoundTrips([application({})]);

    expect(result.completed).toEqual([]);
    expect(result.incomplete).toEqual([
      {
        followerWallet: "follower-wallet",
        leaderWallet: "leader-wallet",
        tokenMint: "token-mint",
        quoteMint: "SOL_NATIVE",
        openFillId: "fill-open",
        latestFillId: "fill-open",
        fillIds: ["fill-open"],
        remainingQuantityRaw: 10n,
      },
    ]);
  });

  it("keeps an OPEN plus ADD as one incomplete lifecycle", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      application({
        fillId: "fill-add",
        transition: "ADD",
        inputAmountRaw: 60n,
        outputAmountRaw: 4n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 14n,
        positionVersionAfter: 2,
        quoteTimestampMs: 2_000,
      }),
    ]);

    expect(result.completed).toEqual([]);
    expect(result.incomplete).toEqual([
      expect.objectContaining({
        openFillId: "fill-open",
        latestFillId: "fill-add",
        fillIds: ["fill-open", "fill-add"],
        remainingQuantityRaw: 14n,
      }),
    ]);
  });

  it("keeps a partial REDUCE incomplete with the persisted remaining quantity", () => {
    const result = matchFollowerRoundTrips([
      application({ quantityAfterRaw: 100n, outputAmountRaw: 100n }),
      application({
        fillId: "fill-reduce",
        side: "SELL",
        transition: "REDUCE",
        inputAmountRaw: 40n,
        outputAmountRaw: 50n,
        quantityBeforeRaw: 100n,
        quantityAfterRaw: 60n,
        allocatedCostBasisRaw: 40n,
        proceedsRaw: 50n,
        realizedPnlDeltaRaw: 10n,
        positionVersionAfter: 2,
        quoteTimestampMs: 2_000,
      }),
    ]);

    expect(result.completed).toEqual([]);
    expect(result.incomplete).toEqual([
      expect.objectContaining({
        openFillId: "fill-open",
        latestFillId: "fill-reduce",
        fillIds: ["fill-open", "fill-reduce"],
        remainingQuantityRaw: 60n,
      }),
    ]);
    expect(result.incomplete[0]).not.toHaveProperty("realizedPnlQuoteRaw");
  });

  it.each([
    ["followerWallet", "other-follower"],
    ["leaderWallet", "other-leader"],
    ["tokenMint", "other-token"],
    ["quoteMint", "USDC"],
  ] as const)(
    "isolates lifecycles when %s differs",
    (identityField, differentValue) => {
      const close = closeApplication({
        [identityField]: differentValue,
      });

      expect(
        matchFollowerRoundTrips([application({}), close]).completed,
      ).toEqual([]);
    },
  );

  it("keeps two token identities as independent incomplete lifecycles", () => {
    const result = matchFollowerRoundTrips([
      application({ fillId: "fill-token-b", tokenMint: "token-b" }),
      application({ fillId: "fill-token-a", tokenMint: "token-a" }),
    ]);

    expect(
      result.incomplete.map(({ tokenMint, openFillId }) => ({
        tokenMint,
        openFillId,
      })),
    ).toEqual([
      { tokenMint: "token-b", openFillId: "fill-token-b" },
      { tokenMint: "token-a", openFillId: "fill-token-a" },
    ]);
  });

  it.each([
    ["followerWallet", "other-follower"],
    ["leaderWallet", "other-leader"],
    ["quoteMint", "USDC"],
  ] as const)(
    "keeps independent incomplete lifecycles isolated across %s",
    (identityField, differentValue) => {
      const result = matchFollowerRoundTrips([
        application({ fillId: "fill-first" }),
        application({
          fillId: "fill-second",
          [identityField]: differentValue,
        }),
      ]);

      expect(result.incomplete).toHaveLength(2);
      expect(result.incomplete.map(({ openFillId }) => openFillId)).toEqual([
        "fill-first",
        "fill-second",
      ]);
    },
  );

  it("keeps SOL and USDC lifecycles and realized raw PnL separate", () => {
    const result = matchFollowerRoundTrips([
      application({ fillId: "sol-open" }),
      application({
        fillId: "usdc-open",
        quoteMint: "USDC",
        inputAmountRaw: 200n,
        outputAmountRaw: 20n,
        quantityAfterRaw: 20n,
      }),
      closeApplication({ fillId: "sol-close" }),
      closeApplication({
        fillId: "usdc-close",
        quoteMint: "USDC",
        inputAmountRaw: 20n,
        outputAmountRaw: 230n,
        quantityBeforeRaw: 20n,
        allocatedCostBasisRaw: 200n,
        proceedsRaw: 230n,
        realizedPnlDeltaRaw: 30n,
      }),
    ]);

    expect(
      result.completed.map((cycle) => ({
        quoteMint: cycle.quoteMint,
        entryCostQuoteRaw: cycle.entryCostQuoteRaw,
        proceedsQuoteRaw: cycle.proceedsQuoteRaw,
        realizedPnlQuoteRaw: cycle.realizedPnlQuoteRaw,
      })),
    ).toEqual([
      {
        quoteMint: "SOL_NATIVE",
        entryCostQuoteRaw: 100n,
        proceedsQuoteRaw: 125n,
        realizedPnlQuoteRaw: 25n,
      },
      {
        quoteMint: "USDC",
        entryCostQuoteRaw: 200n,
        proceedsQuoteRaw: 230n,
        realizedPnlQuoteRaw: 30n,
      },
    ]);
  });

  it("sums persisted realized PnL deltas without deriving a new cost basis", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      application({
        fillId: "fill-reduce",
        side: "SELL",
        transition: "REDUCE",
        inputAmountRaw: 4n,
        outputAmountRaw: 50n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 6n,
        allocatedCostBasisRaw: 40n,
        proceedsRaw: 50n,
        realizedPnlDeltaRaw: 10n,
        positionVersionAfter: 2,
        quoteTimestampMs: 2_000,
      }),
      closeApplication({
        inputAmountRaw: 6n,
        outputAmountRaw: 75n,
        quantityBeforeRaw: 6n,
        allocatedCostBasisRaw: 60n,
        proceedsRaw: 75n,
        realizedPnlDeltaRaw: 15n,
        positionVersionAfter: 3,
      }),
    ]);

    expect(result.completed[0]).toMatchObject({
      entryCostQuoteRaw: 100n,
      proceedsQuoteRaw: 125n,
      realizedPnlQuoteRaw: 25n,
    });
  });

  it("does not duplicate a lifecycle or realized PnL for repeated fill evidence", () => {
    const open = application({});
    const reduce = application({
      fillId: "fill-reduce",
      side: "SELL",
      transition: "REDUCE",
      inputAmountRaw: 4n,
      outputAmountRaw: 50n,
      quantityBeforeRaw: 10n,
      quantityAfterRaw: 6n,
      allocatedCostBasisRaw: 40n,
      proceedsRaw: 50n,
      realizedPnlDeltaRaw: 10n,
      positionVersionAfter: 2,
      quoteTimestampMs: 2_000,
    });
    const close = closeApplication({
      inputAmountRaw: 6n,
      outputAmountRaw: 75n,
      quantityBeforeRaw: 6n,
      allocatedCostBasisRaw: 60n,
      proceedsRaw: 75n,
      realizedPnlDeltaRaw: 15n,
      positionVersionAfter: 3,
    });

    const result = matchFollowerRoundTrips([
      open,
      reduce,
      reduce,
      close,
      open,
      close,
    ]);

    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]).toMatchObject({
      fillIds: ["fill-open", "fill-reduce", "fill-close"],
      proceedsQuoteRaw: 125n,
      realizedPnlQuoteRaw: 25n,
    });
  });

  it("fails closed for conflicting evidence that reuses a fill identity", () => {
    const open = application({});
    const conflictingOpen = application({ quantityAfterRaw: 11n });

    expect(matchFollowerRoundTrips([open, conflictingOpen])).toEqual({
      completed: [],
      incomplete: [],
    });
  });

  it("fails closed when conflicting duplicate evidence drifts position identity", () => {
    const open = application({});
    const identityDrift = application({ leaderWallet: "other-leader" });

    expect(matchFollowerRoundTrips([open, identityDrift])).toEqual({
      completed: [],
      incomplete: [],
    });
  });

  it("starts a new lifecycle after a completed position reopens", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      closeApplication(),
      application({
        fillId: "fill-reopen",
        inputAmountRaw: 80n,
        outputAmountRaw: 8n,
        quantityAfterRaw: 8n,
        positionVersionAfter: 3,
        quoteTimestampMs: 5_000,
      }),
      closeApplication({
        fillId: "fill-second-close",
        inputAmountRaw: 8n,
        outputAmountRaw: 70n,
        quantityBeforeRaw: 8n,
        allocatedCostBasisRaw: 80n,
        proceedsRaw: 70n,
        realizedPnlDeltaRaw: -10n,
        positionVersionAfter: 4,
        quoteTimestampMs: 7_000,
      }),
    ]);

    expect(
      result.completed.map((cycle) => ({
        fillIds: cycle.fillIds,
        realizedPnlQuoteRaw: cycle.realizedPnlQuoteRaw,
      })),
    ).toEqual([
      {
        fillIds: ["fill-open", "fill-close"],
        realizedPnlQuoteRaw: 25n,
      },
      {
        fillIds: ["fill-reopen", "fill-second-close"],
        realizedPnlQuoteRaw: -10n,
      },
    ]);
  });

  it("returns a completed lifecycle plus an incomplete reopened lifecycle at the boundary", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      closeApplication(),
      application({
        fillId: "fill-reopen",
        inputAmountRaw: 80n,
        outputAmountRaw: 8n,
        quantityAfterRaw: 8n,
        positionVersionAfter: 3,
        quoteTimestampMs: 5_000,
      }),
    ]);

    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]).toMatchObject({
      openFillId: "fill-open",
      closeFillId: "fill-close",
    });
    expect(result.incomplete).toEqual([
      expect.objectContaining({
        openFillId: "fill-reopen",
        latestFillId: "fill-reopen",
        remainingQuantityRaw: 8n,
      }),
    ]);
  });

  it("keeps an incomplete reopened lifecycle outside completed-only Strategy Metrics", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      closeApplication(),
      application({
        fillId: "fill-reopen",
        inputAmountRaw: 80n,
        outputAmountRaw: 8n,
        quantityAfterRaw: 8n,
        positionVersionAfter: 3,
      }),
    ]);

    const metrics = calculateStrategyMetrics(result.completed, {
      definitionVersion: "STRATEGY_METRICS_V1",
      minimumCompletedCycles: 1,
    });

    expect(result).toMatchObject({
      completed: [expect.any(Object)],
      incomplete: [expect.any(Object)],
    });
    expect(metrics.netQuoteExpectancy).toMatchObject({
      value: "25",
      sampleCount: 1,
    });
    expect(metrics.holdingTime.sampleCount).toBe(1);
  });

  it("fails a lifecycle closed when position evidence has a version gap", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      closeApplication({ positionVersionAfter: 3 }),
    ]);

    expect(result.completed).toEqual([]);
    expect(result.incomplete).toEqual([]);
  });

  it("fails a lifecycle closed when position quantities are discontinuous", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      closeApplication({ quantityBeforeRaw: 9n }),
    ]);

    expect(result.completed).toEqual([]);
    expect(result.incomplete).toEqual([]);
  });

  it("fails a lifecycle closed when a transition and side are incompatible", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      application({
        fillId: "fill-invalid-add",
        side: "SELL",
        transition: "ADD",
        inputAmountRaw: 4n,
        outputAmountRaw: 40n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 14n,
        positionVersionAfter: 2,
      }),
    ]);

    expect(result).toEqual({ completed: [], incomplete: [] });
  });

  it("fails a lifecycle closed when persisted trade quantity is negative", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      application({
        fillId: "fill-invalid-reduce",
        side: "SELL",
        transition: "REDUCE",
        inputAmountRaw: -4n,
        outputAmountRaw: 50n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 6n,
        allocatedCostBasisRaw: 40n,
        proceedsRaw: 50n,
        realizedPnlDeltaRaw: 10n,
        positionVersionAfter: 2,
      }),
    ]);

    expect(result).toEqual({ completed: [], incomplete: [] });
  });

  it("fails a lifecycle closed when persisted PnL contradicts quote flow", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      closeApplication({ realizedPnlDeltaRaw: 24n }),
    ]);

    expect(result.completed).toEqual([]);
    expect(result.incomplete).toEqual([]);
  });

  it("does not expose an incomplete lifecycle with a persisted PnL invariant violation", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      application({
        fillId: "fill-reduce",
        side: "SELL",
        transition: "REDUCE",
        inputAmountRaw: 4n,
        outputAmountRaw: 50n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 6n,
        allocatedCostBasisRaw: 40n,
        proceedsRaw: 50n,
        realizedPnlDeltaRaw: 9n,
        positionVersionAfter: 2,
      }),
    ]);

    expect(result).toEqual({ completed: [], incomplete: [] });
  });

  it("does not expose an incomplete lifecycle with malformed identity", () => {
    const result = matchFollowerRoundTrips([
      application({ followerWallet: "" }),
    ]);

    expect(result).toEqual({ completed: [], incomplete: [] });
  });

  it("fails an active lifecycle closed when continuation identity is malformed", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      application({
        fillId: "fill-malformed-add",
        leaderWallet: "",
        transition: "ADD",
        inputAmountRaw: 60n,
        outputAmountRaw: 4n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 14n,
        positionVersionAfter: 2,
      }),
    ]);

    expect(result).toEqual({ completed: [], incomplete: [] });
  });

  it("fails an active lifecycle closed when continuation identity drifts", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      application({
        fillId: "fill-drifted-add",
        leaderWallet: "other-leader",
        transition: "ADD",
        inputAmountRaw: 60n,
        outputAmountRaw: 4n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 14n,
        positionVersionAfter: 2,
      }),
    ]);

    expect(result).toEqual({ completed: [], incomplete: [] });
  });

  it.each([
    [
      "multiple identity fields drift",
      { leaderWallet: "other-leader", quoteMint: "USDC" },
    ],
    [
      "one identity field is missing while another drifts",
      { leaderWallet: "", quoteMint: "USDC" },
    ],
  ] as const)("fails closed when %s", (_case, identityOverrides) => {
    const result = matchFollowerRoundTrips([
      application({}),
      application({
        fillId: "fill-corrupt-add",
        transition: "ADD",
        inputAmountRaw: 60n,
        outputAmountRaw: 4n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 14n,
        positionVersionAfter: 2,
        ...identityOverrides,
      }),
    ]);

    expect(result).toEqual({ completed: [], incomplete: [] });
  });

  it("does not expose an incomplete lifecycle with invalid OPEN accounting", () => {
    const result = matchFollowerRoundTrips([
      application({ realizedPnlDeltaRaw: 1n }),
    ]);

    expect(result).toEqual({ completed: [], incomplete: [] });
  });

  it("does not expose an incomplete lifecycle with invalid ADD accounting", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      application({
        fillId: "fill-add",
        transition: "ADD",
        inputAmountRaw: 60n,
        outputAmountRaw: 5n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 14n,
        positionVersionAfter: 2,
      }),
    ]);

    expect(result).toEqual({ completed: [], incomplete: [] });
  });

  it("does not expose an incomplete lifecycle with negative sell proceeds", () => {
    const result = matchFollowerRoundTrips([
      application({}),
      application({
        fillId: "fill-reduce",
        side: "SELL",
        transition: "REDUCE",
        inputAmountRaw: 4n,
        outputAmountRaw: -1n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 6n,
        allocatedCostBasisRaw: 0n,
        proceedsRaw: -1n,
        realizedPnlDeltaRaw: -1n,
        positionVersionAfter: 2,
      }),
    ]);

    expect(result).toEqual({ completed: [], incomplete: [] });
  });

  it("does not expose an incomplete lifecycle with over-allocated cost basis", () => {
    const result = matchFollowerRoundTrips([
      application({ quantityAfterRaw: 100n, outputAmountRaw: 100n }),
      application({
        fillId: "fill-reduce",
        side: "SELL",
        transition: "REDUCE",
        inputAmountRaw: 40n,
        outputAmountRaw: 1_000n,
        quantityBeforeRaw: 100n,
        quantityAfterRaw: 60n,
        allocatedCostBasisRaw: 1_000n,
        proceedsRaw: 1_000n,
        realizedPnlDeltaRaw: 0n,
        positionVersionAfter: 2,
      }),
    ]);

    expect(result).toEqual({ completed: [], incomplete: [] });
  });

  it("preserves exact economic raw values beyond safe integer range", () => {
    const result = matchFollowerRoundTrips([
      application({ inputAmountRaw: 9_007_199_254_740_993n }),
      closeApplication({
        outputAmountRaw: 9_007_199_254_741_020n,
        allocatedCostBasisRaw: 9_007_199_254_740_993n,
        proceedsRaw: 9_007_199_254_741_020n,
        realizedPnlDeltaRaw: 27n,
      }),
    ]);

    expect(result.completed[0]).toMatchObject({
      entryCostQuoteRaw: 9_007_199_254_740_993n,
      proceedsQuoteRaw: 9_007_199_254_741_020n,
      realizedPnlQuoteRaw: 27n,
    });
  });

  it("preserves an incomplete remaining quantity beyond safe integer range", () => {
    const quantityRaw = 9_007_199_254_740_993n;

    expect(
      matchFollowerRoundTrips([
        application({
          outputAmountRaw: quantityRaw,
          quantityAfterRaw: quantityRaw,
        }),
      ]).incomplete[0],
    ).toMatchObject({ remainingQuantityRaw: quantityRaw });
  });

  it("orders incomplete lifecycles deterministically by first OPEN evidence", () => {
    const evidence = [
      application({ fillId: "fill-z", tokenMint: "token-z" }),
      application({ fillId: "fill-a", tokenMint: "token-a" }),
    ] as const;

    const first = matchFollowerRoundTrips(evidence).incomplete.map(
      ({ openFillId }) => openFillId,
    );
    const second = matchFollowerRoundTrips(evidence).incomplete.map(
      ({ openFillId }) => openFillId,
    );

    expect(first).toEqual(["fill-z", "fill-a"]);
    expect(second).toEqual(first);
  });

  it("does not synthesize a lifecycle for a left-censored CLOSE", () => {
    expect(matchFollowerRoundTrips([closeApplication()])).toEqual({
      completed: [],
      incomplete: [],
    });
  });
});
