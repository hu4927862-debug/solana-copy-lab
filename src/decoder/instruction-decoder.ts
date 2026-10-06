import { createHash } from "node:crypto";
import bs58 from "bs58";
import { PROGRAM_IDS } from "./program-registry.js";

function anchorDiscriminator(name: string): string {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8)
    .toString("hex");
}

const ANCHOR_INSTRUCTIONS = new Map<string, Map<string, string>>([
  [
    PROGRAM_IDS.JUPITER_V6,
    new Map(
      [
        "route",
        "route_with_token_ledger",
        "shared_accounts_route",
        "shared_accounts_route_with_token_ledger",
        "exact_out_route",
        "shared_accounts_exact_out_route",
      ].map((name) => [anchorDiscriminator(name), name]),
    ),
  ],
  [
    PROGRAM_IDS.PUMP_FUN,
    new Map(
      ["buy", "sell", "buy_exact_sol_in"].map((name) => [
        anchorDiscriminator(name),
        name,
      ]),
    ),
  ],
  [
    PROGRAM_IDS.PUMP_SWAP,
    new Map(
      ["buy", "sell", "buy_exact_quote_in", "sell_exact_quote_in"].map(
        (name) => [anchorDiscriminator(name), name],
      ),
    ),
  ],
]);

function decodeData(data: string): Uint8Array | undefined {
  try {
    if (data.startsWith("base64:")) return Buffer.from(data.slice(7), "base64");
    if (data.startsWith("base58:")) return bs58.decode(data.slice(7));
    return Buffer.from(data, "base64");
  } catch {
    return undefined;
  }
}

export function decodeKnownInstruction(
  programId: string,
  data?: string,
): string | undefined {
  if (!data) return undefined;
  const bytes = decodeData(data);
  if (!bytes || bytes.length === 0) return undefined;
  if (programId === PROGRAM_IDS.RAYDIUM_AMM_V4) {
    if (bytes[0] === 9) return "swapBaseIn";
    if (bytes[0] === 11) return "swapBaseOut";
    return undefined;
  }
  if (bytes.length < 8) return undefined;
  return ANCHOR_INSTRUCTIONS.get(programId)?.get(
    Buffer.from(bytes.subarray(0, 8)).toString("hex"),
  );
}
