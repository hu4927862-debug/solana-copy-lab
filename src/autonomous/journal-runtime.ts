import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, lstatSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { LiveJournal } from "../live/journal.js";
import type { StageCapitalControls } from "./capital-controls.js";

export interface RuntimeIdentity {
  wallet: string;
  releaseDigest: string;
  policyDigest: string;
}
export interface EpisodeDescriptor {
  episodeId: string;
  protocolDigest: string;
  wallet: string;
  leaderWallet: string;
  mint: string;
  sourceId: string;
  buyAmountRaw: string;
}
interface Owner {
  host: string;
  pid: number;
  token: string;
}
interface EpisodeRow {
  id: string;
  descriptor: string;
  descriptor_digest: string;
  state: string;
}
const canonical = (x: unknown): string =>
  JSON.stringify(x, Object.keys(x as object).sort());
const hash = (x: string) => createHash("sha256").update(x).digest("hex");
const need = (ok: unknown, code: string): void => {
  if (!ok) throw Error(code);
};
const digestPattern = /^[a-f0-9]{64}$/;
function validateIdentity(i: RuntimeIdentity): void {
  need(
    typeof i.wallet === "string" &&
      i.wallet.length > 0 &&
      digestPattern.test(i.releaseDigest) &&
      digestPattern.test(i.policyDigest),
    "RUNTIME_IDENTITY_INVALID",
  );
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export function episodeJournalPath(
  directory: string,
  descriptor: EpisodeDescriptor,
): string {
  return join(directory, "episodes", hash(descriptor.episodeId), "live.sqlite");
}

/** Directory-local ownership and a claim-before-create index, NOT a second
 * execution/accounting ledger. LiveJournal remains the only attempt/settlement
 * truth. Global wallet claims and capital authorization are caller requirements.
 * Construction defaults to entry halted and never opens the historical stage DB.
 */
export class AutonomousJournalRuntime {
  readonly directory: string;
  private readonly db: Database.Database;
  private readonly owner: Owner;
  private readonly journals = new Map<string, LiveJournal>();
  private closed = false;
  constructor(
    directory: string,
    readonly identity: RuntimeIdentity,
    options: {
      owner?: Owner;
      isProcessAlive?: (pid: number) => boolean;
      crashPoint?: (point: "CLAIM_COMMITTED" | "JOURNAL_OPENED") => void;
    } = {},
  ) {
    validateIdentity(identity);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    need(!lstatSync(directory).isSymbolicLink(), "RUNTIME_DIRECTORY_SYMLINK");
    this.directory = realpathSync(directory);
    this.owner = options.owner ?? {
      host: hostname(),
      pid: process.pid,
      token: randomUUID(),
    };
    need(
      this.owner.host.length > 0 &&
        Number.isSafeInteger(this.owner.pid) &&
        this.owner.pid > 0 &&
        this.owner.token.length > 0,
      "RUNTIME_OWNER_INVALID",
    );
    this.crashPoint = options.crashPoint;
    this.db = new Database(join(this.directory, "runtime.sqlite"));
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    try {
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS runtime_meta(k TEXT PRIMARY KEY,v TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runtime_episodes(id TEXT PRIMARY KEY,descriptor TEXT NOT NULL,descriptor_digest TEXT NOT NULL,state TEXT NOT NULL);",
      );
      this.db
        .transaction(() => {
          const bound = this.meta("identity");
          if (bound !== null)
            need(bound === canonical(identity), "RUNTIME_IDENTITY_CHANGED");
          else {
            this.set("identity", canonical(identity));
            this.set("entryHalt", "NOT_ACTIVATED");
            this.set("active", "");
          }
          const rawOwner = this.meta("owner");
          if (rawOwner) {
            const old = JSON.parse(rawOwner) as Owner;
            // Shared/network filesystems and PID reuse are deliberately fail closed.
            need(old.host === this.owner.host, "RUNTIME_OWNER_OTHER_HOST");
            need(
              !(options.isProcessAlive ?? processAlive)(old.pid),
              "RUNTIME_OWNER_ALIVE",
            );
          }
          this.set("owner", JSON.stringify(this.owner));
        })
        .immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private readonly crashPoint:
    ((point: "CLAIM_COMMITTED" | "JOURNAL_OPENED") => void) | undefined;
  private meta(key: string): string | null {
    return (
      (
        this.db.prepare("SELECT v FROM runtime_meta WHERE k=?").get(key) as
          { v: string } | undefined
      )?.v ?? null
    );
  }
  private set(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO runtime_meta VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
      )
      .run(key, value);
  }
  private assertOwner(): void {
    need(
      !this.closed && this.meta("owner") === JSON.stringify(this.owner),
      "RUNTIME_OWNER_LOST",
    );
  }
  private activeRow(): EpisodeRow | undefined {
    const active = this.meta("active");
    if (!active) return undefined;
    const row = this.db
      .prepare("SELECT * FROM runtime_episodes WHERE id=?")
      .get(active) as EpisodeRow | undefined;
    need(row, "RUNTIME_ACTIVE_INDEX_MISSING");
    return row;
  }
  haltEntry(reason: string): void {
    need(reason.trim().length > 0, "RUNTIME_HALT_REASON_REQUIRED");
    this.db
      .transaction(() => {
        this.assertOwner();
        this.set("entryHalt", reason);
      })
      .immediate();
  }
  /** Operator/configuration action only; this is NOT funded authorization. */
  resumeEntry(reason: string): void {
    need(reason.trim().length > 0, "RUNTIME_RESUME_REASON_REQUIRED");
    this.db
      .transaction(() => {
        this.assertOwner();
        need(!this.activeRow(), "RUNTIME_EXISTING_RESPONSIBILITY");
        this.set("entryHalt", "");
        this.set("lastResumeReason", reason);
      })
      .immediate();
  }
  assertEntryAllowed(): void {
    this.assertOwner();
    need(this.meta("entryHalt") === "", "RUNTIME_ENTRY_HALTED");
    need(!this.activeRow(), "RUNTIME_EXISTING_RESPONSIBILITY");
  }
  reserveEpisode(descriptor: EpisodeDescriptor) {
    need(
      descriptor.wallet === this.identity.wallet &&
        digestPattern.test(descriptor.protocolDigest) &&
        [
          descriptor.episodeId,
          descriptor.leaderWallet,
          descriptor.mint,
          descriptor.sourceId,
        ].every((v) => typeof v === "string" && v.length > 0) &&
        /^[1-9][0-9]*$/.test(descriptor.buyAmountRaw),
      "RUNTIME_EPISODE_IDENTITY_INVALID",
    );
    const encoded = canonical(descriptor);
    this.db
      .transaction(() => {
        this.assertOwner();
        const active = this.activeRow();
        if (active) {
          need(
            active.id === descriptor.episodeId && active.descriptor === encoded,
            "RUNTIME_EXISTING_RESPONSIBILITY",
          );
          return; // Idempotent resume of the exact existing claim, never a new BUY.
        }
        this.assertEntryAllowed();
        need(
          !this.db
            .prepare("SELECT 1 FROM runtime_episodes WHERE id=?")
            .get(descriptor.episodeId),
          "RUNTIME_EPISODE_ALREADY_USED",
        );
        this.db
          .prepare("INSERT INTO runtime_episodes VALUES (?,?,?,'CLAIMED')")
          .run(descriptor.episodeId, encoded, hash(encoded));
        this.set("active", descriptor.episodeId);
      })
      .immediate();
    this.crashPoint?.("CLAIM_COMMITTED");
    return this.recoverActive();
  }
  /** Reopens only the durable claim. SIGNED/UNKNOWN/OPEN never create a new
   * intent, refresh bytes or send. LiveExecutor.prepare owns attempt creation;
   * an empty journal means the original claim has not prepared yet.
   */
  recoverActive() {
    this.assertOwner();
    const row = this.activeRow();
    if (!row) return null;
    need(
      row.state === "CLAIMED" && hash(row.descriptor) === row.descriptor_digest,
      "RUNTIME_EPISODE_INDEX_INVALID",
    );
    const descriptor = JSON.parse(row.descriptor) as EpisodeDescriptor;
    need(
      descriptor.episodeId === row.id &&
        descriptor.wallet === this.identity.wallet,
      "RUNTIME_EPISODE_BINDING_CHANGED",
    );
    const file = episodeJournalPath(this.directory, descriptor);
    let journal = this.journals.get(row.id);
    if (!journal) {
      mkdirSync(resolve(file, ".."), { recursive: true, mode: 0o700 });
      journal = new LiveJournal(file, descriptor.protocolDigest);
      this.journals.set(row.id, journal);
    }
    this.crashPoint?.("JOURNAL_OPENED");
    const attempts = journal.attempts();
    const buys = journal.attempts().filter((a) => a.side === "BUY");
    need(
      attempts.length === 0 ||
        (buys.length === 1 &&
          buys[0]!.id === "BUY" &&
          buys[0]!.amount === descriptor.buyAmountRaw),
      "RUNTIME_JOURNAL_EPISODE_MISMATCH",
    );
    const status = journal.status();
    return {
      descriptor,
      journalPath: file,
      journal,
      status,
      recoveryMode:
        attempts.length === 0
          ? "CLAIMED_AWAITING_ORIGINAL_PREPARE"
          : status.closed
            ? "CLOSED_AWAITING_INDEX_RELEASE"
            : "RESUME_EXISTING_RESPONSIBILITY",
    } as const;
  }
  releaseClosedEpisode(): void {
    const current = this.recoverActive();
    need(current?.status.closed, "RUNTIME_LIABILITY_NOT_CLOSED");
    this.db
      .transaction(() => {
        this.assertOwner();
        need(
          this.meta("active") === current!.descriptor.episodeId &&
            current!.journal.status().closed,
          "RUNTIME_CONCURRENT_RESPONSIBILITY_CHANGE",
        );
        this.db
          .prepare(
            "UPDATE runtime_episodes SET state='CLOSED' WHERE id=? AND state='CLAIMED'",
          )
          .run(current!.descriptor.episodeId);
        this.set("active", "");
        // Review the first actual outcome before another entry; no automatic reset.
        this.set("entryHalt", "CLOSED_OUTCOME_REVIEW_REQUIRED");
      })
      .immediate();
  }
  /** Explicit operator-only closure for an exact claim that NEVER prepared or
   * requested anything. A failed prepare has an attempt and cannot use this.
   * Capital closes first; a crash then replays its durable zero-budget receipt.
   * No attempt, Journal, descriptor or evidence file is deleted. */
  closeUnpreparedEpisode(
    expected: EpisodeDescriptor,
    capital: StageCapitalControls,
  ) {
    const current = this.recoverActive();
    need(
      current && canonical(current.descriptor) === canonical(expected),
      "RUNTIME_UNPREPARED_DESCRIPTOR_MISMATCH",
    );
    const proof = () => {
      const db = new Database(current!.journalPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        db.pragma("query_only=ON");
        db.exec("BEGIN");
        const meta = Object.fromEntries(
          (
            db.prepare("SELECT key,value FROM live_meta").all() as {
              key: string;
              value: string;
            }[]
          ).map((r) => [r.key, r.value]),
        );
        need(
          meta.protocol === expected.protocolDigest &&
            meta.requestCount === "0" &&
            !meta.takeover &&
            !meta.entryStopped &&
            !meta.exitAuthority &&
            ["live_attempts", "live_events", "live_settlements"].every(
              (table) =>
                (
                  db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as {
                    n: number;
                  }
                ).n === 0,
            ),
          "RUNTIME_NOT_UNPREPARED_NO_HISTORY",
        );
      } finally {
        db.close();
      }
      return current!.journal.recoveryDigest();
    };
    const before = proof(),
      reference = {
        id: expected.episodeId,
        episodeId: expected.episodeId,
        protocolDigest: expected.protocolDigest,
        journalPath: current!.journalPath,
        principalRaw: expected.buyAmountRaw,
      };
    const active = capital.inspect().active;
    need(
      !active || active.id === expected.episodeId,
      "RUNTIME_CAPITAL_DIFFERENT_EPISODE",
    );
    // releaseUnprepared is idempotent if the stage commit succeeded just before
    // a crash. A no-reservation receipt requires both global claim files absent.
    let capitalReceipt: unknown;
    if (active) capitalReceipt = capital.releaseUnprepared(expected.episodeId);
    else {
      try {
        capitalReceipt = capital.releaseUnprepared(expected.episodeId);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "CAPITAL_RESERVATION_REQUIRED"
        )
          throw error;
        capitalReceipt = capital.confirmUnreservedEpisode(reference);
      }
    }
    return this.db
      .transaction(() => {
        this.assertOwner();
        need(
          this.meta("active") === expected.episodeId && proof() === before,
          "RUNTIME_CONCURRENT_RESPONSIBILITY_CHANGE",
        );
        const receipt = {
          schema: "AUTONOMOUS_UNPREPARED_EPISODE_CLOSURE_V1",
          state: "ABANDONED_UNPREPARED",
          descriptor: expected,
          journalDigest: before,
          capitalReceipt,
          closedAtMs: Date.now(),
          fundsMoved: 0,
          noNewEntry: true,
        };
        this.set(
          "unpreparedClosure:" + expected.episodeId,
          JSON.stringify(receipt),
        );
        this.db
          .prepare(
            "UPDATE runtime_episodes SET state='ABANDONED_UNPREPARED' WHERE id=? AND state='CLAIMED'",
          )
          .run(expected.episodeId);
        this.set("active", "");
        this.set("entryHalt", "UNPREPARED_CLOSURE_REVIEW_REQUIRED");
        return receipt;
      })
      .immediate();
  }
  close(): void {
    if (this.closed) return;
    for (const journal of this.journals.values()) journal.close();
    try {
      this.db
        .transaction(() => {
          this.assertOwner();
          this.set("owner", "");
        })
        .immediate();
    } finally {
      this.closed = true;
      this.db.close();
    }
  }
}

/** Read-only evidence inspection: does not construct LiveJournal or claim a
 * runtime, create schema, alter request counters, release claims or reconcile. */
export function inspectAutonomousRuntime(directory: string) {
  const file = join(directory, "runtime.sqlite");
  if (!existsSync(file)) return { state: "NOT_INITIALIZED" as const };
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    db.exec("BEGIN");
    const meta = Object.fromEntries(
      (
        db.prepare("SELECT k,v FROM runtime_meta").all() as {
          k: string;
          v: string;
        }[]
      ).map((r) => [r.k, r.v]),
    );
    const episodes = db
      .prepare("SELECT * FROM runtime_episodes ORDER BY rowid")
      .all() as EpisodeRow[];
    const active = episodes.find((row) => row.id === meta.active);
    const descriptor = active
      ? (JSON.parse(active.descriptor) as EpisodeDescriptor)
      : null;
    const result = {
      state: "INITIALIZED" as const,
      identity: JSON.parse(meta.identity!),
      entryHalt: meta.entryHalt || null,
      active: descriptor,
      journalPath: descriptor
        ? episodeJournalPath(directory, descriptor)
        : null,
      episodes: episodes.map((r) => ({
        id: r.id,
        state: r.state,
        descriptorDigest: r.descriptor_digest,
      })),
      owner: meta.owner ? JSON.parse(meta.owner) : null,
      accountingSource: "LiveJournal",
      capitalLedgerConnected: false,
    };
    db.exec("ROLLBACK");
    return result;
  } finally {
    db.close();
  }
}
