import { performance } from "node:perf_hooks";
import { TransactionNormalizer } from "../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../src/decoder/swap-classifier.js";
import { distribution } from "../src/telemetry/latency.js";
import { envelope } from "../test/helpers/envelope.js";
import { TestClock } from "../test/helpers/test-clock.js";
import {
  LEADER_A,
  MAINNET_FIXTURES,
} from "../test/fixtures/mainnet-fixtures.js";

const normalizer = new TransactionNormalizer(new TestClock());
const classifier = new SwapClassifier();
const fixture = envelope(MAINNET_FIXTURES.multiHopJupiter);
const iterations = 10_000;

for (let index = 0; index < 1_000; index += 1) {
  classifier.classify(normalizer.normalize(fixture), LEADER_A);
}

const decode: number[] = [];
const local: number[] = [];
for (let index = 0; index < iterations; index += 1) {
  const start = performance.now();
  const normalized = normalizer.normalize(fixture);
  const decoded = performance.now();
  const result = classifier.classify(normalized, LEADER_A);
  const finished = performance.now();
  if (!result.accepted) throw new Error(result.code);
  decode.push(decoded - start);
  local.push(finished - start);
}

process.stdout.write(
  `${JSON.stringify({ iterations, unit: "milliseconds", decode: distribution(decode), localProcessing: distribution(local) }, null, 2)}\n`,
);
