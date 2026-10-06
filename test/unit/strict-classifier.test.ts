import { describe, expect, it } from "vitest";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import type { RawTransaction } from "../../src/decoder/raw-transaction.js";
import { envelope } from "../helpers/envelope.js";
import { TestClock } from "../helpers/test-clock.js";
import { LEADER_A, MAINNET_FIXTURES } from "../fixtures/mainnet-fixtures.js";

function classify(raw: RawTransaction) {
  return new SwapClassifier().classify(
    new TransactionNormalizer(new TestClock()).normalize(envelope(raw)),
    LEADER_A,
  );
}

describe("strict classifier fail-closed rules", () => {
  it("accepts basic Token-2022 balance accounting but rejects unsupported extensions", () => {
    const supported = structuredClone(MAINNET_FIXTURES.jupiterBuy);
    supported.preTokenBalances[0]!.tokenProgram = "TOKEN_2022";
    supported.postTokenBalances[0]!.tokenProgram = "TOKEN_2022";
    expect(classify(supported).accepted).toBe(true);
    const unsupported = structuredClone(supported);
    unsupported.postTokenBalances[0]!.unsupportedExtension = true;
    const result = classify(unsupported);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.code).toBe("UNSUPPORTED_TOKEN_2022");
  });

  it("rejects missing decimals, failed transactions, and a non-signing leader", () => {
    const missingDecimals = structuredClone(MAINNET_FIXTURES.jupiterBuy);
    missingDecimals.preTokenBalances[0]!.decimals = null;
    missingDecimals.postTokenBalances[0]!.decimals = null;
    const failed = structuredClone(MAINNET_FIXTURES.jupiterBuy);
    failed.success = false;
    failed.error = "InstructionError";
    const notSigner = structuredClone(MAINNET_FIXTURES.jupiterBuy);
    notSigner.accountKeys[0]!.signer = false;
    const cases = [
      [missingDecimals, "MISSING_DECIMALS"],
      [failed, "TRANSACTION_FAILED"],
      [notSigner, "LEADER_NOT_SIGNER"],
    ] as const;
    for (const [fixture, code] of cases) {
      const result = classify(fixture);
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.code).toBe(code);
    }
  });
});
