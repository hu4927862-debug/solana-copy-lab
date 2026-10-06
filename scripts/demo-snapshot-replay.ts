import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RawTransactionSchema } from "../src/decoder/raw-transaction.js";
import { TransactionNormalizer } from "../src/decoder/transaction-normalizer.js";
import { SwapClassifier } from "../src/decoder/swap-classifier.js";
import { SystemClock } from "../src/domain/time.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureOwner = "GzzJTU9s5omyN9D9PJfMrYYn3v5QWHT64jGsgTrFCoQi";
const snapshots = [
  {
    name: "v5-native-sol-with-rent",
    path: "test/fixtures/v5-native-sol-with-rent.json",
    sha256: "023fbdcae960231ff677abf32a8385d1b5a3d3ad5b3b9d103ad0ae08af7cb04f",
  },
  {
    name: "v5-jupiter-buy-with-refund",
    path: "test/fixtures/v5-jupiter-buy-with-refund.json",
    sha256: "6f95656017d8b847382802f7a10c25314151bbcaeab28fc7cd904a48d4b25626",
  },
  {
    name: "v5-jupiter-sell-with-output-fee",
    path: "test/fixtures/v5-jupiter-sell-with-output-fee.json",
    sha256: "e90b8ab14dc5ed559d3f0b317609bb2521d4ba143c966f67d6c789a4cf288bbb",
  },
  {
    name: "v5-jupiter-full-sell-with-output-fee",
    path: "test/fixtures/v5-jupiter-full-sell-with-output-fee.json",
    sha256: "63abc340cfb355d7742a918b2b1de3dd55b4ca072d227ad25d21958a75a27a24",
  },
];

export function runSnapshotReplay() {
  const clock = new SystemClock();
  const negativeControls: {
    name: string;
    evidenceKind: string;
    sourceSha256: string;
    derivation: string;
    result: string;
    code: string;
  }[] = [];
  const rows = snapshots.map(({ name, path, sha256 }) => {
    const bytes = readFileSync(resolve(root, path));
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    if (sourceSha256 !== sha256)
      throw new Error(`SNAPSHOT_HASH_MISMATCH:${name}`);
    const raw = RawTransactionSchema.parse(JSON.parse(bytes.toString("utf8")));
    const received = clock.now();
    const envelope = {
      signature: raw.signature,
      slot: BigInt(raw.slot),
      ...(raw.sourceTimestampMs === undefined
        ? {}
        : { sourceTimestampMs: raw.sourceTimestampMs }),
      sourceTimestampPrecision: raw.sourceTimestampPrecision,
      sourceTimestampProvenance: raw.sourceTimestampProvenance,
      streamReceivedTimestampMs: received.wallMs,
      streamReceivedMonotonicNs: received.monotonicNs,
      payload: raw,
    };
    const classifier = new SwapClassifier();
    const normalized = new TransactionNormalizer(clock).normalize(envelope);
    const result = classifier.classify(normalized, fixtureOwner);
    if (name === "v5-native-sol-with-rent") {
      const mutation = { ...raw, innerInstructions: [] };
      const missingProof = classifier.classify(
        new TransactionNormalizer(clock).normalize({
          ...envelope,
          payload: mutation,
        }),
        fixtureOwner,
      );
      const wrongOwner = classifier.classify(
        normalized,
        "11111111111111111111111111111111",
      );
      for (const [controlName, evidenceKind, rejected] of [
        ["missing-native-transfer-proof", "SYNTHETIC_MUTATION", missingProof],
        ["wrong-explicit-owner", "SYNTHETIC_CALLER", wrongOwner],
      ] as const) {
        if (rejected.accepted)
          throw new Error(`NEGATIVE_CONTROL_ACCEPTED:${controlName}`);
        negativeControls.push({
          name: controlName,
          evidenceKind,
          sourceSha256,
          derivation:
            controlName === "missing-native-transfer-proof"
              ? "Clone the saved snapshot and remove innerInstructions; source bytes remain unchanged."
              : "Keep the saved snapshot unchanged and pass the system-program address as an intentionally wrong caller owner.",
          result: "REJECT",
          code: rejected.code,
        });
      }
    }
    const payerIndex = raw.accountKeys.findIndex(
      (account) => account.address === raw.feePayer,
    );
    return {
      name,
      path,
      sourceSha256,
      sourceFormat: "PROJECT_RAW_TRANSACTION_SNAPSHOT",
      originalRpcReceipt: "UNKNOWN",
      historicalFirstObservedAt: "UNKNOWN",
      replayedAtMs: received.wallMs,
      replayedAtUtc: new Date(received.wallMs).toISOString(),
      replayReceiptKind: "REPLAY_NOT_REALTIME",
      signature: raw.signature,
      slot: raw.slot,
      chainTimeMs: raw.sourceTimestampMs ?? null,
      chainTimeUtc:
        raw.sourceTimestampMs === undefined
          ? "UNKNOWN"
          : new Date(raw.sourceTimestampMs).toISOString(),
      chainTimePrecision: raw.sourceTimestampPrecision,
      chainTimeProvenance: raw.sourceTimestampProvenance,
      feeRaw: raw.feeRaw,
      feePayer: raw.feePayer,
      fixtureOwner,
      ownerEqualsFeePayer: fixtureOwner === raw.feePayer,
      nativeDeltaBasis: "FEE_PAYER_ACCOUNT; not the swap principal or proceeds",
      ownerBasis:
        "EXPLICIT_FIXTURE_ADDRESS; caller identity is checked by the classifier, not inferred from fee payer",
      signers: raw.accountKeys
        .filter((account) => account.signer)
        .map((account) => account.address),
      walletNativeDeltaRaw:
        payerIndex >= 0 &&
        raw.preBalances[payerIndex] !== undefined &&
        raw.postBalances[payerIndex] !== undefined
          ? (
              BigInt(raw.postBalances[payerIndex]!) -
              BigInt(raw.preBalances[payerIndex]!)
            ).toString()
          : "UNKNOWN",
      ...(result.accepted
        ? {
            result: "ACCEPT",
            side: result.event.side,
            tokenMint: result.event.token.mint,
            tokenRaw: result.event.token.raw.toString(),
            tokenDecimals: result.event.token.decimals,
            quoteMint: result.event.quote.mint,
            quoteRaw: result.event.quote.raw.toString(),
            quoteDecimals: result.event.quote.decimals,
            evidence: result.event.evidence,
          }
        : { result: "REJECT", code: result.code, details: result.details }),
    };
  });
  return {
    schema: "OFFLINE_SNAPSHOT_REPLAY_V1",
    snapshots: rows,
    negativeControls,
    limitations: [
      "Project-format saved snapshots are not complete original JSON-RPC responses.",
      "Original capture receipts and historical observation times are unavailable.",
      "Caller owner equals fee payer for these four fixtures only; this does not prove universal payer/owner equivalence.",
      "Classification is not FOLLOW, execution qualification, funds authorization or profitability evidence.",
    ],
    fundsAuthorized: false,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 2)
      throw new Error(
        "Usage: node --import tsx scripts/demo-snapshot-replay.ts",
      );
    process.stdout.write(`${JSON.stringify(runSnapshotReplay(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
