export type TimestampPrecision =
  "MILLISECOND" | "SECOND" | "SLOT_ONLY" | "UNKNOWN";
export type SourceTimestampProvenance = "CHAIN_BLOCK_TIME" | "UNKNOWN";

export interface AuthoritativeSourceTimestamp {
  readonly valueMs: number;
  readonly provenance: "CHAIN_BLOCK_TIME";
  readonly precision: "MILLISECOND" | "SECOND";
}

export interface ClockReading {
  readonly wallMs: number;
  readonly monotonicNs: bigint;
}

export interface Clock {
  now(): ClockReading;
}

export class SystemClock implements Clock {
  now(): ClockReading {
    return { wallMs: Date.now(), monotonicNs: process.hrtime.bigint() };
  }
}

export interface TradeTimestamps {
  readonly sourceTimestampMs?: number;
  readonly sourceTimestampPrecision: TimestampPrecision;
  readonly sourceTimestampProvenance: SourceTimestampProvenance;
  readonly streamReceivedTimestampMs: number;
  readonly detectedTimestampMs: number;
  readonly decodedTimestampMs: number;
  readonly orderCreatedTimestampMs?: number;
  readonly orderSignedTimestampMs?: number;
  readonly orderSentTimestampMs?: number;
  readonly confirmedTimestampMs?: number;
  readonly finalizedTimestampMs?: number;
  readonly streamReceivedMonotonicNs: bigint;
  readonly detectedMonotonicNs: bigint;
  readonly decodedMonotonicNs: bigint;
  readonly orderCreatedMonotonicNs?: bigint;
  readonly orderSentMonotonicNs?: bigint;
  readonly confirmedMonotonicNs?: bigint;
}
