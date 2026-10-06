import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { LiveJournal } from "./journal.js";
import { LiveExecutor } from "./executor.js";
import { LiveStaging, writeOnce } from "./staging.js";
import {
  JupiterManagedNetwork,
  type NetworkRequestAudit,
  type RequestPhase,
  type WalletSnapshot,
} from "./adapters.js";
import {
  associatedAccount,
  type TransactionReview,
} from "./transaction-review.js";
import { USDC_MINT, WSOL_MINT } from "../domain/assets.js";
import { digest, type ExecutionProtocol } from "./protocol.js";
import {
  RECOVERY_POLICY,
  recoverySubject,
  assessExpiredRecovery,
  type RecoveryEvidence,
  type RecoveryKind,
  type HistoryRow,
} from "./expired-recovery.js";
import type { LiveAttempt } from "./journal.js";
import type { verifyCandidateIdentity } from "./candidate.js";

type ReadNetwork = {
  recoveryRead(method: string, params: unknown[]): Promise<any>;
  snapshot(
    review: TransactionReview,
    minSlot?: string,
  ): Promise<WalletSnapshot>;
};
/** No transaction/economic mutation. Failures propagate; no retries or provider fallback. */
export async function collectExpiredRecovery(
  p: ExecutionProtocol,
  a: LiveAttempt,
  position: string,
  n: ReadNetwork,
  now = Date.now,
  kind: RecoveryKind = "UNSIGNED",
): Promise<RecoveryEvidence> {
  const startedAtMs = now(),
    s = recoverySubject(p, a, position, startedAtMs, kind);
  const genesis = await n.recoveryRead("getGenesisHash", []);
  if (genesis !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")
    throw Error("RECOVERY_CLUSTER");
  const latest = await n.recoveryRead("getLatestBlockhash", [
    { commitment: "finalized", minContextSlot: s.simulationSlot + 1 },
  ]);
  const barrierSlot = latest.context.slot;
  const validity = await n.recoveryRead("isBlockhashValid", [
    s.review.blockhash,
    { commitment: "finalized", minContextSlot: barrierSlot },
  ]);
  if (
    validity.value !== false ||
    !Number.isSafeInteger(barrierSlot) ||
    barrierSlot <= s.simulationSlot ||
    validity.context.slot < barrierSlot
  )
    throw Error("RECOVERY_BLOCKHASH_NOT_DEFINITIVELY_EXPIRED");
  let finalizedBlockHeight: RecoveryEvidence["finalizedBlockHeight"];
  const savedHeight = (a.data.orderEvidence as {lastValidBlockHeight?:unknown} | undefined)?.lastValidBlockHeight;
  if (kind === "SUBMITTED" && savedHeight !== undefined) {
    const value = await n.recoveryRead("getBlockHeight", [{commitment:"finalized",minContextSlot:validity.context.slot}]);
    finalizedBlockHeight = {minContextSlot:validity.context.slot,value};
  }
  let exactSignature: RecoveryEvidence["exactSignature"];
  if (kind !== "UNSIGNED") {
    const signature = String(a.data.signature);
    const transaction = await n.recoveryRead("getTransaction", [
      signature,
      {
        commitment: "finalized",
        encoding: "base64",
        maxSupportedTransactionVersion: 0,
      },
    ]);
    const status = await n.recoveryRead("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    exactSignature = { signature, transaction, status };
    if (
      transaction !== null ||
      status?.value?.length !== 1 ||
      status.value[0] !== null
    )
      throw Error("RECOVERY_MATCHING_SIGNATURE_RECONCILE");
    if (
      !Number.isSafeInteger(status?.context?.slot) ||
      status.context.slot < validity.context.slot
    )
      throw Error("RECOVERY_EXACT_SIGNATURE_EVIDENCE");
  }
  const firstAvailableBlock = await n.recoveryRead(
    "getFirstAvailableBlock",
    [],
  );
  if (firstAvailableBlock > s.lowerSlot) throw Error("RECOVERY_HISTORY_PRUNED");
  const config = {
    commitment: "finalized",
    minContextSlot: validity.context.slot,
    limit: RECOVERY_POLICY.pageSize,
  };
  const pages: HistoryRow[][] = [];
  let before: string | undefined,
    covered = false;
  for (let i = 0; i < RECOVERY_POLICY.maxPages; i++) {
    const rows = await n.recoveryRead("getSignaturesForAddress", [
      p.wallet,
      { ...config, ...(before ? { before } : {}) },
    ]);
    if (
      !Array.isArray(rows) ||
      rows.length === 0 ||
      rows.length > RECOVERY_POLICY.pageSize
    )
      throw Error("RECOVERY_HISTORY_INCOMPLETE");
    pages.push(rows);
    if (rows.some((r) => r.slot < s.lowerSlot)) {
      covered = true;
      break;
    }
    if (rows.length < RECOVERY_POLICY.pageSize) break;
    before = rows.at(-1).signature;
  }
  if (!covered) throw Error("RECOVERY_HISTORY_BOUNDARY_NOT_REACHED");
  const interval = pages.flat().filter((r) => r.slot >= s.lowerSlot);
  if (interval.length > RECOVERY_POLICY.maxTransactions)
    throw Error("RECOVERY_HISTORY_TRANSACTION_LIMIT");
  const transactions: RecoveryEvidence["transactions"] = {};
  for (const row of interval)
    transactions[row.signature] = await n.recoveryRead("getTransaction", [
      row.signature,
      {
        commitment: "finalized",
        encoding: "base64",
        maxSupportedTransactionVersion: 0,
      },
    ]);
  const snapshot = await n.snapshot(s.review, String(validity.context.slot));
  const headAfter = await n.recoveryRead("getSignaturesForAddress", [
    p.wallet,
    { ...config, minContextSlot: Number(snapshot.slot) },
  ]);
  const evidence = {
    ...(finalizedBlockHeight ? {finalizedBlockHeight} : {}),
    ...(exactSignature ? { exactSignature } : {}),
    startedAtMs,
    completedAtMs: now(),
    genesis,
    barrierSlot,
    validity,
    firstAvailableBlock,
    pages,
    headAfter,
    transactions,
    snapshot,
  };
  assessExpiredRecovery(p, a, position, evidence, now(), kind);
  return evidence;
}
class RecoveryAudit implements NetworkRequestAudit {
  readonly maxAltTablesPerMessage = 1;
  private count = 0;
  constructor(
    readonly path: string,
    readonly deadline: number,
    private rpcUrl: string,
  ) {
    mkdirSync(resolve(path, "requests"));
  }
  assertCurrent() {
    if (Date.now() >= this.deadline) throw Error("RECOVERY_DEADLINE");
  }
  requestSignal() {
    this.assertCurrent();
    return AbortSignal.timeout(Math.max(1, this.deadline - Date.now()));
  }
  reserve(
    kind: "RPC_READ" | "SIMULATION" | "JUPITER",
    method: string,
    params: unknown,
  ) {
    this.assertCurrent();
    if (kind !== "RPC_READ" || this.count >= RECOVERY_POLICY.maxRequests)
      throw Error("RECOVERY_REQUEST_BOUND");
    const id = ++this.count;
    writeOnce(resolve(this.path, "requests", `${id}-request.json`), {
      id,
      kind,
      method,
      params,
      atMs: Date.now(),
    });
    return id;
  }
  complete(id: number, status: number, body: string) {
    this.assertCurrent();
    const endpoint = new URL(this.rpcUrl);
    const forbidden = [
      this.rpcUrl,
      endpoint.username,
      endpoint.password,
      ...endpoint.searchParams.values(),
    ].filter((v) => v.length >= 6);
    if (forbidden.some((v) => body.includes(v)))
      throw Error("RECOVERY_SECRET_IN_RESPONSE");
    // Successful JSON-RPC bodies contain public chain facts; no headers or endpoint is stored.
    writeOnce(resolve(this.path, "requests", `${id}-response.json`), {
      id,
      status,
      bodySha256: digest(body),
      bodyText: body,
      atMs: Date.now(),
    });
  }
  fail(id: number, reason: string, phase?: RequestPhase) {
    writeOnce(resolve(this.path, "requests", `${id}-failure.json`), {
      id,
      reason,
      phase,
      atMs: Date.now(),
    });
  }
  observe(id: number, phase: RequestPhase, fields?: Record<string, unknown>) {
    writeOnce(
      resolve(this.path, "requests", `${id}-phase-${randomUUID()}.json`),
      { id, phase, fields, atMs: Date.now() },
    );
  }
}
/** Cross-release recovery is explicitly pinned to a sealed parent, never a funded
 * qualification bypass for normal live commands. Check mode operates on a backup.
 * Close mode collects fresh facts again and CAS-checks the original attempt in SQLite. */
export async function runExpiredRecovery(
  root: string,
  candidate: ReturnType<typeof verifyCandidateIdentity>,
  proposalPath: string,
  activationPath: string,
  attemptId: string,
  parentManifest: string,
  mode: string,
) {
  const scope = candidate.manifest.recoveryScope;
  const kind: RecoveryKind =
    mode === "--close-expired-signed-unsent" ? "SIGNED_UNSENT" : "UNSIGNED";
  const terminal =
    kind === "UNSIGNED"
      ? "ABANDONED_EXPIRED_UNSIGNED"
      : "ABANDONED_EXPIRED_SIGNED_UNSENT";
  if (
    !(
      (candidate.manifest.releaseKind === "RECOVERY_ONLY" &&
        candidate.manifest.fundedReleaseAllowed === false) ||
      (candidate.manifest.releaseKind === "SUPERVISED_CALIBRATION" &&
        scope?.mode === "SELF")
    ) ||
    scope?.policy !== RECOVERY_POLICY.version ||
    (kind === "SIGNED_UNSENT" && scope?.signedUnsent !== true) ||
    ![
      "--check-only",
      "--close-expired-unsigned",
      "--close-expired-signed-unsent",
    ].includes(mode)
  )
    throw Error("RECOVERY_RELEASE_OR_MODE");
  const stage = new LiveStaging(
    root,
    realpathSync(proposalPath),
    realpathSync(parentManifest),
  );
  if (
    stage.proposal.candidateDigest !==
    (scope.mode === "SELF"
      ? candidate.candidateDigest
      : scope.parentCandidateDigest)
  )
    throw Error("RECOVERY_PARENT_BINDING");
  stage.verifyIdentity();
  stage.assertOwnedWalletClaim();
  if (realpathSync(activationPath) !== stage.activePath)
    throw Error("ACTIVATED_PROTOCOL_PATH_REQUIRED");
  const active = stage.readActive(),
    p = active.protocol;
  const run = resolve(root, "var/minimum-live", p.experimentId),
    db = resolve(run, "live.sqlite");
  if (!existsSync(db)) throw Error("RECOVERY_EXISTING_JOURNAL_REQUIRED");
  const output = resolve(run, `expired-recovery-${Date.now()}-${randomUUID()}`);
  mkdirSync(output, { mode: 0o700 });
  writeOnce(resolve(output, "IDENTITY.json"), {
    candidateDigest: candidate.candidateDigest,
    parentCandidateDigest: scope.parentCandidateDigest,
    proposalDigest: stage.proposalDigest,
    protocolDigest: active.protocolDigest,
    wallet: p.wallet,
    attemptId,
    mode,
    policy: RECOVERY_POLICY,
  });
  const source = new Database(db, { readonly: true, fileMustExist: true });
  try {
    await source.backup(resolve(output, "journal-before.sqlite"));
  } finally {
    source.close();
  }
  const copy = new LiveJournal(
    resolve(output, "journal-before.sqlite"),
    active.protocolDigest,
  );
  let original: LiveAttempt, position: string, journalDigest: string;
  try {
    if (kind === "UNSIGNED") copy.assertNoSignedHistory(attemptId);
    else copy.assertSignedUnsentHistory(attemptId);
    const a = copy.get(attemptId);
    if (!a) throw Error("ATTEMPT_NOT_FOUND");
    original = a;
    journalDigest = copy.recoveryDigest();
    position = copy.status().positionRaw;
    if (a.state === terminal) {
      const r = a.data.recoveryReceipt as ReturnType<
        typeof assessExpiredRecovery
      >;
      if (
        !r ||
        r.state !== terminal ||
        (kind === "SIGNED_UNSENT" &&
          (r.kind !== kind ||
            r.signature !== a.data.signature ||
            r.signedTransactionDigest !==
              digest(
                Buffer.from(String(a.data.signedTransaction), "base64"),
              ))) ||
        r.protocolDigest !== active.protocolDigest ||
        r.attemptId !== attemptId ||
        r.evidenceDigest !== digest(JSON.stringify(r.evidence)) ||
        r.messageDigest !== (a.data.review as TransactionReview).messageDigest
      )
        throw Error("RECOVERY_TERMINAL_RECEIPT_INVALID");
      writeOnce(resolve(output, "EXISTING-CLOSURE.json"), r);
      if (mode === "--check-only")
        return {
          result: "ALREADY_ABANDONED_CLAIM_RETAINED",
          output,
          claimReleased: false,
        };
      // Crash after SQLite commit / before claim release: never repeat chain recovery
      // or rewrite the terminal event. Revalidate the durable closure in the original.
      const current = new LiveJournal(db, active.protocolDigest);
      let closed;
      try {
        if (
          digest(JSON.stringify(current.get(attemptId))) !==
          digest(JSON.stringify(a))
        )
          throw Error("RECOVERY_JOURNAL_CHANGED");
        closed = current.status().closed;
      } finally {
        current.close();
      }
      const claimReleased = closed ? stage.releaseClosedWalletClaim() : false;
      writeOnce(resolve(output, "RESULT.json"), {
        result: "EXISTING_CLOSURE_RESUMED",
        claimReleased,
      });
      return { result: "EXISTING_CLOSURE_RESUMED", output, claimReleased };
    }
    if (copy.status().obligations.length !== 1)
      throw Error("RECOVERY_OTHER_OBLIGATIONS");
    const request = JSON.parse(
      readFileSync(resolve(run, `${attemptId}-signing-request.json`), "utf8"),
    );
    const subject = recoverySubject(p, a, position, Date.now(), kind);
    if (
      request.protocolDigest !== active.protocolDigest ||
      request.wallet !== p.wallet ||
      request.attemptId !== attemptId ||
      request.unsignedTransaction !== a.data.unsignedTransaction ||
      request.review?.messageDigest !== subject.review.messageDigest ||
      Date.now() < request.expiresAtMs
    )
      throw Error("RECOVERY_EXPORTED_REQUEST_BINDING");
    if (
      subject.review.usdcAccount !==
        (await associatedAccount(p.wallet, USDC_MINT)) ||
      subject.review.wsolAccount !==
        (await associatedAccount(p.wallet, WSOL_MINT))
    )
      throw Error("RECOVERY_ATA_BINDING");
  } finally {
    copy.close();
  }
  const rpc =
    process.env.MINIMUM_LIVE_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const audit = new RecoveryAudit(
    output,
    Date.now() + RECOVERY_POLICY.maxDurationMs,
    rpc,
  );
  const network = new JupiterManagedNetwork(
    rpc,
    false,
    undefined,
    () => {},
    audit,
  );
  try {
    const evidence = await collectExpiredRecovery(
      p,
      original,
      position,
      network,
      Date.now,
      kind,
    );
    const receipt = assessExpiredRecovery(
      p,
      original,
      position,
      evidence,
      Date.now(),
      kind,
    );
    writeOnce(resolve(output, "ELIGIBILITY.json"), receipt);
    if (mode === "--check-only")
      return { result: "ELIGIBLE_NOT_APPLIED", output, claimReleased: false };
    stage.verifyIdentity();
    stage.assertOwnedWalletClaim();
    stage.readActive();
    audit.assertCurrent();
    const live = new LiveJournal(db, active.protocolDigest);
    let committed;
    try {
      committed = live.atomic(() => {
        if (
          live.recoveryDigest() !== journalDigest ||
          digest(JSON.stringify(live.get(attemptId))) !== receipt.attemptDigest
        )
          throw Error("RECOVERY_JOURNAL_CHANGED");
        const executor = new LiveExecutor(live, p, network);
        // All external requests and the immutable eligibility receipt already persisted.
        for (let i = 0; i < network.requestEvidence().length; i++)
          live.claimRequest("READ");
        return kind === "UNSIGNED"
          ? executor.abandonExpiredUnsigned(attemptId, evidence)
          : executor.abandonExpiredSignedUnsent(attemptId, evidence);
      });
    } finally {
      live.close();
    }
    writeOnce(resolve(output, "CLOSURE.json"), committed);
    const after = new LiveJournal(db, active.protocolDigest);
    let closed;
    try {
      closed = after.status().closed;
    } finally {
      after.close();
    }
    const claimReleased = closed ? stage.releaseClosedWalletClaim() : false;
    writeOnce(resolve(output, "RESULT.json"), {
      result: terminal,
      claimReleased,
    });
    return { result: terminal, output, claimReleased };
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "RECOVERY_FAILED_REVIEW_EVIDENCE";
    writeOnce(resolve(output, "FAILURE.json"), {
      code,
      requestLedger: network.requestEvidence(),
      atMs: Date.now(),
    });
    throw Error(code);
  }
}
