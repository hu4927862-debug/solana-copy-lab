import type { TradeTimestamps } from "../domain/time.js";

function nsToMs(value: bigint): number {
  return Number(value) / 1_000_000;
}

export interface LatencySample {
  readonly networkLatencyMs?: number;
  readonly detectLatencyMs: number;
  readonly decodeLatencyMs: number;
  readonly decisionLatencyMs?: number;
  readonly executionLatencyMs?: number;
  readonly localTotalLatencyMs?: number;
}

export function calculateLatency(timestamps: TradeTimestamps): LatencySample {
  const networkLatencyMs =
    timestamps.sourceTimestampPrecision === "MILLISECOND" &&
    timestamps.sourceTimestampMs !== undefined
      ? timestamps.streamReceivedTimestampMs - timestamps.sourceTimestampMs
      : undefined;
  const detectLatencyMs = nsToMs(
    timestamps.detectedMonotonicNs - timestamps.streamReceivedMonotonicNs,
  );
  const decodeLatencyMs = nsToMs(
    timestamps.decodedMonotonicNs - timestamps.detectedMonotonicNs,
  );
  const decisionLatencyMs =
    timestamps.orderCreatedMonotonicNs === undefined
      ? undefined
      : nsToMs(
          timestamps.orderCreatedMonotonicNs - timestamps.decodedMonotonicNs,
        );
  const executionLatencyMs =
    timestamps.orderSentMonotonicNs === undefined ||
    timestamps.confirmedMonotonicNs === undefined
      ? undefined
      : nsToMs(
          timestamps.confirmedMonotonicNs - timestamps.orderSentMonotonicNs,
        );
  const localTotalLatencyMs =
    timestamps.confirmedMonotonicNs === undefined
      ? undefined
      : nsToMs(
          timestamps.confirmedMonotonicNs -
            timestamps.streamReceivedMonotonicNs,
        );
  return {
    ...(networkLatencyMs === undefined ? {} : { networkLatencyMs }),
    detectLatencyMs,
    decodeLatencyMs,
    ...(decisionLatencyMs === undefined ? {} : { decisionLatencyMs }),
    ...(executionLatencyMs === undefined ? {} : { executionLatencyMs }),
    ...(localTotalLatencyMs === undefined ? {} : { localTotalLatencyMs }),
  };
}

export interface Distribution {
  readonly count: number;
  readonly average: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export function distribution(samples: readonly number[]): Distribution {
  if (samples.length === 0)
    return { count: 0, average: 0, p50: 0, p95: 0, p99: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
  return {
    count: sorted.length,
    average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}
