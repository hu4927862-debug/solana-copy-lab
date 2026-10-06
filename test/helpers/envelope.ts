import type { StreamTransactionEnvelope } from "../../src/domain/ports.js";
import type { RawTransaction } from "../../src/decoder/raw-transaction.js";

export function envelope(raw: RawTransaction): StreamTransactionEnvelope {
  return {
    signature: raw.signature,
    slot: BigInt(raw.slot),
    ...(raw.sourceTimestampMs === undefined
      ? {}
      : { sourceTimestampMs: raw.sourceTimestampMs }),
    sourceTimestampPrecision: raw.sourceTimestampPrecision,
    sourceTimestampProvenance: raw.sourceTimestampProvenance,
    streamReceivedTimestampMs:
      (raw.sourceTimestampMs ?? 1_730_000_000_000) + 50,
    streamReceivedMonotonicNs: 900_000_000n,
    payload: raw,
  };
}
