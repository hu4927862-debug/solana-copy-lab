import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";

export type LiveState =
  | "CREATED"
  | "REVIEWED"
  | "SIGNED"
  | "UNKNOWN"
  | "SETTLED"
  | "CHAIN_FAILED"
  | "UNSIGNED_CANCELLED"
  | "ABANDONED_EXPIRED_UNSIGNED"
  | "ABANDONED_EXPIRED_SIGNED_UNSENT"
  | "EXPIRED_SUBMITTED_NOT_LANDED"
  | "ATTENTION";
export interface LiveAttempt {
  id: string;
  side: "BUY" | "SELL";
  amount: string;
  state: LiveState;
  data: Record<string, unknown>;
}

/** Dedicated journal: never imports/migrates the Paper schema. Raw economics are TEXT. */
export class LiveJournal {
  private readonly db: Database.Database;
  constructor(path: string, protocolDigest: string) {
    const existing =
      path !== ":memory:" && existsSync(path) && statSync(path).size > 0;
    this.db = new Database(path);
    this.db.pragma("busy_timeout = 5000");
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    if (
      tables.some(
        (t) =>
          ![
            "live_meta",
            "live_attempts",
            "live_events",
            "live_settlements",
          ].includes(t.name),
      )
    ) {
      this.db.close();
      throw new Error("NOT_AN_ISOLATED_LIVE_DATABASE");
    }
    const requiredMeta = [
      "protocol",
      "entryStopped",
      "takeover",
      "requestCount",
      "requestLimit",
      "exitAuthority",
      "schemaVersion",
    ];
    if (existing || tables.length > 0) {
      if (tables.length !== 4 || !tables.some((t) => t.name === "live_meta")) {
        this.db.close();
        throw new Error("LIVE_JOURNAL_METADATA_MISSING");
      }
      if (requiredMeta.some((key) => this.meta(key) === undefined)) {
        this.db.close();
        throw new Error("LIVE_JOURNAL_METADATA_MISSING");
      }
      if (
        this.meta("schemaVersion") !== "MINIMUM_LIVE_V1" ||
        ["requestCount", "requestLimit"].some(
          (k) =>
            !/^\d+$/.test(this.meta(k)!) ||
            !Number.isSafeInteger(Number(this.meta(k))),
        )
      ) {
        this.db.close();
        throw new Error("LIVE_JOURNAL_METADATA_INVALID");
      }
      if (this.meta("protocol") !== protocolDigest) {
        this.db.close();
        throw new Error("PROTOCOL_BINDING_MISMATCH");
      }
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS live_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS live_attempts (id TEXT PRIMARY KEY, side TEXT NOT NULL, amount TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS live_events (sequence INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS live_settlements (signature TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, evidence TEXT NOT NULL);
    `);
    if (!existing && tables.length === 0)
      this.atomic(() => {
        const insert = this.db.prepare("INSERT INTO live_meta VALUES (?,?)");
        for (const [key, value] of Object.entries({
          protocol: protocolDigest,
          entryStopped: "",
          takeover: "",
          requestCount: "0",
          requestLimit: "200",
          exitAuthority: "",
          schemaVersion: "MINIMUM_LIVE_V1",
        }))
          insert.run(key, value);
      });
    if (this.meta("protocol") !== protocolDigest) {
      this.db.close();
      throw new Error("PROTOCOL_BINDING_MISMATCH");
    }
  }
  private meta(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM live_meta WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value;
  }
  private event(kind: string, payload: unknown): void {
    this.db
      .prepare("INSERT INTO live_events(at_ms,kind,payload) VALUES (?,?,?)")
      .run(Date.now(), kind, JSON.stringify(payload));
  }
  atomic<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  claimRequest(kind: "READ" | "NEW_EXECUTION" = "NEW_EXECUTION"): void {
    this.atomic(() => {
      const used = Number(this.meta("requestCount") ?? 0);
      if (used >= Number(this.meta("requestLimit")) && kind !== "READ")
        throw new Error("LIVE_REQUEST_BUDGET_EXHAUSTED");
      this.db
        .prepare("INSERT OR REPLACE INTO live_meta VALUES ('requestCount',?)")
        .run(String(used + 1));
    });
  }
  exitAuthority(): Record<string, unknown> | null {
    const value = this.meta("exitAuthority");
    return value ? (JSON.parse(value) as Record<string, unknown>) : null;
  }
  authorizeExit(authority: Record<string, unknown>): void {
    this.atomic(() => {
      this.db
        .prepare("UPDATE live_meta SET value=? WHERE key='exitAuthority'")
        .run(JSON.stringify(authority));
      this.db
        .prepare("UPDATE live_meta SET value='' WHERE key='takeover'")
        .run();
      this.db
        .prepare("UPDATE live_meta SET value=? WHERE key='requestLimit'")
        .run(
          String(
            Number(this.meta("requestCount")) +
              Number(authority.additionalRequestBudget),
          ),
        );
      this.stopEntry("EXIT_ONLY_AUTHORITY_NEW_ENTRY_REMAINS_DISABLED");
      this.event("LINKED_EXIT_AUTHORITY", authority);
    });
  }
  get(id: string): LiveAttempt | undefined {
    const row = this.db
      .prepare("SELECT * FROM live_attempts WHERE id=?")
      .get(id) as (Omit<LiveAttempt, "data"> & { data: string }) | undefined;
    return row
      ? { ...row, data: JSON.parse(row.data) as Record<string, unknown> }
      : undefined;
  }
  attempts(): LiveAttempt[] {
    return (
      this.db.prepare("SELECT id FROM live_attempts ORDER BY rowid").all() as {
        id: string;
      }[]
    ).map((r) => this.get(r.id)!);
  }
  create(id: string, side: "BUY" | "SELL", amount: string): void {
    this.atomic(() => {
      if (!/^[1-9]\d*$/.test(amount)) throw new Error("INVALID_AMOUNT");
      if (
        side === "BUY" &&
        (this.meta("entryStopped") ||
          this.attempts().some((a) => a.side === "BUY"))
      )
        throw new Error("ENTRY_CLOSED");
      this.db
        .prepare("INSERT INTO live_attempts VALUES (?,?,?,'CREATED','{}')")
        .run(id, side, amount);
      this.event("ATTEMPT_CREATED", { id, side, amount });
    });
  }
  transition(
    id: string,
    expected: LiveState,
    state: LiveState,
    data: Record<string, unknown>,
  ): void {
    this.atomic(() => {
      const row = this.get(id);
      if (!row || row.state !== expected)
        throw new Error("ATTEMPT_STATE_CONFLICT");
      this.db
        .prepare(
          "UPDATE live_attempts SET state=?,data=? WHERE id=? AND state=?",
        )
        .run(state, JSON.stringify({ ...row.data, ...data }), id, expected);
      this.event("STATE_CHANGED", {
        id,
        from: expected,
        to: state,
        evidence: data,
      });
    });
  }
  settle(
    id: string,
    signature: string,
    evidence: Record<string, unknown>,
    failed: boolean,
  ): void {
    this.atomic(() => {
      const existing = this.db
        .prepare("SELECT evidence FROM live_settlements WHERE signature=?")
        .get(signature) as { evidence: string } | undefined;
      if (existing) {
        if (existing.evidence !== JSON.stringify(evidence))
          throw new Error("CONFLICTING_CHAIN_EVIDENCE");
        return;
      }
      const attempt = this.get(id);
      if (
        !attempt ||
        !["UNKNOWN", "SIGNED", "ATTENTION"].includes(attempt.state) ||
        attempt.data.signature !== signature
      )
        throw new Error("SETTLEMENT_BINDING_MISMATCH");
      this.db
        .prepare("INSERT INTO live_settlements VALUES (?,?,?)")
        .run(signature, id, JSON.stringify(evidence));
      this.transition(id, attempt.state, failed ? "CHAIN_FAILED" : "SETTLED", {
        settlement: evidence,
      });
    });
  }
  recoveryDigest(): string {
    return createHash("sha256").update(JSON.stringify([
      this.db.prepare("SELECT * FROM live_meta ORDER BY key").all(),
      this.db.prepare("SELECT * FROM live_attempts ORDER BY id").all(),
      this.db.prepare("SELECT * FROM live_events ORDER BY sequence").all(),
      this.db.prepare("SELECT * FROM live_settlements ORDER BY signature").all(),
    ])).digest("hex");
  }
  assertNoSignedHistory(id: string): void {
    const events = this.db.prepare("SELECT payload FROM live_events WHERE kind='STATE_CHANGED'").all() as {payload:string}[];
    for (const event of events) {
      const p=JSON.parse(event.payload);
      if (p.id===id && ([p.from,p.to].some(v=>["SIGNED","UNKNOWN","SETTLED","CHAIN_FAILED"].includes(v)) ||
        ["signature","signedTransaction","providerReceipt","settlement"].some(k=>Object.hasOwn(p.evidence??{},k))))
        throw Error("RECOVERY_SIGNED_OR_SEND_HISTORY");
    }
  }
  assertSignedUnsentHistory(id: string): void {
    const current=this.get(id);
    const events=this.db.prepare("SELECT payload FROM live_events WHERE kind='STATE_CHANGED'").all() as {payload:string}[];
    let signed=false;
    for (const event of events) {
      const p=JSON.parse(event.payload); if(p.id!==id) continue;
      const d=p.evidence??{};
      if ([p.from,p.to].some(v=>["UNKNOWN","SETTLED","CHAIN_FAILED"].includes(v)) ||
        ["submissionStartedAtMs","submittedAtMs","lastSubmissionKind","providerReceipt","settlement","recovery"].some(k=>Object.hasOwn(d,k)) ||
        (Object.hasOwn(d,"submissionCount") && d.submissionCount!==0)) throw Error("RECOVERY_SEND_OR_SETTLEMENT_HISTORY");
      if(p.to==="SIGNED") signed=true;
      for(const k of ["signature","signedTransaction"]) if(Object.hasOwn(d,k) && d[k]!==current?.data[k]) throw Error("RECOVERY_SIGNED_HISTORY_MISMATCH");
    }
    if(!signed) throw Error("RECOVERY_SIGNED_HISTORY_REQUIRED");
  }
  assertSubmittedHistory(id: string, maxBroadcasts = 1, intervalMs = 0): void {
    const current = this.get(id);
    const count = Number(current?.data.submissionCount);
    if (!current || current.state !== "UNKNOWN" || !Number.isSafeInteger(count) || count < 1 || count > maxBroadcasts ||
        current.data.lastSubmissionKind !== (count === 1 ? "FIRST_SUBMISSION" : "SAME_SIGNED_BYTES_REBROADCAST") ||
        !Number.isSafeInteger(current.data.submissionStartedAtMs)) throw Error("RECOVERY_EXACT_FIRST_SUBMISSION_REQUIRED");
    let signed = false, submitted = 0, lastDelivery = -Infinity;
    const events = this.db.prepare("SELECT payload FROM live_events WHERE kind='STATE_CHANGED' ORDER BY sequence").all() as {payload:string}[];
    for (const event of events) {
      const p = JSON.parse(event.payload); if (p.id !== id) continue;
      const d = p.evidence ?? {};
      if ([p.from, p.to].some(s => ["SETTLED", "CHAIN_FAILED", "EXPIRED_SUBMITTED_NOT_LANDED"].includes(s)) ||
          Object.hasOwn(d, "settlement")) throw Error("RECOVERY_SETTLEMENT_HISTORY");
      for (const k of ["signature", "signedTransaction", "submissionStartedAtMs"])
        if (Object.hasOwn(d, k) && d[k] !== current.data[k]) throw Error("RECOVERY_SUBMITTED_HISTORY_MISMATCH");
      if (Object.hasOwn(d, "submissionCount") && (!Number.isSafeInteger(d.submissionCount) || d.submissionCount < 0 || d.submissionCount > maxBroadcasts))
        throw Error("RECOVERY_REBROADCAST_HISTORY");
      if (p.to === "SIGNED") signed = true;
      if (Object.hasOwn(d, "submissionStartedAtMs")) {
        if (!signed || p.from !== (submitted === 0 ? "SIGNED" : "UNKNOWN") || p.to !== "UNKNOWN" ||
            d.submissionCount !== submitted + 1 ||
            d.lastSubmissionKind !== (submitted === 0 ? "FIRST_SUBMISSION" : "SAME_SIGNED_BYTES_REBROADCAST")) throw Error("RECOVERY_SUBMISSION_HISTORY_REQUIRED");
        if (intervalMs > 0 && (!Number.isSafeInteger(d.lastDeliveryAtMs) || Number(d.lastDeliveryAtMs) - lastDelivery < intervalMs))
          throw Error("RECOVERY_DELIVERY_INTERVAL_HISTORY");
        lastDelivery = Number(d.lastDeliveryAtMs ?? d.submissionStartedAtMs);
        submitted++;
      }
      if (d.providerReceipt?.signature && d.providerReceipt.signature !== current.data.signature)
        throw Error("RECOVERY_PROVIDER_SIGNATURE_MISMATCH");
    }
    if (!signed || submitted !== count || (intervalMs > 0 && lastDelivery !== current.data.lastDeliveryAtMs))
      throw Error("RECOVERY_SUBMISSION_HISTORY_REQUIRED");
  }
  stopEntry(reason: string): void {
    this.atomic(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO live_meta VALUES ('entryStopped',?)")
        .run(reason || "STOPPED");
      this.event("STOP_ENTRY", { reason });
    });
  }
  takeover(reason: string): void {
    this.atomic(() => {
      this.stopEntry(reason);
      this.db
        .prepare("INSERT OR REPLACE INTO live_meta VALUES ('takeover',?)")
        .run(reason || "TAKEOVER");
      this.event("MANUAL_TAKEOVER", { reason });
    });
  }
  status() {
    const attempts = this.attempts();
    let positionRaw = 0n,
      walletDeltaRaw = 0n,
      networkFeeRaw = 0n,
      deliveryTipRaw = 0n,
      recoverableRentDeltaRaw = 0n;
    const unknownCosts: string[] = [];
    for (const a of attempts) {
      const s = a.data.settlement as Record<string, unknown> | undefined;
      if (!s) continue;
      positionRaw += BigInt(String(s.tokenDeltaRaw ?? "0"));
      walletDeltaRaw += BigInt(String(s.walletDeltaRaw ?? "0"));
      networkFeeRaw += BigInt(String(s.networkFeeRaw ?? "0"));
      deliveryTipRaw += BigInt(String(s.deliveryTipRaw ?? "0"));
      recoverableRentDeltaRaw += BigInt(
        String(s.recoverableRentDeltaRaw ?? "0"),
      );
      if (Array.isArray(s.unknownCosts))
        unknownCosts.push(...s.unknownCosts.map(String));
    }
    return {
      protocolDigest: this.meta("protocol"),
      requestCount: Number(this.meta("requestCount") ?? 0),
      entryStopped: Boolean(this.meta("entryStopped")),
      takeover: this.meta("takeover") || null,
      positionRaw: positionRaw.toString(),
      walletDeltaRaw: walletDeltaRaw.toString(),
      networkFeeRaw: networkFeeRaw.toString(),
      deliveryTipRaw: deliveryTipRaw.toString(),
      recoverableRentDeltaRaw: recoverableRentDeltaRaw.toString(),
      unknownCosts: [...new Set(unknownCosts)],
      obligations: attempts.filter(
        (a) =>
          !["SETTLED", "CHAIN_FAILED", "UNSIGNED_CANCELLED", "ABANDONED_EXPIRED_UNSIGNED", "ABANDONED_EXPIRED_SIGNED_UNSENT", "EXPIRED_SUBMITTED_NOT_LANDED"].includes(a.state),
      ),
      attempts,
      closed:
        !this.meta("takeover") &&
        positionRaw === 0n &&
        attempts.length > 0 &&
        attempts.every(
          (a) =>
            ["UNSIGNED_CANCELLED", "ABANDONED_EXPIRED_UNSIGNED", "ABANDONED_EXPIRED_SIGNED_UNSENT", "EXPIRED_SUBMITTED_NOT_LANDED"].includes(a.state) ||
            (["SETTLED", "CHAIN_FAILED"].includes(a.state) &&
              a.data.balanceReconciled === true),
        ),
      roundtripCompleted:
        !this.meta("takeover") &&
        positionRaw === 0n &&
        attempts.some((a) => a.side === "BUY" && a.state === "SETTLED") &&
        attempts.some((a) => a.side === "SELL" && a.state === "SETTLED") &&
        attempts.every(
          (a) =>
            ["UNSIGNED_CANCELLED", "ABANDONED_EXPIRED_UNSIGNED", "ABANDONED_EXPIRED_SIGNED_UNSENT", "EXPIRED_SUBMITTED_NOT_LANDED"].includes(a.state) ||
            (["SETTLED", "CHAIN_FAILED"].includes(a.state) &&
              a.data.balanceReconciled === true),
        ),
    };
  }
  close(): void {
    this.db.close();
  }
}
