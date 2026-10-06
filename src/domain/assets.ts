export const NATIVE_SOL = "SOL_NATIVE" as const;
export const WSOL_MINT = "So11111111111111111111111111111111111111112" as const;
export const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as const;
export const USDT_MINT =
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as const;

export function canonicalDomainQuoteMint(mint: string): string {
  return mint === WSOL_MINT ? NATIVE_SOL : mint;
}

export const QUOTE_ASSETS = new Set<string>([
  NATIVE_SOL,
  WSOL_MINT,
  USDC_MINT,
  USDT_MINT,
]);

export interface AssetAmount {
  readonly mint: string;
  readonly raw: bigint;
  readonly decimals: number;
}

export interface AssetDelta extends AssetAmount {
  readonly owner: string;
  readonly preRaw: bigint;
  readonly postRaw: bigint;
}
