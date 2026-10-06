import { describe, expect, it } from "vitest";
import { ProviderHealthTracker } from "../../src/risk/provider-health.js";

describe("ProviderHealthTracker", () => {
  it("opens a configurable cooldown after a 429 burst and permits reducing SELL", () => {
    const tracker = new ProviderHealthTracker({
      burstThreshold: 3,
      burstWindowMs: 60_000,
      cooldownMs: 30_000,
      halfOpenProbe: 1,
    });
    tracker.recordFailure(1_000, 429);
    tracker.recordFailure(2_000, 429);
    expect(tracker.snapshot(2_000).health).toBe("HEALTHY");
    tracker.recordFailure(3_000, 429);
    expect(tracker.snapshot(3_000).health).toBe("COOLDOWN");
    expect(tracker.canAttempt("BUY", 3_001)).toBe(false);
    expect(tracker.canAttempt("SELL", 3_001)).toBe(true);
    expect(tracker.canAttempt("BUY", 33_000)).toBe(true);
    expect(tracker.canAttempt("BUY", 33_000)).toBe(false);
  });

  it("restores an active cooldown deterministically after restart", () => {
    const policy = {
      burstThreshold: 3,
      burstWindowMs: 60_000,
      cooldownMs: 30_000,
      halfOpenProbe: 1,
    };
    const first = new ProviderHealthTracker(policy);
    first.recordFailure(1_000, 429);
    first.recordFailure(2_000, 429);
    first.recordFailure(3_000, 429);
    const reopened = new ProviderHealthTracker(policy, first.exportState());
    expect(reopened.canAttempt("BUY", 3_001)).toBe(false);
    expect(reopened.snapshot(3_001).failures429).toBe(3);
  });

  it("reopens cooldown when a half-open probe fails", () => {
    const tracker = new ProviderHealthTracker({
      burstThreshold: 3,
      burstWindowMs: 60_000,
      cooldownMs: 30_000,
      halfOpenProbe: 1,
    });
    tracker.recordFailure(1_000, 429);
    tracker.recordFailure(2_000, 429);
    tracker.recordFailure(3_000, 429);
    expect(tracker.canAttempt("BUY", 33_000)).toBe(true);
    tracker.recordFailure(33_001, 503);
    expect(tracker.canAttempt("BUY", 33_002)).toBe(false);
    expect(tracker.canAttempt("BUY", 63_001)).toBe(true);
  });

  it("fails closed on malformed persisted provider state", () => {
    expect(
      () =>
        new ProviderHealthTracker(
          {
            burstThreshold: 3,
            burstWindowMs: 60_000,
            cooldownMs: 30_000,
            halfOpenProbe: 1,
          },
          {
            failures: [],
            state: "INVALID" as "HEALTHY",
            cooldownUntilMs: 0,
            probesRemaining: 0,
            halfOpenStarted: false,
          },
        ),
    ).toThrow("INVALID_PROVIDER_HEALTH_STATE");
  });
});
