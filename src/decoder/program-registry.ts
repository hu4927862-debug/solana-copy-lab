import type { DexName } from "../domain/trades.js";

export const PROGRAM_IDS = {
  JUPITER_V6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  RAYDIUM_AMM_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  PUMP_FUN: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PUMP_SWAP: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  SYSTEM: "11111111111111111111111111111111",
  TOKEN: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN_2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
} as const;

const DEX_BY_PROGRAM = new Map<string, DexName>([
  [PROGRAM_IDS.JUPITER_V6, "JUPITER"],
  [PROGRAM_IDS.RAYDIUM_AMM_V4, "RAYDIUM"],
  [PROGRAM_IDS.PUMP_FUN, "PUMP_FUN"],
  [PROGRAM_IDS.PUMP_SWAP, "PUMP_SWAP"],
]);

export function dexForProgram(programId: string): DexName | undefined {
  return DEX_BY_PROGRAM.get(programId);
}
