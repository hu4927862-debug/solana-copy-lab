import { describe, expect, expectTypeOf, it } from "vitest";
import { calculateStrategyMetrics } from "../../src/strategy-evaluation/metrics.js";
import type { CompletedFollowerRoundTrip } from "../../src/strategy-evaluation/round-trips.js";

const policy = {
  definitionVersion: "STRATEGY_METRICS_V1",
  minimumCompletedCycles: 20,
} as const;

function cycle(
  realizedPnlQuoteRaw: bigint,
  overrides: Partial<CompletedFollowerRoundTrip> = {},
): CompletedFollowerRoundTrip {
  return {
    followerWallet: "follower-wallet",
    leaderWallet: "leader-wallet",
    tokenMint: "token-mint",
    quoteMint: "SOL_NATIVE",
    openFillId: "open-fill",
    closeFillId: "close-fill",
    fillIds: ["open-fill", "close-fill"],
    entryCostQuoteRaw: 100n,
    proceedsQuoteRaw: 100n + realizedPnlQuoteRaw,
    realizedPnlQuoteRaw,
    openedAtMs: 1_000,
    closedAtMs: 2_000,
    holdingTimeMs: 1_000,
    ...overrides,
  };
}

describe("calculateStrategyMetrics", () => {
  it("accepts completed round trips as its only lifecycle sample", () => {
    expectTypeOf(calculateStrategyMetrics)
      .parameter(0)
      .toEqualTypeOf<readonly CompletedFollowerRoundTrip[]>();
  });

  it("reports no expectancy for an empty completed-cycle sample", () => {
    expect(calculateStrategyMetrics([], policy).netQuoteExpectancy).toEqual({
      value: null,
      unit: "QUOTE_RAW_PER_COMPLETED_CYCLE",
      sampleCount: 0,
      status: "NO_TRADES",
      definitionVersion: "STRATEGY_METRICS_V1",
    });
  });

  it("reports mean follower quote PnL over completed cycles", () => {
    const cycles: readonly CompletedFollowerRoundTrip[] = [
      {
        followerWallet: "follower-wallet",
        leaderWallet: "leader-wallet",
        tokenMint: "token-a",
        quoteMint: "SOL_NATIVE",
        openFillId: "open-a",
        closeFillId: "close-a",
        fillIds: ["open-a", "close-a"],
        entryCostQuoteRaw: 100n,
        proceedsQuoteRaw: 125n,
        realizedPnlQuoteRaw: 25n,
        openedAtMs: 1_000,
        closedAtMs: 2_000,
        holdingTimeMs: 1_000,
      },
      {
        followerWallet: "follower-wallet",
        leaderWallet: "leader-wallet",
        tokenMint: "token-b",
        quoteMint: "SOL_NATIVE",
        openFillId: "open-b",
        closeFillId: "close-b",
        fillIds: ["open-b", "close-b"],
        entryCostQuoteRaw: 100n,
        proceedsQuoteRaw: 95n,
        realizedPnlQuoteRaw: -5n,
        openedAtMs: 3_000,
        closedAtMs: 5_000,
        holdingTimeMs: 2_000,
      },
    ];

    expect(calculateStrategyMetrics(cycles, policy)).toMatchObject({
      netQuoteExpectancy: {
        value: "10",
        unit: "QUOTE_RAW_PER_COMPLETED_CYCLE",
        sampleCount: 2,
        status: "AVAILABLE",
        definitionVersion: "STRATEGY_METRICS_V1",
      },
    });
  });

  it("reports a negative follower quote PnL expectancy", () => {
    expect(
      calculateStrategyMetrics([cycle(-25n), cycle(5n)], policy)
        .netQuoteExpectancy,
    ).toMatchObject({
      value: "-10",
      sampleCount: 2,
      status: "AVAILABLE",
    });
  });

  it("reports zero follower quote PnL expectancy", () => {
    expect(
      calculateStrategyMetrics([cycle(5n), cycle(-5n)], policy)
        .netQuoteExpectancy,
    ).toMatchObject({
      value: "0",
      sampleCount: 2,
      status: "AVAILABLE",
    });
  });

  it("formats non-divisible expectancy to 18 decimal places toward zero", () => {
    expect(
      calculateStrategyMetrics([cycle(10n), cycle(0n), cycle(0n)], policy)
        .netQuoteExpectancy.value,
    ).toBe("3.333333333333333333");
  });

  it("preserves expectancy precision beyond Number.MAX_SAFE_INTEGER", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(900_719_925_474_099_312_345_678_901_234_567_890n),
          cycle(900_719_925_474_099_312_345_678_901_234_567_892n),
        ],
        policy,
      ).netQuoteExpectancy.value,
    ).toBe("900719925474099312345678901234567891");
  });

  it("fails closed when completed cycles mix quote mints", () => {
    expect(() =>
      calculateStrategyMetrics(
        [cycle(10n), cycle(20n, { quoteMint: "USDC" })],
        policy,
      ),
    ).toThrowError("CROSS_QUOTE_RAW_PNL");
  });

  it("fails closed when completed cycles mix leader wallets", () => {
    expect(() =>
      calculateStrategyMetrics(
        [cycle(10n), cycle(20n, { leaderWallet: "other-leader" })],
        policy,
      ),
    ).toThrowError("CROSS_LEADER_METRIC_BUCKET");
  });

  it("counts breakeven cycles in the win-rate denominator", () => {
    expect(
      calculateStrategyMetrics(
        [cycle(10n), cycle(-5n), cycle(0n), cycle(20n)],
        policy,
      ),
    ).toMatchObject({
      winRate: {
        value: "0.5",
        unit: "RATIO",
        sampleCount: 4,
        status: "AVAILABLE",
        definitionVersion: "STRATEGY_METRICS_V1",
        wins: 2,
        losses: 1,
        breakevens: 1,
      },
    });
  });

  it("reports a win rate of one when all completed cycles win", () => {
    expect(
      calculateStrategyMetrics([cycle(1n), cycle(10n), cycle(100n)], policy)
        .winRate,
    ).toMatchObject({
      value: "1",
      sampleCount: 3,
      status: "AVAILABLE",
      wins: 3,
      losses: 0,
      breakevens: 0,
    });
  });

  it("reports a win rate of zero when all completed cycles lose", () => {
    expect(
      calculateStrategyMetrics([cycle(-1n), cycle(-10n), cycle(-100n)], policy)
        .winRate,
    ).toMatchObject({
      value: "0",
      sampleCount: 3,
      status: "AVAILABLE",
      wins: 0,
      losses: 3,
      breakevens: 0,
    });
  });

  it("counts all-breakeven completed cycles in a zero win rate", () => {
    expect(
      calculateStrategyMetrics([cycle(0n), cycle(0n), cycle(0n)], policy)
        .winRate,
    ).toMatchObject({
      value: "0",
      sampleCount: 3,
      status: "AVAILABLE",
      wins: 0,
      losses: 0,
      breakevens: 3,
    });
  });

  it("reports no win rate for an empty completed-cycle sample", () => {
    expect(calculateStrategyMetrics([], policy).winRate).toEqual({
      value: null,
      unit: "RATIO",
      sampleCount: 0,
      status: "NO_TRADES",
      definitionVersion: "STRATEGY_METRICS_V1",
      wins: 0,
      losses: 0,
      breakevens: 0,
    });
  });

  it("reports win rate for one completed winning cycle", () => {
    expect(
      calculateStrategyMetrics([cycle(10n)], policy).winRate,
    ).toMatchObject({
      value: "1",
      sampleCount: 1,
      status: "AVAILABLE",
      wins: 1,
      losses: 0,
      breakevens: 0,
    });
  });

  it("uses the shared deterministic decimal contract for win rate", () => {
    expect(
      calculateStrategyMetrics([cycle(10n), cycle(-5n), cycle(0n)], policy)
        .winRate.value,
    ).toBe("0.333333333333333333");
  });

  it("reports gross realized profit divided by absolute gross realized loss", () => {
    expect(
      calculateStrategyMetrics(
        [cycle(25n), cycle(-10n), cycle(0n), cycle(5n), cycle(-5n)],
        policy,
      ).profitFactor,
    ).toEqual({
      value: "2",
      unit: "RATIO",
      sampleCount: 5,
      status: "AVAILABLE",
      definitionVersion: "STRATEGY_METRICS_V1",
      grossProfitRaw: "30",
      grossLossRaw: "15",
    });
  });

  it("reports a zero profit factor when completed cycles have no wins", () => {
    expect(
      calculateStrategyMetrics([cycle(-20n), cycle(-5n), cycle(0n)], policy)
        .profitFactor,
    ).toEqual({
      value: "0",
      unit: "RATIO",
      sampleCount: 3,
      status: "AVAILABLE",
      definitionVersion: "STRATEGY_METRICS_V1",
      grossProfitRaw: "0",
      grossLossRaw: "25",
    });
  });

  it("reports no realized result when every completed cycle breaks even", () => {
    expect(
      calculateStrategyMetrics([cycle(0n), cycle(0n)], policy).profitFactor,
    ).toEqual({
      value: null,
      unit: "RATIO",
      sampleCount: 2,
      status: "NO_REALIZED_RESULT",
      definitionVersion: "STRATEGY_METRICS_V1",
      grossProfitRaw: "0",
      grossLossRaw: "0",
    });
  });

  it("reports no profit factor trades for an empty completed-cycle sample", () => {
    expect(calculateStrategyMetrics([], policy).profitFactor).toEqual({
      value: null,
      unit: "RATIO",
      sampleCount: 0,
      status: "NO_TRADES",
      definitionVersion: "STRATEGY_METRICS_V1",
      grossProfitRaw: "0",
      grossLossRaw: "0",
    });
  });

  it("reports no losses for a single winning completed cycle", () => {
    expect(calculateStrategyMetrics([cycle(10n)], policy).profitFactor).toEqual(
      {
        value: null,
        unit: "RATIO",
        sampleCount: 1,
        status: "NO_LOSSES",
        definitionVersion: "STRATEGY_METRICS_V1",
        grossProfitRaw: "10",
        grossLossRaw: "0",
      },
    );
  });

  it("reports a zero profit factor for a single losing completed cycle", () => {
    expect(
      calculateStrategyMetrics([cycle(-10n)], policy).profitFactor,
    ).toEqual({
      value: "0",
      unit: "RATIO",
      sampleCount: 1,
      status: "AVAILABLE",
      definitionVersion: "STRATEGY_METRICS_V1",
      grossProfitRaw: "0",
      grossLossRaw: "10",
    });
  });

  it("formats a non-divisible profit factor to 18 places toward zero", () => {
    expect(
      calculateStrategyMetrics([cycle(10n), cycle(-3n)], policy).profitFactor
        .value,
    ).toBe("3.333333333333333333");
  });

  it("trims fractional zeros when a tiny ratio truncates to zero", () => {
    expect(
      calculateStrategyMetrics(
        [cycle(1n), cycle(-10_000_000_000_000_000_000n)],
        policy,
      ).profitFactor.value,
    ).toBe("0");
  });

  it("preserves profit-factor precision for very large bigint totals", () => {
    const grossLossRaw = 900_719_925_474_099_312_345_678_901_234_567_890n;
    const grossProfitRaw = 2_251_799_813_685_248_280_864_197_253_086_419_725n;

    expect(
      calculateStrategyMetrics(
        [cycle(grossProfitRaw), cycle(-grossLossRaw)],
        policy,
      ).profitFactor,
    ).toEqual({
      value: "2.5",
      unit: "RATIO",
      sampleCount: 2,
      status: "AVAILABLE",
      definitionVersion: "STRATEGY_METRICS_V1",
      grossProfitRaw: "2251799813685248280864197253086419725",
      grossLossRaw: "900719925474099312345678901234567890",
    });
  });

  it("reports the largest peak-to-trough realized PnL drawdown by close time", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(-15n, { closedAtMs: 4_000, closeFillId: "close-d" }),
          cycle(10n, { closedAtMs: 1_000, closeFillId: "close-a" }),
          cycle(30n, { closedAtMs: 5_000, closeFillId: "close-e" }),
          cycle(20n, { closedAtMs: 2_000, closeFillId: "close-b" }),
          cycle(-10n, { closedAtMs: 3_000, closeFillId: "close-c" }),
        ],
        policy,
      ).realizedPnlDrawdown,
    ).toEqual({
      value: "25",
      unit: "RAW_QUOTE",
      sampleCount: 5,
      status: "AVAILABLE",
      definitionVersion: "STRATEGY_METRICS_V1",
    });
  });

  it("reports zero realized PnL drawdown for monotonic gains", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(5n, { closedAtMs: 1_000 }),
          cycle(10n, { closedAtMs: 2_000 }),
          cycle(20n, { closedAtMs: 3_000 }),
        ],
        policy,
      ).realizedPnlDrawdown.value,
    ).toBe("0");
  });

  it("reports peak-to-trough drawdown through a full recovery", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(20n, { closedAtMs: 1_000 }),
          cycle(-8n, { closedAtMs: 2_000 }),
          cycle(-12n, { closedAtMs: 3_000 }),
          cycle(20n, { closedAtMs: 4_000 }),
        ],
        policy,
      ).realizedPnlDrawdown.value,
    ).toBe("20");
  });

  it("reports the largest rather than the last realized PnL drawdown", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(30n, { closedAtMs: 1_000 }),
          cycle(-20n, { closedAtMs: 2_000 }),
          cycle(25n, { closedAtMs: 3_000 }),
          cycle(-5n, { closedAtMs: 4_000 }),
        ],
        policy,
      ).realizedPnlDrawdown.value,
    ).toBe("20");
  });

  it("measures an all-loss sequence from an initial zero peak", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(-5n, { closedAtMs: 1_000 }),
          cycle(-10n, { closedAtMs: 2_000 }),
          cycle(-20n, { closedAtMs: 3_000 }),
        ],
        policy,
      ).realizedPnlDrawdown.value,
    ).toBe("35");
  });

  it("reports no realized PnL drawdown for an empty completed-cycle sample", () => {
    expect(calculateStrategyMetrics([], policy).realizedPnlDrawdown).toEqual({
      value: null,
      unit: "RAW_QUOTE",
      sampleCount: 0,
      status: "NO_TRADES",
      definitionVersion: "STRATEGY_METRICS_V1",
    });
  });

  it("reports zero realized PnL drawdown for a single winning cycle", () => {
    expect(
      calculateStrategyMetrics([cycle(10n)], policy).realizedPnlDrawdown,
    ).toMatchObject({
      value: "0",
      sampleCount: 1,
      status: "AVAILABLE",
    });
  });

  it("measures a single losing cycle from an initial zero peak", () => {
    expect(
      calculateStrategyMetrics([cycle(-10n)], policy).realizedPnlDrawdown,
    ).toMatchObject({
      value: "10",
      sampleCount: 1,
      status: "AVAILABLE",
    });
  });

  it("preserves realized PnL drawdown precision for very large bigint values", () => {
    const peakGainRaw = 900_719_925_474_099_312_345_678_901_234_567_890n;
    const lossRaw = 1_801_439_850_948_198_624_691_357_802_469_135_780n;

    expect(
      calculateStrategyMetrics(
        [
          cycle(peakGainRaw, { closedAtMs: 1_000 }),
          cycle(-lossRaw, { closedAtMs: 2_000 }),
        ],
        policy,
      ).realizedPnlDrawdown.value,
    ).toBe("1801439850948198624691357802469135780");
  });

  it("uses close-fill evidence to deterministically order equal close times", () => {
    const closeA = cycle(-90n, {
      closedAtMs: 1_000,
      closeFillId: "close-a",
    });
    const closeB = cycle(100n, {
      closedAtMs: 1_000,
      closeFillId: "close-b",
    });
    const closeC = cycle(-30n, {
      closedAtMs: 1_000,
      closeFillId: "close-c",
    });
    const closeD = cycle(10n, {
      closedAtMs: 1_000,
      closeFillId: "close-d",
    });

    const firstOrdering = calculateStrategyMetrics(
      [closeB, closeA, closeD, closeC],
      policy,
    ).realizedPnlDrawdown.value;
    const secondOrdering = calculateStrategyMetrics(
      [closeA, closeB, closeC, closeD],
      policy,
    ).realizedPnlDrawdown.value;

    expect([firstOrdering, secondOrdering]).toEqual(["90", "90"]);
  });

  it("reports average and median holding time from completed lifecycle boundaries", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(0n, { openedAtMs: 1_000, closedAtMs: 4_000 }),
          cycle(0n, { openedAtMs: 2_000, closedAtMs: 7_000 }),
          cycle(0n, { openedAtMs: 3_000, closedAtMs: 10_000 }),
        ],
        policy,
      ).holdingTime,
    ).toEqual({
      count: 3,
      averageMs: 5_000,
      medianMs: 5_000,
      sampleCount: 3,
      status: "AVAILABLE",
      definitionVersion: "STRATEGY_METRICS_V1",
    });
  });

  it("reports one lifecycle duration as both average and median", () => {
    expect(
      calculateStrategyMetrics(
        [cycle(0n, { openedAtMs: 1_000, closedAtMs: 5_200 })],
        policy,
      ).holdingTime,
    ).toMatchObject({
      count: 1,
      averageMs: 4_200,
      medianMs: 4_200,
      sampleCount: 1,
      status: "AVAILABLE",
    });
  });

  it("averages the two middle durations for an even holding-time sample", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(0n, { openedAtMs: 1_000, closedAtMs: 2_000 }),
          cycle(0n, { openedAtMs: 2_000, closedAtMs: 5_000 }),
          cycle(0n, { openedAtMs: 3_000, closedAtMs: 8_000 }),
          cycle(0n, { openedAtMs: 4_000, closedAtMs: 13_000 }),
        ],
        policy,
      ).holdingTime.medianMs,
    ).toBe(4_000);
  });

  it("preserves a half-millisecond even median without rounding", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(0n, { openedAtMs: 1_000, closedAtMs: 2_000 }),
          cycle(0n, { openedAtMs: 2_000, closedAtMs: 3_001 }),
        ],
        policy,
      ).holdingTime,
    ).toMatchObject({
      averageMs: 1_000.5,
      medianMs: 1_000.5,
    });
  });

  it("calculates holding-time statistics independently of input order", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(0n, { openedAtMs: 4_000, closedAtMs: 13_000 }),
          cycle(0n, { openedAtMs: 1_000, closedAtMs: 2_000 }),
          cycle(0n, { openedAtMs: 3_000, closedAtMs: 8_000 }),
          cycle(0n, { openedAtMs: 2_000, closedAtMs: 5_000 }),
        ],
        policy,
      ).holdingTime,
    ).toMatchObject({
      averageMs: 4_500,
      medianMs: 4_000,
    });
  });

  it("accepts a zero-duration completed lifecycle", () => {
    expect(
      calculateStrategyMetrics(
        [cycle(0n, { openedAtMs: 5_000, closedAtMs: 5_000 })],
        policy,
      ).holdingTime,
    ).toMatchObject({
      count: 1,
      averageMs: 0,
      medianMs: 0,
      status: "AVAILABLE",
    });
  });

  it("fails closed when a completed lifecycle has negative holding time", () => {
    expect(() =>
      calculateStrategyMetrics(
        [cycle(0n, { openedAtMs: 5_000, closedAtMs: 4_000 })],
        policy,
      ),
    ).toThrowError("INVALID_HOLDING_TIME");
  });

  it("reports no holding-time statistics for an empty completed-cycle sample", () => {
    expect(calculateStrategyMetrics([], policy).holdingTime).toEqual({
      count: 0,
      averageMs: null,
      medianMs: null,
      sampleCount: 0,
      status: "NO_TRADES",
      definitionVersion: "STRATEGY_METRICS_V1",
    });
  });

  it("requires lifecycle boundary timestamps in the completed-cycle contract", () => {
    expectTypeOf<
      CompletedFollowerRoundTrip["openedAtMs"]
    >().toEqualTypeOf<number>();
    expectTypeOf<
      CompletedFollowerRoundTrip["closedAtMs"]
    >().toEqualTypeOf<number>();
  });

  it("preserves holding time for large safe-integer timestamps", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(0n, {
            openedAtMs: 8_000_000_000_000_000,
            closedAtMs: 8_000_000_001_234_567,
          }),
        ],
        policy,
      ).holdingTime,
    ).toMatchObject({
      averageMs: 1_234_567,
      medianMs: 1_234_567,
    });
  });

  it("fails closed when a lifecycle timestamp is not a safe integer", () => {
    const unsafeTimestampMs = Number.MAX_SAFE_INTEGER + 1;

    expect(() =>
      calculateStrategyMetrics(
        [
          cycle(0n, {
            openedAtMs: unsafeTimestampMs,
            closedAtMs: unsafeTimestampMs,
          }),
        ],
        policy,
      ),
    ).toThrowError("INVALID_HOLDING_TIME");
  });

  it("fails closed when safe timestamps produce an unsafe duration", () => {
    expect(() =>
      calculateStrategyMetrics(
        [
          cycle(0n, {
            openedAtMs: -Number.MAX_SAFE_INTEGER,
            closedAtMs: Number.MAX_SAFE_INTEGER,
          }),
        ],
        policy,
      ),
    ).toThrowError("INVALID_HOLDING_TIME");
  });

  it("fails closed when the holding-time sum exceeds safe integer range", () => {
    expect(() =>
      calculateStrategyMetrics(
        [
          cycle(0n, {
            openedAtMs: 0,
            closedAtMs: Number.MAX_SAFE_INTEGER,
          }),
          cycle(0n, {
            openedAtMs: 0,
            closedAtMs: Number.MAX_SAFE_INTEGER,
          }),
        ],
        policy,
      ),
    ).toThrowError("INVALID_HOLDING_TIME");
  });

  it("reports the best completed trade contribution to positive total realized PnL", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(60n, { closeFillId: "close-a" }),
          cycle(30n, { closeFillId: "close-b" }),
          cycle(10n, { closeFillId: "close-c" }),
        ],
        policy,
      ).bestTradeContribution,
    ).toEqual({
      value: "0.6",
      unit: "RATIO",
      sampleCount: 3,
      status: "AVAILABLE",
      definitionVersion: "STRATEGY_METRICS_V1",
      totalRealizedPnlRaw: "100",
      bestTradeRealizedPnlRaw: "60",
      bestTradeCloseFillId: "close-a",
    });
  });

  it("allows best-trade contribution above one when losses offset profit", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(100n, { closeFillId: "close-win" }),
          cycle(-40n, { closeFillId: "close-loss" }),
        ],
        policy,
      ).bestTradeContribution,
    ).toMatchObject({
      value: "1.666666666666666666",
      status: "AVAILABLE",
      totalRealizedPnlRaw: "60",
      bestTradeRealizedPnlRaw: "100",
      bestTradeCloseFillId: "close-win",
    });
  });

  it("uses close-fill evidence to deterministically attribute equal best trades", () => {
    const closeA = cycle(60n, { closeFillId: "close-a" });
    const closeB = cycle(60n, { closeFillId: "close-b" });
    const loss = cycle(-20n, { closeFillId: "close-loss" });

    const firstOrdering = calculateStrategyMetrics(
      [closeB, closeA, loss],
      policy,
    ).bestTradeContribution.bestTradeCloseFillId;
    const secondOrdering = calculateStrategyMetrics(
      [closeA, closeB, loss],
      policy,
    ).bestTradeContribution.bestTradeCloseFillId;

    expect([firstOrdering, secondOrdering]).toEqual(["close-a", "close-a"]);
  });

  it("withholds best-trade contribution when total realized PnL is zero", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(10n, { closeFillId: "close-win" }),
          cycle(-10n, { closeFillId: "close-loss" }),
        ],
        policy,
      ).bestTradeContribution,
    ).toEqual({
      value: null,
      unit: "RATIO",
      sampleCount: 2,
      status: "NON_POSITIVE_TOTAL_PNL",
      definitionVersion: "STRATEGY_METRICS_V1",
      totalRealizedPnlRaw: "0",
      bestTradeRealizedPnlRaw: "10",
      bestTradeCloseFillId: "close-win",
    });
  });

  it("withholds best-trade contribution when total realized PnL is negative", () => {
    expect(
      calculateStrategyMetrics([cycle(10n), cycle(-20n)], policy)
        .bestTradeContribution,
    ).toMatchObject({
      value: null,
      status: "NON_POSITIVE_TOTAL_PNL",
      totalRealizedPnlRaw: "-10",
      bestTradeRealizedPnlRaw: "10",
    });
  });

  it("reports no best-trade contribution for an empty completed-cycle sample", () => {
    expect(calculateStrategyMetrics([], policy).bestTradeContribution).toEqual({
      value: null,
      unit: "RATIO",
      sampleCount: 0,
      status: "NO_TRADES",
      definitionVersion: "STRATEGY_METRICS_V1",
      totalRealizedPnlRaw: "0",
      bestTradeRealizedPnlRaw: null,
      bestTradeCloseFillId: null,
    });
  });

  it("preserves best-trade contribution precision for very large bigint PnL", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(4_503_599_627_370_496_561_728_394_506_172_839_450n, {
            closeFillId: "close-win",
          }),
          cycle(-1_801_439_850_948_198_624_691_357_802_469_135_780n, {
            closeFillId: "close-loss",
          }),
        ],
        policy,
      ).bestTradeContribution,
    ).toMatchObject({
      value: "1.666666666666666666",
      totalRealizedPnlRaw: "2702159776422297937037036703703703670",
      bestTradeRealizedPnlRaw: "4503599627370496561728394506172839450",
    });
  });

  it("reports the best token contribution from token-level net realized PnL", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(40n, { tokenMint: "TOKEN_A" }),
          cycle(30n, { tokenMint: "TOKEN_A" }),
          cycle(-10n, { tokenMint: "TOKEN_A" }),
          cycle(25n, { tokenMint: "TOKEN_B" }),
          cycle(15n, { tokenMint: "TOKEN_B" }),
        ],
        policy,
      ).bestTokenContribution,
    ).toEqual({
      value: "0.6",
      unit: "RATIO",
      sampleCount: 5,
      status: "AVAILABLE",
      definitionVersion: "STRATEGY_METRICS_V1",
      totalRealizedPnlRaw: "100",
      bestTokenRealizedPnlRaw: "60",
      bestTokenMint: "TOKEN_A",
    });
  });

  it("aggregates multiple completed trades for the same token", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(40n, { tokenMint: "TOKEN_A" }),
          cycle(30n, { tokenMint: "TOKEN_A" }),
          cycle(60n, { tokenMint: "TOKEN_B" }),
        ],
        policy,
      ).bestTokenContribution,
    ).toMatchObject({
      value: "0.538461538461538461",
      totalRealizedPnlRaw: "130",
      bestTokenRealizedPnlRaw: "70",
      bestTokenMint: "TOKEN_A",
    });
  });

  it("selects the largest aggregate realized PnL across multiple tokens", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(20n, { tokenMint: "TOKEN_A" }),
          cycle(50n, { tokenMint: "TOKEN_B" }),
          cycle(30n, { tokenMint: "TOKEN_C" }),
        ],
        policy,
      ).bestTokenContribution,
    ).toMatchObject({
      value: "0.5",
      bestTokenRealizedPnlRaw: "50",
      bestTokenMint: "TOKEN_B",
    });
  });

  it("includes internal losses in each token realized PnL aggregate", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(100n, { tokenMint: "TOKEN_A" }),
          cycle(-40n, { tokenMint: "TOKEN_A" }),
          cycle(55n, { tokenMint: "TOKEN_B" }),
        ],
        policy,
      ).bestTokenContribution,
    ).toMatchObject({
      value: "0.521739130434782608",
      totalRealizedPnlRaw: "115",
      bestTokenRealizedPnlRaw: "60",
      bestTokenMint: "TOKEN_A",
    });
  });

  it("allows best-token contribution above one when another token loses", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(120n, { tokenMint: "TOKEN_A" }),
          cycle(-20n, { tokenMint: "TOKEN_B" }),
        ],
        policy,
      ).bestTokenContribution,
    ).toMatchObject({
      value: "1.2",
      status: "AVAILABLE",
      totalRealizedPnlRaw: "100",
      bestTokenRealizedPnlRaw: "120",
      bestTokenMint: "TOKEN_A",
    });
  });

  it("uses token mint to deterministically attribute equal token aggregates", () => {
    const tokenA = cycle(50n, { tokenMint: "TOKEN_A" });
    const tokenB = cycle(50n, { tokenMint: "TOKEN_B" });

    const firstOrdering = calculateStrategyMetrics([tokenB, tokenA], policy)
      .bestTokenContribution.bestTokenMint;
    const secondOrdering = calculateStrategyMetrics([tokenA, tokenB], policy)
      .bestTokenContribution.bestTokenMint;

    expect([firstOrdering, secondOrdering]).toEqual(["TOKEN_A", "TOKEN_A"]);
  });

  it("withholds best-token contribution when total realized PnL is zero", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(10n, { tokenMint: "TOKEN_A" }),
          cycle(-10n, { tokenMint: "TOKEN_B" }),
        ],
        policy,
      ).bestTokenContribution,
    ).toMatchObject({
      value: null,
      sampleCount: 2,
      status: "NON_POSITIVE_TOTAL_PNL",
      totalRealizedPnlRaw: "0",
      bestTokenRealizedPnlRaw: "10",
      bestTokenMint: "TOKEN_A",
    });
  });

  it("withholds best-token contribution when total realized PnL is negative", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(10n, { tokenMint: "TOKEN_A" }),
          cycle(-20n, { tokenMint: "TOKEN_B" }),
        ],
        policy,
      ).bestTokenContribution,
    ).toMatchObject({
      value: null,
      status: "NON_POSITIVE_TOTAL_PNL",
      totalRealizedPnlRaw: "-10",
      bestTokenRealizedPnlRaw: "10",
      bestTokenMint: "TOKEN_A",
    });
  });

  it("reports no best-token contribution for an empty completed-cycle sample", () => {
    expect(calculateStrategyMetrics([], policy).bestTokenContribution).toEqual({
      value: null,
      unit: "RATIO",
      sampleCount: 0,
      status: "NO_TRADES",
      definitionVersion: "STRATEGY_METRICS_V1",
      totalRealizedPnlRaw: "0",
      bestTokenRealizedPnlRaw: null,
      bestTokenMint: null,
    });
  });

  it("preserves best-token contribution precision for very large bigint PnL", () => {
    expect(
      calculateStrategyMetrics(
        [
          cycle(4_503_599_627_370_496_561_728_394_506_172_839_450n, {
            tokenMint: "TOKEN_A",
          }),
          cycle(-1_801_439_850_948_198_624_691_357_802_469_135_780n, {
            tokenMint: "TOKEN_B",
          }),
        ],
        policy,
      ).bestTokenContribution,
    ).toMatchObject({
      value: "1.666666666666666666",
      totalRealizedPnlRaw: "2702159776422297937037036703703703670",
      bestTokenRealizedPnlRaw: "4503599627370496561728394506172839450",
      bestTokenMint: "TOKEN_A",
    });
  });
});
