import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  fsyncSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {assessExpiredRecovery,type RecoveryEvidence} from "../live/expired-recovery.js";
import {parseExecutionProtocol,protocolDigest as executionProtocolDigest} from "../live/protocol.js";
import type {LiveAttempt} from "../live/journal.js";

/** Structural interface implemented by the existing sealed Research Store. */
export interface ExistingStageStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  atomic<T>(fn: () => T): T;
  event(type: string, data: unknown, id?: string): unknown;
}
export interface CapitalIdentity {
  wallet: string;
  releaseDigest: string;
  policyDigest: string;
  authorizationDigest: string;
}
export interface CapitalReservation {
  id: string;
  episodeId: string;
  protocolDigest: string;
  journalPath: string;
  principalRaw: string;
  feeBudgetRaw: string;
  rentCapRaw: string;
  exitReserveRaw: string;
  cnyPerSolMicro: number;
  valuationAtMs: number;
  valuationExpiresAtMs: number;
}
export type UnpreparedEpisodeReference = Pick<
  CapitalReservation,
  "id" | "episodeId" | "protocolDigest" | "journalPath" | "principalRaw"
>;
interface Stage {
  wallet: string;
  scope: {
    stageMicroCny: number;
    ticketRaw: string;
    ticketMicroCny: number;
    costReserveMicroCny: number;
    batchMicroCny: number;
  };
  spentMicroCny: number;
  carry: {
    spentMicroCny: number;
    rentHeldMicroCny: number;
    unknownReserveMicroCny: number;
    [key: string]: unknown;
  };
  obligation: unknown;
  actualReviewRequired?: string | null;
  [key: string]: unknown;
}
interface ReservationRecord extends CapitalReservation {
  identity: CapitalIdentity;
  reservedMicroCny: number;
  barrier: string;
  createdAtMs: number;
  budgetBasisDigest: string;
}
interface Bridge {
  version: "AUTONOMOUS_STAGE_RESERVATIONS_V1";
  active: ReservationRecord | null;
  outcomes: Record<
    string,
    {
      reservation: ReservationRecord;
      kind: string;
      journalEvidenceDigest: string;
      lossMicroCny: number;
      netCashflowRaw: string;
      roundtripCompleted?: boolean;
      submittedBuy?: boolean;
      atMs: number;
    }
  >;
}
const STAGE = "humanFollow:v1",
  KEY = "autonomousCapital:v1";
const need = (v: unknown, code: string): void => {
  if (!v) throw Error(code);
};
const normalize = (v: unknown): unknown =>
  v && typeof v === "object"
    ? Array.isArray(v)
      ? v.map(normalize)
      : Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, normalize(x)]),
        )
    : v;
const encode = (v: unknown) => JSON.stringify(normalize(v));
const digest = (v: unknown) =>
  createHash("sha256").update(encode(v)).digest("hex");
const uint = (v: unknown): bigint => {
  need(
    typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v),
    "CAPITAL_RAW_AMOUNT_INVALID",
  );
  return BigInt(v as string);
};
const whole = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const ceilCny = (raw: bigint, rate: number) => {
  const n = (raw * BigInt(rate) + 999999999n) / 1000000000n;
  need(n <= BigInt(Number.MAX_SAFE_INTEGER), "CAPITAL_VALUATION_OVERFLOW");
  return Number(n);
};
function syncDirectory(p: string) {
  const fd = openSync(p, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Capital reservation is written in the SAME historical stage database. Its
 * existing spent/carry totals remain authoritative; this bridge contains only
 * reservation and idempotent settlement references, never another position.
 * No constructor side effect and no approval or network authority is created.
 */
export class StageCapitalControls {
  private readonly now: () => number;
  constructor(
    private readonly options: {
      store: ExistingStageStore;
      sourceStageWallet: string;
      claimDirectory: string;
      identity: CapitalIdentity;
      experiment?: { maxClosedOutcomes: number; maxRealizedLossMicroCny: number };
      now?: () => number;
      crashPoint?: (
        point: "CLAIM_CREATED" | "STAGE_RESERVED" | "STAGE_SETTLED",
      ) => void;
    },
  ) {
    const i = options.identity;
    need(
      [i.wallet, options.sourceStageWallet].every(
        (w) => typeof w === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w),
      ) &&
        [i.releaseDigest, i.policyDigest, i.authorizationDigest].every((d) =>
          /^[a-f0-9]{64}$/.test(d),
        ),
      "CAPITAL_IDENTITY_INVALID",
    );
    this.now = options.now ?? Date.now;
    if (options.experiment)
      need(
        whole(options.experiment.maxClosedOutcomes) &&
          options.experiment.maxClosedOutcomes > 0 &&
          whole(options.experiment.maxRealizedLossMicroCny) &&
          options.experiment.maxRealizedLossMicroCny > 0,
        "CAPITAL_EXPERIMENT_LIMIT_INVALID",
      );
    this.stage(); // Existing state is mandatory; no fabricated carry or new stage.
  }
  private stage(): Stage {
    const s = this.options.store.get(STAGE) as Stage | undefined;
    need(
      s && s.wallet === this.options.sourceStageWallet && s.scope && s.carry,
      "CAPITAL_EXISTING_STAGE_REQUIRED",
    );
    need(
      [
        s!.spentMicroCny,
        s!.scope.stageMicroCny,
        s!.scope.ticketMicroCny,
        s!.scope.costReserveMicroCny,
        s!.scope.batchMicroCny,
        s!.carry.spentMicroCny,
        s!.carry.rentHeldMicroCny,
        s!.carry.unknownReserveMicroCny,
      ].every(whole),
      "CAPITAL_STAGE_BUDGET_INVALID",
    );
    return s!;
  }
  private bridge(): Bridge {
    return (
      (this.options.store.get(KEY) as Bridge) ?? {
        version: "AUTONOMOUS_STAGE_RESERVATIONS_V1",
        active: null,
        outcomes: {},
      }
    );
  }
  private experimentProgress(bridge: Bridge) {
    const outcomes = Object.values(bridge.outcomes).filter(
      (x) => encode(x.reservation.identity) === encode(this.options.identity),
    );
    need(outcomes.every((x) => whole(x.lossMicroCny)), "CAPITAL_EXPERIMENT_OUTCOME_INVALID");
    const loss = outcomes.reduce((n, x) => n + x.lossMicroCny, 0);
    need(whole(loss), "CAPITAL_EXPERIMENT_LOSS_OVERFLOW");
    return {
      closed: outcomes.filter((x) => x.roundtripCompleted === true).length,
      submittedBuys: outcomes.filter((x) => x.submittedBuy === true).length,
      loss,
    };
  }
  private assertExperimentHeadroom(bridge: Bridge, prospectiveLossMicroCny: number) {
    const limit = this.options.experiment;
    if (!limit) return;
    const p = this.experimentProgress(bridge);
    need(p.closed < limit.maxClosedOutcomes, "EXPERIMENT_CLOSED_OUTCOME_LIMIT");
    need(p.submittedBuys < limit.maxClosedOutcomes, "EXPERIMENT_BUY_ATTEMPT_LIMIT");
    need(
      p.loss + prospectiveLossMicroCny <= limit.maxRealizedLossMicroCny,
      "EXPERIMENT_LOSS_HEADROOM",
    );
  }
  experimentEntryReason(input: {
    principalRaw: string;
    feeBudgetRaw: string;
    rentCapRaw: string;
    cnyPerSolMicro: number;
  }): string | null {
    const prospective = ceilCny(
      uint(input.principalRaw) + uint(input.feeBudgetRaw) + uint(input.rentCapRaw),
      input.cnyPerSolMicro,
    );
    try {
      this.assertExperimentHeadroom(this.bridge(), prospective);
      return null;
    } catch (error) {
      if (error instanceof Error && [
        "EXPERIMENT_CLOSED_OUTCOME_LIMIT",
        "EXPERIMENT_BUY_ATTEMPT_LIMIT",
        "EXPERIMENT_LOSS_HEADROOM",
      ].includes(error.message)) return error.message;
      throw error;
    }
  }
  private claimPaths() {
    return [
      ...new Set([
        this.options.sourceStageWallet,
        this.options.identity.wallet,
      ]),
    ]
      .sort()
      .map((wallet) => join(this.options.claimDirectory, wallet + ".json"));
  }
  private claim(record: CapitalReservation) {
    return {
      version: "AUTONOMOUS_WALLET_LIABILITY_CLAIM_V1",
      ...this.options.identity,
      sourceStageWallet: this.options.sourceStageWallet,
      reservationId: record.id,
      episodeId: record.episodeId,
      protocolDigest: record.protocolDigest,
      journalPath: record.journalPath,
    };
  }
  private assertClaimFile(
    record: CapitalReservation,
    p: string,
    allowMissing = false,
  ) {
    if (allowMissing && !existsSync(p)) return;
    need(existsSync(p), "CAPITAL_GLOBAL_CLAIM_MISSING");
    const s = lstatSync(p);
    need(s.isFile() && !s.isSymbolicLink(), "CAPITAL_GLOBAL_CLAIM_TYPE");
    let got: unknown;
    try {
      got = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      throw Error("CAPITAL_GLOBAL_CLAIM_INVALID");
    }
    need(
      encode(got) === encode(this.claim(record)),
      "CAPITAL_GLOBAL_WALLET_ALREADY_CLAIMED",
    );
  }
  private assertClaim(record: CapitalReservation, allowMissing = false) {
    for (const p of this.claimPaths())
      this.assertClaimFile(record, p, allowMissing);
  }
  private acquireClaim(record: CapitalReservation) {
    mkdirSync(this.options.claimDirectory, { recursive: true, mode: 0o700 });
    need(
      !lstatSync(this.options.claimDirectory).isSymbolicLink(),
      "CAPITAL_CLAIM_DIRECTORY_SYMLINK",
    );
    for (const p of this.claimPaths()) {
      if (existsSync(p)) {
        this.assertClaimFile(record, p);
        continue;
      }
      let fd: number;
      try {
        fd = openSync(p, "wx", 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          this.assertClaimFile(record, p);
          continue;
        }
        throw e;
      }
      try {
        writeFileSync(fd, encode(this.claim(record)) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    syncDirectory(this.options.claimDirectory);
  }
  reserve(input: CapitalReservation): ReservationRecord {
    need(
      [input.id, input.episodeId].every(
        (v) => typeof v === "string" && v.length > 0,
      ) &&
        /^[a-f0-9]{64}$/.test(input.protocolDigest) &&
        isAbsolute(input.journalPath) &&
        resolve(input.journalPath) === input.journalPath,
      "CAPITAL_RESERVATION_IDENTITY_INVALID",
    );
    const principal = uint(input.principalRaw),
      fee = uint(input.feeBudgetRaw),
      rent = uint(input.rentCapRaw),
      exit = uint(input.exitReserveRaw);
    need(
      principal > 0n &&
        whole(input.cnyPerSolMicro) &&
        input.cnyPerSolMicro > 0 &&
        whole(input.valuationAtMs) &&
        whole(input.valuationExpiresAtMs) &&
        input.valuationAtMs <= this.now() &&
        this.now() < input.valuationExpiresAtMs &&
        input.valuationExpiresAtMs - input.valuationAtMs <= 3600000,
      "CAPITAL_FRESH_VALUATION_REQUIRED",
    );
    const priorStage = this.stage(),
      scope = priorStage.scope,
      principalCny = ceilCny(principal, input.cnyPerSolMicro);
    need(
      principal <= uint(scope.ticketRaw) &&
        principalCny <= scope.ticketMicroCny,
      "CAPITAL_TICKET_LIMIT",
    );
    // Retain original stage's per-ticket unknown-cost reserve. Also reserve any
    // larger explicitly configured fee/rent/exit envelope, conservatively.
    const reservedMicroCny = Math.max(
      principalCny + scope.costReserveMicroCny,
      ceilCny(principal + fee + rent + exit, input.cnyPerSolMicro),
    );
    need(reservedMicroCny <= scope.batchMicroCny, "CAPITAL_ALLOCATION_LIMIT");
    const prospectiveLossMicroCny = ceilCny(
      principal + fee + rent,
      input.cnyPerSolMicro,
    ); // exit reserve is retained SOL, not a spend
    if (!this.bridge().active)
      this.assertExperimentHeadroom(this.bridge(), prospectiveLossMicroCny);
    const record: ReservationRecord = {
      ...input,
      identity: this.options.identity,
      reservedMicroCny,
      barrier:
        "AUTONOMOUS_CAPITAL_RESERVATION:" +
        digest([this.options.identity, input]),
      createdAtMs: this.now(),
      budgetBasisDigest: digest({
        scope,
        carry: priorStage.carry,
        spentMicroCny: priorStage.spentMicroCny,
      }),
    };
    need(!this.bridge().outcomes[input.id], "CAPITAL_RESERVATION_ALREADY_USED");
    need(!priorStage.obligation, "CAPITAL_EXISTING_HUMAN_OBLIGATION");
    // File first excludes Manual; then atomic stage barrier excludes the old
    // FollowBook.beginBuy even if it checked the file just before this creation.
    this.acquireClaim(record);
    this.options.crashPoint?.("CLAIM_CREATED");
    const result = this.options.store.atomic(() => {
      this.assertClaim(record);
      const stage = this.stage(),
        b = this.bridge();
      need(!stage.obligation, "CAPITAL_EXISTING_HUMAN_OBLIGATION");
      need(
        digest({
          scope: stage.scope,
          carry: stage.carry,
          spentMicroCny: stage.spentMicroCny,
        }) === record.budgetBasisDigest,
        "CAPITAL_BUDGET_BASIS_CHANGED",
      );
      if (b.active) {
        need(
          encode({ ...b.active, createdAtMs: 0 }) ===
            encode({ ...record, createdAtMs: 0 }),
          "CAPITAL_EXISTING_RESERVATION",
        );
        need(
          stage.actualReviewRequired === b.active.barrier,
          "CAPITAL_STAGE_BARRIER_CHANGED",
        );
        return b.active;
      }
      need(!b.outcomes[input.id], "CAPITAL_RESERVATION_ALREADY_USED");
      need(!stage.actualReviewRequired, "CAPITAL_EXISTING_STAGE_REVIEW");
      this.assertExperimentHeadroom(b, prospectiveLossMicroCny);
      need(
        stage.spentMicroCny +
          stage.carry.rentHeldMicroCny +
          stage.carry.unknownReserveMicroCny +
          reservedMicroCny <=
          scope.stageMicroCny,
        "CAPITAL_CUMULATIVE_STAGE_LIMIT",
      );
      stage.actualReviewRequired = record.barrier;
      b.active = record;
      this.options.store.set(STAGE, stage);
      this.options.store.set(KEY, b);
      this.options.store.event(
        "AUTONOMOUS_CAPITAL_RESERVED",
        { reservation: record },
        "autonomous-capital-reserve:" + record.id,
      );
      return record;
    });
    this.options.crashPoint?.("STAGE_RESERVED");
    return result;
  }
  assertReserved(id: string): ReservationRecord {
    const b = this.bridge(),
      r = b.active;
    need(
      r && r.id === id && encode(r.identity) === encode(this.options.identity),
      "CAPITAL_RESERVATION_REQUIRED",
    );
    this.assertClaim(r!);
    const s = this.stage();
    need(
      !s.obligation && s.actualReviewRequired === r!.barrier,
      "CAPITAL_STAGE_RESPONSIBILITY_CHANGED",
    );
    need(
      digest({
        scope: s.scope,
        carry: s.carry,
        spentMicroCny: s.spentMicroCny,
      }) === r!.budgetBasisDigest,
      "CAPITAL_BUDGET_BASIS_CHANGED",
    );
    return r!;
  }
  closeFinalized(id: string) {
    return this.close(id, false);
  }
  releaseUnprepared(id: string) {
    return this.close(id, true);
  }
  /** Explicit operator closure after a crash between runtime claim and capital
   * reserve. No global claim may exist: an orphan claim requires separate review.
   * This records absence proof, never fabricates a reservation or changes budget. */
  confirmUnreservedEpisode(reference: UnpreparedEpisodeReference) {
    need(
      reference.id === reference.episodeId &&
        reference.id.length > 0 &&
        /^[a-f0-9]{64}$/.test(reference.protocolDigest) &&
        isAbsolute(reference.journalPath) &&
        resolve(reference.journalPath) === reference.journalPath &&
        uint(reference.principalRaw) > 0n,
      "CAPITAL_UNPREPARED_REFERENCE_INVALID",
    );
    const evidence = readCapitalSettlement(reference, true);
    const key = KEY + ":unreserved-closure:" + digest(reference.id);
    return this.options.store.atomic(() => {
      const bridge = this.bridge(),
        stage = this.stage();
      need(
        !bridge.active &&
          !bridge.outcomes[reference.id] &&
          !stage.obligation &&
          !stage.actualReviewRequired,
        "CAPITAL_EXISTING_RESPONSIBILITY",
      );
      need(
        this.claimPaths().every((p) => !existsSync(p)),
        "CAPITAL_ORPHAN_CLAIM_REQUIRES_REVIEW",
      );
      need(
        readCapitalSettlement(reference, true).digest === evidence.digest,
        "CAPITAL_JOURNAL_CHANGED",
      );
      const prior = this.options.store.get(key) as
        Record<string, unknown> | undefined;
      if (prior) {
        need(
          encode(prior.reference) === encode(reference) &&
            encode(prior.identity) === encode(this.options.identity) &&
            prior.journalEvidenceDigest === evidence.digest,
          "CAPITAL_UNPREPARED_RECEIPT_CHANGED",
        );
        return prior;
      }
      const receipt = {
        schema: "AUTONOMOUS_UNPREPARED_CAPITAL_CLOSURE_V1",
        kind: "UNPREPARED_NO_RESERVATION",
        identity: this.options.identity,
        reference,
        journalEvidenceDigest: evidence.digest,
        lossMicroCny: 0,
        netCashflowRaw: "0",
        atMs: this.now(),
      };
      this.options.store.set(key, receipt);
      this.options.store.event(
        "AUTONOMOUS_UNPREPARED_CAPITAL_CLOSED",
        receipt,
        "autonomous-unreserved-close:" + reference.id,
      );
      return receipt;
    });
  }
  private close(id: string, unprepared: boolean) {
    const b = this.bridge(),
      record = b.active?.id === id ? b.active : b.outcomes[id]?.reservation;
    need(
      record && encode(record.identity) === encode(this.options.identity),
      "CAPITAL_RESERVATION_REQUIRED",
    );
    const prior = b.outcomes[id];
    if (prior && this.claimPaths().every((p) => !existsSync(p))) {
      const evidence = readCapitalSettlement(record!, unprepared);
      need(
        prior.kind ===
          (unprepared ? "UNPREPARED_NO_ATTEMPT" : "FINALIZED_JOURNAL_CLOSED") &&
          prior.journalEvidenceDigest === evidence.digest,
        "CAPITAL_SETTLEMENT_EVIDENCE_CHANGED",
      );
      return prior; // Completed idempotent replay still binds the original proof.
    }
    this.assertClaim(record!, !!prior);
    const evidence = readCapitalSettlement(record!, unprepared),
      kind = unprepared ? "UNPREPARED_NO_ATTEMPT" : "FINALIZED_JOURNAL_CLOSED";
    const lossMicroCny = ceilCny(
      evidence.cashflow < 0n ? -evidence.cashflow : 0n,
      record!.cnyPerSolMicro,
    );
    const outcome = this.options.store.atomic(() => {
      this.assertClaim(record!, !!prior);
      const s = this.stage(),
        next = this.bridge();
      const previous = next.outcomes[id];
      if (previous) {
        need(
          previous.journalEvidenceDigest === evidence.digest &&
            previous.kind === kind,
          "CAPITAL_SETTLEMENT_EVIDENCE_CHANGED",
        );
        return previous;
      }
      need(
        next.active?.id === id &&
          !s.obligation &&
          s.actualReviewRequired === record!.barrier,
        "CAPITAL_STAGE_RESPONSIBILITY_CHANGED",
      );
      need(
        digest({
          scope: s.scope,
          carry: s.carry,
          spentMicroCny: s.spentMicroCny,
        }) === record!.budgetBasisDigest,
        "CAPITAL_BUDGET_BASIS_CHANGED",
      );
      need(
        readCapitalSettlement(record!, unprepared).digest === evidence.digest,
        "CAPITAL_JOURNAL_CHANGED",
      );
      s.spentMicroCny += lossMicroCny;
      need(whole(s.spentMicroCny), "CAPITAL_LOSS_OVERFLOW");
      // Profits never restore cumulative budget; historical rent/unknown carry
      // remains untouched. Actual cashflow already includes transaction fees.
      const breach = lossMicroCny > record!.reservedMicroCny;
      s.actualReviewRequired = breach
        ? "AUTONOMOUS_ACTUAL_LOSS_EXCEEDS_RESERVED_REVIEW"
        : null;
      const value = {
        reservation: record!,
        kind,
        journalEvidenceDigest: evidence.digest,
        lossMicroCny,
        netCashflowRaw: evidence.cashflow.toString(),
        roundtripCompleted: evidence.roundtripCompleted,
        submittedBuy: evidence.submittedBuy,
        atMs: this.now(),
      };
      next.outcomes[id] = value;
      next.active = null;
      this.options.store.set(STAGE, s);
      this.options.store.set(KEY, next);
      this.options.store.event(
        "AUTONOMOUS_CAPITAL_SETTLED",
        value,
        "autonomous-capital-settle:" + id,
      );
      return value;
    });
    this.options.crashPoint?.("STAGE_SETTLED");
    this.assertClaim(record!, true);
    for (const p of this.claimPaths())
      if (existsSync(p)) {
        unlinkSync(p);
        syncDirectory(this.options.claimDirectory);
      }
    return outcome;
  }
  inspect() {
    const s = this.stage(),
      b = this.bridge();
    const progress = this.experimentProgress(b);
    return {
      wallet: this.options.identity.wallet,
      sourceStageWallet: s.wallet,
      stageCapMicroCny: s.scope.stageMicroCny,
      spentMicroCny: s.spentMicroCny,
      historicalRentHeldMicroCny: s.carry.rentHeldMicroCny,
      historicalUnknownReserveMicroCny: s.carry.unknownReserveMicroCny,
      reservedMicroCny: b.active?.reservedMicroCny ?? 0,
      remainingAfterHeldMicroCny:
        s.scope.stageMicroCny -
        s.spentMicroCny -
        s.carry.rentHeldMicroCny -
        s.carry.unknownReserveMicroCny -
        (b.active?.reservedMicroCny ?? 0),
      active: b.active,
      walletClaimPresent: this.claimPaths().some((p) => existsSync(p)),
      actualReviewRequired: s.actualReviewRequired ?? null,
      experimentClosedOutcomes: progress.closed,
      experimentSubmittedBuys: progress.submittedBuys,
      experimentRealizedLossMicroCny: progress.loss,
      capitalLedgerKey: STAGE,
      positionSource: "LiveJournal",
      fundedAuthorizationCreated: false,
    };
  }
}

export function readCapitalSettlement(
  record: Pick<
    ReservationRecord,
    "journalPath" | "protocolDigest" | "principalRaw"
  >,
  unprepared: boolean,
) {
  need(
    existsSync(record.journalPath) &&
      lstatSync(record.journalPath).isFile() &&
      !lstatSync(record.journalPath).isSymbolicLink(),
    "CAPITAL_JOURNAL_MISSING",
  );
  const db = new Database(record.journalPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    db.pragma("query_only = ON");
    db.exec("BEGIN");
    const meta = Object.fromEntries(
      (
        db.prepare("SELECT key,value FROM live_meta ORDER BY key").all() as {
          key: string;
          value: string;
        }[]
      ).map((r) => [r.key, r.value]),
    );
    const attempts = db
      .prepare("SELECT * FROM live_attempts ORDER BY id")
      .all() as {
      id: string;
      side: string;
      amount: string;
      state: string;
      data: string;
    }[];
    const settlements = db
      .prepare("SELECT * FROM live_settlements ORDER BY signature")
      .all() as { signature: string; attempt_id: string; evidence: string }[];
    const events = db
      .prepare("SELECT * FROM live_events ORDER BY sequence")
      .all() as { kind: string; payload: string }[];
    need(
      meta.protocol === record.protocolDigest && !meta.takeover,
      "CAPITAL_JOURNAL_BINDING_OR_TAKEOVER",
    );
    if (unprepared)
      need(
        !attempts.length &&
          !settlements.length &&
          !events.length &&
          meta.requestCount === "0" &&
          !meta.entryStopped &&
          !meta.exitAuthority,
        "CAPITAL_ATTEMPT_ALREADY_EXISTS",
      );
    else need(attempts.length > 0, "CAPITAL_JOURNAL_NO_TERMINAL_ATTEMPT");
    const buys = attempts.filter((a) => a.side === "BUY");
    if (!unprepared)
      need(
        buys.length === 1 && buys[0]!.amount === record.principalRaw,
        "CAPITAL_JOURNAL_PRINCIPAL_BINDING",
      );
    let position = 0n,
      cashflow = 0n;
    for (const a of attempts) {
      const data = JSON.parse(a.data) as Record<string, unknown>;
      if(a.state === "EXPIRED_SUBMITTED_NOT_LANDED"){
        need(!data.settlement&&!settlements.some(s=>s.attempt_id===a.id),"CAPITAL_EXPIRED_SUBMITTED_HAS_SETTLEMENT");
        const r=data.recoveryReceipt as Record<string,unknown>|undefined;
        need(r&&r.state===a.state&&r.kind==="SUBMITTED"&&r.protocolDigest===record.protocolDigest&&
          r.attemptId===a.id&&r.side===a.side&&r.noNewEntry===true&&r.signature===data.signature&&
          r.evidenceDigest===createHash("sha256").update(JSON.stringify(r.evidence)).digest("hex"),"CAPITAL_SUBMITTED_EXPIRY_RECEIPT");
        const protocol=parseExecutionProtocol(JSON.parse(readFileSync(join(dirname(record.journalPath),"episode.json"),"utf8")).protocol);
        need(executionProtocolDigest(protocol)===record.protocolDigest,"CAPITAL_SUBMITTED_EXPIRY_PROTOCOL");
        const {recoveryReceipt,...priorData}=data;
        const original={...a,state:"UNKNOWN",data:priorData} as LiveAttempt;
        const proof=assessExpiredRecovery(protocol,original,String(r!.remainingPositionRaw),r!.evidence as RecoveryEvidence,Number(r!.createdAtMs),"SUBMITTED");
        need(JSON.stringify(proof)===JSON.stringify(r),"CAPITAL_SUBMITTED_EXPIRY_REPROOF");
        let signatureSeen=false,deliveries=0;
        for(const event of events){
          if(event.kind!=="STATE_CHANGED")continue;
          const p=JSON.parse(event.payload);if(p.id!==a.id)continue;const d=p.evidence??{};
          need(![p.from,p.to].some(s=>["SETTLED","CHAIN_FAILED"].includes(s))&&!d.settlement,"CAPITAL_SUBMITTED_SETTLEMENT_HISTORY");
          for(const k of ["signature","signedTransaction"])
            if(Object.hasOwn(d,k))need(d[k]===data[k],"CAPITAL_SUBMITTED_BYTES_CHANGED");
          if(p.to==="SIGNED")signatureSeen=true;
          if(Object.hasOwn(d,"submissionCount")&&Number(d.submissionCount)>0){
            need(signatureSeen&&d.submissionCount===++deliveries&&p.to==="UNKNOWN","CAPITAL_SUBMITTED_DELIVERY_HISTORY");
          }
        }
        need(deliveries===data.submissionCount&&deliveries>0,"CAPITAL_SUBMITTED_DELIVERY_COUNT");
        continue; // Proven no landing: no fill, no fee, no new realized outcome.
      }
      if (
        [
          "UNSIGNED_CANCELLED",
          "ABANDONED_EXPIRED_UNSIGNED",
          "ABANDONED_EXPIRED_SIGNED_UNSENT",
        ].includes(a.state)
      ) {
        need(
          !data.settlement &&
            !settlements.some((s) => s.attempt_id === a.id) &&
            ![
              "providerReceipt",
              "submittedAtMs",
              "submissionStartedAtMs",
              "lastSubmissionKind",
            ].some((k) => Object.hasOwn(data, k)) &&
            (data.submissionCount === undefined || data.submissionCount === 0),
          "CAPITAL_ABANDONMENT_HAS_SEND_OR_SETTLEMENT",
        );
        const signed = a.state === "ABANDONED_EXPIRED_SIGNED_UNSENT";
        if (a.state === "UNSIGNED_CANCELLED")
          need(
            data.signatureNeverRequested === true && !data.signingRequestIssued,
            "CAPITAL_CANCELLATION_EVIDENCE_MISSING",
          );
        else {
          const r = data.recoveryReceipt as Record<string, unknown> | undefined;
          need(
            r &&
              r.state === a.state &&
              r.protocolDigest === record.protocolDigest &&
              r.attemptId === a.id &&
              r.side === a.side &&
              r.noNewEntry === true &&
              typeof r.evidence === "object" &&
              r.evidenceDigest ===
                createHash("sha256")
                  .update(JSON.stringify(r.evidence))
                  .digest("hex"),
            "CAPITAL_RECOVERY_RECEIPT_BINDING",
          );
          if (signed)
            need(
              typeof data.signedTransaction === "string" &&
                typeof data.signature === "string" &&
                r!.signature === data.signature &&
                r!.signedTransactionDigest ===
                  createHash("sha256")
                    .update(Buffer.from(data.signedTransaction, "base64"))
                    .digest("hex"),
              "CAPITAL_RECOVERY_SIGNED_BYTES_BINDING",
            );
        }
        if (!signed)
          need(
            !data.signature && !data.signedTransaction,
            "CAPITAL_UNSIGNED_HAS_SIGNATURE",
          );
        for (const event of events) {
          if (event.kind !== "STATE_CHANGED") continue;
          const p = JSON.parse(event.payload);
          if (p.id !== a.id) continue;
          const d = p.evidence ?? {};
          need(
            ![p.from, p.to].some((s) =>
              ["UNKNOWN", "SETTLED", "CHAIN_FAILED"].includes(s),
            ) &&
              ![
                "submissionStartedAtMs",
                "submittedAtMs",
                "lastSubmissionKind",
                "providerReceipt",
                "settlement",
              ].some((k) => Object.hasOwn(d, k)) &&
              (d.submissionCount === undefined || d.submissionCount === 0),
            "CAPITAL_ABANDONMENT_SEND_HISTORY",
          );
          if (!signed)
            need(
              ![p.from, p.to].includes("SIGNED") &&
                !d.signature &&
                !d.signedTransaction,
              "CAPITAL_UNSIGNED_SIGNATURE_HISTORY",
            );
          else
            for (const k of ["signature", "signedTransaction"])
              if (Object.hasOwn(d, k))
                need(d[k] === data[k], "CAPITAL_SIGNED_HISTORY_CHANGED");
        }
        continue;
      }
      need(
        ["SETTLED", "CHAIN_FAILED"].includes(a.state) &&
          data.balanceReconciled === true,
        "CAPITAL_JOURNAL_NOT_CLOSED",
      );
      const row = settlements.find(
        (s) => s.attempt_id === a.id && s.signature === data.signature,
      );
      need(
        row && encode(JSON.parse(row.evidence)) === encode(data.settlement),
        "CAPITAL_SETTLEMENT_BINDING",
      );
      const s = JSON.parse(row!.evidence) as Record<string, unknown>;
      need(
        s.commitment === "finalized" &&
          typeof s.tokenDeltaRaw === "string" &&
          /^-?\d+$/.test(s.tokenDeltaRaw) &&
          typeof s.walletDeltaRaw === "string" &&
          /^-?\d+$/.test(s.walletDeltaRaw),
        "CAPITAL_FINALIZED_CASHFLOW_REQUIRED",
      );
      position += BigInt(s.tokenDeltaRaw as string);
      cashflow += BigInt(s.walletDeltaRaw as string);
    }
    need(position === 0n, "CAPITAL_POSITION_REMAINS");
    const result = {
      cashflow,
      roundtripCompleted:
        attempts.some((a) => a.side === "BUY" && a.state === "SETTLED") &&
        attempts.some((a) => a.side === "SELL" && a.state === "SETTLED"),
      submittedBuy: attempts.some((a) => a.side === "BUY" &&
        ["SETTLED", "CHAIN_FAILED", "EXPIRED_SUBMITTED_NOT_LANDED"].includes(a.state)),
      digest: digest({ meta, attempts, settlements, events }),
    };
    db.exec("ROLLBACK");
    return result;
  } finally {
    db.close();
  }
}
