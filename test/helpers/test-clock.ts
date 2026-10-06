import type { Clock, ClockReading } from "../../src/domain/time.js";

export class TestClock implements Clock {
  private wallMs: number;
  private monotonicNs: bigint;

  constructor(wallMs = 1_730_000_000_200, monotonicNs = 1_000_000_000n) {
    this.wallMs = wallMs;
    this.monotonicNs = monotonicNs;
  }

  now(): ClockReading {
    const reading = { wallMs: this.wallMs, monotonicNs: this.monotonicNs };
    this.wallMs += 1;
    this.monotonicNs += 1_000_000n;
    return reading;
  }
}
