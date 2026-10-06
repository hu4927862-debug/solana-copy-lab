import { sealedProgramAttestation, sealedCurrentClmmProgramAttestation, validateProgramMetadata, type ClmmProgramAttestationReference } from "./program-attestation.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { address, getProgramDerivedAddress } from "@solana/kit";
import { WSOL_MINT, USDC_MINT } from "../domain/assets.js";
import { PROGRAM_IDS as P } from "../decoder/program-registry.js";
import { digest, DeliveryPolicySchema, ExecutionAssetSchema, MANUAL_EXECUTION_ASSET, type ExecutionAsset, type DeliveryPolicy } from "./protocol.js";

const RAYDIUM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const ALT_OWNER = "AddressLookupTab1e1111111111111111111111111";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const PINNED_PROGRAMS = {
  [P.JUPITER_V6]: {
    programData: "4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT",
    sha256: "a2a018f56440b193568ee224e565ddb3f724b181c8e16bbe59f8a3eb5bdc9b7f",
  },
  [RAYDIUM]: {
    programData: "HzD2cCXXT3UQNjMMY6kDv9w6gZ9qquSdfoGXrLL3LXx",
    sha256: "b3e4706f5fff2399862cb91c9ac07924d1ea8695c686dbe711938db944836ee1",
  },
} as const;

export interface RawAccount {
  space?: number;
  lamports?: number | string;
  owner: string;
  executable: boolean;
  data: readonly [string, string];
}
export interface AccountBatch {
  slot: number;
  keys: string[];
  values: (RawAccount | null)[];
}
/** Raw RPC facts, never a provider-expanded account or role assertion. */
export interface CpiSemanticEvidence {
  preparationCommitment?: "confirmed" | "finalized";
  schema: "NARROW_RAYDIUM_CLMM_V1" | "DIRECT_DAMM_V2_V1" | "EXACT_METEORA_DLMM_V1";
  transactionDigest: string;
  requestId: string;
  quoteContextSlot: number;
  alt: Record<string, { slot: number; account: RawAccount }>;
  accounts: AccountBatch;
  programData: AccountBatch;
  programAttestationDigest?: string;
  clmmProgramAttestationReference?: ClmmProgramAttestationReference;
}
export interface SemanticMessage {
  version: number | string;
  staticAccounts: readonly string[];
  header: {
    numSignerAccounts: number;
    numReadonlyNonSignerAccounts: number;
  };
  addressTableLookups?: readonly {
    lookupTableAddress: string;
    writableIndexes: readonly number[];
    readonlyIndexes: readonly number[];
  }[];
}
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const pub = (b: Buffer, o: number) => bs58.encode(b.subarray(o, o + 32));
const discriminator = (name: string) => hash(Buffer.from(`account:${name}`)).slice(0, 16);
const data = (a: RawAccount | null | undefined, owner: string, length: number, name?: string) => {
  if (!a || a.owner !== owner || a.executable || a.data?.[1] !== "base64")
    throw new Error("CPI_ACCOUNT_OWNER_OR_MISSING");
  const b = Buffer.from(a.data[0], "base64");
  if (b.length !== length || (name && b.subarray(0, 8).toString("hex") !== discriminator(name)))
    throw new Error("CPI_ACCOUNT_LAYOUT");
  return b;
};
const derive = async (...seeds: Buffer[]) => (await getProgramDerivedAddress({
  programAddress: address(RAYDIUM), seeds,
}))[0];
const seed = (s: string) => Buffer.from(s);
const keySeed = (s: string) => Buffer.from(bs58.decode(s));
const check = (ok: boolean, code: string) => { if (!ok) throw new Error(code); };

// Pinned Raydium tick_math.rs, ed1eb41519d5355755f7df52b43fa9610938b60b.
// Exact Q64 integer factors/rounding; this is not swap or order-matching math.
const Q64 = 1n << 64n, MAX_U128 = (1n << 128n) - 1n;
const TICK_PRICE_FACTORS = [
  0xfffcb933bd6fb800n, 0xfff97272373d4000n, 0xfff2e50f5f657000n,
  0xffe5caca7e10f000n, 0xffcb9843d60f7000n, 0xff973b41fa98e800n,
  0xff2ea16466c9b000n, 0xfe5dee046a9a3800n, 0xfcbe86c7900bb000n,
  0xf987a7253ac65800n, 0xf3392b0822bb6000n, 0xe7159475a2caf000n,
  0xd097f3bdfd2f2000n, 0xa9f746462d9f8000n, 0x70d869a156f31c00n,
  0x31be135f97ed3200n, 0x9aa508b5b85a500n, 0x5d6af8dedc582cn,
  0x2216e584f5fan,
] as const;
function sqrtAtTick(tick: number): bigint {
  check(Number.isInteger(tick) && tick >= -443636 && tick <= 443636, "CPI_LIMIT_ORDER_STATE_UNPROVEN");
  let ratio = Q64;
  for (let i = 0; i < TICK_PRICE_FACTORS.length; i++)
    if ((Math.abs(tick) & (1 << i)) !== 0) ratio = (ratio * TICK_PRICE_FACTORS[i]!) >> 64n;
  return tick > 0 ? MAX_U128 / ratio : ratio;
}
const u128 = (b: Buffer, at: number) => b.readBigUInt64LE(at) + (b.readBigUInt64LE(at + 8) << 64n);

// Current pinned pool_fee.rs::DynamicFeeInfo layout/validate_params only;
// never calculate swap fees or outputs here. Quote/minOut and exact wallet
// simulation remain the economic-result owners. Reserved bytes stay zero.
function validDynamicFeeState(b: Buffer): boolean {
  const at = 1096, spacing = b.readUInt16LE(235);
  const filter = b.readUInt16LE(at), decay = b.readUInt16LE(at + 2);
  const reduction = b.readUInt16LE(at + 4), control = b.readUInt32LE(at + 6);
  const maximum = b.readUInt32LE(at + 10), index = b.readInt32LE(at + 14);
  return spacing > 0 && filter > 0 && decay > filter && reduction > 0 && reduction < 10000 &&
    control > 0 && control < 100000 && BigInt(maximum) * BigInt(spacing) <= 0xffffffffn &&
    b.readUInt32LE(at + 18) <= maximum && b.readUInt32LE(at + 22) <= maximum &&
    index >= Math.floor(-443636 / spacing) && index <= Math.floor(443636 / spacing) &&
    b.subarray(at + 34, at + 80).every(x => x === 0);
}

/** Sufficient no-reach proof on the independently read pre-sign snapshot only.
 * Caller already verified the exact root input bytes and the complete directional
 * default-bitmap/PDA array sequence. No simulation or provider role assertion is
 * an input. A first order barrier may be ignored only when gross ExactIn is
 * strictly below a conservative LP-only input lower bound to that barrier.
 * This does not promise that mutable pool state remains unchanged at landing. */
function requireNoReachableLimitOrders(pool: Buffer, arrays: Buffer[], zeroForOne: boolean, inputRaw?: string): void {
  const hasOrders = arrays.some(b => Array.from({ length: 60 }, (_, i) => 44 + i * 168)
    .some(at => b.readBigUInt64LE(at + 124) !== 0n || b.readBigUInt64LE(at + 132) !== 0n));
  if (!hasOrders) return; // Preserve the inherited zero-order contract unchanged.
  check(typeof inputRaw === "string" && /^[1-9]\d*$/.test(inputRaw) &&
    BigInt(inputRaw) <= (1n << 64n) - 1n, "CPI_LIMIT_ORDER_AMOUNT_UNPROVEN");
  const spacing = pool.readUInt16LE(235), currentTick = pool.readInt32LE(269), price = u128(pool, 253);
  check(currentTick >= -443636 && currentTick < 443636 && price >= sqrtAtTick(currentTick) &&
    price <= sqrtAtTick(currentTick + 1), "CPI_LIMIT_ORDER_STATE_UNPROVEN");
  const ticks: { tick: number; net: bigint; orders: boolean }[] = [];
  for (const b of arrays) {
    const start = b.readInt32LE(40); let count = 0;
    for (let i = 0; i < 60; i++) {
      const at = 44 + i * 168, gross = u128(b, at + 20), encodedNet = u128(b, at + 4);
      const net = encodedNet >= (1n << 127n) ? encodedNet - (1n << 128n) : encodedNet;
      const orders = b.readBigUInt64LE(at + 124) !== 0n || b.readBigUInt64LE(at + 132) !== 0n;
      check((net < 0n ? -net : net) <= gross, "CPI_LIMIT_ORDER_STATE_UNPROVEN");
      if (gross === 0n && !orders) continue;
      count++;
      const tick = b.readInt32LE(at);
      check(tick === start + i * spacing && tick >= -443636 && tick <= 443636,
        "CPI_LIMIT_ORDER_STATE_UNPROVEN");
      if (zeroForOne ? tick <= currentTick : tick > currentTick) ticks.push({ tick, net, orders });
    }
    check(b[10124] === count && count > 0 && count <= 60, "CPI_LIMIT_ORDER_STATE_UNPROVEN");
  }
  ticks.sort((a, b) => zeroForOne ? b.tick - a.tick : a.tick - b.tick);
  let liquidity = u128(pool, 237), minimumLiquidity = liquidity;
  check(liquidity > 0n, "CPI_LIMIT_ORDER_STATE_UNPROVEN");
  for (const tick of ticks) {
    if (tick.orders) {
      const barrier = sqrtAtTick(tick.tick), distance = zeroForOne ? price - barrier : barrier - price;
      check(distance > 0n, "CPI_FUNCTION_LIMIT_ORDER_UNQUALIFIED");
      // Each true prefix interval has L >= Lmin. Ignoring nonnegative fees
      // and flooring the telescoped constant-Lmin input cost only lowers it.
      const bound = zeroForOne ? minimumLiquidity * Q64 * distance / (price * barrier) :
        minimumLiquidity * distance / Q64;
      check(BigInt(inputRaw!) < bound, "CPI_FUNCTION_LIMIT_ORDER_UNQUALIFIED");
      return; // Monotonic price cannot reach any farther order barrier either.
    }
    check(!zeroForOne || tick.net !== -(1n << 127n), "CPI_LIMIT_ORDER_STATE_UNPROVEN");
    liquidity += zeroForOne ? -tick.net : tick.net;
    check(liquidity > 0n && liquidity <= MAX_U128, "CPI_LIMIT_ORDER_STATE_UNPROVEN");
    if (liquidity < minimumLiquidity) minimumLiquidity = liquidity;
  }
  // Any orders in the supplied arrays are behind the pinned directional selector.
}

export function decodeIndependentAlt(account: RawAccount): string[] {
  const b = Buffer.from(account.data?.[0] ?? "", "base64");
  check(account.owner === ALT_OWNER && !account.executable && account.data?.[1] === "base64" &&
    b.length >= 56 && (b.length - 56) % 32 === 0 && b.readUInt32LE(0) === 1 &&
    b.readBigUInt64LE(4) === 18446744073709551615n, "CPI_ALT_STATE");
  return Array.from({ length: (b.length - 56) / 32 }, (_, i) => pub(b, 56 + 32 * i));
}

/** Only the observed single-pool V1 account model. No generic instruction decoding. */
export async function validateNarrowCpiEvidence(
  evidence: CpiSemanticEvidence | undefined,
  transactionBytes: Buffer,
  message: SemanticMessage,
  resolvedKeys: readonly string[],
  routeAccounts: readonly string[],
  scope: { wallet: string; side: "BUY" | "SELL"; inputRaw?: string; poolAddress?: string; requestId?: string; asset?: ExecutionAsset; executionPurpose?: "EXECUTION_FUNCTION_TEST"; deliveryPolicy?: DeliveryPolicy },
  wsolAta: string,
  usdcAta: string,
): Promise<void> {
  const asset = scope.asset ? ExecutionAssetSchema.parse(scope.asset) : MANUAL_EXECUTION_ASSET;
  check(!!evidence && evidence.schema === "NARROW_RAYDIUM_CLMM_V1", "CPI_EVIDENCE_REQUIRED");
  const e = evidence!;
  const delivery = scope.deliveryPolicy ? DeliveryPolicySchema.parse(scope.deliveryPolicy) : undefined;
  const followerDeliveryScope = !!delivery && scope.executionPurpose === undefined && !!scope.asset;
  check(e.clmmProgramAttestationReference === undefined || followerDeliveryScope, "PROGRAM_ATTESTATION_REFERENCE_SCOPE");
  check(!delivery || (scope.executionPurpose === "EXECUTION_FUNCTION_TEST" && !scope.asset) ||
    followerDeliveryScope, "CPI_DELIVERY_FUNCTION_SCOPE");
  check(delivery ? e.preparationCommitment === delivery.preparationCommitment :
    e.preparationCommitment === undefined || e.preparationCommitment === "finalized", "CPI_PREPARATION_COMMITMENT_BINDING");
  check(e.transactionDigest === digest(transactionBytes) && !!e.requestId &&
    e.requestId === scope.requestId &&
    Number.isSafeInteger(e.quoteContextSlot) && e.quoteContextSlot > 0, "CPI_ORDER_EVIDENCE_BINDING");
  check(message.version === 0 && (followerDeliveryScope
    ? routeAccounts.length >= 22 && routeAccounts.length <= 24 : routeAccounts.length === 24) &&
    (message.addressTableLookups?.length ?? 0) === 1, "CPI_ROUTE_SHAPE");
  const lookups = message.addressTableLookups!;
  const altKeys: string[] = [];
  for (const lookup of lookups) {
    const fact = e.alt[lookup.lookupTableAddress];
    check(!!fact && fact.slot >= e.quoteContextSlot, "CPI_ALT_EVIDENCE");
    const addresses = decodeIndependentAlt(fact!.account);
    for (const i of [...lookup.writableIndexes, ...lookup.readonlyIndexes]) {
      check(Number.isInteger(i) && !!addresses[i], "CPI_ALT_INDEX");
      altKeys.push(addresses[i]!);
    }
  }
  check(Object.keys(e.alt).length === lookups.length &&
    JSON.stringify(resolvedKeys.slice(message.staticAccounts.length)) === JSON.stringify(altKeys),
    "CPI_ALT_SEMANTIC_BINDING");
  const a = e.accounts;
  check(a.slot >= e.quoteContextSlot && a.keys.length === a.values.length &&
    new Set(a.keys).size === a.keys.length, "CPI_ACCOUNT_BATCH");
  const expectedAccountKeys = [...new Set([...resolvedKeys, WSOL_MINT, asset.tokenMint])]
    .filter(k => k !== scope.wallet);
  check(a.keys.length === expectedAccountKeys.length &&
    a.keys.every(k => expectedAccountKeys.includes(k)), "CPI_ACCOUNT_SET");
  const accounts = new Map(a.keys.map((k, i) => [k, a.values[i]!]));
  const account = (k: string) => accounts.get(k);
  if (delivery) {
    const recipient = account(delivery.tipAccount);
    check(!!recipient && recipient.owner === P.SYSTEM && !recipient.executable && recipient.data?.[1] === "base64" &&
      Buffer.from(recipient.data[0], "base64").length === 0 && !routeAccounts.includes(delivery.tipAccount) &&
      ![scope.wallet,wsolAta,usdcAta].includes(delivery.tipAccount), "CPI_DELIVERY_RECIPIENT_STATE");
  }
  const pd = e.programData;
  // The graduated follower path uses the captured current deployment, never the
  // historical full-byte branch intended for retained pre-graduation fixtures.
  check(!followerDeliveryScope || e.programAttestationDigest !== undefined, "PROGRAM_ATTESTATION_STALE");
  if (e.programAttestationDigest !== undefined) {
    const attestation = followerDeliveryScope ? sealedCurrentClmmProgramAttestation(e.clmmProgramAttestationReference) :
      sealedProgramAttestation(scope.executionPurpose);
    check(e.programAttestationDigest === attestation.digest, "PROGRAM_ATTESTATION_STALE");
    validateProgramMetadata(attestation, pd, a.slot);
  } else {
  check(pd.slot >= a.slot && pd.keys.length === 2 && pd.values.length === 2 &&
    Object.keys(PINNED_PROGRAMS).every(k => pd.keys.includes(PINNED_PROGRAMS[k as keyof typeof PINNED_PROGRAMS].programData)),
    "CPI_PROGRAM_DATA_SET");
  for (const [program, pin] of Object.entries(PINNED_PROGRAMS)) {
    const programAccount = account(program);
    check(!!programAccount && programAccount.owner === LOADER && programAccount.executable &&
      programAccount.data?.[1] === "base64", "CPI_PROGRAM_IDENTITY");
    const programRaw = Buffer.from(programAccount!.data[0], "base64");
    check(programRaw.length === 36 && programRaw.readUInt32LE(0) === 2 &&
      pub(programRaw, 4) === pin.programData, "CPI_PROGRAM_IDENTITY");
    const pdRaw = data(pd.values[pd.keys.indexOf(pin.programData)], LOADER,
      program === P.JUPITER_V6 ? 2892269 : 1700205);
    check(pdRaw.readUInt32LE(0) === 3 && hash(pdRaw) === pin.sha256,
      "CPI_PROGRAM_DATA_IDENTITY");
  }
  }
  // Pool layout offsets and PDA seeds follow the bounded captured Raydium CLMM schema.
  const pool = routeAccounts[12]!;
  check(!!pool && pool === scope.poolAddress, "CPI_POOL_BINDING");
  const b = data(account(pool), RAYDIUM, 1544, "PoolState");
  const token0OnlyDynamic = followerDeliveryScope && e.clmmProgramAttestationReference === "JUPITER_CLMM_20261002_V1" &&
    b[390] === 1 && b.subarray(391,393).every(x => x === 0) && pub(b,73) === WSOL_MINT && validDynamicFeeState(b);
  if (scope.executionPurpose === "EXECUTION_FUNCTION_TEST" || delivery)
    check(token0OnlyDynamic || b[390] === 0 && b.subarray(391,393).every(x => x === 0) &&
      b.subarray(1096,1176).every(x => x === 0), "CPI_FUNCTION_STATIC_POOL_REQUIRED");
  check(token0OnlyDynamic || routeAccounts.length === 24, "CPI_ROUTE_SHAPE");
  const config = pub(b, 9), mint0 = pub(b, 73), mint1 = pub(b, 105);
  const vault0 = pub(b, 137), vault1 = pub(b, 169), observation = pub(b, 201);
  const spacing = b.readUInt16LE(235), currentTick = b.readInt32LE(269);
  const zeroForOne = (scope.side === "BUY" ? WSOL_MINT : asset.tokenMint) === mint0;
  check(new Set([mint0, mint1]).size === 2 && [mint0, mint1].includes(WSOL_MINT) &&
    [mint0, mint1].includes(asset.tokenMint) && Buffer.compare(keySeed(mint0), keySeed(mint1)) < 0 &&
    b[233] === (mint0 === WSOL_MINT ? 9 : asset.tokenDecimals) &&
    b[234] === (mint1 === WSOL_MINT ? 9 : asset.tokenDecimals) &&
    (await derive(seed("pool"), keySeed(config), keySeed(mint0), keySeed(mint1))) === pool,
    "CPI_POOL_MINT_OR_PDA");
  const c = data(account(config), RAYDIUM, 117, "AmmConfig");
  const configIndex = Buffer.alloc(2); configIndex.writeUInt16BE(c.readUInt16LE(9));
  check((await derive(seed("amm_config"), configIndex)) === config &&
    c.readUInt16LE(51) === spacing, "CPI_CONFIG_RELATION");
  for (const [mint, decimals] of [[WSOL_MINT, 9], [asset.tokenMint, asset.tokenDecimals]] as const) {
    const m = data(account(mint), P.TOKEN, 82);
    check(m[44] === decimals && m[45] === 1, "CPI_MINT_STATE");
    if (scope.asset && mint === asset.tokenMint)
      check(m.readUInt32LE(0) === 0 && m.readUInt32LE(46) === 0, "CPI_DYNAMIC_MINT_AUTHORITY");
  }
  for (const [vault, mint] of [[vault0, mint0], [vault1, mint1]] as [string, string][]) {
    const v = data(account(vault), P.TOKEN, 165);
    check(pub(v, 0) === mint && pub(v, 32) === pool && v[108] === 1 &&
      (await derive(seed("pool_vault"), keySeed(pool), keySeed(mint))) === vault,
      "CPI_VAULT_RELATION");
  }
  const o = data(account(observation), RAYDIUM, 4483, "ObservationState");
  check(pub(o, 19) === pool, "CPI_OBSERVATION_RELATION");
  const targetMint = scope.side === "BUY" ? asset.tokenMint : WSOL_MINT;
  const sourceAta = scope.side === "BUY" ? wsolAta : usdcAta;
  const targetAta = scope.side === "BUY" ? usdcAta : wsolAta;
  const inputVault = zeroForOne ? vault0 : vault1;
  const outputVault = zeroForOne ? vault1 : vault0;
  for (const [ata, mint] of [[wsolAta, WSOL_MINT], [usdcAta, asset.tokenMint]] as [string, string][]) {
    const state = account(ata);
    if (state !== null) {
      const t = data(state, P.TOKEN, 165);
      check(pub(t, 0) === mint && pub(t, 32) === scope.wallet && t[108] === 1 &&
        t.readUInt32LE(72) === 0 && t.readUInt32LE(129) === 0,
        "CPI_USER_ATA_STATE");
    }
  }
  const bitmap = await derive(seed("pool_tick_array_bitmap_extension"), keySeed(pool));
  // Exactly 1..3 supplied arrays, first at 19, bitmap at 20, remaining
  // arrays before the final Jupiter sentinel. No arbitrary remaining accounts.
  const tickKeys = [routeAccounts[19]!, ...routeAccounts.slice(21, -1)];
  check(new Set(tickKeys).size === tickKeys.length, "CPI_TICK_POSITION");
  const expectedRoute = [P.TOKEN, scope.wallet, sourceAta, targetAta, P.JUPITER_V6,
    targetMint, P.JUPITER_V6, await getProgramDerivedAddress({programAddress:address(P.JUPITER_V6),seeds:[seed("__event_authority")]}).then(x => x[0]),
    P.JUPITER_V6, RAYDIUM, scope.wallet, config, pool, sourceAta, targetAta,
    inputVault, outputVault, observation, P.TOKEN,
    tickKeys[0]!, bitmap, ...tickKeys.slice(1), P.JUPITER_V6];
  check(expectedRoute.every((k,i) => routeAccounts[i] === k), "CPI_ROUTE_ROLE_RELATION");
  const tickStarts: number[] = [], tickArrays: Buffer[] = [];
  for (const key of tickKeys) {
    const t = data(account(key), RAYDIUM, 10240, "TickArrayState");
    const start = t.readInt32LE(40), startSeed = Buffer.alloc(4);
    startSeed.writeInt32BE(start);
    check(pub(t, 8) === pool && (await derive(seed("tick_array"), keySeed(pool), startSeed)) === key,
      "CPI_TICK_POOL_OR_PDA");
    tickStarts.push(start);
    tickArrays.push(t);
  }
  const span = spacing * 60;
  check(span > 0, "CPI_TICK_POSITION");
  const bitmapData = data(account(bitmap), RAYDIUM, 1832, "TickArrayBitmapExtension");
  check(pub(bitmapData, 8) === pool, "CPI_BITMAP_RELATION");
  // Pinned Raydium permits an uninitialized current array. In that case the
  // first supplied array must be the nearest initialized one in swap direction.
  // Only the PoolState default U1024 bitmap is qualified here; never infer an
  // extension result from provider-supplied array addresses.
  const currentArrayStart = Math.floor(currentTick / span) * span;
  const defaultMin = -512 * span, defaultMax = 512 * span;
  const inDefaultBitmap = (start: number) => start >= defaultMin && start < defaultMax;
  check(inDefaultBitmap(currentArrayStart), "CPI_TICK_BITMAP_EXTENSION_UNSUPPORTED");
  const initialized = (start: number) => {
    const bit = start / span + 512;
    return (b.readBigUInt64LE(904 + Math.floor(bit / 64) * 8) & (1n << BigInt(bit % 64))) !== 0n;
  };
  const nextInitialized = (start: number) => {
    const step = zeroForOne ? -span : span;
    for (let next = start + step; inDefaultBitmap(next); next += step)
      if (initialized(next)) return next;
    throw new Error("CPI_TICK_BITMAP_EXTENSION_UNSUPPORTED");
  };
  const expectedFirst = initialized(currentArrayStart) ? currentArrayStart : nextInitialized(currentArrayStart);
  check(tickStarts[0] === expectedFirst, "CPI_TICK_POSITION");
  for (let i = 0; i < tickStarts.length; i++)
    check(tickStarts[i]! % span === 0 && Math.abs(tickStarts[i]! - expectedFirst) <= 3 * span &&
      (i === 0 || tickStarts[i] === nextInitialized(tickStarts[i-1]!)), "CPI_TICK_POSITION");
  if (scope.executionPurpose === "EXECUTION_FUNCTION_TEST" || delivery)
    requireNoReachableLimitOrders(b, tickArrays, zeroForOne, scope.inputRaw);
  const event = account(expectedRoute[7]!);
  check(event?.owner === P.SYSTEM && !event.executable &&
    Buffer.from(event.data?.[0] ?? "", "base64").length === 0,
    "CPI_EVENT_AUTHORITY_STATE");
  const fixedPrograms = [P.SYSTEM, P.TOKEN, ATA, COMPUTE, P.JUPITER_V6, RAYDIUM];
  const allowed = new Set([...expectedRoute, ...fixedPrograms, wsolAta, usdcAta,
    WSOL_MINT, asset.tokenMint, ...(delivery ? [delivery.tipAccount] : [])]);
  check(resolvedKeys.every(k => allowed.has(k)),
    "CPI_UNKNOWN_MESSAGE_ACCOUNT");
  const writableAllowed = new Set([scope.wallet, wsolAta, usdcAta, pool,
    vault0, vault1, observation, bitmap, ...tickKeys, ...(delivery ? [delivery.tipAccount] : [])]);
  const staticWritableCount = message.staticAccounts.length - message.header.numReadonlyNonSignerAccounts;
  const actualWritable = new Set([
    ...message.staticAccounts.slice(0, staticWritableCount),
    ...lookups.flatMap(l => l.writableIndexes.map(i => e.alt[l.lookupTableAddress] && decodeIndependentAlt(e.alt[l.lookupTableAddress]!.account)[i]!)),
  ]);
  check(resolvedKeys.every(k => actualWritable.has(k) === writableAllowed.has(k)) &&
    message.staticAccounts[0] === scope.wallet && message.header.numSignerAccounts === 1,
    "CPI_FINAL_MESSAGE_PRIVILEGES");
}
