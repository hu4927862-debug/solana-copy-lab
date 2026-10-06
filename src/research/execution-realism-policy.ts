import { z } from "zod";

export const EXECUTION_REALISM_DELAY_POLICY_VERSION =
  "EXECUTION_REALISM_DELAY_POLICY_V1" as const;

const ExecutionRealismDelayPolicySchema = z
  .object({
    policyVersion: z.literal(EXECUTION_REALISM_DELAY_POLICY_VERSION),
    referenceTimestamp: z.literal(
      "FIRST_SCHEMA_VALID_QUOTE_RESPONSE_TIMESTAMP",
    ),
    delayOffsetsMs: z.tuple([z.literal(3_000), z.literal(10_000)]),
    requestSemantics: z.literal("IDENTICAL_CANONICAL_EXACT_INPUT_NO_TAKER"),
  })
  .strict();

export type ExecutionRealismDelayPolicy = z.infer<
  typeof ExecutionRealismDelayPolicySchema
>;

export function parseExecutionRealismDelayPolicy(
  canonicalJson: string,
): ExecutionRealismDelayPolicy {
  let value: unknown;
  try {
    value = JSON.parse(canonicalJson);
  } catch {
    throw new Error("DELAY_POLICY_IDENTITY_MISMATCH");
  }
  const parsed = ExecutionRealismDelayPolicySchema.safeParse(value);
  if (!parsed.success) throw new Error("DELAY_POLICY_IDENTITY_MISMATCH");
  return parsed.data;
}
