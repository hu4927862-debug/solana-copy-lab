import { digest, protocolDigest, executionAsset, isDynamicExecutionProtocol, type ExecutionProtocol } from "./protocol.js";
import {
  decodeWire,
  verifyExternalSignature,
  type TransactionReview,
} from "./transaction-review.js";
import type { LiveAttempt } from "./journal.js";
import { snapshotToken, type WalletSnapshot } from "./adapters.js";
import { USDC_MINT, WSOL_MINT } from "../domain/assets.js";
import { getTransactionDecoder } from "@solana/kit";

export const RECOVERY_POLICY = {
  version: "EXPIRED_EXPORTED_UNSIGNED_V1",
  maxRequests: 24,
  maxDurationMs: 300000,
  maxPages: 4,
  pageSize: 100,
  maxTransactions: 8,
} as const;
const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export interface HistoryRow {
  signature: string;
  slot: number;
  err: unknown;
  confirmationStatus: string;
}
export type RecoveryKind = "UNSIGNED" | "SIGNED_UNSENT" | "SUBMITTED";
export interface RecoveryEvidence {
  exactSignature?: {
    signature: string;
    transaction: unknown;
    status: { context: { slot: number }; value: unknown[] };
  };
  startedAtMs: number;
  completedAtMs: number;
  genesis: string;
  barrierSlot: number;
  validity: { context: { slot: number }; value: boolean };
  finalizedBlockHeight?: { minContextSlot: number; value: number };
  firstAvailableBlock: number;
  pages: HistoryRow[][];
  headAfter: HistoryRow[];
  transactions: Record<
    string,
    { slot: number; transaction: [string, string]; meta: unknown } | null
  >;
  snapshot: WalletSnapshot;
}
function requireFact(ok: unknown, code: string): asserts ok {
  if (!ok) throw Error(code);
}
function slot(value: unknown): number {
  const n = Number(value);
  requireFact(
    (typeof value === "number" || typeof value === "string") &&
      /^\d+$/.test(String(value)) &&
      Number.isSafeInteger(n) &&
      n >= 0,
    "RECOVERY_INVALID_SLOT",
  );
  return n;
}
export function recoverySubject(
  p: ExecutionProtocol,
  a: LiveAttempt,
  positionRaw: string,
  now: number,
  kind: RecoveryKind = "UNSIGNED",
) {
  const asset = executionAsset(p);
  requireFact(["UNSIGNED", "SIGNED_UNSENT", "SUBMITTED"].includes(kind), "RECOVERY_KIND");
  const d = a.data,
    review = d.review as TransactionReview,
    before = d.before as WalletSnapshot;
  if (kind === "SUBMITTED") {
    const delivery = p.version === "AUTONOMOUS_SINGLE_POSITION_V1" ? p.deliveryPolicy : undefined;
    const count = Number(d.submissionCount);
    requireFact(a.state === "UNKNOWN" && d.signingRequestIssued === true &&
      !Object.hasOwn(d, "settlement") &&
      Number.isSafeInteger(d.submissionStartedAtMs) && Number(d.submissionStartedAtMs) >= 0 &&
      Number(d.submissionStartedAtMs) < Number(d.quoteExpiresAtMs) &&
      Number.isSafeInteger(count) && count >= 1 && count <= (delivery?.maxBroadcasts ?? 1) &&
      d.lastSubmissionKind === (count === 1 ? "FIRST_SUBMISSION" : "SAME_SIGNED_BYTES_REBROADCAST") &&
      (count === 1 || (delivery && Number.isSafeInteger(d.lastDeliveryAtMs) &&
        Number(d.lastDeliveryAtMs) >= Number(d.submissionStartedAtMs) + (count - 1) * delivery.broadcastIntervalMs &&
        Number(d.lastDeliveryAtMs) < Number(d.quoteExpiresAtMs))),
      "RECOVERY_EXACT_FIRST_SUBMISSION_REQUIRED");
    const provider = d.providerReceipt as {signature?: unknown} | undefined;
    requireFact(!provider?.signature || provider.signature === d.signature, "RECOVERY_PROVIDER_SIGNATURE_MISMATCH");
  } else requireFact(
    a.state === (kind === "UNSIGNED" ? "REVIEWED" : "SIGNED") &&
      d.signingRequestIssued === true &&
      ![
        "settlement",
        "providerReceipt",
        "recovery",
        "submittedAtMs",
        "submissionStartedAtMs",
        "lastSubmissionKind",
      ].some((k) => Object.hasOwn(d, k)) &&
      (d.submissionCount === undefined || d.submissionCount === 0) &&
      (kind === "SIGNED_UNSENT" ||
        !["signature", "signedTransaction"].some((k) => Object.hasOwn(d, k))),
    "RECOVERY_POSSIBLY_SIGNED_OR_SENT",
  );
  if (kind !== "UNSIGNED") {
    requireFact(
      typeof d.signedTransaction === "string" &&
        typeof d.signature === "string",
      "RECOVERY_SIGNED_BYTES_REQUIRED",
    );
    const verified = verifyExternalSignature(
      String(d.unsignedTransaction),
      d.signedTransaction,
      p.wallet,
    );
    requireFact(
      verified.signature === d.signature &&
        verified.messageDigest === review?.messageDigest,
      "RECOVERY_SIGNED_BINDING",
    );
  }
  requireFact(
    Number.isSafeInteger(d.quoteExpiresAtMs) &&
      now >= Number(d.quoteExpiresAtMs),
    "RECOVERY_REQUEST_NOT_EXPIRED",
  );
  requireFact(
    review &&
      before &&
      d.simulation &&
      before.wsolAbsent === true &&
      snapshotToken(before, asset).raw === positionRaw &&
      (a.side === "BUY"
        ? positionRaw === "0" && a.amount === p.buyLamports
        : BigInt(positionRaw) > 0n && a.amount === positionRaw),
    "RECOVERY_POSITION_BASELINE",
  );
  requireFact(
    review.inputRaw === a.amount &&
      review.inputMint === (a.side === "BUY" ? WSOL_MINT : asset.tokenMint) &&
      review.outputMint === (a.side === "BUY" ? asset.tokenMint : WSOL_MINT) &&
      (!isDynamicExecutionProtocol(p) || JSON.stringify(review.asset) === JSON.stringify(asset)),
    "RECOVERY_REVIEW_SIDE_BINDING",
  );
  const wire = decodeWire(String(d.unsignedTransaction));
  requireFact(
    wire.message.staticAccounts[0] === p.wallet &&
      review.wallet === p.wallet &&
      digest(Buffer.from(wire.transaction.messageBytes)) ===
        review.messageDigest &&
      digest(wire.bytes) === review.transactionDigest &&
      wire.message.lifetimeToken === review.blockhash &&
      Object.values(wire.transaction.signatures).every(
        (s) => !s || s.every((b) => b === 0),
      ),
    "RECOVERY_MESSAGE_BINDING",
  );
  // No nonce proof by user assertion: inspect actual bytes. Fail closed on a loaded
  // program id or any System operation other than the reviewed SOL transfer.
  for (const ix of wire.message.instructions) {
    const program = wire.message.staticAccounts[ix.programAddressIndex];
    requireFact(program !== undefined, "RECOVERY_LOADED_PROGRAM_UNSUPPORTED");
    if (program === "11111111111111111111111111111111") {
      const data = Buffer.from(ix.data ?? []);
      requireFact(
        data.length >= 4 && data.readUInt32LE(0) === 2,
        "RECOVERY_DURABLE_NONCE_OR_SYSTEM_OPERATION",
      );
    }
  }
  const simulation = d.simulation as { slot: string };
  return {
    review,
    before,
    lowerSlot: slot(before.slot),
    simulationSlot: slot(simulation.slot),
    attemptDigest: digest(JSON.stringify(a)),
    protocolDigest: protocolDigest(p),
  };
}
/** Evidence is collected by the sealed read-only runner, never a user-supplied PASS flag.
 * Finalized false at a bank later than the successful simulation prevents a too-new
 * confirmed hash from being confused with expiry. Nonce messages are excluded above.
 * RPC history completeness is trusted exactly as other finalized RPC facts, with
 * explicit retention, pagination, body availability and stable-head checks. */
export function assessExpiredRecovery(
  p: ExecutionProtocol,
  a: LiveAttempt,
  positionRaw: string,
  e: RecoveryEvidence,
  now: number,
  kind: RecoveryKind = "UNSIGNED",
) {
  const s = recoverySubject(p, a, positionRaw, now, kind);
  requireFact(e.genesis === MAINNET, "RECOVERY_CLUSTER");
  requireFact(
    Number.isSafeInteger(e.startedAtMs) &&
      Number.isSafeInteger(e.completedAtMs) &&
      e.startedAtMs >= Number(a.data.quoteExpiresAtMs) &&
      e.completedAtMs >= e.startedAtMs &&
      e.completedAtMs - e.startedAtMs <= RECOVERY_POLICY.maxDurationMs &&
      now >= e.completedAtMs &&
      now - e.completedAtMs <= 60000,
    "RECOVERY_STALE_EVIDENCE",
  );
  requireFact(
    slot(e.barrierSlot) > s.simulationSlot &&
      slot(e.validity.context.slot) >= e.barrierSlot &&
      e.validity.value === false,
    "RECOVERY_BLOCKHASH_NOT_DEFINITIVELY_EXPIRED",
  );
  if (kind === "SUBMITTED") {
    const height = (a.data.orderEvidence as {lastValidBlockHeight?:unknown} | undefined)?.lastValidBlockHeight;
    if (height !== undefined) {
      const last = slot(height), finalized = e.finalizedBlockHeight;
      requireFact(finalized && slot(finalized.minContextSlot) >= e.validity.context.slot &&
        slot(finalized.value) > last, "RECOVERY_FINALIZED_HEIGHT_REQUIRED");
    }
  }
  if (kind !== "UNSIGNED") {
    const exact = e.exactSignature;
    requireFact(
      exact &&
        exact.signature === a.data.signature &&
        slot(exact.status?.context?.slot) >= e.validity.context.slot &&
        Array.isArray(exact.status.value) &&
        exact.status.value.length === 1,
      "RECOVERY_EXACT_SIGNATURE_EVIDENCE",
    );
    requireFact(
      exact.transaction === null && exact.status.value[0] === null,
      "RECOVERY_MATCHING_SIGNATURE_RECONCILE",
    );
  }
  requireFact(
    slot(e.firstAvailableBlock) <= s.lowerSlot,
    "RECOVERY_HISTORY_PRUNED",
  );
  requireFact(
    e.pages.length > 0 && e.pages.length <= RECOVERY_POLICY.maxPages,
    "RECOVERY_HISTORY_BOUND",
  );
  requireFact(
    JSON.stringify(e.pages[0]) === JSON.stringify(e.headAfter),
    "RECOVERY_HISTORY_CHANGED",
  );
  const seen = new Set<string>();
  let previous = Infinity,
    crossed = false;
  const relevant: HistoryRow[] = [];
  for (let i = 0; i < e.pages.length; i++) {
    const page = e.pages[i]!;
    requireFact(
      page.length > 0 && page.length <= RECOVERY_POLICY.pageSize && !crossed,
      "RECOVERY_HISTORY_INCOMPLETE",
    );
    for (const row of page) {
      requireFact(
        typeof row.signature === "string" &&
          row.signature.length > 0 &&
          !seen.has(row.signature) &&
          row.confirmationStatus === "finalized" &&
          slot(row.slot) <= previous,
        "RECOVERY_HISTORY_INVALID",
      );
      seen.add(row.signature);
      previous = row.slot;
      if (row.slot < s.lowerSlot) crossed = true;
      else relevant.push(row);
    }
    requireFact(
      crossed || page.length === RECOVERY_POLICY.pageSize,
      "RECOVERY_HISTORY_BOUNDARY_NOT_REACHED",
    );
  }
  requireFact(
    crossed && relevant.length <= RECOVERY_POLICY.maxTransactions,
    "RECOVERY_HISTORY_BOUNDARY_NOT_REACHED",
  );
  requireFact(
    Object.keys(e.transactions).length === relevant.length,
    "RECOVERY_TRANSACTION_COVERAGE",
  );
  let unrelated = false;
  for (const row of relevant) {
    if (kind !== "UNSIGNED" && row.signature === a.data.signature)
      throw Error("RECOVERY_MATCHING_SIGNATURE_RECONCILE");
    const tx = e.transactions[row.signature];
    requireFact(
      tx &&
        slot(tx.slot) === row.slot &&
        tx.meta !== null &&
        tx.transaction?.[1] === "base64",
      "RECOVERY_TRANSACTION_UNAVAILABLE",
    );
    const bytes = Buffer.from(tx.transaction[0], "base64");
    requireFact(
      bytes.toString("base64") === tx.transaction[0],
      "RECOVERY_TRANSACTION_ENCODING",
    );
    const decoded = getTransactionDecoder().decode(bytes);
    if (digest(Buffer.from(decoded.messageBytes)) === s.review.messageDigest)
      throw Error("RECOVERY_MATCHING_LANDED_MESSAGE_RECONCILE");
    unrelated = true;
  }
  // Classify, never attribute unrelated traffic to the candidate or silently net it out.
  requireFact(!unrelated, "RECOVERY_UNRELATED_WALLET_ACTIVITY_REQUIRES_REVIEW");
  requireFact(
    slot(e.snapshot.slot) >= e.validity.context.slot &&
      ["walletLamports", "wsolAbsent"].every(
        (k) =>
          e.snapshot[k as keyof WalletSnapshot] ===
          s.before[k as keyof WalletSnapshot],
      ) && JSON.stringify(snapshotToken(e.snapshot, executionAsset(p))) ===
        JSON.stringify(snapshotToken(s.before, executionAsset(p))),
    "RECOVERY_UNEXPLAINED_ACCOUNT_DELTA",
  );
  return {
    version: kind === "SUBMITTED" ? "EXPIRED_SUBMITTED_NOT_LANDED_V1" : RECOVERY_POLICY.version,
    state:
      kind === "UNSIGNED"
        ? ("ABANDONED_EXPIRED_UNSIGNED" as const)
        : kind === "SIGNED_UNSENT" ? ("ABANDONED_EXPIRED_SIGNED_UNSENT" as const)
        : ("EXPIRED_SUBMITTED_NOT_LANDED" as const),
    kind,
    ...(kind !== "UNSIGNED"
      ? {
          signature: a.data.signature,
          signedTransactionDigest: digest(
            Buffer.from(String(a.data.signedTransaction), "base64"),
          ),
        }
      : {}),
    ...(kind === "SUBMITTED" ? {submissionCount:a.data.submissionCount,
      lastSubmissionKind:a.data.lastSubmissionKind,
      ...(a.data.lastDeliveryAtMs !== undefined ? {lastDeliveryAtMs:a.data.lastDeliveryAtMs} : {})} : {}),
    protocolDigest: s.protocolDigest,
    attemptId: a.id,
    attemptDigest: s.attemptDigest,
    messageDigest: s.review.messageDigest,
    blockhash: s.review.blockhash,
    side: a.side,
    evidenceDigest: digest(JSON.stringify(e)),
    evidence: e,
    reason:
      "RECENT_BLOCKHASH_NONVIABLE_AT_LATER_FINALIZED_BANK_NO_LANDED_MESSAGE_UNCHANGED_ACCOUNTS",
    noNewEntry: true,
    remainingPositionRaw: positionRaw,
    createdAtMs: now,
  };
}
