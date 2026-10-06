import { z } from "zod";
import type { RiskPolicy } from "./risk-engine.js";

const PositiveRawSchema = z
  .string()
  .regex(/^[0-9]+$/)
  .refine((value) => BigInt(value) > 0n, "Expected a positive raw amount");
const PercentagePointSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const RawBucketSchema = z
  .record(z.string().min(1), PositiveRawSchema)
  .refine((value) => Object.keys(value).length > 0, "Expected a quote policy");
const PriceImpactBucketSchema = z
  .record(z.string().min(1), PercentagePointSchema)
  .refine((value) => Object.keys(value).length > 0, "Expected a quote policy");

const RiskPolicySchema = z
  .object({
    policyVersion: z.string().min(1),
    maxSingleTradeRawByQuoteMint: RawBucketSchema,
    maxTokenExposureRawByQuoteMint: RawBucketSchema,
    maxPortfolioExposureRawByQuoteMint: RawBucketSchema,
    dailyRealizedLossLimitRawByQuoteMint: RawBucketSchema,
    maxIntentAgeMs: z.number().int().positive(),
    maxQuoteAgeMs: z.number().int().positive(),
    maxBuyPriceImpactPctByQuoteMint: PriceImpactBucketSchema,
    maxSellPriceImpactPctByQuoteMint: PriceImpactBucketSchema,
    requireRouteEvidence: z.literal(true),
    provider429BurstThreshold: z.number().int().positive(),
    providerBurstWindowMs: z.number().int().positive(),
    providerCooldownMs: z.number().int().positive(),
    halfOpenProbe: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = Object.keys(value.maxSingleTradeRawByQuoteMint).sort();
    const buckets = [
      value.maxTokenExposureRawByQuoteMint,
      value.maxPortfolioExposureRawByQuoteMint,
      value.dailyRealizedLossLimitRawByQuoteMint,
      value.maxBuyPriceImpactPctByQuoteMint,
      value.maxSellPriceImpactPctByQuoteMint,
    ];
    if (
      buckets.some(
        (bucket) =>
          Object.keys(bucket).sort().join("\0") !== expected.join("\0"),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Risk policy quote-mint buckets must have identical keys",
      });
    }
  });

function toBigIntBucket(
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, bigint>> {
  return Object.fromEntries(
    Object.entries(values).map(([mint, value]) => [mint, BigInt(value)]),
  );
}

export function parseRiskPolicy(input: unknown): RiskPolicy {
  const parsed = RiskPolicySchema.parse(input);
  return {
    ...parsed,
    maxSingleTradeRawByQuoteMint: toBigIntBucket(
      parsed.maxSingleTradeRawByQuoteMint,
    ),
    maxTokenExposureRawByQuoteMint: toBigIntBucket(
      parsed.maxTokenExposureRawByQuoteMint,
    ),
    maxPortfolioExposureRawByQuoteMint: toBigIntBucket(
      parsed.maxPortfolioExposureRawByQuoteMint,
    ),
    dailyRealizedLossLimitRawByQuoteMint: toBigIntBucket(
      parsed.dailyRealizedLossLimitRawByQuoteMint,
    ),
  };
}
