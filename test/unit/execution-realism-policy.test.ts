import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXECUTION_REALISM_DELAY_POLICY_VERSION,
  parseExecutionRealismDelayPolicy,
} from "../../src/research/execution-realism-policy.js";

const policyJson = readFileSync(
  resolve("config/research/execution-realism-delay-policy-v1.json"),
  "utf8",
);

describe("EXECUTION_REALISM_DELAY_POLICY_V1", () => {
  it("loads the frozen deterministic offsets and reference", () => {
    expect(parseExecutionRealismDelayPolicy(policyJson)).toEqual({
      policyVersion: EXECUTION_REALISM_DELAY_POLICY_VERSION,
      referenceTimestamp: "FIRST_SCHEMA_VALID_QUOTE_RESPONSE_TIMESTAMP",
      delayOffsetsMs: [3_000, 10_000],
      requestSemantics: "IDENTICAL_CANONICAL_EXACT_INPUT_NO_TAKER",
    });
  });

  it("rejects an altered policy instead of silently accepting new delays", () => {
    expect(() =>
      parseExecutionRealismDelayPolicy(policyJson.replace("10000", "12000")),
    ).toThrowError("DELAY_POLICY_IDENTITY_MISMATCH");
  });
});
