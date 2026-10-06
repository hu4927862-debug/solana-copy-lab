import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import {
  address,
  blockhash,
  getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress,
  getTransactionEncoder,
  type Transaction,
} from "@solana/kit";
import { USDC_MINT, WSOL_MINT } from "../src/domain/assets.js";
import { PROGRAM_IDS as P } from "../src/decoder/program-registry.js";
import {
  associatedAccount,
  ATA,
  COMPUTE,
  RAYDIUM_CLMM,
  reviewTransaction,
  verifyExternalSignature,
  type ReviewScope,
} from "../src/live/transaction-review.js";

// Codec-only fixture encoding. No builder, RPC, signer, authorization, account
// evidence, program binary, private state or transaction submission is used.
// This is a deliberately incomplete SYNTHETIC message, never a live order.
const syntheticKey = (value: number) =>
  bs58.encode(new Uint8Array(32).fill(value));
const wallet = syntheticKey(1);
const otherWallet = syntheticKey(2);
const pool = syntheticKey(3);
const inputRaw = 10_000_000n;
const quotedOutputRaw = 1_000_000n;

type FixtureVariant =
  | "baseline"
  | "unexpected-program"
  | "wrong-route-account"
  | "wrong-amount"
  | "excessive-slippage";

async function encodeSyntheticFixture(
  variant: FixtureVariant,
): Promise<string> {
  const source = await associatedAccount(wallet, WSOL_MINT);
  const destination = await associatedAccount(wallet, USDC_MINT);
  const eventAuthority = (
    await getProgramDerivedAddress({
      programAddress: address(P.JUPITER_V6),
      seeds: [Buffer.from("__event_authority")],
    })
  )[0];
  const config = syntheticKey(4);
  const vaultA = syntheticKey(5);
  const vaultB = syntheticKey(6);
  const observation = syntheticKey(7);
  const ticks = [
    syntheticKey(8),
    syntheticKey(9),
    syntheticKey(10),
    syntheticKey(11),
  ];
  const writable = [
    wallet,
    source,
    destination,
    pool,
    config,
    vaultA,
    vaultB,
    observation,
    ...ticks,
  ];
  const readonly = [
    COMPUTE,
    ATA,
    P.SYSTEM,
    P.TOKEN,
    WSOL_MINT,
    USDC_MINT,
    P.JUPITER_V6,
    RAYDIUM_CLMM,
    eventAuthority,
    P.PUMP_FUN,
  ];
  const accounts = [...writable, ...readonly].map(address);
  const index = (key: string) => {
    const result = accounts.indexOf(address(key));
    assert.notEqual(result, -1, "SYNTHETIC_ACCOUNT_MISSING");
    return result;
  };
  const instruction = (
    program: string,
    keys: readonly string[],
    data: Uint8Array,
  ) => ({
    programAddressIndex: index(program),
    accountIndices: keys.map(index),
    data,
  });
  const limit = Buffer.alloc(5);
  limit[0] = 2;
  limit.writeUInt32LE(800_000, 1);
  const price = Buffer.alloc(9);
  price[0] = 3;
  price.writeBigUInt64LE(1n, 1);
  const transfer = Buffer.alloc(12);
  transfer.writeUInt32LE(2, 0);
  transfer.writeBigUInt64LE(inputRaw, 4);
  const route = Buffer.alloc(35);
  Buffer.from("e517cb977ae3ad2a", "hex").copy(route);
  route.writeUInt32LE(1, 8);
  route[12] = 26;
  route[13] = 100;
  route[14] = 0;
  route[15] = 1;
  route.writeBigUInt64LE(
    variant === "wrong-amount" ? inputRaw + 1n : inputRaw,
    16,
  );
  route.writeBigUInt64LE(quotedOutputRaw, 24);
  route.writeUInt16LE(variant === "excessive-slippage" ? 51 : 50, 32);
  const routeAccounts = [
    P.TOKEN,
    wallet,
    variant === "wrong-route-account" ? pool : source,
    destination,
    P.JUPITER_V6,
    USDC_MINT,
    P.JUPITER_V6,
    eventAuthority,
    P.JUPITER_V6,
    RAYDIUM_CLMM,
    wallet,
    config,
    pool,
    source,
    destination,
    vaultA,
    vaultB,
    observation,
    P.TOKEN,
    ...ticks,
    WSOL_MINT,
  ];
  const messageBytes = getCompiledTransactionMessageEncoder().encode({
    version: 0,
    header: {
      numSignerAccounts: 1,
      numReadonlySignerAccounts: 0,
      numReadonlyNonSignerAccounts: readonly.length,
    },
    staticAccounts: accounts,
    lifetimeToken: blockhash(syntheticKey(12)),
    addressTableLookups: [],
    instructions: [
      instruction(
        variant === "unexpected-program" ? P.PUMP_FUN : COMPUTE,
        [],
        limit,
      ),
      instruction(COMPUTE, [], price),
      instruction(
        ATA,
        [wallet, source, wallet, WSOL_MINT, P.SYSTEM, P.TOKEN],
        Uint8Array.of(1),
      ),
      instruction(
        ATA,
        [wallet, destination, wallet, USDC_MINT, P.SYSTEM, P.TOKEN],
        Uint8Array.of(1),
      ),
      instruction(P.SYSTEM, [wallet, source], transfer),
      instruction(P.TOKEN, [source], Uint8Array.of(17)),
      instruction(P.JUPITER_V6, routeAccounts, route),
      instruction(P.TOKEN, [source, wallet, wallet], Uint8Array.of(9)),
    ],
  });
  return Buffer.from(
    getTransactionEncoder().encode({
      messageBytes: messageBytes as Transaction["messageBytes"],
      signatures: { [address(wallet)]: null },
    }),
  ).toString("base64");
}

export async function runOfflineReviewDemo() {
  const scope: ReviewScope = {
    wallet,
    side: "BUY",
    inputRaw: inputRaw.toString(),
    quotedOutputRaw: quotedOutputRaw.toString(),
    maxSlippageBps: 50,
    maxPlatformFeeBps: 0,
    networkFeeCapLamports: "25000",
    poolAddress: pool,
    requestId: "SYNTHETIC_PUBLIC_REVIEW",
  };
  let lookupCalls = 0;
  const noLookup = async (_key: string): Promise<readonly string[]> => {
    lookupCalls += 1;
    throw new Error("LOOKUP_NETWORK_FORBIDDEN");
  };
  const cases: {
    name: string;
    expected: string;
    actual: string;
    result: "EXPECTED_BLOCK";
  }[] = [];
  const expectBlock = async (
    name: string,
    expected: string,
    operation: () => unknown | Promise<unknown>,
  ) => {
    let actual: string | undefined;
    try {
      await operation();
    } catch (error) {
      actual = error instanceof Error ? error.message : String(error);
    }
    assert.equal(actual, expected, `Unexpected guard behavior in ${name}`);
    cases.push({ name, expected, actual, result: "EXPECTED_BLOCK" });
  };
  const baseline = await encodeSyntheticFixture("baseline");
  await expectBlock("missing-cpi-evidence", "CPI_EVIDENCE_REQUIRED", () =>
    reviewTransaction(baseline, scope, noLookup),
  );
  await expectBlock("wrong-wallet", "UNEXPECTED_SIGNER_OR_PRE_SIGNATURE", () =>
    reviewTransaction(baseline, { ...scope, wallet: otherWallet }, noLookup),
  );
  for (const [variant, expected] of [
    ["unexpected-program", "UNSUPPORTED_OUTER_PROGRAM"],
    ["wrong-route-account", "ROUTE_ACCOUNT_SCOPE"],
    ["wrong-amount", "ROUTE_AMOUNT_SCOPE"],
    ["excessive-slippage", "ROUTE_FEE_OR_SLIPPAGE_SCOPE"],
  ] as const) {
    const encoded = await encodeSyntheticFixture(variant);
    await expectBlock(variant, expected, () =>
      reviewTransaction(encoded, scope, noLookup),
    );
  }
  // SYNTHETIC budget counterexample: ceil(800_000 CU * 1 micro-lamport / 1e6)
  // is 1 lamport, plus the reviewer's 5_000-lamport base fee. This exercises
  // the original guard before missing CPI evidence, without changing policy.
  await expectBlock("network-fee-over-budget", "NETWORK_FEE_CAP", () =>
    reviewTransaction(
      baseline,
      { ...scope, networkFeeCapLamports: "5000" },
      noLookup,
    ),
  );
  const changed = await encodeSyntheticFixture("wrong-amount");
  await expectBlock(
    "changed-message-at-signature-intake",
    "SIGNER_CHANGED_TRANSACTION",
    () => verifyExternalSignature(baseline, changed, wallet),
  );
  await expectBlock("absent-signature-at-intake", "MISSING_SIGNATURE", () =>
    verifyExternalSignature(baseline, baseline, wallet),
  );
  assert.equal(lookupCalls, 0);
  return {
    schema: "PUBLIC_OFFLINE_REVIEW_GUARDS_V1",
    evidence: "SYNTHETIC_OFFLINE_GUARD_CHECK",
    cases,
    lookupCalls,
    completeTransactionReview: "NOT_PASSED_MISSING_CPI_EVIDENCE",
    fixtureWireEncoding: "LOCAL_CODEC_ONLY_NOT_LIVE_TRANSACTION_BUILD",
    unverified: [
      "Current program/account attestation",
      "ALT resolution",
      "Quote/review expiry and authorization/Journal binding",
      "On-chain simulation",
      "Real signature/submission",
      "Execution qualification",
    ],
    forbiddenEffects: {
      network: 0,
      liveBuild: 0,
      onchainSimulation: 0,
      sign: 0,
      send: 0,
      funds: 0,
    },
    fundsAuthorized: false,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 2) {
    process.stderr.write(
      "This fixed synthetic example accepts no input or live parameters.\n",
    );
    process.exitCode = 1;
  } else {
    runOfflineReviewDemo()
      .then((result) => {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      });
  }
}
