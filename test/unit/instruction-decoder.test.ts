import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeKnownInstruction } from "../../src/decoder/instruction-decoder.js";
import { PROGRAM_IDS } from "../../src/decoder/program-registry.js";
import { SwapClassifier } from "../../src/decoder/swap-classifier.js";
import { TransactionNormalizer } from "../../src/decoder/transaction-normalizer.js";
import { LEADER_A, MAINNET_FIXTURES } from "../fixtures/mainnet-fixtures.js";
import { envelope } from "../helpers/envelope.js";
import { TestClock } from "../helpers/test-clock.js";

function anchorData(name: string): string {
  return `base64:${createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8)
    .toString("base64")}`;
}

describe("known Solana swap instruction decoder", () => {
  it.each([
    [PROGRAM_IDS.JUPITER_V6, "route"],
    [PROGRAM_IDS.JUPITER_V6, "shared_accounts_route"],
    [PROGRAM_IDS.PUMP_FUN, "buy"],
    [PROGRAM_IDS.PUMP_FUN, "sell"],
    [PROGRAM_IDS.PUMP_SWAP, "buy_exact_quote_in"],
    [PROGRAM_IDS.PUMP_SWAP, "sell"],
  ])("decodes %s %s Anchor discriminator", (program, name) => {
    expect(decodeKnownInstruction(program, anchorData(name))).toBe(name);
  });

  it("decodes only the Raydium v4 swap opcodes", () => {
    expect(
      decodeKnownInstruction(
        PROGRAM_IDS.RAYDIUM_AMM_V4,
        `base64:${Buffer.from([9]).toString("base64")}`,
      ),
    ).toBe("swapBaseIn");
    expect(
      decodeKnownInstruction(
        PROGRAM_IDS.RAYDIUM_AMM_V4,
        `base64:${Buffer.from([11]).toString("base64")}`,
      ),
    ).toBe("swapBaseOut");
    expect(
      decodeKnownInstruction(
        PROGRAM_IDS.RAYDIUM_AMM_V4,
        `base64:${Buffer.from([3]).toString("base64")}`,
      ),
    ).toBeUndefined();
  });

  it("provides strict swap evidence for unparsed Yellowstone instructions", () => {
    const raw = structuredClone(MAINNET_FIXTURES.jupiterBuy);
    delete raw.innerInstructions[0]!.parsedType;
    raw.innerInstructions[0]!.data = anchorData("route");
    raw.logMessages = [];
    const result = new SwapClassifier().classify(
      new TransactionNormalizer(new TestClock()).normalize(envelope(raw)),
      LEADER_A,
    );
    expect(result.accepted).toBe(true);
  });
});
