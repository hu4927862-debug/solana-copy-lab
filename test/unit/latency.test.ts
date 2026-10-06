import { describe, expect, it } from "vitest";
import { calculateLatency, distribution } from "../../src/telemetry/latency.js";

describe("latency telemetry", () => {
  it("uses monotonic time locally and calculates network latency only for millisecond sources", () => {
    const sample = calculateLatency({
      sourceTimestampMs: 900,
      sourceTimestampPrecision: "MILLISECOND",
      sourceTimestampProvenance: "CHAIN_BLOCK_TIME",
      streamReceivedTimestampMs: 1000,
      detectedTimestampMs: 1001,
      decodedTimestampMs: 1003,
      streamReceivedMonotonicNs: 1_000_000_000n,
      detectedMonotonicNs: 1_001_000_000n,
      decodedMonotonicNs: 1_003_000_000n,
      orderCreatedMonotonicNs: 1_004_000_000n,
      orderSentMonotonicNs: 1_005_000_000n,
      confirmedMonotonicNs: 1_010_000_000n,
    });
    expect(sample).toEqual({
      networkLatencyMs: 100,
      detectLatencyMs: 1,
      decodeLatencyMs: 2,
      decisionLatencyMs: 1,
      executionLatencyMs: 5,
      localTotalLatencyMs: 10,
    });
    const noNetwork = calculateLatency({
      sourceTimestampPrecision: "SLOT_ONLY",
      sourceTimestampProvenance: "UNKNOWN",
      streamReceivedTimestampMs: 1000,
      detectedTimestampMs: 1000,
      decodedTimestampMs: 1000,
      streamReceivedMonotonicNs: 1n,
      detectedMonotonicNs: 2n,
      decodedMonotonicNs: 3n,
    });
    expect(noNetwork.networkLatencyMs).toBeUndefined();
  });

  it("calculates average and P50/P95/P99", () => {
    const stats = distribution(
      Array.from({ length: 100 }, (_value, index) => index + 1),
    );
    expect(stats.average).toBe(50.5);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(95);
    expect(stats.p99).toBe(99);
  });
});
