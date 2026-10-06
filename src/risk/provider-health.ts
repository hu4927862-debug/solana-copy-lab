export type ProviderHealthState = "HEALTHY" | "DEGRADED" | "COOLDOWN";

export interface ProviderHealthPolicy {
  readonly burstThreshold: number;
  readonly burstWindowMs: number;
  readonly cooldownMs: number;
  readonly halfOpenProbe: number;
}

export interface ProviderHealthSnapshot {
  readonly health: ProviderHealthState;
  readonly failures429: number;
  readonly cooldownUntilMs?: number;
  readonly probesRemaining: number;
}

export interface ProviderHealthStateSnapshot {
  readonly failures: readonly number[];
  readonly state: ProviderHealthState;
  readonly cooldownUntilMs: number;
  readonly probesRemaining: number;
  readonly halfOpenStarted: boolean;
}

export class ProviderHealthTracker {
  private readonly failures: number[] = [];
  private state: ProviderHealthState = "HEALTHY";
  private cooldownUntilMs = 0;
  private probesRemaining = 0;
  private halfOpenStarted = false;

  constructor(
    private readonly policy: ProviderHealthPolicy,
    restored?: ProviderHealthStateSnapshot,
  ) {
    if (restored) {
      if (
        !["HEALTHY", "DEGRADED", "COOLDOWN"].includes(restored.state) ||
        restored.failures.some(
          (timestamp) => !Number.isSafeInteger(timestamp) || timestamp < 0,
        ) ||
        !Number.isSafeInteger(restored.cooldownUntilMs) ||
        restored.cooldownUntilMs < 0 ||
        !Number.isSafeInteger(restored.probesRemaining) ||
        restored.probesRemaining < 0
      ) {
        throw new Error("INVALID_PROVIDER_HEALTH_STATE");
      }
      this.failures.push(...restored.failures);
      this.state = restored.state;
      this.cooldownUntilMs = restored.cooldownUntilMs;
      this.probesRemaining = restored.probesRemaining;
      this.halfOpenStarted = restored.halfOpenStarted;
    }
  }

  exportState(): ProviderHealthStateSnapshot {
    return {
      failures: [...this.failures],
      state: this.state,
      cooldownUntilMs: this.cooldownUntilMs,
      probesRemaining: this.probesRemaining,
      halfOpenStarted: this.halfOpenStarted,
    };
  }

  recordFailure(nowMs: number, status?: number): void {
    if (status !== 429) {
      if (this.state === "COOLDOWN") {
        this.cooldownUntilMs = nowMs + this.policy.cooldownMs;
        this.probesRemaining = 0;
        this.halfOpenStarted = false;
      }
      return;
    }
    this.failures.push(nowMs);
    while (
      this.failures.length > 0 &&
      this.failures[0]! < nowMs - this.policy.burstWindowMs
    ) {
      this.failures.shift();
    }
    if (this.failures.length >= this.policy.burstThreshold) {
      this.state = "COOLDOWN";
      this.cooldownUntilMs = nowMs + this.policy.cooldownMs;
      this.probesRemaining = 0;
      this.halfOpenStarted = false;
    }
  }

  recordSuccess(nowMs: number): void {
    if (this.state === "COOLDOWN" && nowMs >= this.cooldownUntilMs) {
      this.state = "HEALTHY";
      this.probesRemaining = 0;
      this.halfOpenStarted = false;
      this.failures.length = 0;
    }
  }

  canAttempt(side: "BUY" | "SELL", nowMs: number): boolean {
    if (this.state !== "COOLDOWN") return true;
    if (side === "SELL") return true;
    if (nowMs < this.cooldownUntilMs) return false;
    if (!this.halfOpenStarted) {
      this.halfOpenStarted = true;
      this.probesRemaining = this.policy.halfOpenProbe;
    }
    if (this.probesRemaining <= 0) return false;
    this.probesRemaining -= 1;
    return true;
  }

  snapshot(nowMs: number): ProviderHealthSnapshot {
    if (this.state === "COOLDOWN" && nowMs >= this.cooldownUntilMs) {
      return {
        health: "COOLDOWN",
        failures429: this.failures.length,
        cooldownUntilMs: this.cooldownUntilMs,
        probesRemaining: this.probesRemaining || this.policy.halfOpenProbe,
      };
    }
    return {
      health: this.state,
      failures429: this.failures.length,
      ...(this.state === "COOLDOWN"
        ? { cooldownUntilMs: this.cooldownUntilMs }
        : {}),
      probesRemaining: this.probesRemaining,
    };
  }
}
