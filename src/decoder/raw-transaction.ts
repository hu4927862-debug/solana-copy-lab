import { z } from "zod";

const BigIntString = z.string().regex(/^-?\d+$/);

export const RawAccountKeySchema = z.object({
  address: z.string().min(32),
  signer: z.boolean(),
  writable: z.boolean(),
  source: z
    .enum(["MESSAGE", "LOOKUP_WRITABLE", "LOOKUP_READONLY"])
    .default("MESSAGE"),
});

export const RawInstructionSchema = z.object({
  programId: z.string().min(32),
  accounts: z.array(z.string()).default([]),
  data: z.string().optional(),
  parsedType: z.string().optional(),
  stackHeight: z.number().int().nonnegative().optional(),
});

export const RawTokenBalanceSchema = z.object({
  accountIndex: z.number().int().nonnegative(),
  mint: z.string().min(32),
  owner: z.string().min(32).optional(),
  rawAmount: BigIntString,
  decimals: z.number().int().min(0).max(255).nullable(),
  tokenProgram: z.enum(["TOKEN", "TOKEN_2022"]).default("TOKEN"),
  unsupportedExtension: z.boolean().default(false),
});

export const RawTransactionSchema = z.object({
  signature: z.string().min(32),
  slot: BigIntString,
  version: z.union([z.literal("legacy"), z.literal(0)]),
  success: z.boolean(),
  error: z.string().nullable().default(null),
  feeRaw: BigIntString,
  feePayer: z.string().min(32),
  accountKeys: z.array(RawAccountKeySchema),
  preBalances: z.array(BigIntString),
  postBalances: z.array(BigIntString),
  preTokenBalances: z.array(RawTokenBalanceSchema),
  postTokenBalances: z.array(RawTokenBalanceSchema),
  outerInstructions: z.array(RawInstructionSchema),
  innerInstructions: z.array(RawInstructionSchema),
  logMessages: z.array(z.string()),
  sourceTimestampMs: z.number().int().nonnegative().optional(),
  sourceTimestampPrecision: z
    .enum(["MILLISECOND", "SECOND", "SLOT_ONLY", "UNKNOWN"])
    .default("UNKNOWN"),
  sourceTimestampProvenance: z
    .enum(["CHAIN_BLOCK_TIME", "UNKNOWN"])
    .default("UNKNOWN"),
});

export type RawTransaction = z.infer<typeof RawTransactionSchema>;
export type RawInstruction = z.infer<typeof RawInstructionSchema>;
export type RawTokenBalance = z.infer<typeof RawTokenBalanceSchema>;
