import { Decimal } from "decimal.js";

import type { JupiterPriceImpactEvidence } from "../domain/execution.js";

/** Swap V2 contract checked 2026-09-07. Keep provider signs; risk caps magnitude. */
export function normalizeJupiterPriceImpact(
  raw: JupiterPriceImpactEvidence["raw"],
): JupiterPriceImpactEvidence {
  const common = {
    contractVersion: "JUPITER_SWAP_V2_IMPACT_V1",
    unit: "PERCENTAGE_POINTS",
    raw,
  } as const;
  if (raw.priceImpact === undefined && raw.priceImpactPct === undefined)
    return { ...common, status: "MISSING" };
  const parse = (value: unknown): Decimal => {
    if (
      (typeof value !== "string" && typeof value !== "number") ||
      !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(String(value))
    )
      throw new Error("INVALID_IMPACT");
    const result = new Decimal(value);
    if (!result.isFinite()) throw new Error("INVALID_IMPACT");
    return result;
  };
  try {
    const points =
      raw.priceImpact === undefined ? undefined : parse(raw.priceImpact);
    const ratioPoints =
      raw.priceImpactPct === undefined
        ? undefined
        : parse(raw.priceImpactPct).mul(100);
    // These fields can differ at binary floating-point rounding precision.
    if (
      points !== undefined &&
      ratioPoints !== undefined &&
      points.minus(ratioPoints).abs().gt("0.000000001")
    )
      return { ...common, status: "CONFLICT" };
    return {
      ...common,
      status: "AVAILABLE",
      normalizedPct: (points ?? ratioPoints)!.toString(),
    };
  } catch {
    return { ...common, status: "INVALID" };
  }
}
