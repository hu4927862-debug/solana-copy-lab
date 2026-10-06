import assert from "node:assert/strict";
import type { RawTransaction } from "../src/decoder/raw-transaction.js";
import type { StreamTransactionEnvelope } from "../src/domain/ports.js";
import type { Clock } from "../src/domain/time.js";
import { TransactionNormalizer } from "../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../src/decoder/swap-classifier.js";
import { jsonStringify } from "../src/domain/json.js";
import {
  LEADER_A,
  MAINNET_FIXTURES,
} from "../test/fixtures/mainnet-fixtures.js";

// These times describe this SYNTHETIC fixture, not a historical receipt.
const observed = { wallMs: 1_730_000_000_150, monotonicNs: 900_000_000n };
const clock: Clock = {
  now: () => ({ wallMs: 1_730_000_000_200, monotonicNs: 1_000_000_000n }),
};

// Input is the provider-neutral RawTransaction contract, not unprocessed
// JSON-RPC output. Never infer asset ownership merely from the fee payer.
const raw: RawTransaction = MAINNET_FIXTURES.jupiterBuy;
const envelope: StreamTransactionEnvelope = {
  signature: raw.signature,
  slot: BigInt(raw.slot),
  ...(raw.sourceTimestampMs === undefined
    ? {}
    : { sourceTimestampMs: raw.sourceTimestampMs }),
  sourceTimestampPrecision: raw.sourceTimestampPrecision,
  sourceTimestampProvenance: raw.sourceTimestampProvenance,
  streamReceivedTimestampMs: observed.wallMs,
  streamReceivedMonotonicNs: observed.monotonicNs,
  payload: raw,
};

const result = new SwapClassifier().classify(
  new TransactionNormalizer(clock).normalize(envelope),
  LEADER_A,
);
if (!result.accepted) throw new Error(result.code);
assert.equal(result.event.side, "BUY");
assert.equal(result.event.token.raw, 2_000_000n);

process.stdout.write(
  `${jsonStringify(
    {
      evidence: "SYNTHETIC_OFFLINE_CLASSIFICATION",
      limitation:
        "Classification is not FOLLOW, token safety, execution qualification or funds authority.",
      result,
    },
    2,
  )}\n`,
);
