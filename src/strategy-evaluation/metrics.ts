import type { CompletedFollowerRoundTrip } from "./round-trips.js";

export interface StrategyMetricsPolicy {
  readonly definitionVersion: string;
  readonly minimumCompletedCycles: number;
}

export interface StrategyMetricResult {
  readonly value: string | null;
  readonly unit: string;
  readonly sampleCount: number;
  readonly status:
    | "AVAILABLE"
    | "NO_TRADES"
    | "NO_LOSSES"
    | "NO_REALIZED_RESULT"
    | "NON_POSITIVE_TOTAL_PNL";
  readonly definitionVersion: string;
}

export interface WinRateMetricResult extends StrategyMetricResult {
  readonly wins: number;
  readonly losses: number;
  readonly breakevens: number;
}

export interface ProfitFactorMetricResult extends StrategyMetricResult {
  readonly grossProfitRaw: string;
  readonly grossLossRaw: string;
}

export interface HoldingTimeMetricResult {
  readonly count: number;
  readonly averageMs: number | null;
  readonly medianMs: number | null;
  readonly sampleCount: number;
  readonly status: "AVAILABLE" | "NO_TRADES";
  readonly definitionVersion: string;
}

export interface BestTradeContributionMetricResult extends StrategyMetricResult {
  readonly totalRealizedPnlRaw: string;
  readonly bestTradeRealizedPnlRaw: string | null;
  readonly bestTradeCloseFillId: string | null;
}

export interface BestTokenContributionMetricResult extends StrategyMetricResult {
  readonly totalRealizedPnlRaw: string;
  readonly bestTokenRealizedPnlRaw: string | null;
  readonly bestTokenMint: string | null;
}

export interface StrategyMetrics {
  readonly netQuoteExpectancy: StrategyMetricResult;
  readonly winRate: WinRateMetricResult;
  readonly profitFactor: ProfitFactorMetricResult;
  readonly realizedPnlDrawdown: StrategyMetricResult;
  readonly holdingTime: HoldingTimeMetricResult;
  readonly bestTradeContribution: BestTradeContributionMetricResult;
  readonly bestTokenContribution: BestTokenContributionMetricResult;
}

function divideBigIntToDecimalString(
  numerator: bigint,
  denominator: bigint,
): string {
  const negative = numerator < 0n;
  const absoluteNumerator = negative ? -numerator : numerator;
  const integerPart = absoluteNumerator / denominator;
  let remainder = absoluteNumerator % denominator;

  if (remainder === 0n) {
    return `${negative ? "-" : ""}${integerPart}`;
  }

  let fractionalPart = "";
  for (let digit = 0; digit < 18 && remainder !== 0n; digit += 1) {
    remainder *= 10n;
    fractionalPart += (remainder / denominator).toString();
    remainder %= denominator;
  }

  fractionalPart = fractionalPart.replace(/0+$/, "");
  const sign =
    negative && (integerPart !== 0n || fractionalPart !== "") ? "-" : "";
  return fractionalPart === ""
    ? `${sign}${integerPart}`
    : `${sign}${integerPart}.${fractionalPart}`;
}

export function calculateNetQuoteExpectancyMetric(
  totalRealizedPnlRaw: bigint,
  completedCycleCount: number,
  definitionVersion: string,
): StrategyMetricResult {
  if (completedCycleCount === 0) {
    return {
      value: null,
      unit: "QUOTE_RAW_PER_COMPLETED_CYCLE",
      sampleCount: 0,
      status: "NO_TRADES",
      definitionVersion,
    };
  }

  return {
    value: divideBigIntToDecimalString(
      totalRealizedPnlRaw,
      BigInt(completedCycleCount),
    ),
    unit: "QUOTE_RAW_PER_COMPLETED_CYCLE",
    sampleCount: completedCycleCount,
    status: "AVAILABLE",
    definitionVersion,
  };
}

export function calculateStrategyMetrics(
  cycles: readonly CompletedFollowerRoundTrip[],
  policy: StrategyMetricsPolicy,
): StrategyMetrics {
  if (cycles.length === 0) {
    return {
      netQuoteExpectancy: calculateNetQuoteExpectancyMetric(
        0n,
        0,
        policy.definitionVersion,
      ),
      winRate: {
        value: null,
        unit: "RATIO",
        sampleCount: 0,
        status: "NO_TRADES",
        definitionVersion: policy.definitionVersion,
        wins: 0,
        losses: 0,
        breakevens: 0,
      },
      profitFactor: {
        value: null,
        unit: "RATIO",
        sampleCount: 0,
        status: "NO_TRADES",
        definitionVersion: policy.definitionVersion,
        grossProfitRaw: "0",
        grossLossRaw: "0",
      },
      realizedPnlDrawdown: {
        value: null,
        unit: "RAW_QUOTE",
        sampleCount: 0,
        status: "NO_TRADES",
        definitionVersion: policy.definitionVersion,
      },
      holdingTime: {
        count: 0,
        averageMs: null,
        medianMs: null,
        sampleCount: 0,
        status: "NO_TRADES",
        definitionVersion: policy.definitionVersion,
      },
      bestTradeContribution: {
        value: null,
        unit: "RATIO",
        sampleCount: 0,
        status: "NO_TRADES",
        definitionVersion: policy.definitionVersion,
        totalRealizedPnlRaw: "0",
        bestTradeRealizedPnlRaw: null,
        bestTradeCloseFillId: null,
      },
      bestTokenContribution: {
        value: null,
        unit: "RATIO",
        sampleCount: 0,
        status: "NO_TRADES",
        definitionVersion: policy.definitionVersion,
        totalRealizedPnlRaw: "0",
        bestTokenRealizedPnlRaw: null,
        bestTokenMint: null,
      },
    };
  }

  const quoteMint = cycles[0]!.quoteMint;
  const leaderWallet = cycles[0]!.leaderWallet;
  if (cycles.some((cycle) => cycle.quoteMint !== quoteMint)) {
    throw new Error("CROSS_QUOTE_RAW_PNL");
  }
  if (cycles.some((cycle) => cycle.leaderWallet !== leaderWallet)) {
    throw new Error("CROSS_LEADER_METRIC_BUCKET");
  }

  const totalRealizedPnlRaw = cycles.reduce(
    (total, cycle) => total + cycle.realizedPnlQuoteRaw,
    0n,
  );
  const sampleCount = cycles.length;
  const divisor = BigInt(sampleCount);
  const wins = cycles.filter((cycle) => cycle.realizedPnlQuoteRaw > 0n).length;
  const losses = cycles.filter(
    (cycle) => cycle.realizedPnlQuoteRaw < 0n,
  ).length;
  const breakevens = sampleCount - wins - losses;
  const grossProfitRaw = cycles.reduce(
    (total, cycle) =>
      cycle.realizedPnlQuoteRaw > 0n
        ? total + cycle.realizedPnlQuoteRaw
        : total,
    0n,
  );
  const grossLossRaw = cycles.reduce(
    (total, cycle) =>
      cycle.realizedPnlQuoteRaw < 0n
        ? total - cycle.realizedPnlQuoteRaw
        : total,
    0n,
  );
  let cumulativeRealizedPnlRaw = 0n;
  let runningPeakRaw = 0n;
  let maxDrawdownRaw = 0n;
  for (const cycle of [...cycles].sort((left, right) => {
    const closeTimeOrder = left.closedAtMs - right.closedAtMs;
    if (closeTimeOrder !== 0) return closeTimeOrder;
    if (left.closeFillId < right.closeFillId) return -1;
    if (left.closeFillId > right.closeFillId) return 1;
    return 0;
  })) {
    cumulativeRealizedPnlRaw += cycle.realizedPnlQuoteRaw;
    if (cumulativeRealizedPnlRaw > runningPeakRaw) {
      runningPeakRaw = cumulativeRealizedPnlRaw;
    }
    const drawdownRaw = runningPeakRaw - cumulativeRealizedPnlRaw;
    if (drawdownRaw > maxDrawdownRaw) {
      maxDrawdownRaw = drawdownRaw;
    }
  }
  const holdingTimesMs = cycles
    .map((cycle) => {
      if (
        !Number.isSafeInteger(cycle.openedAtMs) ||
        !Number.isSafeInteger(cycle.closedAtMs)
      ) {
        throw new Error("INVALID_HOLDING_TIME");
      }
      const durationMs = cycle.closedAtMs - cycle.openedAtMs;
      if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
        throw new Error("INVALID_HOLDING_TIME");
      }
      return durationMs;
    })
    .sort((left, right) => left - right);
  const totalHoldingTimeMs = holdingTimesMs.reduce((total, durationMs) => {
    if (durationMs > Number.MAX_SAFE_INTEGER - total) {
      throw new Error("INVALID_HOLDING_TIME");
    }
    return total + durationMs;
  }, 0);
  const medianIndex = Math.floor(sampleCount / 2);
  const medianHoldingTimeMs =
    sampleCount % 2 === 0
      ? (holdingTimesMs[medianIndex - 1]! + holdingTimesMs[medianIndex]!) / 2
      : holdingTimesMs[medianIndex]!;
  let bestTrade = cycles[0]!;
  for (const cycle of cycles.slice(1)) {
    if (
      cycle.realizedPnlQuoteRaw > bestTrade.realizedPnlQuoteRaw ||
      (cycle.realizedPnlQuoteRaw === bestTrade.realizedPnlQuoteRaw &&
        cycle.closeFillId < bestTrade.closeFillId)
    ) {
      bestTrade = cycle;
    }
  }
  const tokenRealizedPnlRaw = new Map<string, bigint>();
  for (const cycle of cycles) {
    tokenRealizedPnlRaw.set(
      cycle.tokenMint,
      (tokenRealizedPnlRaw.get(cycle.tokenMint) ?? 0n) +
        cycle.realizedPnlQuoteRaw,
    );
  }
  let bestToken = [...tokenRealizedPnlRaw.entries()][0]!;
  for (const token of [...tokenRealizedPnlRaw.entries()].slice(1)) {
    if (
      token[1] > bestToken[1] ||
      (token[1] === bestToken[1] && token[0] < bestToken[0])
    ) {
      bestToken = token;
    }
  }

  return {
    netQuoteExpectancy: calculateNetQuoteExpectancyMetric(
      totalRealizedPnlRaw,
      sampleCount,
      policy.definitionVersion,
    ),
    winRate: {
      value: divideBigIntToDecimalString(BigInt(wins), divisor),
      unit: "RATIO",
      sampleCount,
      status: "AVAILABLE",
      definitionVersion: policy.definitionVersion,
      wins,
      losses,
      breakevens,
    },
    profitFactor: {
      value:
        grossLossRaw === 0n
          ? null
          : divideBigIntToDecimalString(grossProfitRaw, grossLossRaw),
      unit: "RATIO",
      sampleCount,
      status:
        grossLossRaw !== 0n
          ? "AVAILABLE"
          : grossProfitRaw === 0n
            ? "NO_REALIZED_RESULT"
            : "NO_LOSSES",
      definitionVersion: policy.definitionVersion,
      grossProfitRaw: grossProfitRaw.toString(),
      grossLossRaw: grossLossRaw.toString(),
    },
    realizedPnlDrawdown: {
      value: maxDrawdownRaw.toString(),
      unit: "RAW_QUOTE",
      sampleCount,
      status: "AVAILABLE",
      definitionVersion: policy.definitionVersion,
    },
    holdingTime: {
      count: sampleCount,
      averageMs: totalHoldingTimeMs / sampleCount,
      medianMs: medianHoldingTimeMs,
      sampleCount,
      status: "AVAILABLE",
      definitionVersion: policy.definitionVersion,
    },
    bestTradeContribution: {
      value:
        totalRealizedPnlRaw > 0n
          ? divideBigIntToDecimalString(
              bestTrade.realizedPnlQuoteRaw,
              totalRealizedPnlRaw,
            )
          : null,
      unit: "RATIO",
      sampleCount,
      status: totalRealizedPnlRaw > 0n ? "AVAILABLE" : "NON_POSITIVE_TOTAL_PNL",
      definitionVersion: policy.definitionVersion,
      totalRealizedPnlRaw: totalRealizedPnlRaw.toString(),
      bestTradeRealizedPnlRaw: bestTrade.realizedPnlQuoteRaw.toString(),
      bestTradeCloseFillId: bestTrade.closeFillId,
    },
    bestTokenContribution: {
      value:
        totalRealizedPnlRaw > 0n
          ? divideBigIntToDecimalString(bestToken[1], totalRealizedPnlRaw)
          : null,
      unit: "RATIO",
      sampleCount,
      status: totalRealizedPnlRaw > 0n ? "AVAILABLE" : "NON_POSITIVE_TOTAL_PNL",
      definitionVersion: policy.definitionVersion,
      totalRealizedPnlRaw: totalRealizedPnlRaw.toString(),
      bestTokenRealizedPnlRaw: bestToken[1].toString(),
      bestTokenMint: bestToken[0],
    },
  };
}
