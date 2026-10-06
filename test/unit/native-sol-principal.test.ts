import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import { RawTransactionSchema } from "../../src/decoder/raw-transaction.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { CopyEngine } from "../../src/copy/copy-engine.js";
import { envelope } from "../helpers/envelope.js";
import { TestClock } from "../helpers/test-clock.js";
import { FOLLOWER } from "../fixtures/mainnet-fixtures.js";

const raw = RawTransactionSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../fixtures/v5-native-sol-with-rent.json", import.meta.url),
      "utf8",
    ),
  ),
);
const leader = raw.feePayer;
describe("native SOL swap principal", () => {
  it("fails closed if the WSOL transfer proof is missing despite a wallet delta", () => {
    const incomplete = { ...raw, innerInstructions: [] };
    expect(
      new SwapClassifier().classify(
        new TransactionNormalizer(new TestClock()).normalize(
          envelope(incomplete),
        ),
        leader,
      ),
    ).toMatchObject({
      accepted: false,
      code: "NATIVE_SOL_PRINCIPAL_UNAVAILABLE",
    });
  });
  it("keeps principal independent of additional wallet costs", () => {
    const expensive = {
      ...raw,
      postBalances: raw.postBalances.map((value, i) =>
        i === 0 ? (BigInt(value) - 2_000_000n).toString() : value,
      ),
    };
    const result = new SwapClassifier().classify(
      new TransactionNormalizer(new TestClock()).normalize(envelope(expensive)),
      leader,
    );
    expect(result.accepted && result.event.quote.raw).toBe(5_000_000n);
  });
  it("excludes account rent and unrelated SOL transfer from V5 BUY sizing", () => {
    const result = new SwapClassifier().classify(
      new TransactionNormalizer(new TestClock()).normalize(envelope(raw)),
      leader,
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error(result.code);
    expect(result.event.quote.raw).toBe(5_000_000n);
    expect(
      new CopyEngine().decide(result.event, {
        followerWallet: FOLLOWER,
        copyRatioBps: 1000,
        mode: "PAPER",
      }).theoreticalQuoteRaw,
    ).toBe(500_000n);
  });
});
