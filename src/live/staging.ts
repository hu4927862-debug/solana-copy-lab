import { verifyCandidateIdentity } from "./candidate.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  ProtocolSchema,
  protocolDigest,
  digest,
  type LiveProtocol,
} from "./protocol.js";
import { LiveJournal } from "./journal.js";
import { LiveExecutor } from "./executor.js";
import type { LiveNetwork } from "./adapters.js";

type Network = LiveNetwork & { verifyCluster(): Promise<void> };
const decisionSchema = z
  .object({
    decision: z.literal("APPROVE_FUNDS"),
    proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
    candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
    wallet: z.string(),
    operator: z.string().min(1),
    userStatement: z.string().min(1),
    sourceReference: z.string().min(1),
  })
  .strict();
type Active = {
  version: "LIVE_ACTIVATION_V1";
  proposalDigest: string;
  approvalDigest: string;
  preflightDigest: string;
  protocolDigest: string;
  protocol: LiveProtocol;
  requestCount: number;
};
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
export function writeOnce(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const fd = openSync(path, "wx", 0o600);
  try {
    const data = Buffer.from(JSON.stringify(value, null, 2) + "\n");
    let at = 0;
    while (at < data.length) at += writeSync(fd, data, at);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dir = openSync(parent, "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/** Public approval/unsigned-preflight/activation boundary. No key, signing or submission method. */
export class LiveStaging {
  readonly proposal: any;
  readonly proposalDigest: string;
  readonly stagePath: string;
  readonly activePath: string;
  readonly walletClaimPath: string;
  constructor(
    readonly root: string,
    readonly proposalPath: string,
    readonly manifestPath: string,
    private now: () => number = Date.now,
  ) {
    this.root = realpathSync(root);
    this.proposal = read(proposalPath);
    this.proposalDigest = digest(JSON.stringify(this.proposal));
    if (
      this.proposal.status !== "PROPOSED" ||
      this.proposal.fundsAuthorized !== false ||
      this.proposal.executionProtocolTemplate?.approval !== "PROPOSED" ||
      this.proposal.candidateDigest !==
        this.proposal.executionProtocolTemplate.candidateDigest
    )
      throw Error("PROPOSAL_REQUIRED");
    this.protocolAt(0, "PROPOSED");
    this.stagePath = resolve(
      this.root,
      "var/minimum-live-staging",
      this.proposalDigest,
    );
    this.activePath = resolve(this.stagePath, "active.json");
    this.walletClaimPath = resolve(
      this.root,
      "var/minimum-live-wallet-claims",
      `${this.proposal.executionProtocolTemplate.wallet}.json`,
    );
  }
  private claimIdentity() {
    return {
      version: "LIVE_WALLET_LIABILITY_CLAIM_V1",
      wallet: this.proposal.executionProtocolTemplate.wallet as string,
      proposalDigest: this.proposalDigest,
      candidateDigest: this.proposal.candidateDigest as string,
      experimentId: this.proposal.executionProtocolTemplate.experimentId as string,
    };
  }
  private existingClaim(): unknown {
    if (!existsSync(this.walletClaimPath)) return null;
    try {
      return read(this.walletClaimPath);
    } catch {
      throw Error("WALLET_LIABILITY_CLAIM_INVALID");
    }
  }
  private assertAvailableClaim(): void {
    const existing = this.existingClaim();
    if (existing && JSON.stringify(existing) !== JSON.stringify(this.claimIdentity()))
      throw Error("WALLET_LIABILITY_CLAIMED");
  }
  assertOwnedWalletClaim(): void {
    const existing = this.existingClaim();
    if (!existing || JSON.stringify(existing) !== JSON.stringify(this.claimIdentity()))
      throw Error("WALLET_LIABILITY_CLAIM_MISSING_OR_DIFFERENT");
  }
  private acquireWalletClaim(): void {
    this.assertAvailableClaim();
    if (existsSync(this.walletClaimPath)) return;
    try {
      writeOnce(this.walletClaimPath, this.claimIdentity());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      this.assertAvailableClaim();
    }
  }
  /** Only durable settled/failed/cancelled evidence in the original journal releases this wallet. */
  releaseClosedWalletClaim(): boolean {
    if (!existsSync(this.walletClaimPath)) return false;
    this.assertOwnedWalletClaim();
    const active = this.readActive();
    const dbPath = resolve(
      this.root,
      "var/minimum-live",
      active.protocol.experimentId,
      "live.sqlite",
    );
    if (!existsSync(dbPath)) throw Error("WALLET_LIABILITY_JOURNAL_MISSING");
    const journal = new LiveJournal(dbPath, active.protocolDigest);
    try {
      if (!journal.status().closed) throw Error("WALLET_LIABILITY_NOT_CLOSED");
    } finally {
      journal.close();
    }
    unlinkSync(this.walletClaimPath);
    const dir = openSync(dirname(this.walletClaimPath), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
    return true;
  }
  private protocolAt(
    t0: number,
    approval: "PROPOSED" | "FUNDS_AUTHORIZED",
  ): LiveProtocol {
    return ProtocolSchema.parse({
      ...this.proposal.executionProtocolTemplate,
      approval,
      validFromMs: t0,
      entryUntilMs: t0 + 300000,
      exitUntilMs: t0 + 1800000,
    });
  }
  verifyIdentity(): void {
    verifyCandidateIdentity(this.manifestPath, this.proposal.candidateDigest);
  }
  verifyCandidate(): void {
    const { manifest: m } = verifyCandidateIdentity(this.manifestPath, this.proposal.candidateDigest);
    if (m.fundedReleaseAllowed !== true ||
        !m.fundedTransports?.includes(this.proposal.executionProtocolTemplate.transport))
      throw Error("CANDIDATE_NOT_ELIGIBLE");
    if (m.releaseKind === "SUPERVISED_CALIBRATION") {
      const scope = m.fundedScope;
      if (!scope?.protocolFields || scope.entryWindowMs !== 300000 || scope.exitWindowMs !== 1800000 ||
          scope.buyLimit !== 1 || scope.sellPolicy !== "FULL_SELL_ONLY" ||
          Object.entries(scope.protocolFields).some(([key, value]) =>
            this.proposal.executionProtocolTemplate[key] !== value))
        throw Error("CALIBRATION_RELEASE_SCOPE_MISMATCH");
    }
  }
  recordApproval(raw: unknown): unknown {
    this.verifyCandidate();
    const decision = decisionSchema.parse(raw);
    if (
      decision.proposalDigest !== this.proposalDigest ||
      decision.candidateDigest !== this.proposal.candidateDigest ||
      decision.wallet !== this.proposal.executionProtocolTemplate.wallet
    )
      throw Error("APPROVAL_BINDING_MISMATCH");
    const path = resolve(this.stagePath, "approval.json");
    if (existsSync(path)) {
      const existing = this.approval();
      if (JSON.stringify(existing.decision) !== JSON.stringify(decision))
        throw Error("APPROVAL_ALREADY_RECORDED");
      return existing;
    }
    const receipt = {
      version: "LIVE_HUMAN_APPROVAL_V1",
      status: "FUNDS_AUTHORIZED",
      decision,
      recordedAtMs: this.now(),
      T0: null,
    };
    writeOnce(path, receipt);
    return receipt;
  }
  private approval(): any {
    const path = resolve(this.stagePath, "approval.json");
    if (!existsSync(path)) throw Error("USER_APPROVAL_REQUIRED");
    const receipt = read(path),
      d = decisionSchema.parse(receipt.decision);
    if (
      receipt.version !== "LIVE_HUMAN_APPROVAL_V1" ||
      receipt.status !== "FUNDS_AUTHORIZED" ||
      d.proposalDigest !== this.proposalDigest ||
      d.candidateDigest !== this.proposal.candidateDigest ||
      d.wallet !== this.proposal.executionProtocolTemplate.wallet
    )
      throw Error("APPROVAL_BINDING_MISMATCH");
    return receipt;
  }
  status() {
    return {
      proposalDigest: this.proposalDigest,
      approvalRecorded: existsSync(resolve(this.stagePath, "approval.json")),
      T0: existsSync(this.activePath)
        ? this.readActive().protocol.validFromMs
        : null,
      requestCount: this.requestCount(),
    };
  }
  requestCount(): number {
    const p = resolve(this.stagePath, "requests");
    return existsSync(p)
      ? readdirSync(p).filter((n) => /^\d+\.json$/.test(n)).length
      : 0;
  }
  claimRequest(kind: "READ" | "NEW_EXECUTION"): void {
    this.approval();
    const path = resolve(this.stagePath, "requests");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    for (let n = 1; n <= 200; n++) {
      try {
        writeOnce(resolve(path, `${n}.json`), { kind, atMs: this.now() });
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    throw Error("STAGING_REQUEST_BUDGET_EXHAUSTED");
  }
  async preflight(network: Network): Promise<any> {
    this.approval();
    this.verifyCandidate();
    this.assertAvailableClaim();
    if (existsSync(this.activePath))
      throw Error("ALREADY_ACTIVATED_USE_LIVE_JOURNAL");
    if (this.requestCount() >= 200)
      throw Error("STAGING_REQUEST_BUDGET_EXHAUSTED");
    const started = this.now(),
      protocol = this.protocolAt(started, "PROPOSED");
    await network.verifyCluster();
    // Reuse the exact existing executor review, simulation and reserve checks in ephemeral memory.
    const memory = new LiveJournal(":memory:", protocolDigest(protocol));
    try {
      const executor = new LiveExecutor(memory, protocol, network, this.now),
        attempt = await executor.prepare("BUY");
      const before = attempt.data.before as { walletLamports: string };
      if (
        BigInt(before.walletLamports) >
        BigInt(this.proposal.budget.maxCreditAfterExternalFeeReserveLamports)
      )
        throw Error("EXTERNAL_FUNDING_FEE_RESERVE_REQUIRED");
      const result = {
        kind: "UNSIGNED_PREFLIGHT_PASS",
        proposalDigest: this.proposalDigest,
        candidateDigest: this.proposal.candidateDigest,
        startedAtMs: started,
        completedAtMs: this.now(),
        requestCount: this.requestCount(),
        attempt,
        signCalls: 0,
        submitCalls: 0,
        persistentLedgerCreated: false,
        T0: null,
      };
      writeOnce(
        resolve(this.stagePath, `preflight-${this.now()}-${randomUUID()}.json`),
        result,
      );
      return result;
    } catch (e) {
      writeOnce(
        resolve(
          this.stagePath,
          `preflight-failed-${this.now()}-${randomUUID()}.json`,
        ),
        {
          proposalDigest: this.proposalDigest,
          atMs: this.now(),
          failure: e instanceof Error ? e.message : "UNKNOWN",
          attempt: memory.get("BUY") ?? null,
          diagnostic:
            e && typeof e === "object" && "diagnostic" in e
              ? e.diagnostic
              : null,
          signCalls: 0,
          submitCalls: 0,
          T0: null,
        },
      );
      throw e;
    } finally {
      memory.close();
    }
  }
  async activate(network: Network): Promise<Active> {
    this.approval();
    this.verifyCandidate();
    this.assertAvailableClaim();
    if (existsSync(this.activePath)) {
      this.assertOwnedWalletClaim();
      return this.readActive();
    }
    const preflight = await this.preflight(network),
      t0 = this.now();
    if (
      t0 >= Number(preflight.attempt.data.quoteExpiresAtMs ?? Infinity) ||
      t0 - preflight.completedAtMs > 60000 ||
      t0 - Number(preflight.attempt.data.reviewedAtMs) > 60000
    )
      throw Error("ACTIVATION_PREFLIGHT_STALE");
    const protocol = this.protocolAt(t0, "FUNDS_AUTHORIZED");
    const active: Active = {
      version: "LIVE_ACTIVATION_V1",
      proposalDigest: this.proposalDigest,
      approvalDigest: digest(JSON.stringify(this.approval())),
      preflightDigest: digest(JSON.stringify(preflight)),
      protocolDigest: protocolDigest(protocol),
      protocol,
      requestCount: this.requestCount(),
    };
    this.acquireWalletClaim();
    writeOnce(this.activePath, active);
    return active;
  }
  readActive(): Active {
    const a = read(this.activePath) as Active;
    if (
      a.version !== "LIVE_ACTIVATION_V1" ||
      a.proposalDigest !== this.proposalDigest ||
      a.approvalDigest !== digest(JSON.stringify(this.approval())) ||
      a.protocolDigest !== protocolDigest(a.protocol) ||
      JSON.stringify(a.protocol) !==
        JSON.stringify(
          this.protocolAt(a.protocol.validFromMs, "FUNDS_AUTHORIZED"),
        ) ||
      !Number.isSafeInteger(a.requestCount) ||
      a.requestCount < 0 ||
      a.requestCount > 200
    )
      throw Error("ACTIVATION_BINDING_MISMATCH");
    const evidence = readdirSync(this.stagePath)
      .filter((n) => /^preflight-\d/.test(n))
      .map((n) => read(resolve(this.stagePath, n)))
      .find((p) => digest(JSON.stringify(p)) === a.preflightDigest);
    if (
      !evidence ||
      evidence.proposalDigest !== this.proposalDigest ||
      evidence.kind !== "UNSIGNED_PREFLIGHT_PASS" ||
      a.protocol.validFromMs < evidence.completedAtMs ||
      a.protocol.validFromMs - evidence.completedAtMs > 60000
    )
      throw Error("ACTIVATION_PREFLIGHT_BINDING_MISMATCH");
    return a;
  }
}
