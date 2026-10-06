import type {
  ExecutionIntent,
  ExecutionResult,
  ExecutionState,
} from "../domain/execution.js";
import type { SystemEvent } from "../domain/events.js";
import { canonicalDomainQuoteMint } from "../domain/assets.js";
import { stableId } from "../domain/ids.js";
import { jsonStringify } from "../domain/json.js";
import type { Position } from "../domain/positions.js";
import {
  applyPaperFill as reducePaperFill,
  PAPER_ACCOUNTING_POLICY_VERSION,
  type PaperFill,
  type PaperPosition,
} from "../domain/paper-trading.js";
import type { SwapEvent } from "../domain/trades.js";
import type { Clock } from "../domain/time.js";
import type {
  PreQuoteRiskContext,
  PreQuoteRiskDecision,
  PostQuoteRiskDecision,
} from "../risk/risk-engine.js";
import { RiskEngine } from "../risk/risk-engine.js";
import type {
  RiskPolicy,
  RiskGlobalState,
  RiskQuoteState,
} from "../risk/risk-engine.js";
import type { ProviderHealthStateSnapshot } from "../risk/provider-health.js";
import { Decimal } from "decimal.js";
import { SqliteDatabase } from "./database.js";
import { captureExitGoal, exitBlocksBuy } from "../recovery/automatic-exit-recovery.js";

interface WalletRow {
  id: number;
  address: string;
  role: "LEADER" | "FOLLOWER";
}

interface PositionRow {
  follower_wallet: string;
  leader_wallet: string;
  token_mint: string;
  quote_mint: string | null;
  accounting_policy_version: string | null;
  raw_amount: string;
  reserved_raw_amount: string;
  version: number;
  state: "OPEN" | "CLOSED";
}

interface RecoverableRow {
  execution_key: string;
  leader_trade_id: string;
  leader_wallet: string;
  follower_wallet: string;
  side: "BUY" | "SELL";
  token_mint: string;
  quote_mint: string;
  theoretical_token_raw: string;
  theoretical_quote_raw: string;
  executed_token_raw: string | null;
  executed_quote_raw: string | null;
  copy_ratio_bps: number;
  sell_ratio_numerator: string | null;
  sell_ratio_denominator: string | null;
  skip_reason: string | null;
  order_created_timestamp_ms: number;
  order_created_monotonic_ns: string;
  authoritative_source_timestamp_ms: number | null;
  authoritative_source_timestamp_precision: string;
  authoritative_source_timestamp_provenance: string;
  state: ExecutionState;
}

interface PaperFillRow {
  id: string;
  intent_id: string;
  leader_trade_id: string;
  leader_tx_signature: string;
  leader_wallet: string;
  follower_wallet: string;
  side: "BUY" | "SELL";
  input_mint: string;
  output_mint: string;
  token_decimals: number;
  quote_decimals: number;
  input_amount_raw: string;
  output_amount_raw: string;
  quote_request_timestamp_ms: number;
  quote_timestamp_ms: number;
  quote_rtt_ms: number;
  fee_evidence_status: "AVAILABLE" | "AMOUNT_UNAVAILABLE";
  fee_evidence_contract_id: string | null;
  fee_bps: number | null;
  fee_mint: string | null;
  fee_amount_raw: string | null;
  provider: string;
  request_id: string | null;
  fill_policy_version: PaperFill["fillPolicyVersion"];
  created_at_ms: number;
}

interface PaperPositionRow {
  id: number;
  follower_wallet: string;
  leader_wallet: string;
  token_mint: string;
  quote_mint: string | null;
  token_decimals: number | null;
  quote_decimals: number | null;
  raw_amount: string;
  reserved_raw_amount: string;
  total_cost_quote_raw: string | null;
  realized_pnl_quote_raw: string | null;
  accounting_policy_version: string | null;
  opened_at_ms: number | null;
  updated_at_ms: number;
  closed_at_ms: number | null;
  version: number;
  state: "OPEN" | "CLOSED";
}

export interface ReservedIntent {
  readonly created: boolean;
  readonly state: ExecutionState;
}

export type PersistedRiskDecision =
  PreQuoteRiskDecision | PostQuoteRiskDecision;

export class StateStore {
  constructor(
    readonly database: SqliteDatabase,
    private readonly clock: Clock,
    readonly riskPolicy: RiskPolicy,
  ) {
    if (!riskPolicy) throw new Error("RISK_POLICY_REQUIRED");
  }

  getQuoteRiskState(
    quoteMint: string,
    atMs?: number,
  ):
    | {
        readonly quoteState: RiskQuoteState;
        readonly utcDay: string;
        readonly dailyRealizedPnlRaw: bigint;
      }
    | undefined {
    const row = this.database.sqlite
      .prepare(
        "SELECT quote_state, utc_day, daily_realized_pnl_raw FROM risk_state WHERE quote_mint = ?",
      )
      .get(quoteMint) as
      | {
          quote_state: RiskQuoteState;
          utc_day: string;
          daily_realized_pnl_raw: string;
        }
      | undefined;
    const requestedUtcDay = new Date(atMs ?? this.clock.now().wallMs)
      .toISOString()
      .slice(0, 10);
    return row
      ? {
          quoteState:
            row.utc_day === requestedUtcDay ? row.quote_state : "RUNNING",
          utcDay: requestedUtcDay,
          dailyRealizedPnlRaw:
            row.utc_day === requestedUtcDay
              ? BigInt(row.daily_realized_pnl_raw)
              : 0n,
        }
      : undefined;
  }

  getGlobalRiskState(): RiskGlobalState {
    const row = this.database.sqlite
      .prepare(
        "SELECT global_state FROM risk_global_state WHERE singleton_id = 1",
      )
      .get() as { global_state: RiskGlobalState } | undefined;
    if (!row) throw new Error("RISK_GLOBAL_STATE_UNAVAILABLE");
    return row.global_state;
  }

  async setGlobalRiskState(
    globalState: RiskGlobalState,
    reasonCode: string,
  ): Promise<void> {
    await this.database.write(() => {
      this.setGlobalRiskStateSync(
        globalState,
        reasonCode,
        this.clock.now().wallMs,
      );
    });
  }

  getProviderHealthState(
    provider: string,
  ): ProviderHealthStateSnapshot | undefined {
    const row = this.database.sqlite
      .prepare("SELECT state_json FROM risk_provider_health WHERE provider = ?")
      .get(provider) as { state_json: string } | undefined;
    return row
      ? (JSON.parse(row.state_json) as ProviderHealthStateSnapshot)
      : undefined;
  }

  async saveProviderHealthState(
    provider: string,
    state: ProviderHealthStateSnapshot,
  ): Promise<void> {
    await this.database.write(() => {
      this.database.sqlite
        .prepare(
          `INSERT INTO risk_provider_health(provider, state_json, updated_at_ms)
           VALUES (?, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET
             state_json = excluded.state_json,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(provider, jsonStringify(state), this.clock.now().wallMs);
    });
  }

  async saveRiskDecision(decision: PersistedRiskDecision): Promise<boolean> {
    return this.database.write(() => {
      const result = this.database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO risk_decisions(
             decision_id, phase, intent_id, leader_trade_id, leader_wallet,
             follower_wallet, side, token_mint, quote_mint,
             pre_decision_id, quote_request_id,
             decision, requested_amount_raw, approved_amount_raw,
             requested_token_raw, approved_token_raw, requested_quote_raw,
             approved_quote_raw, reason_code, policy_version, relevant_limit_raw,
             relevant_evidence_json, decided_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decision.decisionId,
          decision.phase,
          decision.intentId,
          decision.leaderTradeId,
          decision.leaderWallet,
          decision.followerWallet,
          decision.side,
          decision.tokenMint,
          decision.quoteMint,
          "preDecisionId" in decision ? decision.preDecisionId : null,
          "quoteRequestId" in decision ? decision.quoteRequestId : null,
          decision.decision,
          decision.requestedAmountRaw.toString(),
          decision.approvedAmountRaw.toString(),
          decision.requestedTokenRaw.toString(),
          decision.approvedTokenRaw.toString(),
          decision.requestedQuoteRaw.toString(),
          decision.approvedQuoteRaw.toString(),
          decision.reasonCode,
          decision.policyVersion,
          decision.relevantLimitRaw?.toString() ?? null,
          jsonStringify(decision.relevantEvidence ?? {}),
          decision.decidedAtMs,
        );
      return result.changes === 1;
    });
  }

  async evaluateAndReservePreQuote(
    context: PreQuoteRiskContext,
    engine: RiskEngine,
  ): Promise<PreQuoteRiskDecision> {
    return this.database.write(() =>
      this.database.sqlite.transaction(() =>
        this.evaluateAndReservePreQuoteSync(context, engine),
      )(),
    );
  }

  async evaluateAndReserveExecutionIntent(
    intent: ExecutionIntent,
    engine: RiskEngine,
    providerHealth: PreQuoteRiskContext["providerHealth"] = "HEALTHY",
  ): Promise<PreQuoteRiskDecision> {
    return this.database.write(() =>
      this.database.sqlite.transaction(() => {
        const evaluatedAtMs = this.clock.now().wallMs;
        const portfolioPositions = this.paperPositionsForFollowerQuote(
          intent.followerWallet,
          intent.quoteMint,
        );
        const currentPosition = portfolioPositions.find(
          (position) =>
            position.leaderWallet === intent.leaderWallet &&
            position.tokenMint === intent.tokenMint,
        );
        const riskState = this.getQuoteRiskState(
          intent.quoteMint,
          evaluatedAtMs,
        );
        return this.evaluateAndReservePreQuoteSync(
          {
            phase: "PRE_QUOTE",
            nowMs: evaluatedAtMs,
            intent: {
              intentId: intent.executionKey,
              leaderTradeId: intent.leaderTradeId,
              leaderWallet: intent.leaderWallet,
              followerWallet: intent.followerWallet,
              side: intent.side,
              tokenMint: intent.tokenMint,
              quoteMint: intent.quoteMint,
              requestedTokenRaw: intent.theoreticalTokenRaw,
              requestedQuoteRaw: intent.theoreticalQuoteRaw,
              createdAtMs: intent.createdAtMs,
              ...(intent.authoritativeSourceTimestamp === undefined
                ? {}
                : {
                    authoritativeSourceTimestamp:
                      intent.authoritativeSourceTimestamp,
                  }),
            },
            ...(currentPosition === undefined ? {} : { currentPosition }),
            portfolioPositions,
            pendingApprovedBuyQuoteRawByQuoteMint: {
              [intent.quoteMint]: 0n,
            },
            pendingApprovedBuyQuoteRawForToken: 0n,
            dailyRealizedPnlRawByQuoteMint: {
              [intent.quoteMint]: riskState?.dailyRealizedPnlRaw ?? 0n,
            },
            quoteState: riskState?.quoteState ?? "RUNNING",
            globalState: this.getGlobalRiskState(),
            providerHealth,
          },
          engine,
        );
      })(),
    );
  }

  private evaluateAndReservePreQuoteSync(
    context: PreQuoteRiskContext,
    engine: RiskEngine,
  ): PreQuoteRiskDecision {
    const existingDecision = this.database.sqlite
      .prepare(
        "SELECT decision_id FROM risk_decisions WHERE phase = 'PRE_QUOTE' AND intent_id = ?",
      )
      .get(context.intent.intentId) as { decision_id: string } | undefined;
    if (existingDecision) {
      const decision = this.getRiskDecision(existingDecision.decision_id);
      if (!decision) throw new Error("RISK_DECISION_IDENTITY_UNAVAILABLE");
      return decision as PreQuoteRiskDecision;
    }
    const legacyActive = this.database.sqlite
      .prepare(
        "SELECT intent_id FROM risk_buy_reservations WHERE state = 'ACTIVE' AND follower_wallet IS NULL LIMIT 1",
      )
      .get() as { intent_id: string } | undefined;
    if (legacyActive)
      throw new Error("LEGACY_RISK_COMMITMENT_SCOPE_UNAVAILABLE");
    const rows = this.database.sqlite
      .prepare(
        `SELECT token_mint, approved_quote_raw
         FROM risk_buy_reservations
         WHERE follower_wallet = ? AND quote_mint = ? AND state = 'ACTIVE'`,
      )
      .all(context.intent.followerWallet, context.intent.quoteMint) as {
      token_mint: string;
      approved_quote_raw: string;
    }[];
    const portfolioPendingRaw = rows.reduce(
      (total, row) => total + BigInt(row.approved_quote_raw),
      0n,
    );
    const tokenPendingRaw = rows
      .filter((row) => row.token_mint === context.intent.tokenMint)
      .reduce((total, row) => total + BigInt(row.approved_quote_raw), 0n);
    const decision = engine.evaluatePreQuote({
      ...context,
      pendingApprovedBuyQuoteRawByQuoteMint: {
        ...context.pendingApprovedBuyQuoteRawByQuoteMint,
        [context.intent.quoteMint]: portfolioPendingRaw,
      },
      pendingApprovedBuyQuoteRawForToken: tokenPendingRaw,
    });
    this.insertRiskDecisionRow(decision);
    if (context.intent.side !== "BUY") return decision;
    const now = this.clock.now().wallMs;
    this.database.sqlite
      .prepare(
        `INSERT INTO risk_buy_reservations(
           intent_id, follower_wallet, leader_wallet, token_mint, quote_mint,
           approved_quote_raw, state, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        context.intent.intentId,
        context.intent.followerWallet,
        context.intent.leaderWallet,
        context.intent.tokenMint,
        context.intent.quoteMint,
        decision.approvedQuoteRaw.toString(),
        decision.approvedQuoteRaw === 0n ? "RELEASED" : "ACTIVE",
        now,
        now,
      );
    return decision;
  }

  async releaseRiskBuyReservation(intentId: string): Promise<void> {
    await this.database.write(() => {
      this.database.sqlite
        .prepare(
          `UPDATE risk_buy_reservations
           SET state = 'RELEASED', updated_at_ms = ?
           WHERE intent_id = ? AND state = 'ACTIVE'`,
        )
        .run(this.clock.now().wallMs, intentId);
    });
  }

  async recoverOrphanRiskBuyReservations(): Promise<number> {
    return this.database.write(() => {
      const now = this.clock.now().wallMs;
      const result = this.database.sqlite
        .prepare(
          `UPDATE risk_buy_reservations
           SET state = 'RELEASED', updated_at_ms = ?
           WHERE state = 'ACTIVE'
             AND NOT EXISTS (
               SELECT 1 FROM follower_trades ft
               WHERE ft.execution_key = risk_buy_reservations.intent_id
             )`,
        )
        .run(now);
      return result.changes;
    });
  }

  private insertRiskDecisionRow(decision: PersistedRiskDecision): void {
    this.database.sqlite
      .prepare(
        `INSERT OR IGNORE INTO risk_decisions(
           decision_id, phase, intent_id, leader_trade_id, leader_wallet,
           follower_wallet, side, token_mint, quote_mint,
           pre_decision_id, quote_request_id,
           decision, requested_amount_raw, approved_amount_raw,
           requested_token_raw, approved_token_raw, requested_quote_raw,
           approved_quote_raw, reason_code, policy_version, relevant_limit_raw,
           relevant_evidence_json, decided_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.decisionId,
        decision.phase,
        decision.intentId,
        decision.leaderTradeId,
        decision.leaderWallet,
        decision.followerWallet,
        decision.side,
        decision.tokenMint,
        decision.quoteMint,
        "preDecisionId" in decision ? decision.preDecisionId : null,
        "quoteRequestId" in decision ? decision.quoteRequestId : null,
        decision.decision,
        decision.requestedAmountRaw.toString(),
        decision.approvedAmountRaw.toString(),
        decision.requestedTokenRaw.toString(),
        decision.approvedTokenRaw.toString(),
        decision.requestedQuoteRaw.toString(),
        decision.approvedQuoteRaw.toString(),
        decision.reasonCode,
        decision.policyVersion,
        decision.relevantLimitRaw?.toString() ?? null,
        jsonStringify(decision.relevantEvidence ?? {}),
        decision.decidedAtMs,
      );
  }

  getRiskDecision(decisionId: string): PersistedRiskDecision | undefined {
    const row = this.database.sqlite
      .prepare("SELECT * FROM risk_decisions WHERE decision_id = ?")
      .get(decisionId) as
      | {
          decision_id: string;
          phase: "PRE_QUOTE" | "POST_QUOTE";
          intent_id: string;
          leader_trade_id: string | null;
          leader_wallet: string | null;
          follower_wallet: string | null;
          side: "BUY" | "SELL" | null;
          token_mint: string | null;
          quote_mint: string | null;
          pre_decision_id: string | null;
          quote_request_id: string | null;
          decision: "ALLOW" | "RESIZE" | "REJECT" | "HALT";
          requested_amount_raw: string;
          approved_amount_raw: string;
          requested_token_raw: string;
          approved_token_raw: string;
          requested_quote_raw: string;
          approved_quote_raw: string;
          reason_code: PersistedRiskDecision["reasonCode"];
          policy_version: string;
          relevant_limit_raw: string | null;
          relevant_evidence_json: string;
          decided_at_ms: number;
        }
      | undefined;
    if (!row) return undefined;
    if (
      row.leader_trade_id === null ||
      row.leader_wallet === null ||
      row.follower_wallet === null ||
      row.side === null ||
      row.token_mint === null ||
      row.quote_mint === null
    ) {
      return undefined;
    }
    const base = {
      phase: row.phase,
      decisionId: row.decision_id,
      decision: row.decision,
      intentId: row.intent_id,
      leaderTradeId: row.leader_trade_id,
      leaderWallet: row.leader_wallet,
      followerWallet: row.follower_wallet,
      side: row.side,
      tokenMint: row.token_mint,
      quoteMint: row.quote_mint,
      requestedAmountRaw: BigInt(row.requested_amount_raw),
      approvedAmountRaw: BigInt(row.approved_amount_raw),
      requestedTokenRaw: BigInt(row.requested_token_raw),
      approvedTokenRaw: BigInt(row.approved_token_raw),
      requestedQuoteRaw: BigInt(row.requested_quote_raw),
      approvedQuoteRaw: BigInt(row.approved_quote_raw),
      reasonCode: row.reason_code,
      policyVersion: row.policy_version,
      ...(row.relevant_limit_raw === null
        ? {}
        : { relevantLimitRaw: BigInt(row.relevant_limit_raw) }),
      ...(row.relevant_evidence_json === "{}"
        ? {}
        : {
            relevantEvidence: JSON.parse(row.relevant_evidence_json) as Record<
              string,
              string | number | boolean
            >,
          }),
      decidedAtMs: row.decided_at_ms,
    };
    return row.phase === "POST_QUOTE"
      ? {
          ...base,
          phase: "POST_QUOTE",
          preDecisionId: row.pre_decision_id!,
          quoteRequestId: row.quote_request_id!,
        }
      : { ...base, phase: "PRE_QUOTE" };
  }

  getRiskDecisionForIntent(
    phase: "PRE_QUOTE" | "POST_QUOTE",
    intentId: string,
  ): PersistedRiskDecision | undefined {
    const row = this.database.sqlite
      .prepare(
        "SELECT decision_id FROM risk_decisions WHERE phase = ? AND intent_id = ?",
      )
      .get(phase, intentId) as { decision_id: string } | undefined;
    return row ? this.getRiskDecision(row.decision_id) : undefined;
  }

  async upsertWallet(
    address: string,
    role: "LEADER" | "FOLLOWER",
    copyRatioBps = 10_000,
    maxQuoteRaw?: bigint,
  ): Promise<number> {
    return this.database.write(() => {
      const now = this.clock.now().wallMs;
      this.database.sqlite
        .prepare(
          `
          INSERT INTO wallets(address, role, enabled, copy_ratio_bps, max_quote_raw, created_at_ms, updated_at_ms)
          VALUES (?, ?, 1, ?, ?, ?, ?)
          ON CONFLICT(address) DO UPDATE SET
            role = excluded.role,
            copy_ratio_bps = excluded.copy_ratio_bps,
            max_quote_raw = excluded.max_quote_raw,
            updated_at_ms = excluded.updated_at_ms
        `,
        )
        .run(
          address,
          role,
          copyRatioBps,
          maxQuoteRaw?.toString() ?? null,
          now,
          now,
        );
      return this.requireWallet(address).id;
    });
  }

  async saveLeaderTrade(event: SwapEvent): Promise<boolean> {
    if (canonicalDomainQuoteMint(event.quote.mint) !== event.quote.mint) {
      throw new Error("NON_CANONICAL_QUOTE_MINT");
    }
    return this.database.write(() =>
      this.database.sqlite.transaction(() => {
        const leader = this.requireWallet(event.leaderWallet);
        this.ensureTokenSync(event.token.mint, event.token.decimals, false);
        this.ensureTokenSync(event.quote.mint, event.quote.decimals, true);
        const now = this.clock.now().wallMs;
        const sourcePrice = this.normalizedPrice(
          event.quote.raw,
          event.quote.decimals,
          event.token.raw,
          event.token.decimals,
        );
        const result = this.database.sqlite
          .prepare(
            `
            INSERT OR IGNORE INTO leader_trades(
              id, leader_wallet_id, signature, event_index, slot, side, token_mint, quote_mint,
              token_raw, quote_raw, leader_pre_token_raw, source_price, source_timestamp_ms,
              source_timestamp_precision, source_timestamp_provenance,
              stream_received_timestamp_ms, detected_timestamp_ms,
              decoded_timestamp_ms, evidence_json, created_at_ms
              , stream_received_monotonic_ns, detected_monotonic_ns, decoded_monotonic_ns
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            event.id,
            leader.id,
            event.signature,
            event.eventIndex,
            event.slot.toString(),
            event.side,
            event.token.mint,
            event.quote.mint,
            event.token.raw.toString(),
            event.quote.raw.toString(),
            event.leaderPreTokenRaw.toString(),
            sourcePrice,
            event.timestamps.sourceTimestampMs ?? null,
            event.timestamps.sourceTimestampPrecision,
            event.timestamps.sourceTimestampProvenance,
            event.timestamps.streamReceivedTimestampMs,
            event.timestamps.detectedTimestampMs,
            event.timestamps.decodedTimestampMs,
            jsonStringify(event.evidence),
            now,
            event.timestamps.streamReceivedMonotonicNs.toString(),
            event.timestamps.detectedMonotonicNs.toString(),
            event.timestamps.decodedMonotonicNs.toString(),
          );
        if (result.changes === 0) return false;
        const signedDelta =
          event.side === "BUY" ? event.token.raw : -event.token.raw;
        const existing = this.database.sqlite
          .prepare(
            "SELECT raw_amount FROM leader_positions WHERE leader_wallet_id = ? AND token_mint = ?",
          )
          .get(leader.id, event.token.mint) as
          { raw_amount: string } | undefined;
        const current = BigInt(existing?.raw_amount ?? "0");
        const next = current + signedDelta < 0n ? 0n : current + signedDelta;
        this.database.sqlite
          .prepare(
            `
            INSERT INTO leader_positions(leader_wallet_id, token_mint, raw_amount, state, last_trade_id, version, updated_at_ms)
            VALUES (?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(leader_wallet_id, token_mint) DO UPDATE SET
              raw_amount = excluded.raw_amount,
              state = excluded.state,
              last_trade_id = excluded.last_trade_id,
              version = leader_positions.version + 1,
              updated_at_ms = excluded.updated_at_ms
          `,
          )
          .run(
            leader.id,
            event.token.mint,
            next.toString(),
            next === 0n ? "CLOSED" : "OPEN",
            event.id,
            now,
          );
        return true;
      })(),
    );
  }

  async savePaperFill(fill: PaperFill): Promise<boolean> {
    const quoteMint = fill.side === "BUY" ? fill.inputMint : fill.outputMint;
    if (canonicalDomainQuoteMint(quoteMint) !== quoteMint) {
      throw new Error("NON_CANONICAL_QUOTE_MINT");
    }
    return this.database.write(() => {
      const result = this.database.sqlite
        .prepare(
          `
          INSERT OR IGNORE INTO paper_fills(
            id, intent_id, leader_trade_id, leader_tx_signature, leader_wallet,
            follower_wallet, side, input_mint, output_mint, token_decimals,
            quote_decimals, input_amount_raw,
            output_amount_raw, quote_request_timestamp_ms, quote_timestamp_ms,
            quote_rtt_ms, fee_evidence_status, fee_evidence_contract_id,
            fee_bps, fee_mint, fee_amount_raw,
            provider, request_id, fill_policy_version, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          fill.id,
          fill.intentId,
          fill.leaderTradeId,
          fill.leaderTxSignature,
          fill.leaderWallet,
          fill.followerWallet,
          fill.side,
          fill.inputMint,
          fill.outputMint,
          fill.tokenDecimals,
          fill.quoteDecimals,
          fill.inputAmountRaw.toString(),
          fill.outputAmountRaw.toString(),
          fill.quoteRequestTimestampMs,
          fill.quoteTimestampMs,
          fill.quoteRttMs,
          fill.feeEvidence.status,
          fill.feeEvidence.feeEvidenceContractId ?? null,
          fill.feeEvidence.feeBps ?? null,
          fill.feeEvidence.feeMint ?? null,
          fill.feeEvidence.feeAmountRaw?.toString() ?? null,
          fill.provider,
          fill.requestId ?? null,
          fill.fillPolicyVersion,
          fill.createdAtMs,
        );
      return result.changes === 1;
    });
  }

  async savePaperFillFromExecutionResult(
    result: ExecutionResult,
  ): Promise<string> {
    const evidence = result.paperQuoteEvidence;
    if (result.state !== "PAPER_EXECUTED" || evidence === undefined) {
      throw new Error("PAPER_FILL_QUOTE_REQUIRED");
    }
    const row = this.database.sqlite
      .prepare(
        `
        SELECT ft.execution_key, ft.leader_trade_id, ft.side, ft.token_mint,
               ft.quote_mint, lt.signature AS leader_tx_signature,
               lw.address AS leader_wallet, fw.address AS follower_wallet,
               token.decimals AS token_decimals,
               quote.decimals AS quote_decimals
        FROM follower_trades ft
        JOIN leader_trades lt ON lt.id = ft.leader_trade_id
        JOIN wallets lw ON lw.id = lt.leader_wallet_id
        JOIN wallets fw ON fw.id = ft.follower_wallet_id
        JOIN tokens token ON token.mint = ft.token_mint
        JOIN tokens quote ON quote.mint = ft.quote_mint
        WHERE ft.execution_key = ?
      `,
      )
      .get(result.executionKey) as
      | {
          execution_key: string;
          leader_trade_id: string;
          side: "BUY" | "SELL";
          token_mint: string;
          quote_mint: string;
          leader_tx_signature: string;
          leader_wallet: string;
          follower_wallet: string;
          token_decimals: number;
          quote_decimals: number;
        }
      | undefined;
    if (!row) throw new Error("PAPER_FILL_INTENT_NOT_FOUND");
    const expectedInputMint =
      row.side === "BUY" ? row.quote_mint : row.token_mint;
    const expectedOutputMint =
      row.side === "BUY" ? row.token_mint : row.quote_mint;
    if (
      evidence.inputMint !== expectedInputMint ||
      evidence.outputMint !== expectedOutputMint ||
      evidence.inputAmountRaw <= 0n ||
      evidence.outputAmountRaw <= 0n
    ) {
      throw new Error("PAPER_FILL_QUOTE_EVIDENCE_MISMATCH");
    }
    const fillId = stableId(
      "paper_fill",
      row.execution_key,
      "JUPITER_ORDER_QUOTE_AS_FILL_V1",
    );
    await this.savePaperFill({
      id: fillId,
      intentId: row.execution_key,
      leaderTradeId: row.leader_trade_id,
      leaderTxSignature: row.leader_tx_signature,
      leaderWallet: row.leader_wallet,
      followerWallet: row.follower_wallet,
      side: row.side,
      inputMint: evidence.inputMint,
      outputMint: evidence.outputMint,
      tokenDecimals: row.token_decimals,
      quoteDecimals: row.quote_decimals,
      inputAmountRaw: evidence.inputAmountRaw,
      outputAmountRaw: evidence.outputAmountRaw,
      quoteRequestTimestampMs: evidence.requestTimestampMs,
      quoteTimestampMs: evidence.responseTimestampMs,
      quoteRttMs:
        Number(evidence.responseMonotonicNs - evidence.requestMonotonicNs) /
        1_000_000,
      feeEvidence:
        evidence.feeEvidence?.status === "AVAILABLE"
          ? {
              status: "AVAILABLE",
              feeEvidenceContractId: evidence.feeEvidence.contractVersion,
              feeBps: evidence.feeEvidence.feeBps,
              feeMint: evidence.feeEvidence.feeMint,
              feeAmountRaw: evidence.feeEvidence.feeAmountRaw,
            }
          : {
              status: "AMOUNT_UNAVAILABLE",
              ...(evidence.feeEvidence === undefined
                ? {}
                : {
                    feeEvidenceContractId: evidence.feeEvidence.contractVersion,
                  }),
              feeBps: evidence.feeBps,
              feeMint: evidence.feeMint,
            },
      provider: evidence.provider,
      requestId: evidence.requestId,
      fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
      createdAtMs: evidence.responseTimestampMs,
    });
    return fillId;
  }

  getPaperFill(id: string): PaperFill | undefined {
    const row = this.database.sqlite
      .prepare("SELECT * FROM paper_fills WHERE id = ?")
      .get(id) as PaperFillRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      intentId: row.intent_id,
      leaderTradeId: row.leader_trade_id,
      leaderTxSignature: row.leader_tx_signature,
      leaderWallet: row.leader_wallet,
      followerWallet: row.follower_wallet,
      side: row.side,
      inputMint: row.input_mint,
      outputMint: row.output_mint,
      tokenDecimals: row.token_decimals,
      quoteDecimals: row.quote_decimals,
      inputAmountRaw: BigInt(row.input_amount_raw),
      outputAmountRaw: BigInt(row.output_amount_raw),
      quoteRequestTimestampMs: row.quote_request_timestamp_ms,
      quoteTimestampMs: row.quote_timestamp_ms,
      quoteRttMs: row.quote_rtt_ms,
      feeEvidence: {
        status: row.fee_evidence_status,
        ...(row.fee_evidence_contract_id === null
          ? {}
          : { feeEvidenceContractId: row.fee_evidence_contract_id }),
        ...(row.fee_bps === null ? {} : { feeBps: row.fee_bps }),
        ...(row.fee_mint === null ? {} : { feeMint: row.fee_mint }),
        ...(row.fee_amount_raw === null
          ? {}
          : { feeAmountRaw: BigInt(row.fee_amount_raw) }),
      },
      provider: row.provider,
      ...(row.request_id === null ? {} : { requestId: row.request_id }),
      fillPolicyVersion: row.fill_policy_version,
      createdAtMs: row.created_at_ms,
    };
  }

  getPaperPosition(
    followerWallet: string,
    leaderWallet: string,
    tokenMint: string,
    quoteMint: string,
  ): PaperPosition | undefined {
    const row = this.paperPositionRow(
      followerWallet,
      leaderWallet,
      tokenMint,
      quoteMint,
    );
    if (!row) return undefined;
    if (row.accounting_policy_version === null) {
      if (BigInt(row.raw_amount) > 0n) {
        throw new Error("LEGACY_POSITION_COST_BASIS_UNAVAILABLE");
      }
      return undefined;
    }
    if (row.quote_mint !== quoteMint) {
      throw new Error("POSITION_IDENTITY_MISMATCH");
    }
    return this.paperPositionFromRow(row);
  }

  async applyPaperFill(fillId: string): Promise<"APPLIED" | "ALREADY_APPLIED"> {
    return this.database.write(() =>
      this.database.sqlite.transaction(() => {
        const existing = this.database.sqlite
          .prepare("SELECT 1 FROM paper_fill_applications WHERE fill_id = ?")
          .get(fillId);
        if (existing) return "ALREADY_APPLIED" as const;
        const fill = this.getPaperFill(fillId);
        if (!fill) throw new Error("PAPER_FILL_NOT_FOUND");
        const tokenMint =
          fill.side === "BUY" ? fill.outputMint : fill.inputMint;
        const quoteMint =
          fill.side === "BUY" ? fill.inputMint : fill.outputMint;
        const row = this.paperPositionRow(
          fill.followerWallet,
          fill.leaderWallet,
          tokenMint,
          quoteMint,
        );
        if (!row) throw new Error("FOLLOWER_POSITION_NOT_RESERVED");
        if (
          row.accounting_policy_version === null &&
          BigInt(row.raw_amount) > 0n
        ) {
          throw new Error("LEGACY_POSITION_COST_BASIS_UNAVAILABLE");
        }
        if (row.quote_mint !== null && row.quote_mint !== quoteMint) {
          throw new Error("POSITION_IDENTITY_MISMATCH");
        }
        const current =
          row.accounting_policy_version === null
            ? undefined
            : this.paperPositionFromRow(row);
        const reduced = reducePaperFill(current, fill);
        const reservation = this.database.sqlite
          .prepare(
            "SELECT theoretical_token_raw FROM follower_trades WHERE execution_key = ?",
          )
          .get(fill.intentId) as { theoretical_token_raw: string } | undefined;
        if (!reservation) throw new Error("PAPER_FILL_INTENT_NOT_FOUND");
        const reservationRaw = BigInt(reservation.theoretical_token_raw);
        const persistedReservedRaw = BigInt(row.reserved_raw_amount);
        if (persistedReservedRaw < reservationRaw) {
          throw new Error("RESERVATION_INVARIANT_VIOLATION");
        }
        const next = {
          ...reduced.position,
          reservedRaw: persistedReservedRaw - reservationRaw,
          version: row.version + 1,
        } satisfies PaperPosition;
        const appliedAtMs = this.clock.now().wallMs;
        this.database.sqlite
          .prepare(
            `
            INSERT INTO paper_fill_applications(
              fill_id, position_id, transition, quantity_before_raw,
              quantity_after_raw, total_cost_before_raw, total_cost_after_raw,
              allocated_cost_basis_raw, proceeds_raw, realized_pnl_delta_raw,
              realized_pnl_after_raw, position_version_after, applied_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            fill.id,
            row.id,
            reduced.transition,
            row.raw_amount,
            next.quantityRaw.toString(),
            row.total_cost_quote_raw ?? "0",
            next.totalCostQuoteRaw.toString(),
            reduced.allocatedCostBasisRaw.toString(),
            reduced.proceedsRaw.toString(),
            reduced.realizedPnlDeltaRaw.toString(),
            next.realizedPnlQuoteRaw.toString(),
            next.version,
            appliedAtMs,
          );
        const update = this.database.sqlite
          .prepare(
            `
            UPDATE follower_positions
            SET quote_mint = ?, raw_amount = ?, reserved_raw_amount = ?,
                total_cost_quote_raw = ?, realized_pnl_quote_raw = ?,
                accounting_policy_version = ?, opened_at_ms = ?,
                updated_at_ms = ?, closed_at_ms = ?, state = ?,
                last_execution_key = ?, last_fill_id = ?, version = ?
            WHERE id = ? AND version = ?
          `,
          )
          .run(
            next.quoteMint,
            next.quantityRaw.toString(),
            next.reservedRaw.toString(),
            next.totalCostQuoteRaw.toString(),
            next.realizedPnlQuoteRaw.toString(),
            next.accountingPolicyVersion,
            next.openedAtMs,
            next.updatedAtMs,
            next.closedAtMs,
            next.status,
            fill.intentId,
            fill.id,
            next.version,
            row.id,
            row.version,
          );
        if (update.changes !== 1) throw new Error("POSITION_VERSION_CONFLICT");
        this.database.sqlite
          .prepare(
            `
            UPDATE follower_trades
            SET state = 'CONFIRMED', executed_token_raw = ?,
                executed_quote_raw = ?, confirmed_timestamp_ms = ?, updated_at_ms = ?
            WHERE execution_key = ?
          `,
          )
          .run(
            (fill.side === "BUY"
              ? fill.outputAmountRaw
              : fill.inputAmountRaw
            ).toString(),
            (fill.side === "BUY"
              ? fill.inputAmountRaw
              : fill.outputAmountRaw
            ).toString(),
            fill.createdAtMs,
            appliedAtMs,
            fill.intentId,
          );
        this.applyRiskStateForFill(
          quoteMint,
          reduced.realizedPnlDeltaRaw,
          appliedAtMs,
        );
        if (fill.side === "BUY") {
          this.database.sqlite
            .prepare(
              `UPDATE risk_buy_reservations
               SET state = 'APPLIED', updated_at_ms = ?
               WHERE intent_id = ? AND state = 'ACTIVE'`,
            )
            .run(appliedAtMs, fill.intentId);
        }
        return "APPLIED" as const;
      })(),
    );
  }

  private applyRiskStateForFill(
    quoteMint: string,
    realizedPnlDeltaRaw: bigint,
    appliedAtMs: number,
  ): void {
    const limit =
      this.riskPolicy.dailyRealizedLossLimitRawByQuoteMint[quoteMint];
    if (limit === undefined)
      throw new Error("RISK_POLICY_FOR_QUOTE_UNAVAILABLE");
    const utcDay = new Date(appliedAtMs).toISOString().slice(0, 10);
    const existing = this.database.sqlite
      .prepare(
        "SELECT quote_state, utc_day, daily_realized_pnl_raw FROM risk_state WHERE quote_mint = ?",
      )
      .get(quoteMint) as
      | {
          quote_state: RiskQuoteState;
          utc_day: string;
          daily_realized_pnl_raw: string;
        }
      | undefined;
    const previousDailyRaw =
      existing?.utc_day === utcDay
        ? BigInt(existing.daily_realized_pnl_raw)
        : 0n;
    const nextDailyRaw = previousDailyRaw + realizedPnlDeltaRaw;
    const nextState: RiskQuoteState =
      (existing?.utc_day === utcDay &&
        existing.quote_state === "HALT_NEW_RISK") ||
      nextDailyRaw <= -limit
        ? "HALT_NEW_RISK"
        : "RUNNING";
    this.database.sqlite
      .prepare(
        `INSERT INTO risk_state(
           quote_mint, quote_state, utc_day, daily_realized_pnl_raw,
           updated_at_ms, version
         ) VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(quote_mint) DO UPDATE SET
           quote_state = excluded.quote_state,
           utc_day = excluded.utc_day,
           daily_realized_pnl_raw = excluded.daily_realized_pnl_raw,
           updated_at_ms = excluded.updated_at_ms,
           version = risk_state.version + 1`,
      )
      .run(quoteMint, nextState, utcDay, nextDailyRaw.toString(), appliedAtMs);
  }

  private setGlobalRiskStateSync(
    globalState: RiskGlobalState,
    reasonCode: string,
    updatedAtMs: number,
  ): void {
    this.database.sqlite
      .prepare(
        `UPDATE risk_global_state
         SET global_state = ?, reason_code = ?, updated_at_ms = ?,
             version = version + 1
         WHERE singleton_id = 1`,
      )
      .run(globalState, reasonCode, updatedAtMs);
  }

  async recoverUnappliedPaperFills(): Promise<number> {
    const rows = this.database.sqlite
      .prepare(
        `
        SELECT pf.id
        FROM paper_fills pf
        LEFT JOIN paper_fill_applications pfa ON pfa.fill_id = pf.id
        WHERE pfa.fill_id IS NULL
        ORDER BY pf.created_at_ms ASC, pf.id ASC
      `,
      )
      .all() as { id: string }[];
    let applied = 0;
    for (const row of rows) {
      if ((await this.applyPaperFill(row.id)) === "APPLIED") applied += 1;
    }
    return applied;
  }

  getFollowerPosition(
    followerWallet: string,
    leaderWallet: string,
    tokenMint: string,
    quoteMint: string,
  ): Position | undefined {
    const row = this.database.sqlite
      .prepare(
        `
        SELECT fp.raw_amount, fp.reserved_raw_amount, fp.version, fp.state,
               fp.quote_mint, fp.accounting_policy_version,
               fw.address AS follower_wallet, lw.address AS leader_wallet, fp.token_mint
        FROM follower_positions fp
        JOIN wallets fw ON fw.id = fp.follower_wallet_id
        JOIN wallets lw ON lw.id = fp.leader_wallet_id
        WHERE fw.address = ? AND lw.address = ? AND fp.token_mint = ?
          AND (fp.quote_mint = ? OR fp.quote_mint IS NULL)
        ORDER BY CASE WHEN fp.quote_mint = ? THEN 0 ELSE 1 END
        LIMIT 1
      `,
      )
      .get(followerWallet, leaderWallet, tokenMint, quoteMint, quoteMint) as
      PositionRow | undefined;
    if (!row) return undefined;
    return {
      followerWallet: row.follower_wallet,
      leaderWallet: row.leader_wallet,
      tokenMint: row.token_mint,
      ...(row.quote_mint === null ? {} : { quoteMint: row.quote_mint }),
      rawAmount: BigInt(row.raw_amount),
      reservedRawAmount: BigInt(row.reserved_raw_amount),
      ...(row.accounting_policy_version === PAPER_ACCOUNTING_POLICY_VERSION
        ? { accountingPolicyVersion: PAPER_ACCOUNTING_POLICY_VERSION }
        : {}),
      version: row.version,
      state: row.state,
    };
  }

  async reserveIntent(intent: ExecutionIntent): Promise<ReservedIntent> {
    if (canonicalDomainQuoteMint(intent.quoteMint) !== intent.quoteMint) {
      throw new Error("NON_CANONICAL_QUOTE_MINT");
    }
    return this.database.write(() =>
      this.database.sqlite.transaction(() => {
        const leader = this.requireWallet(intent.leaderWallet);
        const follower = this.requireWallet(intent.followerWallet);
        const existing = this.database.sqlite
          .prepare("SELECT state FROM follower_trades WHERE execution_key = ?")
          .get(intent.executionKey) as { state: ExecutionState } | undefined;
        if (existing) return { created: false, state: existing.state };
        const now = this.clock.now();
        let state: ExecutionState = intent.skipReason ? "SKIPPED" : "RESERVED";
        let skipReason = intent.skipReason;
        if (!skipReason && exitBlocksBuy(this.database, intent)) {
          state = "SKIPPED";
          skipReason = "AUTOMATIC_EXIT_PENDING";
          this.database.sqlite.prepare("UPDATE risk_buy_reservations SET state='RELEASED' WHERE intent_id=? AND state='ACTIVE'").run(intent.executionKey);
        }
        if (!skipReason) {
          this.database.sqlite
            .prepare(
              `
              INSERT INTO follower_positions(
                follower_wallet_id, leader_wallet_id, token_mint, quote_mint, raw_amount,
                reserved_raw_amount, state, version, updated_at_ms
              ) VALUES (?, ?, ?, ?, '0', '0', 'CLOSED', 0, ?)
              ON CONFLICT(follower_wallet_id, leader_wallet_id, token_mint, quote_mint) DO NOTHING
            `,
            )
            .run(
              follower.id,
              leader.id,
              intent.tokenMint,
              intent.quoteMint,
              now.wallMs,
            );
        }
        if (!skipReason && intent.side === "SELL") {
          const position = this.database.sqlite
            .prepare(
              `SELECT raw_amount, reserved_raw_amount FROM follower_positions
                      WHERE follower_wallet_id = ? AND leader_wallet_id = ? AND token_mint = ? AND quote_mint = ?`,
            )
            .get(
              follower.id,
              leader.id,
              intent.tokenMint,
              intent.quoteMint,
            ) as {
            raw_amount: string;
            reserved_raw_amount: string;
          };
          const available =
            BigInt(position.raw_amount) - BigInt(position.reserved_raw_amount);
          if (available < intent.theoreticalTokenRaw) {
            state = "SKIPPED";
            skipReason = "INSUFFICIENT_MAPPED_POSITION";
          }
        }
        this.database.sqlite
          .prepare(
            `
            INSERT INTO follower_trades(
              id, execution_key, leader_trade_id, follower_wallet_id, state, side, token_mint,
              quote_mint, theoretical_token_raw, theoretical_quote_raw, copy_ratio_bps,
              sell_ratio_numerator, sell_ratio_denominator, skip_reason, order_created_timestamp_ms,
              order_created_monotonic_ns, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            intent.executionKey,
            intent.executionKey,
            intent.leaderTradeId,
            follower.id,
            state,
            intent.side,
            intent.tokenMint,
            intent.quoteMint,
            intent.theoreticalTokenRaw.toString(),
            intent.theoreticalQuoteRaw.toString(),
            intent.copyRatioBps,
            intent.sellRatio?.numerator.toString() ?? null,
            intent.sellRatio?.denominator.toString() ?? null,
            skipReason ?? null,
            intent.createdAtMs,
            intent.createdMonotonicNs.toString(),
            now.wallMs,
            now.wallMs,
          );
        if (state === "RESERVED") {
          const reserveRaw = intent.theoreticalTokenRaw;
          const position = this.database.sqlite
            .prepare(
              `SELECT reserved_raw_amount FROM follower_positions
                      WHERE follower_wallet_id = ? AND leader_wallet_id = ? AND token_mint = ? AND quote_mint = ?`,
            )
            .get(
              follower.id,
              leader.id,
              intent.tokenMint,
              intent.quoteMint,
            ) as {
            reserved_raw_amount: string;
          };
          const nextReservedRaw =
            BigInt(position.reserved_raw_amount) + reserveRaw;
          this.database.sqlite
            .prepare(
              `
              UPDATE follower_positions
              SET reserved_raw_amount = ?,
                  updated_at_ms = ?, version = version + 1
              WHERE follower_wallet_id = ? AND leader_wallet_id = ? AND token_mint = ? AND quote_mint = ?
            `,
            )
            .run(
              nextReservedRaw.toString(),
              now.wallMs,
              follower.id,
              leader.id,
              intent.tokenMint,
              intent.quoteMint,
            );
        }
        this.insertExecutionEvent(
          intent.executionKey,
          0,
          "INTENT_RESERVED",
          state,
          { skipReason, diagnosticCode: intent.diagnosticCode },
          now,
        );
        this.database.sqlite
          .prepare(
            `
            INSERT INTO outbox(event_key, aggregate_type, aggregate_id, event_type, payload_json,
              status, attempts, available_at_ms, created_at_ms)
            VALUES (?, 'EXECUTION', ?, 'INTENT_RESERVED', ?, 'PENDING', 0, ?, ?)
          `,
          )
          .run(
            `${intent.executionKey}:reserved`,
            intent.executionKey,
            jsonStringify(intent),
            now.wallMs,
            now.wallMs,
          );
        captureExitGoal(this.database, {...intent, ...(skipReason ? {skipReason} : {})}, now.wallMs);
        return { created: true, state };
      })(),
    );
  }

  async markAttemptStarted(executionKey: string): Promise<void> {
    await this.database.write(() => {
      const now = this.clock.now();
      this.insertExecutionEvent(
        executionKey,
        1,
        "SEND_ATTEMPT_STARTED",
        "RESERVED",
        {},
        now,
      );
      this.database.sqlite
        .prepare(
          "UPDATE follower_trades SET order_sent_timestamp_ms = ?, order_sent_monotonic_ns = ?, updated_at_ms = ? WHERE execution_key = ?",
        )
        .run(now.wallMs, now.monotonicNs.toString(), now.wallMs, executionKey);
    });
  }

  async saveExecutionResult(result: ExecutionResult): Promise<void> {
    await this.database.write(() =>
      this.database.sqlite.transaction(() => {
        const now = this.clock.now();
        const trade = this.database.sqlite
          .prepare(
            `SELECT ft.token_mint, ft.quote_mint, lt.source_price
                    FROM follower_trades ft JOIN leader_trades lt ON lt.id = ft.leader_trade_id
                    WHERE ft.execution_key = ?`,
          )
          .get(result.executionKey) as {
          token_mint: string;
          quote_mint: string;
          source_price: string | null;
        };
        const decimals = this.database.sqlite
          .prepare("SELECT mint, decimals FROM tokens WHERE mint IN (?, ?)")
          .all(trade.token_mint, trade.quote_mint) as {
          mint: string;
          decimals: number;
        }[];
        const tokenDecimals = decimals.find(
          (item) => item.mint === trade.token_mint,
        )?.decimals;
        const quoteDecimals = decimals.find(
          (item) => item.mint === trade.quote_mint,
        )?.decimals;
        const executionPrice =
          result.executedTokenRaw > 0n &&
          tokenDecimals !== undefined &&
          quoteDecimals !== undefined
            ? this.normalizedPrice(
                result.executedQuoteRaw,
                quoteDecimals,
                result.executedTokenRaw,
                tokenDecimals,
              )
            : undefined;
        const priceDifferencePct =
          executionPrice !== undefined &&
          trade.source_price !== null &&
          trade.source_price !== "0"
            ? new Decimal(executionPrice)
                .minus(trade.source_price)
                .div(trade.source_price)
                .mul(100)
                .toString()
            : undefined;
        this.database.sqlite
          .prepare(
            `
            UPDATE follower_trades
            SET state = ?, execution_price = ?, price_difference_pct = ?, executed_token_raw = ?, executed_quote_raw = ?,
                order_sent_timestamp_ms = COALESCE(?, order_sent_timestamp_ms),
                confirmed_timestamp_ms = ?, confirmed_monotonic_ns = ?, updated_at_ms = ?
            WHERE execution_key = ?
          `,
          )
          .run(
            result.state,
            executionPrice ?? result.executionPrice ?? null,
            priceDifferencePct ?? null,
            result.executedTokenRaw.toString(),
            result.executedQuoteRaw.toString(),
            result.sentAtMs ?? null,
            result.confirmedAtMs ?? null,
            result.confirmedAtMs === undefined
              ? null
              : now.monotonicNs.toString(),
            now.wallMs,
            result.executionKey,
          );
        this.insertExecutionEvent(
          result.executionKey,
          2,
          "EXECUTION_RESULT",
          result.state,
          result,
          now,
        );
      })(),
    );
  }

  async commitPosition(
    intent: ExecutionIntent,
    result: ExecutionResult,
  ): Promise<void> {
    await this.database.write(() =>
      this.database.sqlite.transaction(() => {
        const leader = this.requireWallet(intent.leaderWallet);
        const follower = this.requireWallet(intent.followerWallet);
        const row = this.database.sqlite
          .prepare(
            `SELECT raw_amount, reserved_raw_amount FROM follower_positions
                    WHERE follower_wallet_id = ? AND leader_wallet_id = ? AND token_mint = ? AND quote_mint = ?`,
          )
          .get(follower.id, leader.id, intent.tokenMint, intent.quoteMint) as {
          raw_amount: string;
          reserved_raw_amount: string;
        };
        const current = BigInt(row.raw_amount);
        const reserved = BigInt(row.reserved_raw_amount);
        const executed =
          result.state === "PAPER_EXECUTED" || result.state === "CONFIRMED";
        const next = !executed
          ? current
          : intent.side === "BUY"
            ? current + result.executedTokenRaw
            : current > result.executedTokenRaw
              ? current - result.executedTokenRaw
              : 0n;
        const nextReserved =
          reserved > intent.theoreticalTokenRaw
            ? reserved - intent.theoreticalTokenRaw
            : 0n;
        const now = this.clock.now();
        this.database.sqlite
          .prepare(
            `
            UPDATE follower_positions
            SET raw_amount = ?, reserved_raw_amount = ?, state = ?, last_execution_key = ?,
                version = version + 1, updated_at_ms = ?
            WHERE follower_wallet_id = ? AND leader_wallet_id = ? AND token_mint = ? AND quote_mint = ?
          `,
          )
          .run(
            next.toString(),
            nextReserved.toString(),
            next === 0n ? "CLOSED" : "OPEN",
            intent.executionKey,
            now.wallMs,
            follower.id,
            leader.id,
            intent.tokenMint,
            intent.quoteMint,
          );
        if (executed) {
          this.database.sqlite
            .prepare(
              "UPDATE follower_trades SET state = 'CONFIRMED', confirmed_timestamp_ms = ?, updated_at_ms = ? WHERE execution_key = ?",
            )
            .run(
              result.confirmedAtMs ?? now.wallMs,
              now.wallMs,
              intent.executionKey,
            );
          this.insertExecutionEvent(
            intent.executionKey,
            3,
            "POSITION_COMMITTED",
            "CONFIRMED",
            { nextRaw: next },
            now,
          );
        } else {
          this.insertExecutionEvent(
            intent.executionKey,
            3,
            "RESERVATION_RELEASED",
            result.state,
            { reason: result.reason },
            now,
          );
        }
      })(),
    );
  }

  listRecoverable(): readonly {
    intent: ExecutionIntent;
    state: ExecutionState;
    attemptStarted: boolean;
    persistedResult?: ExecutionResult;
  }[] {
    const rows = this.database.sqlite
      .prepare(
        `
        SELECT ft.*, lw.address AS leader_wallet, fw.address AS follower_wallet,
               lt.source_timestamp_ms AS authoritative_source_timestamp_ms,
               lt.source_timestamp_precision AS authoritative_source_timestamp_precision,
               lt.source_timestamp_provenance AS authoritative_source_timestamp_provenance
        FROM follower_trades ft
        JOIN leader_trades lt ON lt.id = ft.leader_trade_id
        JOIN wallets lw ON lw.id = lt.leader_wallet_id
        JOIN wallets fw ON fw.id = ft.follower_wallet_id
        WHERE ft.state IN ('RESERVED', 'PAPER_EXECUTED')
        ORDER BY ft.created_at_ms ASC
      `,
      )
      .all() as RecoverableRow[];
    const attempt = this.database.sqlite.prepare(
      "SELECT 1 FROM execution_events WHERE execution_key = ? AND type = 'SEND_ATTEMPT_STARTED'",
    );
    return rows.map((row) => {
      const persistedResult =
        row.state === "PAPER_EXECUTED" &&
        row.executed_token_raw !== null &&
        row.executed_quote_raw !== null
          ? ({
              executionKey: row.execution_key,
              state: "PAPER_EXECUTED",
              executedTokenRaw: BigInt(row.executed_token_raw),
              executedQuoteRaw: BigInt(row.executed_quote_raw),
            } satisfies ExecutionResult)
          : undefined;
      return {
        state: row.state,
        attemptStarted: attempt.get(row.execution_key) !== undefined,
        ...(persistedResult === undefined ? {} : { persistedResult }),
        intent: {
          executionKey: row.execution_key,
          leaderTradeId: row.leader_trade_id,
          leaderWallet: row.leader_wallet,
          followerWallet: row.follower_wallet,
          mode: "PAPER",
          side: row.side,
          tokenMint: row.token_mint,
          quoteMint: row.quote_mint,
          theoreticalTokenRaw: BigInt(row.theoretical_token_raw),
          theoreticalQuoteRaw: BigInt(row.theoretical_quote_raw),
          copyRatioBps: row.copy_ratio_bps,
          ...(row.sell_ratio_numerator === null ||
          row.sell_ratio_denominator === null
            ? {}
            : {
                sellRatio: {
                  numerator: BigInt(row.sell_ratio_numerator),
                  denominator: BigInt(row.sell_ratio_denominator),
                },
              }),
          ...(row.skip_reason === null ? {} : { skipReason: row.skip_reason }),
          ...(row.authoritative_source_timestamp_ms === null ||
          row.authoritative_source_timestamp_provenance !==
            "CHAIN_BLOCK_TIME" ||
          (row.authoritative_source_timestamp_precision !== "MILLISECOND" &&
            row.authoritative_source_timestamp_precision !== "SECOND")
            ? {}
            : {
                authoritativeSourceTimestamp: {
                  valueMs: row.authoritative_source_timestamp_ms,
                  provenance: "CHAIN_BLOCK_TIME" as const,
                  precision: row.authoritative_source_timestamp_precision,
                },
              }),
          createdAtMs: row.order_created_timestamp_ms,
          createdMonotonicNs: BigInt(row.order_created_monotonic_ns),
        },
      };
    });
  }

  async markUncertain(executionKey: string, reason: string): Promise<void> {
    await this.database.write(() => {
      const now = this.clock.now();
      this.database.sqlite
        .prepare(
          "UPDATE follower_trades SET state = 'UNCERTAIN', skip_reason = ?, updated_at_ms = ? WHERE execution_key = ?",
        )
        .run(reason, now.wallMs, executionKey);
      this.insertExecutionEvent(
        executionKey,
        2,
        "RECOVERY_UNCERTAIN",
        "UNCERTAIN",
        { reason },
        now,
      );
    });
  }

  revalidateBeforeQuote(intent: ExecutionIntent): string | undefined {
    const nowMs = this.clock.now().wallMs;
    const positions = this.paperPositionsForFollowerQuote(
      intent.followerWallet,
      intent.quoteMint,
    );
    const currentPosition = positions.find(
      (position) =>
        position.leaderWallet === intent.leaderWallet &&
        position.tokenMint === intent.tokenMint,
    );
    const pending = this.database.sqlite
      .prepare(
        `SELECT token_mint, approved_quote_raw FROM risk_buy_reservations
      WHERE follower_wallet=? AND quote_mint=? AND state='ACTIVE' AND intent_id<>?`,
      )
      .all(intent.followerWallet, intent.quoteMint, intent.executionKey) as {
      token_mint: string;
      approved_quote_raw: string;
    }[];
    const riskState = this.getQuoteRiskState(intent.quoteMint, nowMs);
    const decision = new RiskEngine(this.riskPolicy).evaluatePreQuote({
      phase: "PRE_QUOTE",
      nowMs,
      intent: {
        intentId: intent.executionKey,
        leaderTradeId: intent.leaderTradeId,
        leaderWallet: intent.leaderWallet,
        followerWallet: intent.followerWallet,
        side: intent.side,
        tokenMint: intent.tokenMint,
        quoteMint: intent.quoteMint,
        requestedTokenRaw: intent.theoreticalTokenRaw,
        requestedQuoteRaw: intent.theoreticalQuoteRaw,
        createdAtMs: intent.createdAtMs,
        ...(intent.authoritativeSourceTimestamp === undefined
          ? {}
          : {
              authoritativeSourceTimestamp: intent.authoritativeSourceTimestamp,
            }),
      },
      ...(currentPosition === undefined ? {} : { currentPosition }),
      portfolioPositions: positions,
      pendingApprovedBuyQuoteRawByQuoteMint: {
        [intent.quoteMint]: pending.reduce(
          (sum, row) => sum + BigInt(row.approved_quote_raw),
          0n,
        ),
      },
      pendingApprovedBuyQuoteRawForToken: pending
        .filter((row) => row.token_mint === intent.tokenMint)
        .reduce((sum, row) => sum + BigInt(row.approved_quote_raw), 0n),
      dailyRealizedPnlRawByQuoteMint: {
        [intent.quoteMint]: riskState?.dailyRealizedPnlRaw ?? 0n,
      },
      quoteState: riskState?.quoteState ?? "RUNNING",
      globalState: this.getGlobalRiskState(),
      providerHealth:
        this.getProviderHealthState("JUPITER_SWAP_V2_ORDER")?.state ??
        "HEALTHY",
    });
    // A recovered authorization is immutable: a new RESIZE cannot replace it.
    return decision.decision === "ALLOW" ? undefined : decision.reasonCode;
  }

  followerTradeForSource(
    leaderTradeId: string,
    followerWallet: string,
  ): { executionKey: string; state: ExecutionState } | undefined {
    return this.database.sqlite
      .prepare(
        `SELECT ft.execution_key AS executionKey, ft.state
      FROM follower_trades ft JOIN wallets w ON w.id=ft.follower_wallet_id
      WHERE ft.leader_trade_id=? AND w.address=?`,
      )
      .get(leaderTradeId, followerWallet) as
      { executionKey: string; state: ExecutionState } | undefined;
  }

  async savePendingDelivery(
    provider: string,
    subscriptionKey: string,
    slot: bigint,
    signature: string,
  ): Promise<void> {
    await this.database.write(() => {
      this.database.sqlite
        .prepare(
          "INSERT OR IGNORE INTO stream_pending_deliveries(provider, subscription_key, slot, signature) VALUES (?, ?, ?, ?)",
        )
        .run(provider, subscriptionKey, slot.toString(), signature);
    });
  }

  async deletePendingDelivery(
    provider: string,
    subscriptionKey: string,
    signature: string,
  ): Promise<void> {
    await this.database.write(() => {
      this.database.sqlite
        .prepare(
          "DELETE FROM stream_pending_deliveries WHERE provider=? AND subscription_key=? AND signature=?",
        )
        .run(provider, subscriptionKey, signature);
    });
  }

  listPendingDeliveries(
    provider: string,
    subscriptionKey: string,
  ): readonly { slot: bigint; signature: string }[] {
    const rows = this.database.sqlite
      .prepare(
        "SELECT slot, signature FROM stream_pending_deliveries WHERE provider=? AND subscription_key=?",
      )
      .all(provider, subscriptionKey) as { slot: string; signature: string }[];
    return rows.map((row) => ({ ...row, slot: BigInt(row.slot) }));
  }

  async saveCheckpoint(
    provider: string,
    subscriptionKey: string,
    slot: bigint,
    signature?: string,
  ): Promise<void> {
    await this.database.write(() => {
      this.database.sqlite
        .prepare(
          `
          INSERT INTO stream_checkpoints(provider, subscription_key, slot, signature, updated_at_ms)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(provider, subscription_key) DO UPDATE SET
            slot = excluded.slot, signature = excluded.signature, updated_at_ms = excluded.updated_at_ms
        `,
        )
        .run(
          provider,
          subscriptionKey,
          slot.toString(),
          signature ?? null,
          this.clock.now().wallMs,
        );
    });
  }

  getCheckpoint(
    provider: string,
    subscriptionKey: string,
  ): { slot: bigint; signature?: string } | undefined {
    const row = this.database.sqlite
      .prepare(
        "SELECT slot, signature FROM stream_checkpoints WHERE provider = ? AND subscription_key = ?",
      )
      .get(provider, subscriptionKey) as
      { slot: string; signature: string | null } | undefined;
    if (!row) return undefined;
    return {
      slot: BigInt(row.slot),
      ...(row.signature === null ? {} : { signature: row.signature }),
    };
  }

  count(
    table: "leader_trades" | "follower_trades" | "execution_events",
  ): number {
    const row = this.database.sqlite
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as { count: number };
    return row.count;
  }

  followerTradeState(executionKey: string): ExecutionState | undefined {
    const row = this.database.sqlite
      .prepare("SELECT state FROM follower_trades WHERE execution_key = ?")
      .get(executionKey) as { state: ExecutionState } | undefined;
    return row?.state;
  }

  async saveSystemEvent(event: SystemEvent): Promise<void> {
    await this.database.write(() => {
      this.database.sqlite
        .prepare(
          `
          INSERT INTO system_events(
            type, severity, component, message, details_json, wall_timestamp_ms, monotonic_timestamp_ns
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          event.type,
          event.severity,
          event.component,
          event.message,
          jsonStringify(event.details),
          event.timestamp.wallMs,
          event.timestamp.monotonicNs.toString(),
        );
    });
  }

  private requireWallet(address: string): WalletRow {
    const row = this.database.sqlite
      .prepare("SELECT id, address, role FROM wallets WHERE address = ?")
      .get(address) as WalletRow | undefined;
    if (!row) throw new Error(`Wallet not registered: ${address}`);
    return row;
  }

  private ensureTokenSync(
    mint: string,
    decimals: number,
    isQuote: boolean,
  ): void {
    const now = this.clock.now().wallMs;
    this.database.sqlite
      .prepare(
        `
        INSERT INTO tokens(mint, decimals, is_quote, first_seen_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(mint) DO UPDATE SET
          decimals = COALESCE(tokens.decimals, excluded.decimals),
          is_quote = MAX(tokens.is_quote, excluded.is_quote),
          updated_at_ms = excluded.updated_at_ms
      `,
      )
      .run(mint, decimals, isQuote ? 1 : 0, now, now);
  }

  private insertExecutionEvent(
    executionKey: string,
    sequence: number,
    type: string,
    status: string,
    details: unknown,
    timestamp: { wallMs: number; monotonicNs: bigint },
  ): void {
    this.database.sqlite
      .prepare(
        `
        INSERT OR IGNORE INTO execution_events(
          execution_key, sequence, type, status, details_json, wall_timestamp_ms, monotonic_timestamp_ns
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        executionKey,
        sequence,
        type,
        status,
        jsonStringify(details),
        timestamp.wallMs,
        timestamp.monotonicNs.toString(),
      );
  }

  private paperPositionRow(
    followerWallet: string,
    leaderWallet: string,
    tokenMint: string,
    quoteMint: string,
  ): PaperPositionRow | undefined {
    return this.database.sqlite
      .prepare(
        `
        SELECT fp.id, fp.raw_amount, fp.reserved_raw_amount, fp.version,
               fp.state, fp.quote_mint, fp.total_cost_quote_raw,
               fp.realized_pnl_quote_raw, fp.accounting_policy_version,
               fp.opened_at_ms, fp.updated_at_ms, fp.closed_at_ms,
               fw.address AS follower_wallet, lw.address AS leader_wallet,
               fp.token_mint, token.decimals AS token_decimals,
               quote.decimals AS quote_decimals
        FROM follower_positions fp
        JOIN wallets fw ON fw.id = fp.follower_wallet_id
        JOIN wallets lw ON lw.id = fp.leader_wallet_id
        LEFT JOIN tokens token ON token.mint = fp.token_mint
        LEFT JOIN tokens quote ON quote.mint = fp.quote_mint
        WHERE fw.address = ? AND lw.address = ? AND fp.token_mint = ?
          AND (fp.quote_mint = ? OR fp.quote_mint IS NULL)
        ORDER BY CASE WHEN fp.quote_mint = ? THEN 0 ELSE 1 END
        LIMIT 1
      `,
      )
      .get(followerWallet, leaderWallet, tokenMint, quoteMint, quoteMint) as
      PaperPositionRow | undefined;
  }

  private paperPositionsForFollowerQuote(
    followerWallet: string,
    quoteMint: string,
  ): readonly PaperPosition[] {
    const rows = this.database.sqlite
      .prepare(
        `SELECT fp.id, fp.raw_amount, fp.reserved_raw_amount, fp.version,
                fp.state, fp.quote_mint, fp.total_cost_quote_raw,
                fp.realized_pnl_quote_raw, fp.accounting_policy_version,
                fp.opened_at_ms, fp.updated_at_ms, fp.closed_at_ms,
                fw.address AS follower_wallet, lw.address AS leader_wallet,
                fp.token_mint, token.decimals AS token_decimals,
                quote.decimals AS quote_decimals
         FROM follower_positions fp
         JOIN wallets fw ON fw.id = fp.follower_wallet_id
         JOIN wallets lw ON lw.id = fp.leader_wallet_id
         LEFT JOIN tokens token ON token.mint = fp.token_mint
         LEFT JOIN tokens quote ON quote.mint = fp.quote_mint
         WHERE fw.address = ? AND fp.quote_mint = ?`,
      )
      .all(followerWallet, quoteMint) as PaperPositionRow[];
    return rows.flatMap((row) => {
      if (row.accounting_policy_version === null) {
        if (BigInt(row.raw_amount) > 0n) {
          throw new Error("LEGACY_POSITION_COST_BASIS_UNAVAILABLE");
        }
        return [];
      }
      return [this.paperPositionFromRow(row)];
    });
  }

  private paperPositionFromRow(row: PaperPositionRow): PaperPosition {
    if (
      row.accounting_policy_version !== PAPER_ACCOUNTING_POLICY_VERSION ||
      row.quote_mint === null ||
      row.total_cost_quote_raw === null ||
      row.realized_pnl_quote_raw === null ||
      row.token_decimals === null ||
      row.quote_decimals === null
    ) {
      throw new Error("LEGACY_POSITION_COST_BASIS_UNAVAILABLE");
    }
    const quantityRaw = BigInt(row.raw_amount);
    const totalCostQuoteRaw = BigInt(row.total_cost_quote_raw);
    return {
      followerWallet: row.follower_wallet,
      leaderWallet: row.leader_wallet,
      tokenMint: row.token_mint,
      quoteMint: row.quote_mint,
      tokenDecimals: row.token_decimals,
      quoteDecimals: row.quote_decimals,
      quantityRaw,
      reservedRaw: BigInt(row.reserved_raw_amount),
      totalCostQuoteRaw,
      realizedPnlQuoteRaw: BigInt(row.realized_pnl_quote_raw),
      averageEntry:
        quantityRaw === 0n
          ? null
          : this.normalizedPrice(
              totalCostQuoteRaw,
              row.quote_decimals,
              quantityRaw,
              row.token_decimals,
            ),
      openedAtMs: row.opened_at_ms,
      updatedAtMs: row.updated_at_ms,
      closedAtMs: row.closed_at_ms,
      status: row.state,
      accountingPolicyVersion: PAPER_ACCOUNTING_POLICY_VERSION,
      version: row.version,
    };
  }

  private normalizedPrice(
    quoteRaw: bigint,
    quoteDecimals: number,
    tokenRaw: bigint,
    tokenDecimals: number,
  ): string {
    if (tokenRaw === 0n) return "0";
    return new Decimal(quoteRaw.toString())
      .mul(new Decimal(10).pow(tokenDecimals))
      .div(
        new Decimal(tokenRaw.toString()).mul(
          new Decimal(10).pow(quoteDecimals),
        ),
      )
      .toString();
  }
}
