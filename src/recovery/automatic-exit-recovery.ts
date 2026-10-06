import type { ExecutionIntent, ExecutionResult } from "../domain/execution.js";
import type { TransactionSender } from "../domain/ports.js";
import { jsonStringify } from "../domain/json.js";
import type { SqliteDatabase } from "../persistence/database.js";
import type { StateStore } from "../persistence/state-store.js";
import { RiskEngine, type PreQuoteRiskDecision } from "../risk/risk-engine.js";

export const AUTOMATIC_EXIT_VERSION = "AUTOMATIC_EXIT_RECOVERY_V1";
const BACKOFF_MS = [5_000, 10_000, 20_000] as const;
type Goal = {
  id: string;
  position_id: number;
  opening_fill_id: string;
  intent_id: string;
  intent_json: string;
  state: string;
  attempts: number;
  next_at_ms: number;
  lease_until_ms: number | null;
  result_json: string | null;
  reason: string;
};
const decode = <T>(s: string): T =>
  JSON.parse(s, (key, value) =>
    typeof value === "string" &&
    (/Raw$|MonotonicNs$/.test(key) ||
      key === "numerator" ||
      key === "denominator")
      ? BigInt(value)
      : value,
  ) as T;

export function exitRecoveryEnabled(db: SqliteDatabase): boolean {
  return !!db.sqlite
    .prepare("SELECT 1 FROM automatic_exit_policy WHERE singleton=1")
    .get();
}

// Called inside the original intent reservation transaction. No historical scan.
export function captureExitGoal(
  db: SqliteDatabase,
  intent: ExecutionIntent,
  now: number,
): void {
  if (
    !exitRecoveryEnabled(db) ||
    intent.side !== "SELL" ||
    !intent.sellRatio ||
    intent.sellRatio.numerator <= 0n ||
    intent.sellRatio.numerator !== intent.sellRatio.denominator
  )
    return;
  const p = db.sqlite
    .prepare(
      `SELECT p.id,a.fill_id FROM follower_positions p
    JOIN wallets fw ON fw.id=p.follower_wallet_id JOIN wallets lw ON lw.id=p.leader_wallet_id
    JOIN paper_fill_applications a ON a.position_id=p.id AND a.transition='OPEN'
    WHERE fw.address=? AND lw.address=? AND p.token_mint=? AND p.quote_mint=?
    ORDER BY a.position_version_after DESC LIMIT 1`,
    )
    .get(
      intent.followerWallet,
      intent.leaderWallet,
      intent.tokenMint,
      intent.quoteMint,
    ) as { id: number; fill_id: string } | undefined;
  if (!p) return;
  const id = `exit:${p.id}:${p.fill_id}`;
  const inserted = db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO automatic_exit_goals(id,position_id,opening_fill_id,intent_id,intent_json,state,next_at_ms,reason) VALUES(?,?,?,?,?,'WAITING',?,'SOURCE_FULL_EXIT')`,
    )
    .run(
      id,
      p.id,
      p.fill_id,
      intent.executionKey,
      jsonStringify(intent),
      now + BACKOFF_MS[0],
    );
  if (inserted.changes) {
    db.sqlite
      .prepare(
        "INSERT INTO automatic_exit_events(goal_id,at_ms,state,reason,evidence_json) VALUES(?,?,'WAITING','SOURCE_FULL_EXIT',?)",
      )
      .run(
        id,
        now,
        jsonStringify({
          source: intent.leaderTradeId,
          version: AUTOMATIC_EXIT_VERSION,
        }),
      );
    if (intent.skipReason) {
      db.sqlite
        .prepare(
          "UPDATE automatic_exit_goals SET state='ATTENTION',reason=? WHERE id=?",
        )
        .run(intent.skipReason, id);
      db.sqlite
        .prepare(
          "INSERT INTO automatic_exit_events(goal_id,at_ms,state,reason,evidence_json) VALUES(?,?,'ATTENTION',?,'{}')",
        )
        .run(id, now, intent.skipReason);
    }
  }
}

export function exitBlocksBuy(
  db: SqliteDatabase,
  intent: ExecutionIntent,
): boolean {
  if (intent.side !== "BUY" || !exitRecoveryEnabled(db)) return false;
  return !!db.sqlite
    .prepare(
      `SELECT 1 FROM automatic_exit_goals g JOIN follower_positions p ON p.id=g.position_id
    JOIN wallets fw ON fw.id=p.follower_wallet_id JOIN wallets lw ON lw.id=p.leader_wallet_id
    WHERE fw.address=? AND lw.address=? AND p.token_mint=? AND p.quote_mint=? AND g.state<>'COMPLETED'`,
    )
    .get(
      intent.followerWallet,
      intent.leaderWallet,
      intent.tokenMint,
      intent.quoteMint,
    );
}

/** One original source/intent can acquire at most one Paper fill. Attempts are
 * quote evidence, never invented chain trades or repeated accounting fills. */
export class AutomaticExitRecovery {
  private readonly pendingQuotes = new Set<Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();
  private stopped = false;
  get pendingQuoteCount(): number {
    return this.pendingQuotes.size;
  }
  async stop(drainMs = 5_000): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.pendingQuotes]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("EXIT_QUOTE_DRAIN_TIMEOUT")),
            drainMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  constructor(
    private readonly store: StateStore,
    private readonly sender: TransactionSender,
    private readonly now: () => number = Date.now,
    private readonly fault?: (
      point: "AFTER_CLAIM" | "AFTER_ACCEPT" | "AFTER_FILL" | "AFTER_APPLY",
    ) => void | Promise<void>,
  ) {
    if (sender.mode !== "PAPER") throw Error("PAPER_EXIT_RECOVERY_ONLY");
  }
  enableFresh(): void {
    if (
      process.env.PAPER_ONLY !== "true" ||
      process.env.LIVE_FUNDS_ENABLED !== "false"
    )
      throw Error("PAPER_EXIT_RECOVERY_SAFETY_REQUIRED");
    const db = this.store.database.sqlite;
    db.transaction(() => {
      if (exitRecoveryEnabled(this.store.database)) return;
      if (
        (
          db.prepare("SELECT count(*) n FROM leader_trades").get() as {
            n: number;
          }
        ).n
      )
        throw Error("EXIT_RECOVERY_REQUIRES_FRESH_DATABASE");
      db.prepare("INSERT INTO automatic_exit_policy VALUES(1,?)").run(
        AUTOMATIC_EXIT_VERSION,
      );
    }).immediate();
  }
  statuses(): readonly Goal[] {
    return this.store.database.sqlite
      .prepare("SELECT * FROM automatic_exit_goals ORDER BY id")
      .all() as Goal[];
  }
  events(): readonly unknown[] {
    return this.store.database.sqlite
      .prepare("SELECT * FROM automatic_exit_events ORDER BY id")
      .all();
  }
  private change(
    g: Goal,
    state: string,
    reason: string,
    evidence: unknown = {},
  ): void {
    const db = this.store.database.sqlite;
    db.prepare(
      "UPDATE automatic_exit_goals SET state=?,reason=? WHERE id=?",
    ).run(state, reason, g.id);
    db.prepare(
      "INSERT INTO automatic_exit_events(goal_id,at_ms,state,reason,evidence_json) VALUES(?,?,?,?,?)",
    ).run(g.id, this.now(), state, reason, jsonStringify(evidence));
  }
  private position(g: Goal) {
    return this.store.database.sqlite
      .prepare(
        "SELECT raw_amount,reserved_raw_amount,version FROM follower_positions WHERE id=?",
      )
      .get(g.position_id) as {
      raw_amount: string;
      reserved_raw_amount: string;
      version: number;
    };
  }
  private release(g: Goal, intent: ExecutionIntent): void {
    const p = this.position(g),
      reserved = BigInt(p.reserved_raw_amount);
    if (reserved < intent.theoreticalTokenRaw)
      throw Error("EXIT_RESERVATION_INVARIANT");
    this.store.database.sqlite
      .prepare(
        "UPDATE follower_positions SET reserved_raw_amount=?,version=version+1 WHERE id=?",
      )
      .run((reserved - intent.theoreticalTokenRaw).toString(), g.position_id);
  }
  private authorization(
    intent: ExecutionIntent,
  ): PreQuoteRiskDecision | undefined {
    const source = this.store.database.sqlite
      .prepare(
        `SELECT l.*,w.address leader FROM leader_trades l JOIN wallets w ON w.id=l.leader_wallet_id WHERE l.id=?`,
      )
      .get(intent.leaderTradeId) as
      | {
          side: string;
          leader: string;
          token_mint: string;
          quote_mint: string;
          token_raw: string;
          leader_pre_token_raw: string;
          source_timestamp_ms: number;
          source_timestamp_precision: string;
          source_timestamp_provenance: string;
          slot: string;
        }
      | undefined;
    if (
      !source ||
      source.side !== "SELL" ||
      source.leader !== intent.leaderWallet ||
      source.token_mint !== intent.tokenMint ||
      source.quote_mint !== intent.quoteMint ||
      BigInt(source.token_raw) <= 0n ||
      source.token_raw !== source.leader_pre_token_raw ||
      source.source_timestamp_ms !==
        intent.authoritativeSourceTimestamp?.valueMs ||
      source.source_timestamp_precision !==
        intent.authoritativeSourceTimestamp.precision ||
      source.source_timestamp_provenance !==
        intent.authoritativeSourceTimestamp.provenance
    )
      return undefined;
    const opening = this.store.database.sqlite
      .prepare(
        `SELECT l.slot FROM automatic_exit_goals g
      JOIN paper_fills f ON f.id=g.opening_fill_id JOIN leader_trades l ON l.id=f.leader_trade_id
      WHERE g.intent_id=?`,
      )
      .get(intent.executionKey) as { slot: string } | undefined;
    if (!opening || BigInt(source.slot) < BigInt(opening.slot))
      return undefined;
    const p = this.store.getRiskDecisionForIntent(
      "PRE_QUOTE",
      intent.executionKey,
    ) as PreQuoteRiskDecision | undefined;
    if (
      !p ||
      p.decision !== "ALLOW" ||
      p.policyVersion !== this.store.riskPolicy.policyVersion ||
      p.intentId !== intent.executionKey ||
      p.leaderTradeId !== intent.leaderTradeId ||
      p.leaderWallet !== intent.leaderWallet ||
      p.followerWallet !== intent.followerWallet ||
      p.side !== "SELL" ||
      p.tokenMint !== intent.tokenMint ||
      p.quoteMint !== intent.quoteMint ||
      p.approvedTokenRaw !== intent.theoreticalTokenRaw ||
      p.approvedQuoteRaw !== intent.theoreticalQuoteRaw ||
      p.approvedAmountRaw !== intent.theoreticalTokenRaw ||
      p.requestedTokenRaw !== intent.theoreticalTokenRaw
    )
      return undefined;
    return p;
  }
  async tick(): Promise<void> {
    if (!exitRecoveryEnabled(this.store.database)) return;
    for (const row of this.statuses()) {
      if (this.stopped) return;
      if (row.state === "COMPLETED") continue;
      const db = this.store.database.sqlite;
      const claimed = await this.store.database.write(() =>
        db
          .transaction(() => {
            const g = db
              .prepare("SELECT * FROM automatic_exit_goals WHERE id=?")
              .get(row.id) as Goal;
            const intent = decode<ExecutionIntent>(g.intent_json);
            if (g.state === "ATTENTION") {
              if (BigInt(this.position(g).raw_amount) === 0n)
                this.change(g, "COMPLETED", "POSITION_CLOSED_AFTER_ATTENTION");
              return;
            }
            if (g.state === "COMMITTING") return { g, intent, commit: true };
            if (g.state === "QUOTING") {
              if (this.now() > (g.lease_until_ms ?? 0)) {
                this.release(g, intent);
                this.change(g, "ATTENTION", "QUOTE_LEASE_EXPIRED");
              }
              return;
            }
            if (g.state !== "WAITING") return;
            const p = this.position(g);
            const opening = db
              .prepare(
                "SELECT fill_id FROM paper_fill_applications WHERE position_id=? AND transition='OPEN' ORDER BY position_version_after DESC LIMIT 1",
              )
              .get(g.position_id) as { fill_id: string } | undefined;
            if (opening?.fill_id !== g.opening_fill_id) {
              this.change(g, "ATTENTION", "LIFECYCLE_CHANGED");
              return;
            }
            if (BigInt(p.raw_amount) === 0n) {
              this.change(g, "COMPLETED", "POSITION_ALREADY_CLOSED");
              return;
            }
            const state = this.store.followerTradeState(intent.executionKey);
            if (state === "RESERVED" || state === "PAPER_EXECUTED") {
              if (
                this.now() - intent.createdAtMs >
                this.store.riskPolicy.maxIntentAgeMs
              )
                this.change(
                  g,
                  "ATTENTION",
                  "ORIGINAL_EXECUTION_REQUIRES_RECONCILIATION",
                );
              return;
            }
            if (state !== "FAILED") {
              this.change(g, "ATTENTION", "ORIGINAL_INTENT_NOT_RETRYABLE");
              return;
            }
            if (this.now() < g.next_at_ms) return;
            let pre: PreQuoteRiskDecision | undefined;
            try {
              pre = this.authorization(intent);
            } catch {
              /* fail closed */
            }
            const source = intent.authoritativeSourceTimestamp;
            const invalid =
              process.env.PAPER_ONLY !== "true" ||
              process.env.LIVE_FUNDS_ENABLED !== "false"
                ? "PAPER_SAFETY_INVALID"
                : !pre
                  ? "IMMUTABLE_PRE_INVALID"
                  : !source ||
                      this.now() - source.valueMs >
                        this.store.riskPolicy.maxIntentAgeMs
                    ? "SOURCE_AUTHORIZATION_EXPIRED"
                    : BigInt(p.raw_amount) !== intent.theoreticalTokenRaw
                      ? "POSITION_CHANGED_REMAINDER_REQUIRES_ATTENTION"
                      : BigInt(p.reserved_raw_amount) !== 0n
                        ? "POSITION_BUSY"
                        : this.store.revalidateBeforeQuote(intent);
            if (invalid) {
              this.change(g, "ATTENTION", invalid);
              return;
            }
            const wallets = db
              .prepare("SELECT enabled FROM wallets WHERE address IN (?,?)")
              .all(intent.leaderWallet, intent.followerWallet) as {
              enabled: number;
            }[];
            if (wallets.length !== 2 || wallets.some((w) => w.enabled !== 1)) {
              this.change(g, "ATTENTION", "WALLET_DISABLED");
              return;
            }
            db.prepare(
              "UPDATE follower_positions SET reserved_raw_amount=?,version=version+1 WHERE id=?",
            ).run(intent.theoreticalTokenRaw.toString(), g.position_id);
            db.prepare(
              "UPDATE automatic_exit_goals SET attempts=attempts+1,lease_until_ms=? WHERE id=?",
            ).run(this.now() + 5_000, g.id);
            this.change(g, "QUOTING", "ATTEMPT_STARTED", {
              attempt: g.attempts + 1,
              preDecisionId: pre?.decisionId,
            });
            return {
              g: { ...g, attempts: g.attempts + 1 },
              intent,
              commit: false,
            };
          })
          .immediate(),
      );
      if (!claimed) continue;
      const { g, intent } = claimed;
      if (claimed.commit) {
        await this.commit(g);
        continue;
      }
      this.fault?.("AFTER_CLAIM");
      // Distinct cache identity; quote output is rebound only after risk approval.
      let result: ExecutionResult;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      if (this.stopped) controller.abort();
      this.controllers.add(controller);
      const pending = Promise.resolve().then(() =>
        this.sender.send(
          {
            ...intent,
            executionKey: `${intent.executionKey}:exit:${g.attempts}`,
          },
          { signal: controller.signal },
        ),
      );
      this.pendingQuotes.add(pending);
      void pending
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          this.pendingQuotes.delete(pending);
          this.controllers.delete(controller);
        });
      try {
        result = await Promise.race([
          pending,
          new Promise<ExecutionResult>((resolve) => {
            timer = setTimeout(() => {
              controller.abort();
              resolve({
                executionKey: intent.executionKey,
                state: "FAILED",
                executedTokenRaw: 0n,
                executedQuoteRaw: 0n,
                reason: "QUOTE_TIMEOUT",
              });
            }, 3_000);
          }),
        ]);
      } catch {
        result = {
          executionKey: intent.executionKey,
          state: "FAILED",
          executedTokenRaw: 0n,
          executedQuoteRaw: 0n,
          reason: "QUOTE_THROW",
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
      result = { ...result, executionKey: intent.executionKey };
      const accepted = await this.store.database.write(() =>
        db
          .transaction(() => {
            const current = db
              .prepare("SELECT * FROM automatic_exit_goals WHERE id=?")
              .get(g.id) as Goal;
            if (current.state !== "QUOTING" || current.attempts !== g.attempts)
              return false;
            const p = this.position(g);
            let pre: PreQuoteRiskDecision | undefined;
            try {
              pre = this.authorization(intent);
            } catch {
              /* fail closed */
            }
            const wallets = db
              .prepare("SELECT enabled FROM wallets WHERE address IN (?,?)")
              .all(intent.leaderWallet, intent.followerWallet) as {
              enabled: number;
            }[];
            const invalid =
              this.now() > (current.lease_until_ms ?? 0)
                ? "QUOTE_LEASE_EXPIRED"
                : !pre
                  ? "IMMUTABLE_PRE_INVALID"
                  : process.env.PAPER_ONLY !== "true" ||
                      process.env.LIVE_FUNDS_ENABLED !== "false"
                    ? "PAPER_SAFETY_INVALID"
                    : wallets.length !== 2 ||
                        wallets.some((w) => w.enabled !== 1)
                      ? "WALLET_DISABLED"
                      : !intent.authoritativeSourceTimestamp ||
                          this.now() -
                            intent.authoritativeSourceTimestamp.valueMs >
                            this.store.riskPolicy.maxIntentAgeMs
                        ? "SOURCE_AUTHORIZATION_EXPIRED"
                        : BigInt(p.raw_amount) !== intent.theoreticalTokenRaw
                          ? "POSITION_CHANGED_REMAINDER_REQUIRES_ATTENTION"
                          : BigInt(p.reserved_raw_amount) !==
                              intent.theoreticalTokenRaw
                            ? "EXIT_RESERVATION_CHANGED"
                            : this.store.revalidateBeforeQuote(intent);
            const post =
              !invalid &&
              pre &&
              result.state === "PAPER_EXECUTED" &&
              result.paperQuoteEvidence
                ? new RiskEngine(this.store.riskPolicy).evaluatePostQuote({
                    phase: "POST_QUOTE",
                    nowMs: this.now(),
                    intent: {
                      intentId: intent.executionKey,
                      leaderTradeId: intent.leaderTradeId,
                      leaderWallet: intent.leaderWallet,
                      followerWallet: intent.followerWallet,
                      side: "SELL",
                      tokenMint: intent.tokenMint,
                      quoteMint: intent.quoteMint,
                      requestedTokenRaw: intent.theoreticalTokenRaw,
                      requestedQuoteRaw: intent.theoreticalQuoteRaw,
                      createdAtMs: intent.createdAtMs,
                      ...(intent.authoritativeSourceTimestamp
                        ? {
                            authoritativeSourceTimestamp:
                              intent.authoritativeSourceTimestamp,
                          }
                        : {}),
                    },
                    preDecision: pre,
                    quoteEvidence: result.paperQuoteEvidence,
                  })
                : undefined;
            if (
              !invalid &&
              post?.decision === "ALLOW" &&
              result.executedTokenRaw === intent.theoreticalTokenRaw &&
              result.executedQuoteRaw ===
                result.paperQuoteEvidence?.outputAmountRaw
            ) {
              db.prepare(
                "UPDATE automatic_exit_goals SET result_json=? WHERE id=?",
              ).run(jsonStringify(result), g.id);
              this.change(g, "COMMITTING", "POST_ALLOW", { post, result });
              return true;
            }
            this.release(g, intent);
            const reason =
              invalid ??
              post?.reasonCode ??
              result.reason ??
              "QUOTE_RESULT_INVALID";
            const retryable =
              !invalid &&
              [
                "PRICE_IMPACT_TOO_HIGH",
                "JUPITER_ORDER_FAILED",
                "QUOTE_THROW",
                "QUOTE_TIMEOUT",
                "STALE_QUOTE",
              ].includes(reason) &&
              g.attempts < BACKOFF_MS.length;
            db.prepare(
              "UPDATE automatic_exit_goals SET next_at_ms=? WHERE id=?",
            ).run(this.now() + (BACKOFF_MS[g.attempts] ?? 0), g.id);
            this.change(g, retryable ? "WAITING" : "ATTENTION", reason, {
              post,
              result,
            });
            return false;
          })
          .immediate(),
      );
      if (accepted) {
        this.fault?.("AFTER_ACCEPT");
        await this.commit(g);
      }
    }
  }
  private async commit(g: Goal): Promise<void> {
    const current = this.statuses().find((x) => x.id === g.id);
    if (current?.state !== "COMMITTING" || !current.result_json) return;
    const result = decode<ExecutionResult>(current.result_json);
    const fill = await this.store.savePaperFillFromExecutionResult(result);
    this.fault?.("AFTER_FILL");
    await this.store.applyPaperFill(fill);
    await this.fault?.("AFTER_APPLY");
    await this.store.database.write(() =>
      this.store.database.sqlite
        .transaction(() => {
          const latest = this.store.database.sqlite
            .prepare("SELECT state FROM automatic_exit_goals WHERE id=?")
            .get(g.id) as { state: string };
          if (latest.state !== "COMMITTING") return;
          const application = this.store.database.sqlite
            .prepare(
              `SELECT a.transition,a.position_id,
            (SELECT o.fill_id FROM paper_fill_applications o WHERE o.position_id=a.position_id AND o.transition='OPEN' AND o.position_version_after<=a.position_version_after ORDER BY o.position_version_after DESC LIMIT 1) opening_fill_id
            FROM paper_fill_applications a WHERE a.fill_id=?`,
            )
            .get(fill) as
            | {
                transition: string;
                position_id: number;
                opening_fill_id: string;
              }
            | undefined;
          if (
            !application ||
            application.position_id !== g.position_id ||
            application.opening_fill_id !== g.opening_fill_id
          )
            throw Error("EXIT_APPLICATION_LIFECYCLE_MISMATCH");
          this.change(
            g,
            application.transition === "CLOSE" ? "COMPLETED" : "ATTENTION",
            application.transition === "CLOSE"
              ? "PAPER_CLOSE_APPLIED"
              : "REMAINDER_AFTER_FILL",
            { fill },
          );
        })
        .immediate(),
    );
  }
}
