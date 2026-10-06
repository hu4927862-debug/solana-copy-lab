import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { NATIVE_SOL, WSOL_MINT } from "../../src/domain/assets.js";
import { SqliteDatabase } from "../../src/persistence/database.js";
import {
  calculateEndToEndApplicationCompatibility,
  type ClassifiedCopyabilityOpportunity,
  type CopyabilityBucket,
  type CopyabilityEvaluationContext,
} from "../../src/strategy-evaluation/copyability.js";
import {
  calculatePaperFillOutcome,
  calculateJupiterSuccessRate,
  calculatePostRiskDistribution,
} from "../../src/strategy-evaluation/execution-quality.js";
import { evaluatePaperFillCostCompleteness } from "../../src/strategy-evaluation/cost-completeness.js";
import { classifyOpportunityFailure } from "../../src/strategy-evaluation/failure-taxonomy.js";
import {
  StrategyEvaluationReadModel as ProductionStrategyEvaluationReadModel,
  type ShadowPaperEvidenceBinding,
  type StrategyEvaluationReadSnapshotRequest,
  type StrategyEvaluationReadWindow,
} from "../../src/strategy-evaluation/read-model.js";
import {
  matchFollowerRoundTrips,
  matchFollowerRoundTripsDetailed,
} from "../../src/strategy-evaluation/round-trips.js";
import { testStore } from "../helpers/database.js";

const FOLLOWER_WALLET = "follower-wallet";
const LEADER_WALLET = "leader-wallet";
const TOKEN_MINT = "token-mint";
const COPYABILITY_BUCKET = {
  followerWallet: FOLLOWER_WALLET,
  leaderWallet: LEADER_WALLET,
  quoteMint: NATIVE_SOL,
} as const;
const COPYABILITY_CONTEXT: CopyabilityEvaluationContext = {
  window: { fromMs: 0, toMs: 10_000 },
  source: "strategy-evaluation-read-model-fixture",
  mode: "PAPER",
  copyRatioBps: 10_000,
  riskPolicyVersion: "RISK_TEST_V1",
  fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
  accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
  copyabilityDefinitionVersion: "COPYABILITY_TEST_V1",
};
const DEFAULT_WINDOW: StrategyEvaluationReadWindow = {
  windowStartMs: 0,
  windowEndMs: 10_000,
};
const APPROVED_SHADOW_PAPER_BINDING: ShadowPaperEvidenceBinding = {
  definitionVersion: "SHADOW_PAPER_EVIDENCE_BINDING_V1",
  observationPosture: "SHADOW",
  economicMode: "PAPER",
  paperOnly: true,
  liveFundsEnabled: false,
  riskPolicyVersion: "PAPER_RISK_V1",
  fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
  accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
  copyabilityDefinitionVersion: "COPYABILITY_V1",
  historicalEvaluationDefinitionVersion: "HISTORICAL_EVALUATION_V3",
  roundTripDefinitionVersion: "FOLLOWER_ROUND_TRIPS_V2",
  strategyMetricDefinitionVersion: "STRATEGY_METRICS_V1",
};
const CANONICAL_STRATEGY_A_CONTEXT: CopyabilityEvaluationContext = {
  window: { fromMs: 0, toMs: 9_999_999_999_999 },
  source: "POST_BATCH3_EVIDENCE_RECONCILIATION_V1",
  mode: "PAPER",
  copyRatioBps: 1_000,
  riskPolicyVersion: "PAPER_RISK_V1",
  fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
  accountingPolicyVersion: "WEIGHTED_AVERAGE_V1",
  copyabilityDefinitionVersion: "COPYABILITY_V1",
};

class StrategyEvaluationReadModel extends ProductionStrategyEvaluationReadModel {
  override readSnapshot(
    request: Pick<StrategyEvaluationReadSnapshotRequest, "databasePath"> &
      Partial<
        Pick<
          StrategyEvaluationReadSnapshotRequest,
          "window" | "expectedContext" | "shadowPaperEvidenceBinding"
        >
      >,
  ) {
    const window = request.window ?? DEFAULT_WINDOW;
    return super.readSnapshot({
      databasePath: request.databasePath,
      window,
      expectedContext: request.expectedContext ?? {
        ...COPYABILITY_CONTEXT,
        window: { fromMs: window.windowStartMs, toMs: window.windowEndMs },
      },
      ...(request.shadowPaperEvidenceBinding === undefined
        ? {}
        : {
            shadowPaperEvidenceBinding: request.shadowPaperEvidenceBinding,
          }),
    });
  }
}

function roundTripFixture(migrationsDirectory?: string): string {
  const context =
    migrationsDirectory === undefined
      ? testStore("strategy-read-model-")
      : (() => {
          const directory = mkdtempSync(
            resolve(tmpdir(), "strategy-read-model-legacy-"),
          );
          const path = resolve(directory, "test.sqlite");
          return {
            database: new SqliteDatabase({ path, migrationsDirectory }),
            path,
          };
        })();
  const { database, path } = context;
  database.sqlite.exec(`
    INSERT INTO wallets(
      id, address, role, enabled, copy_ratio_bps, created_at_ms, updated_at_ms
    ) VALUES
      (1, '${LEADER_WALLET}', 'LEADER', 1, 10000, 1, 1),
      (2, '${FOLLOWER_WALLET}', 'FOLLOWER', 1, 10000, 1, 1);

    INSERT INTO tokens(mint, decimals, is_quote, first_seen_at_ms, updated_at_ms)
    VALUES
      ('${NATIVE_SOL}', 9, 1, 1, 1),
      ('${TOKEN_MINT}', 6, 0, 1, 1);

    INSERT INTO leader_trades(
      id, leader_wallet_id, signature, event_index, slot, side,
      token_mint, quote_mint, token_raw, quote_raw, leader_pre_token_raw,
      source_timestamp_ms, source_timestamp_precision,
      source_timestamp_provenance, stream_received_timestamp_ms,
      detected_timestamp_ms, decoded_timestamp_ms,
      stream_received_monotonic_ns, detected_monotonic_ns,
      decoded_monotonic_ns, evidence_json, created_at_ms
    ) VALUES
      (
        'leader-buy', 1, 'signature-buy', 0, '1', 'BUY',
        '${TOKEN_MINT}', '${NATIVE_SOL}', '10', '9007199254740993', '0',
        900, 'SECOND', 'CHAIN_BLOCK_TIME',
        900, 950, 975, '900', '950', '975', '[]', 975
      ),
      (
        'leader-sell', 1, 'signature-sell', 0, '2', 'SELL',
        '${TOKEN_MINT}', '${NATIVE_SOL}', '10', '9007199254741020', '10',
        3900, 'SECOND', 'CHAIN_BLOCK_TIME',
        3900, 3950, 3975, '3900', '3950', '3975', '[]', 3975
      );

    INSERT INTO follower_trades(
      id, execution_key, leader_trade_id, follower_wallet_id, state, side,
      token_mint, quote_mint, theoretical_token_raw, theoretical_quote_raw,
      copy_ratio_bps, order_created_timestamp_ms, order_created_monotonic_ns,
      created_at_ms, updated_at_ms
    ) VALUES
      (
        'exec-buy', 'exec-buy', 'leader-buy', 2, 'CONFIRMED', 'BUY',
        '${TOKEN_MINT}', '${NATIVE_SOL}', '10', '9007199254740993',
        10000, 975, '975', 975, 1000
      ),
      (
        'exec-sell', 'exec-sell', 'leader-sell', 2, 'CONFIRMED', 'SELL',
        '${TOKEN_MINT}', '${NATIVE_SOL}', '10', '9007199254741020',
        10000, 3975, '3975', 3975, 4000
      );

    INSERT INTO outbox(
      event_key, aggregate_type, aggregate_id, event_type, payload_json,
      status, attempts, available_at_ms, created_at_ms
    ) VALUES
      (
        'exec-buy:reserved', 'EXECUTION', 'exec-buy', 'INTENT_RESERVED',
        '{"executionKey":"exec-buy","leaderTradeId":"leader-buy","leaderWallet":"${LEADER_WALLET}","followerWallet":"${FOLLOWER_WALLET}","mode":"PAPER","side":"BUY","tokenMint":"${TOKEN_MINT}","quoteMint":"${NATIVE_SOL}","theoreticalTokenRaw":"10","theoreticalQuoteRaw":"9007199254740993","copyRatioBps":10000,"createdAtMs":975,"createdMonotonicNs":"975"}',
        'PENDING', 0, 975, 975
      ),
      (
        'exec-sell:reserved', 'EXECUTION', 'exec-sell', 'INTENT_RESERVED',
        '{"executionKey":"exec-sell","leaderTradeId":"leader-sell","leaderWallet":"${LEADER_WALLET}","followerWallet":"${FOLLOWER_WALLET}","mode":"PAPER","side":"SELL","tokenMint":"${TOKEN_MINT}","quoteMint":"${NATIVE_SOL}","theoreticalTokenRaw":"10","theoreticalQuoteRaw":"9007199254741020","copyRatioBps":10000,"createdAtMs":3975,"createdMonotonicNs":"3975"}',
        'PENDING', 0, 3975, 3975
      );

    INSERT INTO live_validation_events(
      id, signature, event_index, slot, leader, primary_provider,
      program_ids_json, system_classification, ground_truth_classification,
      ground_truth_source, token_mint, quote_mint, balance_deltas_json,
      classifier_evidence_json,
      capture_path, is_duplicate, created_at_ms
    ) VALUES (
      'validation-buy', 'signature-buy', 0, '1', '${LEADER_WALLET}',
      'PRIMARY', '[]', 'BUY', 'BUY', 'AUTO_RULE', '${TOKEN_MINT}',
      '${NATIVE_SOL}', '[]', '{}',
      'fixture', 0, 1000
    );

    INSERT INTO jupiter_shadow_quotes(
      validation_event_id, execution_key, request_timestamp_ms,
      response_timestamp_ms, request_monotonic_ns, response_monotonic_ns,
      http_status, schema_valid, input_mint, output_mint, input_raw,
      expected_output_raw, router, route_json, failure_reason, created_at_ms
    ) VALUES (
      'validation-buy', 'exec-buy', 990, 1000, '990', '1000',
      200, 1, '${NATIVE_SOL}', '${TOKEN_MINT}',
      '9007199254740993', '10', 'Jupiter',
      '[{"swapInfo":{"label":"Raydium"}}]', NULL, 1000
    );

    INSERT INTO risk_decisions(
      decision_id, phase, intent_id, leader_trade_id, leader_wallet,
      follower_wallet, side, token_mint, quote_mint, pre_decision_id,
      quote_request_id, decision, requested_amount_raw, approved_amount_raw,
      requested_token_raw, approved_token_raw, requested_quote_raw,
      approved_quote_raw, reason_code, policy_version, relevant_limit_raw,
      relevant_evidence_json, decided_at_ms
    ) VALUES
      (
        'risk-pre-buy', 'PRE_QUOTE', 'exec-buy', 'leader-buy',
        '${LEADER_WALLET}', '${FOLLOWER_WALLET}', 'BUY', '${TOKEN_MINT}',
        '${NATIVE_SOL}', NULL, NULL, 'ALLOW', '9007199254740993',
        '9007199254740993', '10', '10', '9007199254740993',
        '9007199254740993', 'ALLOW', 'RISK_TEST_V1', NULL, '{}', 980
      ),
      (
        'risk-post-buy', 'POST_QUOTE', 'exec-buy', 'leader-buy',
        '${LEADER_WALLET}', '${FOLLOWER_WALLET}', 'BUY', '${TOKEN_MINT}',
        '${NATIVE_SOL}', 'risk-pre-buy', 'request-buy', 'ALLOW',
        '9007199254740993', '9007199254740993', '10', '10',
        '9007199254740993', '9007199254740993', 'ALLOW', 'RISK_TEST_V1',
        NULL, '{}', 1001
      );

    INSERT INTO follower_positions(
      id, follower_wallet_id, leader_wallet_id, token_mint, quote_mint,
      raw_amount, reserved_raw_amount, total_cost_quote_raw,
      realized_pnl_quote_raw, accounting_policy_version, state,
      last_execution_key, last_fill_id, opened_at_ms, closed_at_ms,
      version, updated_at_ms
    ) VALUES (
      10, 2, 1, '${TOKEN_MINT}', '${NATIVE_SOL}',
      '0', '0', '0', '27', 'WEIGHTED_AVERAGE_V1', 'CLOSED',
      'exec-sell', 'fill-a-close', 1000, 4000, 2, 4000
    );

    INSERT INTO paper_fills(
      id, intent_id, leader_trade_id, leader_tx_signature, leader_wallet,
      follower_wallet, side, input_mint, output_mint, token_decimals,
      quote_decimals, input_amount_raw, output_amount_raw,
      quote_request_timestamp_ms, quote_timestamp_ms, quote_rtt_ms,
      fee_evidence_status, provider, request_id, fill_policy_version,
      created_at_ms
    ) VALUES
      (
        'fill-a-close', 'exec-sell', 'leader-sell', 'signature-sell',
        '${LEADER_WALLET}', '${FOLLOWER_WALLET}', 'SELL',
        '${TOKEN_MINT}', '${NATIVE_SOL}', 6, 9,
        '10', '9007199254741020', 3900, 4000, 100,
        'AMOUNT_UNAVAILABLE', 'JUPITER_SWAP_V2_ORDER', 'request-sell',
        'JUPITER_ORDER_QUOTE_AS_FILL_V1', 4000
      ),
      (
        'fill-z-open', 'exec-buy', 'leader-buy', 'signature-buy',
        '${LEADER_WALLET}', '${FOLLOWER_WALLET}', 'BUY',
        '${NATIVE_SOL}', '${TOKEN_MINT}', 6, 9,
        '9007199254740993', '10', 900, 1000, 100,
        'AMOUNT_UNAVAILABLE', 'JUPITER_SWAP_V2_ORDER', 'request-buy',
        'JUPITER_ORDER_QUOTE_AS_FILL_V1', 1000
      );

    INSERT INTO paper_fill_applications(
      fill_id, position_id, transition, quantity_before_raw,
      quantity_after_raw, total_cost_before_raw, total_cost_after_raw,
      allocated_cost_basis_raw, proceeds_raw, realized_pnl_delta_raw,
      realized_pnl_after_raw, position_version_after, applied_at_ms
    ) VALUES
      (
        'fill-a-close', 10, 'CLOSE', '10', '0',
        '9007199254740993', '0', '9007199254740993',
        '9007199254741020', '27', '27', 2, 4000
      ),
      (
        'fill-z-open', 10, 'OPEN', '0', '10',
        '0', '9007199254740993', '0', '0', '0', '0', 1, 1000
      );
  `);
  database.close();
  return path;
}

function completeBuyOpportunityFixture(): string {
  const databasePath = roundTripFixture();
  mutateDatabase(
    databasePath,
    `DELETE FROM paper_fill_applications WHERE fill_id = 'fill-a-close';
     DELETE FROM paper_fills WHERE id = 'fill-a-close';
     DELETE FROM follower_trades WHERE execution_key = 'exec-sell';
     DELETE FROM leader_trades WHERE id = 'leader-sell';`,
  );
  return databasePath;
}

function mutateDatabase(databasePath: string, sql: string): void {
  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = OFF");
    database.exec(sql);
  } finally {
    database.close();
  }
}

function canonicalStrategyAShadowPaperFixture(): string {
  const databasePath = roundTripFixture();
  mutateDatabase(
    databasePath,
    `UPDATE follower_trades SET copy_ratio_bps = 1000;
     UPDATE outbox
     SET payload_json = json_set(payload_json, '$.mode', 'SHADOW')
     WHERE aggregate_type = 'EXECUTION'
       AND event_type = 'INTENT_RESERVED';
     UPDATE risk_decisions SET policy_version = 'PAPER_RISK_V1';`,
  );
  return databasePath;
}

function insertWindowOpportunity(
  databasePath: string,
  input: {
    readonly executionKey: string;
    readonly sourceTimestampMs: number;
    readonly sourceTimestampPrecision?: "MILLISECOND" | "SECOND" | "SLOT_ONLY";
    readonly sourceTimestampProvenance?: "CHAIN_BLOCK_TIME" | "UNKNOWN";
    readonly copyRatioBps?: number;
    readonly mode?: "PAPER" | "SHADOW";
    readonly leaderWalletId?: number;
    readonly followerWalletId?: number;
    readonly tokenMint?: string;
    readonly quoteMint?: string;
  },
): void {
  const leaderTradeId = `leader-${input.executionKey}`;
  const signature = `signature-${input.executionKey}`;
  const precision = input.sourceTimestampPrecision ?? "MILLISECOND";
  const provenance = input.sourceTimestampProvenance ?? "CHAIN_BLOCK_TIME";
  const copyRatioBps = input.copyRatioBps ?? 10_000;
  const mode = input.mode ?? "PAPER";
  const leaderWalletId = input.leaderWalletId ?? 1;
  const followerWalletId = input.followerWalletId ?? 2;
  const tokenMint = input.tokenMint ?? TOKEN_MINT;
  const quoteMint = input.quoteMint ?? NATIVE_SOL;
  mutateDatabase(
    databasePath,
    `INSERT INTO leader_trades(
       id, leader_wallet_id, signature, event_index, slot, side,
       token_mint, quote_mint, token_raw, quote_raw, leader_pre_token_raw,
       source_timestamp_ms, source_timestamp_precision,
       source_timestamp_provenance, stream_received_timestamp_ms,
       detected_timestamp_ms, decoded_timestamp_ms,
       stream_received_monotonic_ns, detected_monotonic_ns,
       decoded_monotonic_ns, evidence_json, created_at_ms
     ) VALUES (
       '${leaderTradeId}', ${leaderWalletId}, '${signature}', 0,
       '${input.sourceTimestampMs}', 'BUY', '${tokenMint}', '${quoteMint}',
       '1', '1', '0', ${input.sourceTimestampMs}, '${precision}',
       '${provenance}', ${input.sourceTimestampMs}, ${input.sourceTimestampMs},
       ${input.sourceTimestampMs}, '${input.sourceTimestampMs}',
       '${input.sourceTimestampMs}', '${input.sourceTimestampMs}', '[]',
       ${input.sourceTimestampMs}
     );
     INSERT INTO follower_trades(
       id, execution_key, leader_trade_id, follower_wallet_id, state, side,
       token_mint, quote_mint, theoretical_token_raw, theoretical_quote_raw,
       copy_ratio_bps, order_created_timestamp_ms,
       order_created_monotonic_ns, created_at_ms, updated_at_ms
     ) VALUES (
       '${input.executionKey}', '${input.executionKey}', '${leaderTradeId}',
       ${followerWalletId},
       'CREATED', 'BUY', '${tokenMint}', '${quoteMint}', '1', '1',
       ${copyRatioBps}, ${input.sourceTimestampMs},
       '${input.sourceTimestampMs}', ${input.sourceTimestampMs},
       ${input.sourceTimestampMs}
     );
     INSERT INTO outbox(
       event_key, aggregate_type, aggregate_id, event_type, payload_json,
       status, attempts, available_at_ms, created_at_ms
     ) VALUES (
       '${input.executionKey}:reserved', 'EXECUTION', '${input.executionKey}',
       'INTENT_RESERVED',
       '{"executionKey":"${input.executionKey}","mode":"${mode}"}',
       'PENDING', 0, ${input.sourceTimestampMs}, ${input.sourceTimestampMs}
     );`,
  );
}

function fullSnapshotFixture(): string {
  const databasePath = roundTripFixture();
  insertWindowOpportunity(databasePath, {
    executionKey: "exec-terminal",
    sourceTimestampMs: 3_500,
  });
  insertWindowOpportunity(databasePath, {
    executionKey: "exec-context-limited",
    sourceTimestampMs: 3_600,
    copyRatioBps: 2_000,
  });
  insertWindowOpportunity(databasePath, {
    executionKey: "exec-outside",
    sourceTimestampMs: 5_000,
  });
  mutateDatabase(
    databasePath,
    `INSERT INTO live_validation_events(
       id, signature, event_index, slot, block_time_ms, leader,
       primary_provider, program_ids_json, system_classification,
       ground_truth_classification, ground_truth_source, token_mint,
       quote_mint, balance_deltas_json, classifier_evidence_json,
       skip_reason, capture_path, decode_error, is_duplicate, created_at_ms
     ) VALUES
       (
         'validation-sell', 'signature-sell', 0, '2', 3900,
         '${LEADER_WALLET}', 'PRIMARY', '[]', 'SELL', 'SELL', 'AUTO_RULE',
         '${TOKEN_MINT}', '${NATIVE_SOL}', '[]', '{}', NULL, 'fixture',
         NULL, 0, 3900
       ),
       (
         'observation-unproven', 'observation-unproven-signature', 4, '3',
         3700, '${LEADER_WALLET}', 'PRIMARY', '[]', 'UNSUPPORTED',
         'UNSUPPORTED', 'AUTO_RULE', '${TOKEN_MINT}', '${NATIVE_SOL}',
         '[]', '{}', 'UNSUPPORTED_TOKEN_2022', 'fixture', NULL, 0, 3700
       );

     INSERT INTO jupiter_shadow_quotes(
       validation_event_id, execution_key, request_timestamp_ms,
       response_timestamp_ms, request_monotonic_ns, response_monotonic_ns,
       http_status, schema_valid, input_mint, output_mint, input_raw,
       expected_output_raw, router, route_json, failure_reason, created_at_ms
     ) VALUES (
       'validation-sell', 'exec-sell', 6000, 6100, '6000', '6100', 200, 1,
       '${TOKEN_MINT}', '${NATIVE_SOL}', '10', '9007199254741020',
       'Jupiter', '[{"swapInfo":{"label":"Raydium"}}]', NULL, 6100
     );

     INSERT INTO risk_decisions(
       decision_id, phase, intent_id, leader_trade_id, leader_wallet,
       follower_wallet, side, token_mint, quote_mint, pre_decision_id,
       quote_request_id, decision, requested_amount_raw, approved_amount_raw,
       requested_token_raw, approved_token_raw, requested_quote_raw,
       approved_quote_raw, reason_code, policy_version, relevant_limit_raw,
       relevant_evidence_json, decided_at_ms
     ) VALUES
       (
         'risk-pre-sell', 'PRE_QUOTE', 'exec-sell', 'leader-sell',
         '${LEADER_WALLET}', '${FOLLOWER_WALLET}', 'SELL', '${TOKEN_MINT}',
         '${NATIVE_SOL}', NULL, NULL, 'ALLOW', '10', '10', '10', '10',
         '9007199254741020', '9007199254741020', 'ALLOW', 'RISK_TEST_V1',
         NULL, '{}', 6000
       ),
       (
         'risk-post-sell', 'POST_QUOTE', 'exec-sell', 'leader-sell',
         '${LEADER_WALLET}', '${FOLLOWER_WALLET}', 'SELL', '${TOKEN_MINT}',
         '${NATIVE_SOL}', 'risk-pre-sell', 'request-sell', 'ALLOW', '10',
         '10', '10', '10', '9007199254741020', '9007199254741020',
         'ALLOW', 'RISK_TEST_V1', NULL, '{}', 6100
       ),
       (
         'risk-pre-terminal', 'PRE_QUOTE', 'exec-terminal',
         'leader-exec-terminal', '${LEADER_WALLET}', '${FOLLOWER_WALLET}',
         'BUY', '${TOKEN_MINT}', '${NATIVE_SOL}', NULL, NULL, 'REJECT', '1',
         '0', '1', '0', '1', '0', 'SINGLE_TRADE_LIMIT', 'RISK_TEST_V1',
         '0', '{}', 7000
       );

     INSERT INTO paper_fills(
       id, intent_id, leader_trade_id, leader_tx_signature, leader_wallet,
       follower_wallet, side, input_mint, output_mint, token_decimals,
       quote_decimals, input_amount_raw, output_amount_raw,
       quote_request_timestamp_ms, quote_timestamp_ms, quote_rtt_ms,
       fee_evidence_status, provider, request_id, fill_policy_version,
       created_at_ms
     ) VALUES (
       'fill-post-window', 'exec-outside', 'leader-exec-outside',
       'signature-exec-outside', '${LEADER_WALLET}', '${FOLLOWER_WALLET}',
       'BUY', '${NATIVE_SOL}', '${TOKEN_MINT}', 6, 9, '1', '1', 5000,
       5100, 100, 'AMOUNT_UNAVAILABLE', 'JUPITER_SWAP_V2_ORDER',
       'request-post-window', 'JUPITER_ORDER_QUOTE_AS_FILL_V1', 5100
     );

     INSERT INTO paper_fill_applications(
       fill_id, position_id, transition, quantity_before_raw,
       quantity_after_raw, total_cost_before_raw, total_cost_after_raw,
       allocated_cost_basis_raw, proceeds_raw, realized_pnl_delta_raw,
       realized_pnl_after_raw, position_version_after, applied_at_ms
     ) VALUES (
       'fill-post-window', 10, 'OPEN', '0', '1', '0', '1', '0', '0', '0',
       '27', 3, 5100
     );`,
  );
  return databasePath;
}

function persistedEvidence(databasePath: string): {
  readonly migrations: readonly unknown[];
  readonly fills: readonly unknown[];
  readonly applications: readonly unknown[];
  readonly jupiterQuotes: readonly unknown[];
  readonly riskDecisions: readonly unknown[];
  readonly leaderTrades: readonly unknown[];
  readonly followerTrades: readonly unknown[];
  readonly followerPositions: readonly unknown[];
  readonly validationEvents: readonly unknown[];
  readonly outbox: readonly unknown[];
} {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return {
      migrations: database
        .prepare(
          `SELECT version, checksum, applied_at_ms
           FROM schema_migrations ORDER BY version`,
        )
        .all(),
      fills: database.prepare("SELECT * FROM paper_fills ORDER BY id").all(),
      applications: database
        .prepare("SELECT * FROM paper_fill_applications ORDER BY fill_id")
        .all(),
      jupiterQuotes: database
        .prepare("SELECT * FROM jupiter_shadow_quotes ORDER BY execution_key")
        .all(),
      riskDecisions: database
        .prepare("SELECT * FROM risk_decisions ORDER BY decision_id")
        .all(),
      leaderTrades: database
        .prepare("SELECT * FROM leader_trades ORDER BY id")
        .all(),
      followerTrades: database
        .prepare("SELECT * FROM follower_trades ORDER BY execution_key")
        .all(),
      followerPositions: database
        .prepare("SELECT * FROM follower_positions ORDER BY id")
        .all(),
      validationEvents: database
        .prepare("SELECT * FROM live_validation_events ORDER BY id")
        .all(),
      outbox: database.prepare("SELECT * FROM outbox ORDER BY id").all(),
    };
  } finally {
    database.close();
  }
}

function sqliteErrorCode(operation: () => void): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error instanceof Error && "code" in error
      ? String((error as Error & { code?: unknown }).code)
      : undefined;
  }
}

describe("StrategyEvaluationReadModel", () => {
  it("refuses to label prospective automatic recovery as legacy strategy evidence", () => {
    const databasePath=fullSnapshotFixture();
    mutateDatabase(databasePath,"INSERT INTO automatic_exit_policy VALUES(1,'AUTOMATIC_EXIT_RECOVERY_V1')");
    expect(()=>new StrategyEvaluationReadModel().readSnapshot({databasePath})).toThrow("AUTOMATIC_EXIT_RECOVERY_REQUIRES_SEPARATE_AUDIT");
  });
  it("preserves pre-migration Paper evidence as legacy NULL provenance", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "strategy-schema-v8-"));
    const legacyMigrations = resolve(directory, "migrations");
    mkdirSync(legacyMigrations);
    for (const file of [
      "0001_initial.sql",
      "0002_live_shadow_validation.sql",
      "0003_paper_trading_v1.sql",
      "0004_risk_engine_v1.sql",
      "0005_risk_commitment_scope.sql",
      "0006_risk_authorization_hardening.sql",
      "0007_leader_research_evidence.sql",
      "0008_execution_realism_delayed_quotes.sql",
    ]) {
      copyFileSync(
        resolve(process.cwd(), "migrations", file),
        resolve(legacyMigrations, file),
      );
    }
    const databasePath = roundTripFixture(legacyMigrations);
    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });

    expect(
      snapshot.provenance.observedSchemaMigrations.map(
        ({ version }) => version,
      ),
    ).toHaveLength(8);
    expect(snapshot.paperFills).toHaveLength(2);
    expect(
      snapshot.paperFills.every(
        ({ feeEvidence }) => !("feeEvidenceContractId" in feeEvidence),
      ),
    ).toBe(true);
  });

  it("assembles provenance for a complete immutable evidence snapshot", () => {
    const databasePath = fullSnapshotFixture();
    const window = { windowStartMs: 3_000, windowEndMs: 5_000 } as const;
    const expectedContext = {
      ...COPYABILITY_CONTEXT,
      window: { fromMs: 3_000, toMs: 5_000 },
    };
    const snapshot = new ProductionStrategyEvaluationReadModel().readSnapshot({
      databasePath: relative(process.cwd(), databasePath),
      window,
      expectedContext,
    });

    expect(Object.keys(snapshot).sort()).toEqual([
      "contextLimitations",
      "jupiterAttempts",
      "observationExclusions",
      "observationLimitations",
      "opportunities",
      "paperFillApplications",
      "paperFills",
      "provenance",
      "riskDecisions",
      "roundTripApplicationSources",
      "roundTripApplications",
    ]);
    expect(snapshot.provenance).toEqual({
      resolvedDatabasePath: resolve(databasePath),
      observedSchemaMigrations: expect.arrayContaining([
        expect.objectContaining({ version: "0001_initial.sql" }),
        expect.objectContaining({
          version: "0006_risk_authorization_hardening.sql",
        }),
      ]),
      requestedWindow: window,
      expectedContext,
    });
    expect(
      snapshot.provenance.observedSchemaMigrations.map(
        ({ version }) => version,
      ),
    ).toEqual([
      "0001_initial.sql",
      "0002_live_shadow_validation.sql",
      "0003_paper_trading_v1.sql",
      "0004_risk_engine_v1.sql",
      "0005_risk_commitment_scope.sql",
      "0006_risk_authorization_hardening.sql",
      "0007_leader_research_evidence.sql",
      "0008_execution_realism_delayed_quotes.sql",
      "0009_paper_fee_evidence_contract_v1.sql",
      "0010_stream_pending_deliveries.sql",
      "0011_automatic_exit_recovery.sql",
    ]);
    expect(
      snapshot.provenance.observedSchemaMigrations.every(({ checksum }) =>
        /^[a-f0-9]{64}$/.test(checksum),
      ),
    ).toBe(true);

    expect(
      snapshot.opportunities.map(({ executionKey }) => executionKey),
    ).toEqual(["exec-terminal", "exec-sell"]);
    const opportunityExecutionKeys = new Set(
      snapshot.opportunities.map(({ executionKey }) => executionKey),
    );
    expect(
      snapshot.jupiterAttempts.every(({ executionKey }) =>
        opportunityExecutionKeys.has(executionKey),
      ),
    ).toBe(true);
    expect(
      snapshot.riskDecisions.every(({ intentId }) =>
        opportunityExecutionKeys.has(intentId),
      ),
    ).toBe(true);
    expect(
      snapshot.paperFills.every(({ intentId }) =>
        opportunityExecutionKeys.has(intentId),
      ),
    ).toBe(true);
    const cohortFillIds = new Set(snapshot.paperFills.map(({ id }) => id));
    expect(
      snapshot.paperFillApplications.every(({ fillId }) =>
        cohortFillIds.has(fillId),
      ),
    ).toBe(true);

    expect(snapshot.roundTripApplications.map(({ fillId }) => fillId)).toEqual([
      "fill-z-open",
      "fill-a-close",
    ]);
    expect(snapshot.roundTripApplicationSources[0]).toMatchObject({
      fillId: "fill-z-open",
      sourceTimestamp: { valueMs: 900 },
    });
    expect(
      snapshot.roundTripApplications.some(
        ({ fillId }) => fillId === "fill-post-window",
      ),
    ).toBe(false);
    expect(snapshot.paperFills.map(({ id }) => id)).toEqual(["fill-a-close"]);
    expect(snapshot.paperFillApplications.map(({ fillId }) => fillId)).toEqual([
      "fill-a-close",
    ]);

    expect(snapshot.observationLimitations).toContainEqual(
      expect.objectContaining({
        id: "observation-unproven",
        limitationReason: "WINDOW_MEMBERSHIP_UNPROVEN",
      }),
    );
    expect(snapshot.observationExclusions).toEqual([]);
    expect(snapshot.contextLimitations).toContainEqual({
      ...COPYABILITY_BUCKET,
      executionKey: "exec-context-limited",
      reason: "CONTEXT_COPY_RATIO_MISMATCH",
      expected: 10_000,
      observed: 2_000,
    });
    expect(snapshot.contextLimitations).toContainEqual({
      observationId: "observation-unproven",
      reason: "WINDOW_MEMBERSHIP_UNPROVEN",
    });
    expect(JSON.stringify(snapshot.provenance)).not.toMatch(
      /api.?key|private.?key|rpc.?url|secret/i,
    );
  });

  it("keeps every analytical consumer outside the full snapshot assembly", () => {
    const databasePath = fullSnapshotFixture();
    const window = { windowStartMs: 3_000, windowEndMs: 5_000 } as const;
    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      window,
    });
    const bucket = {
      followerWallet: FOLLOWER_WALLET,
      leaderWallet: LEADER_WALLET,
      quoteMint: NATIVE_SOL,
    };

    expect(
      matchFollowerRoundTrips(snapshot.roundTripApplications).completed,
    ).toHaveLength(1);
    expect(
      calculateJupiterSuccessRate(bucket, snapshot.jupiterAttempts),
    ).toMatchObject({
      attemptCount: 1,
      successCount: 1,
      successRate: "1",
    });
    expect(
      calculatePostRiskDistribution(bucket, snapshot.riskDecisions),
    ).toMatchObject({
      postRiskDecisionCount: 1,
      postRiskAllowCount: 1,
      allowRate: "1",
    });
    expect(
      calculatePaperFillOutcome(
        { leaderWallet: LEADER_WALLET, quoteMint: NATIVE_SOL },
        snapshot.paperFills,
        snapshot.paperFillApplications,
      ),
    ).toMatchObject({
      paperFillCount: 1,
      paperFillApplicationCount: 1,
      paperFillApplicationRate: "1",
    });

    const classified = snapshot.opportunities.map(
      (opportunity): ClassifiedCopyabilityOpportunity => ({
        executionKey: opportunity.executionKey,
        followerWallet: opportunity.followerWallet,
        leaderWallet: opportunity.leaderWallet,
        quoteMint: opportunity.quoteMint,
        side: opportunity.side,
        failureClassification: classifyOpportunityFailure(
          opportunity.normalizedEvidence,
          { definitionVersion: "OPPORTUNITY_FAILURE_V1" },
        ),
      }),
    );
    expect(classified).toEqual([
      expect.objectContaining({
        executionKey: "exec-terminal",
        failureClassification: expect.objectContaining({
          classificationStatus: "CLASSIFIED",
          primaryCategory: "RISK_REJECTION",
          stage: "PRE_QUOTE_RISK",
        }),
      }),
      expect.objectContaining({
        executionKey: "exec-sell",
        failureClassification: expect.objectContaining({
          classificationStatus: "NOT_A_FAILURE",
          stage: "PAPER_APPLICATION",
        }),
      }),
    ]);
    expect(
      calculateEndToEndApplicationCompatibility(
        bucket,
        classified,
        snapshot.provenance.expectedContext,
      ),
    ).toMatchObject({
      applicationSuccessCount: 1,
      terminalFailureCount: 1,
      endToEndApplicationCompatibilityRate: "0.5",
      preconditionCount: 2,
      evaluableCount: 2,
      status: "AVAILABLE",
    });
  });

  it("normalizes database path and defensively copies window and context provenance", () => {
    const databasePath = fullSnapshotFixture();
    const window = { windowStartMs: 3_000, windowEndMs: 5_000 };
    const expectedContext = {
      ...COPYABILITY_CONTEXT,
      window: { fromMs: 3_000, toMs: 5_000 },
    };
    const reader = new ProductionStrategyEvaluationReadModel();
    const snapshot = reader.readSnapshot({
      databasePath: relative(process.cwd(), databasePath),
      window,
      expectedContext,
    });
    const repeated = reader.readSnapshot({
      databasePath: resolve(databasePath),
      window: { windowStartMs: 3_000, windowEndMs: 5_000 },
      expectedContext: {
        ...COPYABILITY_CONTEXT,
        window: { fromMs: 3_000, toMs: 5_000 },
      },
    });

    expect(repeated).toEqual(snapshot);
    window.windowStartMs = 1;
    window.windowEndMs = 2;
    expectedContext.window.fromMs = 1;
    expectedContext.window.toMs = 2;
    expectedContext.source = "mutated-source";
    expectedContext.riskPolicyVersion = "mutated-risk";

    expect(snapshot.provenance).toMatchObject({
      resolvedDatabasePath: resolve(databasePath),
      requestedWindow: { windowStartMs: 3_000, windowEndMs: 5_000 },
      expectedContext: {
        window: { fromMs: 3_000, toMs: 5_000 },
        source: "strategy-evaluation-read-model-fixture",
        riskPolicyVersion: "RISK_TEST_V1",
      },
    });
  });

  it("uses a half-open authoritative leader opportunity window", () => {
    const databasePath = roundTripFixture();
    insertWindowOpportunity(databasePath, {
      executionKey: "exec-end-minus-one",
      sourceTimestampMs: 3_899,
    });
    insertWindowOpportunity(databasePath, {
      executionKey: "exec-before-start",
      sourceTimestampMs: 899,
    });
    insertWindowOpportunity(databasePath, {
      executionKey: "exec-unproven",
      sourceTimestampMs: 1_000,
      sourceTimestampProvenance: "UNKNOWN",
    });
    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      window: { windowStartMs: 900, windowEndMs: 3_900 },
      expectedContext: {
        ...COPYABILITY_CONTEXT,
        window: { fromMs: 900, toMs: 3_900 },
      },
    });

    expect(
      snapshot.opportunities.map(({ executionKey }) => executionKey),
    ).toEqual(["exec-buy", "exec-end-minus-one"]);
    expect(snapshot.contextLimitations).toContainEqual({
      ...COPYABILITY_BUCKET,
      executionKey: "exec-unproven",
      reason: "WINDOW_MEMBERSHIP_UNPROVEN",
    });
  });

  it.each([
    ["NaN start", { windowStartMs: Number.NaN, windowEndMs: 10 }],
    [
      "infinite end",
      { windowStartMs: 0, windowEndMs: Number.POSITIVE_INFINITY },
    ],
    ["fractional start", { windowStartMs: 0.5, windowEndMs: 10 }],
    ["empty", { windowStartMs: 10, windowEndMs: 10 }],
    ["reversed", { windowStartMs: 11, windowEndMs: 10 }],
  ])("rejects an invalid evaluation window: %s", (_case, window) => {
    const databasePath = roundTripFixture();
    expect(() =>
      new ProductionStrategyEvaluationReadModel().readSnapshot({
        databasePath,
        window,
        expectedContext: {
          ...COPYABILITY_CONTEXT,
          window: { fromMs: window.windowStartMs, toMs: window.windowEndMs },
        },
      }),
    ).toThrowError("INVALID_EVALUATION_WINDOW");
  });

  it("requires the window and expected context and binds their boundaries", () => {
    const databasePath = roundTripFixture();
    const reader = new ProductionStrategyEvaluationReadModel();
    expect(() =>
      reader.readSnapshot({
        databasePath,
      } as StrategyEvaluationReadSnapshotRequest),
    ).toThrowError("EVALUATION_WINDOW_REQUIRED");
    expect(() =>
      reader.readSnapshot({
        databasePath,
        window: DEFAULT_WINDOW,
      } as StrategyEvaluationReadSnapshotRequest),
    ).toThrowError("EXPECTED_EVALUATION_CONTEXT_REQUIRED");
    expect(() =>
      reader.readSnapshot({
        databasePath,
        window: DEFAULT_WINDOW,
        expectedContext: {
          ...COPYABILITY_CONTEXT,
          window: { fromMs: 1, toMs: DEFAULT_WINDOW.windowEndMs },
        },
      }),
    ).toThrowError("EXPECTED_CONTEXT_WINDOW_MISMATCH");
  });

  it("includes downstream evidence by execution identity rather than its timestamps", () => {
    const databasePath = roundTripFixture();
    const window = { windowStartMs: 900, windowEndMs: 950 } as const;
    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      window,
    });

    expect(
      snapshot.opportunities.map(({ executionKey }) => executionKey),
    ).toEqual(["exec-buy"]);
    expect(
      snapshot.jupiterAttempts.map(({ executionKey }) => executionKey),
    ).toEqual(["exec-buy"]);
    expect(snapshot.riskDecisions).toHaveLength(2);
    expect(
      snapshot.riskDecisions.every(({ decidedAtMs }) => decidedAtMs > 950),
    ).toBe(true);
    expect(snapshot.paperFills.map(({ intentId }) => intentId)).toEqual([
      "exec-buy",
    ]);
    expect(snapshot.paperFillApplications).toEqual([
      {
        fillId: "fill-z-open",
        positionId: 10,
        transition: "OPEN",
        positionVersionAfter: 1,
        appliedAtMs: 1_000,
      },
    ]);
  });

  it("replays relevant application history before windowEnd without selecting RoundTrips", () => {
    const databasePath = roundTripFixture();
    const window = { windowStartMs: 3_000, windowEndMs: 5_000 } as const;
    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      window,
    });

    expect(
      snapshot.opportunities.map(({ executionKey }) => executionKey),
    ).toEqual(["exec-sell"]);
    expect(snapshot.paperFills.map(({ intentId }) => intentId)).toEqual([
      "exec-sell",
    ]);
    expect(snapshot.roundTripApplications.map(({ fillId }) => fillId)).toEqual([
      "fill-z-open",
      "fill-a-close",
    ]);
    expect(snapshot.roundTripApplicationSources).toEqual([
      {
        fillId: "fill-z-open",
        executionKey: "exec-buy",
        leaderTradeId: "leader-buy",
        sourceTimestamp: {
          valueMs: 900,
          precision: "SECOND",
          provenance: "CHAIN_BLOCK_TIME",
        },
      },
      {
        fillId: "fill-a-close",
        executionKey: "exec-sell",
        leaderTradeId: "leader-sell",
        sourceTimestamp: {
          valueMs: 3_900,
          precision: "SECOND",
          provenance: "CHAIN_BLOCK_TIME",
        },
      },
    ]);
    expect(
      matchFollowerRoundTrips(snapshot.roundTripApplications).completed,
    ).toHaveLength(1);
  });

  it("preserves bucket scope for unproven pre-window replay membership", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE leader_trades
       SET source_timestamp_provenance = 'UNKNOWN'
       WHERE id = 'leader-buy';
       DELETE FROM live_validation_events;`,
    );

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      window: { windowStartMs: 3_000, windowEndMs: 5_000 },
    });

    expect(snapshot.roundTripApplications.map(({ fillId }) => fillId)).toEqual([
      "fill-a-close",
    ]);
    expect(snapshot.contextLimitations).toEqual([
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "WINDOW_MEMBERSHIP_UNPROVEN",
      },
    ]);
  });

  it("exposes OPEN source evidence separately from an incomplete RoundTrip at the replay boundary", () => {
    const databasePath = roundTripFixture();
    const window = { windowStartMs: 500, windowEndMs: 3_000 } as const;
    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      window,
    });

    const result = matchFollowerRoundTrips(snapshot.roundTripApplications);

    expect(snapshot.roundTripApplications.map(({ fillId }) => fillId)).toEqual([
      "fill-z-open",
    ]);
    expect(result.completed).toEqual([]);
    expect(result.incomplete).toEqual([
      expect.objectContaining({
        openFillId: "fill-z-open",
        latestFillId: "fill-z-open",
        remainingQuantityRaw: 10n,
      }),
    ]);
    expect(
      snapshot.roundTripApplicationSources.find(
        ({ fillId }) => fillId === result.incomplete[0]?.openFillId,
      ),
    ).toEqual({
      fillId: "fill-z-open",
      executionKey: "exec-buy",
      leaderTradeId: "leader-buy",
      sourceTimestamp: {
        valueMs: 900,
        precision: "SECOND",
        provenance: "CHAIN_BLOCK_TIME",
      },
    });
  });

  it("fails closed when pre-window replay mixes PaperFill and joined leader identity", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE paper_fills
       SET leader_trade_id = 'leader-mismatched'
       WHERE id = 'fill-z-open'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({
        databasePath,
        window: { windowStartMs: 3_000, windowEndMs: 5_000 },
      }),
    ).toThrowError("CONFLICTING_OPPORTUNITY_PAPER_FILL:exec-buy");
  });

  it("fails closed when pre-window replay position identity conflicts", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `INSERT INTO follower_positions(
         id, follower_wallet_id, leader_wallet_id, token_mint, quote_mint,
         raw_amount, reserved_raw_amount, total_cost_quote_raw,
         realized_pnl_quote_raw, accounting_policy_version, state,
         last_execution_key, last_fill_id, opened_at_ms, closed_at_ms,
         version, updated_at_ms
       ) VALUES (
         11, 2, 2, '${TOKEN_MINT}', '${NATIVE_SOL}', '10', '0',
         '9007199254740993', '0', 'WEIGHTED_AVERAGE_V1', 'OPEN',
         'exec-buy', 'fill-z-open', 1000, NULL, 1, 1000
       );
       UPDATE paper_fill_applications
       SET position_id = 11
       WHERE fill_id = 'fill-z-open'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({
        databasePath,
        window: { windowStartMs: 3_000, windowEndMs: 5_000 },
      }),
    ).toThrowError("CONFLICTING_APPLICATION_POSITION_IDENTITY:fill-z-open");
  });

  it("fails closed when pre-window replay contains WSOL domain identity", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE paper_fills
       SET input_mint = '${WSOL_MINT}'
       WHERE id = 'fill-z-open'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({
        databasePath,
        window: { windowStartMs: 3_000, windowEndMs: 5_000 },
      }),
    ).toThrowError("NON_CANONICAL_DOMAIN_QUOTE_MINT:fill-z-open");
  });

  it("accepts the historical follower-trade copy ratio rather than the wallet setting", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      "UPDATE follower_trades SET copy_ratio_bps = 1000 WHERE execution_key = 'exec-buy'",
    );
    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      expectedContext: { ...COPYABILITY_CONTEXT, copyRatioBps: 1_000 },
    });

    expect(snapshot.opportunities).toHaveLength(1);
    expect(snapshot.contextLimitations).toEqual([]);
  });

  it("scopes a copy-ratio limitation to its bucket without limiting an independent bucket", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      `INSERT INTO wallets(
         id, address, role, enabled, copy_ratio_bps, created_at_ms, updated_at_ms
       ) VALUES
         (3, 'leader-wallet-b', 'LEADER', 1, 10000, 1, 1),
         (4, 'follower-wallet-b', 'FOLLOWER', 1, 10000, 1, 1);
       UPDATE follower_trades
       SET copy_ratio_bps = 2000
       WHERE execution_key = 'exec-buy';`,
    );
    insertWindowOpportunity(databasePath, {
      executionKey: "exec-b",
      sourceTimestampMs: 2_000,
      leaderWalletId: 3,
      followerWalletId: 4,
    });

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });

    expect(
      snapshot.opportunities.map(({ executionKey }) => executionKey),
    ).toEqual(["exec-b"]);
    expect(snapshot.contextLimitations).toEqual([
      {
        executionKey: "exec-buy",
        followerWallet: FOLLOWER_WALLET,
        leaderWallet: LEADER_WALLET,
        quoteMint: NATIVE_SOL,
        reason: "CONTEXT_COPY_RATIO_MISMATCH",
        expected: 10_000,
        observed: 2_000,
      },
    ]);

    const bucketKey = (bucket: CopyabilityBucket): string =>
      [bucket.followerWallet, bucket.leaderWallet, bucket.quoteMint].join(
        "\u0000",
      );
    const limitedBucketKeys = new Set(
      snapshot.contextLimitations.flatMap((limitation) =>
        "executionKey" in limitation ? [bucketKey(limitation)] : [],
      ),
    );
    expect(limitedBucketKeys.has(bucketKey(COPYABILITY_BUCKET))).toBe(true);
    expect(
      limitedBucketKeys.has(
        bucketKey({
          followerWallet: "follower-wallet-b",
          leaderWallet: "leader-wallet-b",
          quoteMint: NATIVE_SOL,
        }),
      ),
    ).toBe(false);
  });

  it("proves structured limitation scope isolates follower/leader and quote buckets together", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      `INSERT INTO wallets(
         id, address, role, enabled, copy_ratio_bps, created_at_ms, updated_at_ms
       ) VALUES
         (3, 'leader-wallet-b', 'LEADER', 1, 10000, 1, 1),
         (4, 'follower-wallet-b', 'FOLLOWER', 1, 10000, 1, 1);
       INSERT INTO tokens(mint, decimals, is_quote, first_seen_at_ms, updated_at_ms)
       VALUES ('USDC', 6, 1, 1, 1);
       UPDATE follower_trades
       SET copy_ratio_bps = 2000
       WHERE execution_key = 'exec-buy';`,
    );
    insertWindowOpportunity(databasePath, {
      executionKey: "exec-b",
      sourceTimestampMs: 2_000,
      leaderWalletId: 3,
      followerWalletId: 4,
    });
    insertWindowOpportunity(databasePath, {
      executionKey: "exec-c",
      sourceTimestampMs: 2_100,
      quoteMint: "USDC",
    });

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });
    const bucketKey = (bucket: CopyabilityBucket): string =>
      [bucket.followerWallet, bucket.leaderWallet, bucket.quoteMint].join(
        "\u0000",
      );
    const limitedBucketKeys = new Set(
      snapshot.contextLimitations.flatMap((limitation) =>
        "executionKey" in limitation ? [bucketKey(limitation)] : [],
      ),
    );

    expect(snapshot.contextLimitations).toEqual([
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_COPY_RATIO_MISMATCH",
        expected: 10_000,
        observed: 2_000,
      },
    ]);
    expect(limitedBucketKeys).toEqual(new Set([bucketKey(COPYABILITY_BUCKET)]));
    expect(
      snapshot.opportunities.map(
        ({ executionKey, followerWallet, leaderWallet, quoteMint }) => ({
          executionKey,
          followerWallet,
          leaderWallet,
          quoteMint,
        }),
      ),
    ).toEqual([
      {
        executionKey: "exec-b",
        followerWallet: "follower-wallet-b",
        leaderWallet: "leader-wallet-b",
        quoteMint: NATIVE_SOL,
      },
      {
        executionKey: "exec-c",
        followerWallet: FOLLOWER_WALLET,
        leaderWallet: LEADER_WALLET,
        quoteMint: "USDC",
      },
    ]);
  });

  it.each([
    [
      "follower wallet",
      `INSERT INTO wallets(
         id, address, role, enabled, copy_ratio_bps, created_at_ms, updated_at_ms
       ) VALUES (4, 'follower-wallet-b', 'FOLLOWER', 1, 10000, 1, 1)`,
      { followerWalletId: 4 },
      {
        followerWallet: "follower-wallet-b",
        leaderWallet: LEADER_WALLET,
        quoteMint: NATIVE_SOL,
      },
    ],
    [
      "leader wallet",
      `INSERT INTO wallets(
         id, address, role, enabled, copy_ratio_bps, created_at_ms, updated_at_ms
       ) VALUES (3, 'leader-wallet-b', 'LEADER', 1, 10000, 1, 1)`,
      { leaderWalletId: 3 },
      {
        followerWallet: FOLLOWER_WALLET,
        leaderWallet: "leader-wallet-b",
        quoteMint: NATIVE_SOL,
      },
    ],
    [
      "quote mint",
      `INSERT INTO tokens(mint, decimals, is_quote, first_seen_at_ms, updated_at_ms)
       VALUES ('USDC', 6, 1, 1, 1)`,
      { quoteMint: "USDC" },
      {
        followerWallet: FOLLOWER_WALLET,
        leaderWallet: LEADER_WALLET,
        quoteMint: "USDC",
      },
    ],
  ] as const)(
    "isolates a limited bucket from a valid bucket with a different %s",
    (_case, setupSql, opportunityOverrides, validBucket) => {
      const databasePath = completeBuyOpportunityFixture();
      mutateDatabase(
        databasePath,
        `${setupSql};
         UPDATE follower_trades
         SET copy_ratio_bps = 2000
         WHERE execution_key = 'exec-buy';`,
      );
      insertWindowOpportunity(databasePath, {
        executionKey: "exec-valid-bucket",
        sourceTimestampMs: 2_000,
        ...opportunityOverrides,
      });

      const snapshot = new StrategyEvaluationReadModel().readSnapshot({
        databasePath,
      });

      expect(snapshot.contextLimitations).toEqual([
        {
          ...COPYABILITY_BUCKET,
          executionKey: "exec-buy",
          reason: "CONTEXT_COPY_RATIO_MISMATCH",
          expected: 10_000,
          observed: 2_000,
        },
      ]);
      expect(snapshot.opportunities).toEqual([
        expect.objectContaining({
          executionKey: "exec-valid-bucket",
          ...validBucket,
        }),
      ]);
    },
  );

  it("keeps same-bucket opportunity limitations traceable by execution key", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      `UPDATE follower_trades
       SET copy_ratio_bps = 2000
       WHERE execution_key = 'exec-buy'`,
    );
    insertWindowOpportunity(databasePath, {
      executionKey: "exec-same-bucket",
      sourceTimestampMs: 2_000,
      copyRatioBps: 3_000,
    });

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });

    expect(
      snapshot.contextLimitations.flatMap((limitation) =>
        "executionKey" in limitation
          ? [
              {
                followerWallet: limitation.followerWallet,
                leaderWallet: limitation.leaderWallet,
                quoteMint: limitation.quoteMint,
                executionKey: limitation.executionKey,
                reason: limitation.reason,
              },
            ]
          : [],
      ),
    ).toEqual([
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_COPY_RATIO_MISMATCH",
      },
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-same-bucket",
        reason: "CONTEXT_COPY_RATIO_MISMATCH",
      },
    ]);
  });

  it("traces different limitation reasons to executions within one bucket", () => {
    const databasePath = completeBuyOpportunityFixture();
    insertWindowOpportunity(databasePath, {
      executionKey: "exec-valid",
      sourceTimestampMs: 2_000,
    });
    insertWindowOpportunity(databasePath, {
      executionKey: "exec-mode-limited",
      sourceTimestampMs: 2_100,
      mode: "SHADOW",
    });

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      expectedContext: {
        ...COPYABILITY_CONTEXT,
        riskPolicyVersion: "OTHER_RISK_V1",
      },
    });

    expect(
      snapshot.opportunities.map(({ executionKey }) => executionKey),
    ).toEqual(["exec-valid"]);
    expect(snapshot.contextLimitations).toEqual([
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_RISK_POLICY_MISMATCH",
        expected: "OTHER_RISK_V1",
        observed: "RISK_TEST_V1",
      },
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-mode-limited",
        reason: "CONTEXT_MODE_MISMATCH",
        expected: "PAPER",
        observed: "SHADOW",
      },
    ]);
  });

  it("qualifies SHADOW observation posture as Paper evidence only through the approved semantic binding", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE outbox
       SET payload_json = json_set(payload_json, '$.mode', 'SHADOW')
       WHERE aggregate_type = 'EXECUTION'
         AND event_type = 'INTENT_RESERVED';
       UPDATE risk_decisions SET policy_version = 'PAPER_RISK_V1';`,
    );

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      expectedContext: {
        ...COPYABILITY_CONTEXT,
        riskPolicyVersion: "PAPER_RISK_V1",
        copyabilityDefinitionVersion: "COPYABILITY_V1",
      },
      shadowPaperEvidenceBinding: APPROVED_SHADOW_PAPER_BINDING,
    });

    expect(
      snapshot.opportunities.map(({ executionKey }) => executionKey),
    ).toEqual(["exec-buy", "exec-sell"]);
    expect(snapshot.contextLimitations).toEqual([]);
    expect(snapshot.provenance.shadowPaperEvidenceBinding).toEqual(
      APPROVED_SHADOW_PAPER_BINDING,
    );
  });

  it("reads the canonical Strategy A Shadow/Paper request as compatible evidence", () => {
    const databasePath = canonicalStrategyAShadowPaperFixture();
    const snapshot = new ProductionStrategyEvaluationReadModel().readSnapshot({
      databasePath,
      window: {
        windowStartMs: CANONICAL_STRATEGY_A_CONTEXT.window.fromMs,
        windowEndMs: CANONICAL_STRATEGY_A_CONTEXT.window.toMs,
      },
      expectedContext: CANONICAL_STRATEGY_A_CONTEXT,
      shadowPaperEvidenceBinding: APPROVED_SHADOW_PAPER_BINDING,
    });

    expect({
      opportunities: snapshot.opportunities.length,
      paperFills: snapshot.paperFills.length,
      paperFillApplications: snapshot.paperFillApplications.length,
      roundTripApplications: snapshot.roundTripApplications.length,
    }).toEqual({
      opportunities: 2,
      paperFills: 2,
      paperFillApplications: 2,
      roundTripApplications: 2,
    });
  });

  it.each([
    [
      "copy ratio",
      { copyRatioBps: 10_000 },
      true,
      "CONTEXT_COPY_RATIO_MISMATCH",
    ],
    [
      "Risk",
      { riskPolicyVersion: "OTHER_RISK_V1" },
      true,
      "CONTEXT_RISK_POLICY_MISMATCH",
    ],
    [
      "Fill",
      { fillPolicyVersion: "OTHER_FILL_V1" },
      true,
      "CONTEXT_FILL_POLICY_MISMATCH",
    ],
    [
      "Accounting",
      { accountingPolicyVersion: "OTHER_ACCOUNTING_V1" },
      true,
      "CONTEXT_ACCOUNTING_POLICY_MISMATCH",
    ],
    ["Shadow/Paper mode binding", {}, false, "CONTEXT_MODE_MISMATCH"],
  ] as const)(
    "keeps canonical Strategy A evidence with incompatible %s semantics outside the cohort",
    (_case, contextOverride, includeBinding, expectedReason) => {
      const databasePath = canonicalStrategyAShadowPaperFixture();
      const snapshot = new ProductionStrategyEvaluationReadModel().readSnapshot(
        {
          databasePath,
          window: {
            windowStartMs: CANONICAL_STRATEGY_A_CONTEXT.window.fromMs,
            windowEndMs: CANONICAL_STRATEGY_A_CONTEXT.window.toMs,
          },
          expectedContext: {
            ...CANONICAL_STRATEGY_A_CONTEXT,
            ...contextOverride,
          },
          ...(includeBinding
            ? { shadowPaperEvidenceBinding: APPROVED_SHADOW_PAPER_BINDING }
            : {}),
        },
      );

      expect(snapshot.opportunities).toEqual([]);
      expect(snapshot.contextLimitations).toContainEqual(
        expect.objectContaining({ reason: expectedReason }),
      );
    },
  );

  it("rejects an incompatible Strategy A Shadow/Paper binding version", () => {
    const databasePath = roundTripFixture();

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({
        databasePath,
        shadowPaperEvidenceBinding: {
          ...APPROVED_SHADOW_PAPER_BINDING,
          definitionVersion: "SHADOW_PAPER_EVIDENCE_BINDING_V2",
        } as unknown as ShadowPaperEvidenceBinding,
      }),
    ).toThrowError("INVALID_SHADOW_PAPER_EVIDENCE_BINDING:definitionVersion");
  });

  it.each([
    [
      "Risk",
      "UPDATE risk_decisions SET policy_version = 'OTHER_RISK_V1'",
      {},
      "CONTEXT_RISK_POLICY_MISMATCH",
    ],
    [
      "Fill",
      "SELECT 1",
      { fillPolicyVersion: "OTHER_FILL_V1" },
      "CONTEXT_FILL_POLICY_MISMATCH",
    ],
    [
      "Accounting",
      "UPDATE follower_positions SET accounting_policy_version = 'OTHER_ACCOUNTING_V1'",
      {},
      "CONTEXT_ACCOUNTING_POLICY_MISMATCH",
    ],
  ] as const)(
    "keeps SHADOW evidence with wrong %s semantics outside the Paper cohort",
    (_name, incompatibleMutation, contextOverride, expectedReason) => {
      const databasePath = roundTripFixture();
      mutateDatabase(
        databasePath,
        `UPDATE outbox
         SET payload_json = json_set(payload_json, '$.mode', 'SHADOW')
         WHERE aggregate_type = 'EXECUTION'
           AND event_type = 'INTENT_RESERVED';
         UPDATE risk_decisions SET policy_version = 'PAPER_RISK_V1';
         ${incompatibleMutation};`,
      );

      const snapshot = new StrategyEvaluationReadModel().readSnapshot({
        databasePath,
        expectedContext: {
          ...COPYABILITY_CONTEXT,
          riskPolicyVersion: "PAPER_RISK_V1",
          copyabilityDefinitionVersion: "COPYABILITY_V1",
          ...contextOverride,
        },
        shadowPaperEvidenceBinding: APPROVED_SHADOW_PAPER_BINDING,
      });

      expect(snapshot.contextLimitations).toContainEqual(
        expect.objectContaining({
          executionKey: "exec-buy",
          reason: expectedReason,
        }),
      );
    },
  );

  it("keeps an unknown persisted execution mode outside an approved Shadow Paper binding", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE outbox
       SET payload_json = json_set(payload_json, '$.mode', 'LIVE')
       WHERE aggregate_type = 'EXECUTION'
         AND event_type = 'INTENT_RESERVED';
       UPDATE risk_decisions SET policy_version = 'PAPER_RISK_V1';`,
    );

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      expectedContext: {
        ...COPYABILITY_CONTEXT,
        riskPolicyVersion: "PAPER_RISK_V1",
        copyabilityDefinitionVersion: "COPYABILITY_V1",
      },
      shadowPaperEvidenceBinding: APPROVED_SHADOW_PAPER_BINDING,
    });

    expect(snapshot.opportunities).toEqual([]);
    expect(snapshot.contextLimitations).toContainEqual({
      ...COPYABILITY_BUCKET,
      executionKey: "exec-buy",
      reason: "CONTEXT_MODE_UNAVAILABLE",
    });
  });

  it("preserves multiple specific context reasons for one execution and bucket", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      `UPDATE follower_trades
       SET copy_ratio_bps = 2000
       WHERE execution_key = 'exec-buy';
       UPDATE outbox
       SET payload_json = '{"executionKey":"exec-buy","mode":"SHADOW"}'
       WHERE aggregate_id = 'exec-buy';`,
    );

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });

    expect(snapshot.contextLimitations).toEqual([
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_COPY_RATIO_MISMATCH",
        expected: 10_000,
        observed: 2_000,
      },
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_MODE_MISMATCH",
        expected: "PAPER",
        observed: "SHADOW",
      },
    ]);
  });

  it("preserves bucket scope for a pre-window replay accounting limitation", () => {
    const databasePath = completeBuyOpportunityFixture();
    insertWindowOpportunity(databasePath, {
      executionKey: "exec-current",
      sourceTimestampMs: 3_000,
    });
    mutateDatabase(
      databasePath,
      `UPDATE follower_positions
       SET accounting_policy_version = 'OTHER_ACCOUNTING_V1'
       WHERE id = 10`,
    );

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      window: { windowStartMs: 2_000, windowEndMs: 4_000 },
    });

    expect(
      snapshot.opportunities.map(({ executionKey }) => executionKey),
    ).toEqual(["exec-current"]);
    expect(snapshot.roundTripApplications.map(({ fillId }) => fillId)).toEqual([
      "fill-z-open",
    ]);
    expect(snapshot.contextLimitations).toEqual([
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_ACCOUNTING_POLICY_MISMATCH",
        expected: "WEIGHTED_AVERAGE_V1",
        observed: "OTHER_ACCOUNTING_V1",
      },
    ]);
  });

  it("reuses immutable context checks for a pre-window replay opportunity", () => {
    const databasePath = completeBuyOpportunityFixture();
    insertWindowOpportunity(databasePath, {
      executionKey: "exec-current",
      sourceTimestampMs: 3_000,
    });
    mutateDatabase(
      databasePath,
      `UPDATE follower_trades
       SET copy_ratio_bps = 2000
       WHERE execution_key = 'exec-buy'`,
    );

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      window: { windowStartMs: 2_000, windowEndMs: 4_000 },
    });

    expect(snapshot.contextLimitations).toEqual([
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_COPY_RATIO_MISMATCH",
        expected: 10_000,
        observed: 2_000,
      },
    ]);
  });

  it("deduplicates the same structured limitation discovered by cohort and replay paths", () => {
    const databasePath = completeBuyOpportunityFixture();
    insertWindowOpportunity(databasePath, {
      executionKey: "exec-same-bucket",
      sourceTimestampMs: 2_000,
    });
    mutateDatabase(
      databasePath,
      `UPDATE follower_positions
       SET accounting_policy_version = 'OTHER_ACCOUNTING_V1'
       WHERE id = 10`,
    );

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });

    expect(snapshot.contextLimitations).toEqual([
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_ACCOUNTING_POLICY_MISMATCH",
        expected: "WEIGHTED_AVERAGE_V1",
        observed: "OTHER_ACCOUNTING_V1",
      },
    ]);
  });

  it("limits an opportunity whose historical copy ratio mismatches context", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      "UPDATE follower_trades SET copy_ratio_bps = 2000 WHERE execution_key = 'exec-buy'",
    );
    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      expectedContext: { ...COPYABILITY_CONTEXT, copyRatioBps: 1_000 },
    });

    expect(snapshot.opportunities).toEqual([]);
    expect(snapshot.jupiterAttempts).toEqual([]);
    expect(snapshot.riskDecisions).toEqual([]);
    expect(snapshot.paperFills).toEqual([]);
    expect(snapshot.paperFillApplications).toEqual([]);
    expect(snapshot.contextLimitations).toContainEqual({
      ...COPYABILITY_BUCKET,
      executionKey: "exec-buy",
      reason: "CONTEXT_COPY_RATIO_MISMATCH",
      expected: 1_000,
      observed: 2_000,
    });
  });

  it.each([
    [
      "mode unavailable",
      "DELETE FROM outbox WHERE aggregate_id = 'exec-buy'",
      {},
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_MODE_UNAVAILABLE",
      },
    ],
    [
      "mode mismatch",
      `UPDATE outbox
       SET payload_json = '{"executionKey":"exec-buy","mode":"SHADOW"}'
       WHERE aggregate_id = 'exec-buy'`,
      {},
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_MODE_MISMATCH",
        expected: "PAPER",
        observed: "SHADOW",
      },
    ],
    [
      "risk policy mismatch",
      "SELECT 1",
      { riskPolicyVersion: "OTHER_RISK_V1" },
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_RISK_POLICY_MISMATCH",
        expected: "OTHER_RISK_V1",
        observed: "RISK_TEST_V1",
      },
    ],
    [
      "fill policy mismatch",
      "SELECT 1",
      { fillPolicyVersion: "OTHER_FILL_V1" },
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_FILL_POLICY_MISMATCH",
        expected: "OTHER_FILL_V1",
        observed: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
      },
    ],
    [
      "accounting policy mismatch",
      "SELECT 1",
      { accountingPolicyVersion: "OTHER_ACCOUNTING_V1" },
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_ACCOUNTING_POLICY_MISMATCH",
        expected: "OTHER_ACCOUNTING_V1",
        observed: "WEIGHTED_AVERAGE_V1",
      },
    ],
    [
      "accounting policy unavailable",
      "UPDATE follower_positions SET accounting_policy_version = NULL WHERE id = 10",
      {},
      {
        ...COPYABILITY_BUCKET,
        executionKey: "exec-buy",
        reason: "CONTEXT_ACCOUNTING_POLICY_UNAVAILABLE",
        expected: "WEIGHTED_AVERAGE_V1",
        observed: null,
      },
    ],
  ] as const)(
    "reports a specific context limitation for %s",
    (_case, mutation, contextOverride, expectedLimitation) => {
      const databasePath = completeBuyOpportunityFixture();
      mutateDatabase(databasePath, mutation);
      const snapshot = new StrategyEvaluationReadModel().readSnapshot({
        databasePath,
        expectedContext: { ...COPYABILITY_CONTEXT, ...contextOverride },
      });

      expect(snapshot.opportunities).toEqual([]);
      expect(snapshot.contextLimitations).toContainEqual(expectedLimitation);
    },
  );

  it("reports conflicting PRE and POST Risk policy versions distinctly", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      "UPDATE risk_decisions SET policy_version = 'OTHER_RISK_V1' WHERE phase = 'POST_QUOTE'",
    );
    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });

    expect(snapshot.opportunities).toEqual([]);
    expect(snapshot.contextLimitations).toContainEqual({
      ...COPYABILITY_BUCKET,
      executionKey: "exec-buy",
      reason: "CONTEXT_RISK_POLICY_CONFLICT",
      expected: "RISK_TEST_V1",
      observed: "OTHER_RISK_V1,RISK_TEST_V1",
    });
  });

  it("does not require later policy evidence before its stage exists", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      `DELETE FROM paper_fill_applications;
       DELETE FROM paper_fills;
       DELETE FROM jupiter_shadow_quotes;
       DELETE FROM risk_decisions;`,
    );
    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });

    expect(snapshot.opportunities).toHaveLength(1);
    expect(snapshot.contextLimitations).toEqual([]);
  });

  it("treats definition versions as software provenance rather than DB facts", () => {
    const databasePath = completeBuyOpportunityFixture();
    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
      expectedContext: {
        ...COPYABILITY_CONTEXT,
        source: "another-evaluator-source",
        copyabilityDefinitionVersion: "COPYABILITY_FUTURE_V2",
      },
    });

    expect(snapshot.opportunities).toHaveLength(1);
    expect(snapshot.contextLimitations).toEqual([]);
  });

  it("fails closed when an application position does not prove the bucket identity", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      "UPDATE follower_positions SET leader_wallet_id = 2 WHERE id = 10",
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("CONFLICTING_APPLICATION_POSITION_IDENTITY:fill-z-open");
  });

  it("uses an authoritative matching leader identity for observation-only window membership", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      `INSERT INTO live_validation_events(
         id, signature, event_index, slot, block_time_ms, leader,
         primary_provider, program_ids_json, system_classification,
         ground_truth_classification, ground_truth_source, token_mint,
         quote_mint, balance_deltas_json, classifier_evidence_json,
         skip_reason, capture_path, decode_error, is_duplicate, created_at_ms
       ) VALUES (
         'observation-authoritative-policy', 'observation-signature', 7,
         '20', 2000, '${LEADER_WALLET}', 'PRIMARY', '[]', 'BUY', 'BUY',
         'AUTO_RULE', '${TOKEN_MINT}', '${NATIVE_SOL}', '[]', '{}',
         'QUOTE_ASSET_NOT_ALLOWED', 'fixture', NULL, 0, 2000
       );
       INSERT INTO leader_trades(
         id, leader_wallet_id, signature, event_index, slot, side,
         token_mint, quote_mint, token_raw, quote_raw, leader_pre_token_raw,
         source_timestamp_ms, source_timestamp_precision,
         source_timestamp_provenance, stream_received_timestamp_ms,
         detected_timestamp_ms, decoded_timestamp_ms,
         stream_received_monotonic_ns, detected_monotonic_ns,
         decoded_monotonic_ns, evidence_json, created_at_ms
       ) VALUES (
         'leader-observation-authoritative-policy', 1,
         'observation-signature', 7, '20', 'BUY', '${TOKEN_MINT}',
         '${NATIVE_SOL}', '1', '1', '0', 2000, 'MILLISECOND',
         'CHAIN_BLOCK_TIME', 2000, 2000, 2000, '2000', '2000', '2000',
         '[]', 2000
       );`,
    );

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });

    expect(snapshot.observationExclusions).toContainEqual(
      expect.objectContaining({
        id: "observation-authoritative-policy",
        structuredReasonCode: "QUOTE_ASSET_NOT_ALLOWED",
      }),
    );
    expect(snapshot.observationLimitations).not.toContainEqual(
      expect.objectContaining({ id: "observation-authoritative-policy" }),
    );
  });

  it("projects one complete executable opportunity for the existing classifier", () => {
    const databasePath = completeBuyOpportunityFixture();
    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });

    expect(snapshot.opportunities).toHaveLength(1);
    const projected = snapshot.opportunities[0]!;
    expect("failureClassification" in projected).toBe(false);
    expect(projected).toMatchObject({
      executionKey: "exec-buy",
      followerWallet: FOLLOWER_WALLET,
      leaderWallet: LEADER_WALLET,
      quoteMint: NATIVE_SOL,
      side: "BUY",
      leaderTradeId: "leader-buy",
      sourceTimestamp: {
        valueMs: 900,
        precision: "SECOND",
        provenance: "CHAIN_BLOCK_TIME",
      },
      observation: {
        id: "validation-buy",
        signature: "signature-buy",
        eventIndex: 0,
        leaderWallet: LEADER_WALLET,
        systemClassification: "BUY",
        groundTruthClassification: "BUY",
        structuredReasonCode: null,
        isDuplicate: false,
      },
      normalizedEvidence: {
        executionKey: "exec-buy",
        observationClassification: "BUY",
        followerTrade: {
          executionKey: "exec-buy",
          state: "CONFIRMED",
        },
        paperFill: { id: "fill-z-open", intentId: "exec-buy" },
        paperFillApplication: { fillId: "fill-z-open" },
      },
      preRiskSizingEvidence: {
        followerWallet: FOLLOWER_WALLET,
        leaderWallet: LEADER_WALLET,
        quoteMint: NATIVE_SOL,
        phase: "PRE_QUOTE",
        intentId: "exec-buy",
        side: "BUY",
        decision: "ALLOW",
        reasonCode: "ALLOW",
        requestedAmountRaw: 9_007_199_254_740_993n,
        approvedAmountRaw: 9_007_199_254_740_993n,
        requestedTokenRaw: 10n,
        approvedTokenRaw: 10n,
        requestedQuoteRaw: 9_007_199_254_740_993n,
        approvedQuoteRaw: 9_007_199_254_740_993n,
      },
    });
    expect(projected.normalizedEvidence.jupiterAttempts).toEqual([
      snapshot.jupiterAttempts[0],
    ]);
    expect(projected.normalizedEvidence.jupiterAttempts?.[0]).toBe(
      snapshot.jupiterAttempts[0],
    );
    expect(projected.normalizedEvidence.riskDecisions).toEqual(
      snapshot.riskDecisions,
    );
    expect(projected.normalizedEvidence.riskDecisions?.[0]).toBe(
      snapshot.riskDecisions[0],
    );
    expect(snapshot.observationExclusions).toEqual([]);
    expect(snapshot.observationLimitations).toEqual([]);
    expect(
      classifyOpportunityFailure(projected.normalizedEvidence, {
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      }),
    ).toEqual({
      classificationStatus: "NOT_A_FAILURE",
      primaryCategory: null,
      stage: "PAPER_APPLICATION",
      reasonCode: null,
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });
  });

  it.each([
    [
      "PRE Risk rejection",
      `DELETE FROM paper_fill_applications;
       DELETE FROM paper_fills;
       DELETE FROM jupiter_shadow_quotes;
       DELETE FROM risk_decisions WHERE phase = 'POST_QUOTE';
       UPDATE risk_decisions
       SET decision = 'REJECT', reason_code = 'STALE_INTENT',
           approved_amount_raw = '0', approved_token_raw = '0',
           approved_quote_raw = '0'
       WHERE phase = 'PRE_QUOTE';`,
      {
        classificationStatus: "CLASSIFIED",
        primaryCategory: "RISK_REJECTION",
        stage: "PRE_QUOTE_RISK",
        reasonCode: "STALE_INTENT",
      },
    ],
    [
      "Jupiter HTTP failure",
      `DELETE FROM paper_fill_applications;
       DELETE FROM paper_fills;
       DELETE FROM risk_decisions WHERE phase = 'POST_QUOTE';
       UPDATE jupiter_shadow_quotes
       SET http_status = 503, schema_valid = 0,
           expected_output_raw = NULL, route_json = NULL;`,
      {
        classificationStatus: "CLASSIFIED",
        primaryCategory: "EXECUTION_FAILURE",
        stage: "JUPITER_ORDER",
        reasonCode: "JUPITER_HTTP_5XX",
      },
    ],
    [
      "POST STALE_QUOTE",
      `DELETE FROM paper_fill_applications;
       DELETE FROM paper_fills;
       UPDATE risk_decisions
       SET decision = 'REJECT', reason_code = 'STALE_QUOTE',
           approved_amount_raw = '0', approved_token_raw = '0',
           approved_quote_raw = '0'
       WHERE phase = 'POST_QUOTE';`,
      {
        classificationStatus: "CLASSIFIED",
        primaryCategory: "COPYABILITY_FAILURE",
        stage: "POST_QUOTE_RISK",
        reasonCode: "STALE_QUOTE",
      },
    ],
    [
      "POST PRICE_IMPACT_TOO_HIGH",
      `DELETE FROM paper_fill_applications;
       DELETE FROM paper_fills;
       UPDATE risk_decisions
       SET decision = 'REJECT', reason_code = 'PRICE_IMPACT_TOO_HIGH',
           approved_amount_raw = '0', approved_token_raw = '0',
           approved_quote_raw = '0'
       WHERE phase = 'POST_QUOTE';`,
      {
        classificationStatus: "CLASSIFIED",
        primaryCategory: "MARKET_FAILURE",
        stage: "POST_QUOTE_RISK",
        reasonCode: "PRICE_IMPACT_TOO_HIGH",
      },
    ],
    [
      "SIZE_ROUNDED_TO_ZERO",
      `DELETE FROM paper_fill_applications;
       DELETE FROM paper_fills;
       DELETE FROM jupiter_shadow_quotes;
       DELETE FROM risk_decisions;
       UPDATE follower_trades
       SET state = 'SKIPPED', skip_reason = 'SIZE_ROUNDED_TO_ZERO';`,
      {
        classificationStatus: "CLASSIFIED",
        primaryCategory: "COPYABILITY_FAILURE",
        stage: "COPY_DECISION",
        reasonCode: "SIZE_ROUNDED_TO_ZERO",
      },
    ],
    [
      "NO_MAPPED_POSITION",
      `DELETE FROM paper_fill_applications;
       DELETE FROM paper_fills;
       DELETE FROM jupiter_shadow_quotes;
       DELETE FROM risk_decisions;
       UPDATE follower_trades
       SET state = 'SKIPPED', skip_reason = 'NO_MAPPED_POSITION';`,
      {
        classificationStatus: "CLASSIFIED",
        primaryCategory: "COPYABILITY_FAILURE",
        stage: "COPY_DECISION",
        reasonCode: "NO_MAPPED_POSITION",
      },
    ],
  ])(
    "composes structured %s evidence through the existing classifier",
    (_case, mutation, expected) => {
      const databasePath = completeBuyOpportunityFixture();
      mutateDatabase(databasePath, mutation);
      const normalizedEvidence = new StrategyEvaluationReadModel().readSnapshot(
        { databasePath },
      ).opportunities[0]!.normalizedEvidence;

      expect(
        classifyOpportunityFailure(normalizedEvidence, {
          definitionVersion: "OPPORTUNITY_FAILURE_V1",
        }),
      ).toEqual({
        ...expected,
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      });
    },
  );

  it("fails closed when downstream Risk evidence exists without PRE", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      "DELETE FROM risk_decisions WHERE phase = 'PRE_QUOTE'",
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("POST_RISK_WITHOUT_PRE:risk-post-buy");
  });

  it("does not synthesize an application when PaperFill is present but application is missing", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(databasePath, "DELETE FROM paper_fill_applications");

    const normalizedEvidence = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    }).opportunities[0]!.normalizedEvidence;
    expect(normalizedEvidence.paperFill).toEqual({
      id: "fill-z-open",
      intentId: "exec-buy",
    });
    expect(normalizedEvidence.paperFillApplication).toBeUndefined();
    expect(
      classifyOpportunityFailure(normalizedEvidence, {
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      }),
    ).toMatchObject({ classificationStatus: "UNAVAILABLE" });
  });

  it("characterizes current taxonomy when Jupiter and POST succeed without Paper evidence", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      `DELETE FROM paper_fill_applications;
       DELETE FROM paper_fills;`,
    );

    const projected = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    }).opportunities[0]!;
    const normalizedEvidence = projected.normalizedEvidence;
    expect(normalizedEvidence.paperFill).toBeUndefined();
    expect(normalizedEvidence.paperFillApplication).toBeUndefined();
    const failureClassification = classifyOpportunityFailure(
      normalizedEvidence,
      { definitionVersion: "OPPORTUNITY_FAILURE_V1" },
    );
    expect(failureClassification).toEqual({
      classificationStatus: "NOT_A_FAILURE",
      primaryCategory: null,
      stage: "JUPITER_ORDER",
      reasonCode: null,
      definitionVersion: "OPPORTUNITY_FAILURE_V1",
    });

    const classifiedOpportunity: ClassifiedCopyabilityOpportunity = {
      executionKey: projected.executionKey,
      followerWallet: projected.followerWallet,
      leaderWallet: projected.leaderWallet,
      quoteMint: projected.quoteMint,
      side: projected.side,
      failureClassification,
    };
    expect(
      calculateEndToEndApplicationCompatibility(
        {
          followerWallet: projected.followerWallet,
          leaderWallet: projected.leaderWallet,
          quoteMint: projected.quoteMint,
        },
        [classifiedOpportunity],
        COPYABILITY_CONTEXT,
      ),
    ).toMatchObject({
      applicationSuccessCount: 0,
      terminalFailureCount: 0,
      endToEndApplicationCompatibilityRate: null,
      preconditionCount: 1,
      evaluableCount: 0,
      dataLimitationCount: 0,
      unavailableCount: 1,
      coverageRate: "0",
      status: "NO_EVALUABLE_END_TO_END_OUTCOMES",
    });
  });

  it("leaves precedence conflicts to the existing Failure Classification layer", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      `UPDATE risk_decisions
       SET decision = 'REJECT', reason_code = 'STALE_INTENT',
           approved_amount_raw = '0', approved_token_raw = '0',
           approved_quote_raw = '0'
       WHERE phase = 'PRE_QUOTE';`,
    );

    const normalizedEvidence = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    }).opportunities[0]!.normalizedEvidence;
    expect(normalizedEvidence.jupiterAttempts).toHaveLength(1);
    expect(normalizedEvidence.paperFillApplication).toEqual({
      fillId: "fill-z-open",
    });
    expect(
      classifyOpportunityFailure(normalizedEvidence, {
        definitionVersion: "OPPORTUNITY_FAILURE_V1",
      }),
    ).toMatchObject({
      classificationStatus: "UNAVAILABLE",
      reasonCode: "CONFLICTING_EVIDENCE",
    });
  });

  it("keeps observation-only exclusions and limitations out of executable opportunities", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      `INSERT INTO live_validation_events(
         id, signature, event_index, slot, leader, primary_provider,
         program_ids_json, system_classification, ground_truth_classification,
         ground_truth_source, token_mint, quote_mint, balance_deltas_json,
         classifier_evidence_json, skip_reason, capture_path, decode_error,
         is_duplicate, created_at_ms
       ) VALUES
         (
           'observation-non-swap', 'obs-transfer', 0, '10',
           '${LEADER_WALLET}', 'PRIMARY', '[]', 'TRANSFER', 'BUY',
           'HUMAN_REVIEW', NULL, NULL, '[]', '{}', 'ORDINARY_TRANSFER',
           'fixture', NULL, 0, 10000
         ),
         (
           'observation-policy', 'obs-policy', 0, '11',
           '${LEADER_WALLET}', 'PRIMARY', '[]', 'BUY', 'BUY', 'AUTO_RULE',
           '${TOKEN_MINT}', '${NATIVE_SOL}', '[]', '{}',
           'QUOTE_ASSET_NOT_ALLOWED', 'fixture', NULL, 0, 11000
         ),
         (
           'observation-unsupported', 'obs-unsupported', 0, '12',
           '${LEADER_WALLET}', 'PRIMARY', '[]', 'UNSUPPORTED', 'UNSUPPORTED',
           'AUTO_RULE', '${TOKEN_MINT}', '${NATIVE_SOL}', '[]', '{}',
           'UNSUPPORTED_TOKEN_2022', 'fixture', NULL, 0, 12000
         ),
         (
           'observation-duplicate', 'obs-duplicate', 0, '13',
           '${LEADER_WALLET}', 'PRIMARY', '[]', 'BUY', 'BUY', 'AUTO_RULE',
           '${TOKEN_MINT}', '${NATIVE_SOL}', '[]', '{}', NULL,
           'fixture', NULL, 1, 13000
         ),
         (
           'observation-no-opportunity', 'obs-no-opportunity', 0, '14',
           '${LEADER_WALLET}', 'PRIMARY', '[]', 'BUY', 'BUY', 'AUTO_RULE',
           '${TOKEN_MINT}', '${NATIVE_SOL}', '[]', '{}', NULL,
           'fixture', NULL, 0, 14000
         );
       UPDATE live_validation_events
       SET block_time_ms = 1000
       WHERE id = 'observation-non-swap';`,
    );

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });
    expect(
      snapshot.opportunities.map(({ executionKey }) => executionKey),
    ).toEqual(["exec-buy"]);
    expect(snapshot.observationExclusions).toEqual([]);
    expect(snapshot.observationLimitations.map(({ id }) => id).sort()).toEqual([
      "observation-duplicate",
      "observation-no-opportunity",
      "observation-non-swap",
      "observation-policy",
      "observation-unsupported",
    ]);
    expect(
      snapshot.observationLimitations.find(
        ({ id }) => id === "observation-non-swap",
      ),
    ).toMatchObject({
      systemClassification: "TRANSFER",
      groundTruthClassification: "BUY",
      structuredReasonCode: "ORDINARY_TRANSFER",
      limitationReason: "WINDOW_MEMBERSHIP_UNPROVEN",
    });
    expect(
      snapshot.observationLimitations.every(
        ({ limitationReason }) =>
          limitationReason === "WINDOW_MEMBERSHIP_UNPROVEN",
      ),
    ).toBe(true);
    expect(
      snapshot.observationLimitations.every(
        (evidence) => !("executionKey" in evidence),
      ),
    ).toBe(true);
  });

  it("keeps the same signature with another eventIndex out of the matched observation", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      `INSERT INTO live_validation_events(
         id, signature, event_index, slot, leader, primary_provider,
         program_ids_json, system_classification, ground_truth_classification,
         ground_truth_source, token_mint, quote_mint, balance_deltas_json,
         classifier_evidence_json, skip_reason, capture_path, is_duplicate,
         created_at_ms
       ) VALUES (
         'validation-buy-event-1', 'signature-buy', 1, '1',
         '${LEADER_WALLET}', 'PRIMARY', '[]', 'BUY', 'BUY', 'AUTO_RULE',
         '${TOKEN_MINT}', '${NATIVE_SOL}', '[]', '{}', NULL, 'fixture', 0, 1000
       );`,
    );

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });
    expect(snapshot.opportunities[0]!.observation?.id).toBe("validation-buy");
    expect(snapshot.observationLimitations.map(({ id }) => id)).toContain(
      "validation-buy-event-1",
    );
  });

  it("fails closed when PaperFill intent has no executable opportunity", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      "UPDATE paper_fills SET intent_id = 'missing-execution' WHERE id = 'fill-z-open'",
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("PAPER_FILL_WITHOUT_OPPORTUNITY:fill-z-open");
  });

  it("fails closed when observation identity differs from the leader trade", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      "UPDATE live_validation_events SET event_index = 1 WHERE id = 'validation-buy'",
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("CONFLICTING_OPPORTUNITY_OBSERVATION:exec-buy");
  });

  it.each([
    ["side", "side = 'SELL'"],
    ["token mint", `token_mint = '${NATIVE_SOL}'`],
    ["quote mint", `quote_mint = '${TOKEN_MINT}'`],
  ])(
    "fails closed when follower and leader opportunity %s conflicts",
    (_case, update) => {
      const databasePath = completeBuyOpportunityFixture();
      mutateDatabase(
        databasePath,
        `DELETE FROM paper_fill_applications;
         DELETE FROM paper_fills;
         DELETE FROM jupiter_shadow_quotes;
         DELETE FROM risk_decisions;
         UPDATE follower_trades SET ${update}
         WHERE execution_key = 'exec-buy';`,
      );

      expect(() =>
        new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
      ).toThrowError("CONFLICTING_OPPORTUNITY_IDENTITY:exec-buy");
    },
  );

  it("fails closed when a follower root binds a different leader trade", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `DELETE FROM paper_fill_applications;
       DELETE FROM paper_fills;
       DELETE FROM jupiter_shadow_quotes;
       DELETE FROM risk_decisions;
       DELETE FROM follower_trades WHERE execution_key = 'exec-sell';
       UPDATE follower_trades SET leader_trade_id = 'leader-sell'
       WHERE execution_key = 'exec-buy';`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("CONFLICTING_OPPORTUNITY_IDENTITY:exec-buy");
  });

  it("fails closed for WSOL in the executable opportunity domain bucket", () => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      `DELETE FROM paper_fill_applications;
       DELETE FROM paper_fills;
       DELETE FROM jupiter_shadow_quotes;
       DELETE FROM risk_decisions;
       UPDATE follower_trades SET quote_mint = '${WSOL_MINT}';
       UPDATE leader_trades SET quote_mint = '${WSOL_MINT}';
       UPDATE live_validation_events SET quote_mint = '${WSOL_MINT}';`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("NON_CANONICAL_DOMAIN_QUOTE_MINT:exec-buy");
  });

  it("relies on the persisted execution-key uniqueness constraint for roots", () => {
    const databasePath = completeBuyOpportunityFixture();

    expect(() =>
      mutateDatabase(
        databasePath,
        `INSERT INTO follower_trades(
           id, execution_key, leader_trade_id, follower_wallet_id, state, side,
           token_mint, quote_mint, theoretical_token_raw,
           theoretical_quote_raw, copy_ratio_bps,
           order_created_timestamp_ms, order_created_monotonic_ns,
           created_at_ms, updated_at_ms
         ) VALUES (
           'duplicate-root', 'exec-buy', 'leader-buy', 2, 'CREATED', 'BUY',
           '${TOKEN_MINT}', '${NATIVE_SOL}', '1', '1', 10000,
           1000, '1000', 1000, 1000
         );`,
      ),
    ).toThrowError(/UNIQUE constraint failed/);
  });

  it("orders opportunity roots by authoritative leader time and stable identity", () => {
    const databasePath = roundTripFixture();
    const reader = new StrategyEvaluationReadModel();

    const first = reader.readSnapshot({ databasePath }).opportunities;
    const second = reader.readSnapshot({ databasePath }).opportunities;

    expect(second).toEqual(first);
    expect(
      first.map(({ executionKey, sourceTimestamp }) => ({
        executionKey,
        sourceTimestamp,
      })),
    ).toEqual([
      {
        executionKey: "exec-buy",
        sourceTimestamp: {
          valueMs: 900,
          precision: "SECOND",
          provenance: "CHAIN_BLOCK_TIME",
        },
      },
      {
        executionKey: "exec-sell",
        sourceTimestamp: {
          valueMs: 3900,
          precision: "SECOND",
          provenance: "CHAIN_BLOCK_TIME",
        },
      },
    ]);
  });

  it("projects ordered PRE and POST Risk decisions for existing analytics", () => {
    const databasePath = roundTripFixture();

    const decisions = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    }).riskDecisions;

    expect(decisions).toEqual([
      {
        phase: "PRE_QUOTE",
        decisionId: "risk-pre-buy",
        intentId: "exec-buy",
        leaderTradeId: "leader-buy",
        leaderWallet: LEADER_WALLET,
        followerWallet: FOLLOWER_WALLET,
        side: "BUY",
        tokenMint: TOKEN_MINT,
        quoteMint: NATIVE_SOL,
        decision: "ALLOW",
        requestedAmountRaw: 9_007_199_254_740_993n,
        approvedAmountRaw: 9_007_199_254_740_993n,
        requestedTokenRaw: 10n,
        approvedTokenRaw: 10n,
        requestedQuoteRaw: 9_007_199_254_740_993n,
        approvedQuoteRaw: 9_007_199_254_740_993n,
        reasonCode: "ALLOW",
        policyVersion: "RISK_TEST_V1",
        decidedAtMs: 980,
      },
      {
        phase: "POST_QUOTE",
        decisionId: "risk-post-buy",
        intentId: "exec-buy",
        leaderTradeId: "leader-buy",
        leaderWallet: LEADER_WALLET,
        followerWallet: FOLLOWER_WALLET,
        side: "BUY",
        tokenMint: TOKEN_MINT,
        quoteMint: NATIVE_SOL,
        preDecisionId: "risk-pre-buy",
        quoteRequestId: "request-buy",
        decision: "ALLOW",
        requestedAmountRaw: 9_007_199_254_740_993n,
        approvedAmountRaw: 9_007_199_254_740_993n,
        requestedTokenRaw: 10n,
        approvedTokenRaw: 10n,
        requestedQuoteRaw: 9_007_199_254_740_993n,
        approvedQuoteRaw: 9_007_199_254_740_993n,
        reasonCode: "ALLOW",
        policyVersion: "RISK_TEST_V1",
        decidedAtMs: 1001,
      },
    ]);
    expect(
      calculatePostRiskDistribution(
        {
          followerWallet: FOLLOWER_WALLET,
          leaderWallet: LEADER_WALLET,
          quoteMint: NATIVE_SOL,
        },
        decisions,
      ),
    ).toEqual({
      followerWallet: FOLLOWER_WALLET,
      leaderWallet: LEADER_WALLET,
      quoteMint: NATIVE_SOL,
      postRiskDecisionCount: 1,
      postRiskAllowCount: 1,
      postRiskResizeCount: 0,
      postRiskRejectCount: 0,
      postRiskHaltCount: 0,
      allowRate: "1",
      resizeRate: "0",
      rejectRate: "0",
      haltRate: "0",
      status: "AVAILABLE",
    });
  });

  it.each([
    ["PRE RESIZE", "PRE_QUOTE", "RESIZE", "SINGLE_TRADE_LIMIT"],
    ["PRE REJECT", "PRE_QUOTE", "REJECT", "STALE_INTENT"],
    ["POST STALE_QUOTE", "POST_QUOTE", "REJECT", "STALE_QUOTE"],
    [
      "POST PRICE_IMPACT_TOO_HIGH",
      "POST_QUOTE",
      "REJECT",
      "PRICE_IMPACT_TOO_HIGH",
    ],
  ])(
    "faithfully projects %s without reclassifying Risk semantics",
    (_case, phase, decision, reasonCode) => {
      const databasePath = roundTripFixture();
      mutateDatabase(
        databasePath,
        `UPDATE risk_decisions
         SET decision = '${decision}', reason_code = '${reasonCode}',
             approved_amount_raw = '0', approved_token_raw = '0',
             approved_quote_raw = '0'
         WHERE phase = '${phase}' AND intent_id = 'exec-buy'`,
      );

      const projected = new StrategyEvaluationReadModel()
        .readSnapshot({ databasePath })
        .riskDecisions.find((item) => item.phase === phase);
      expect(projected).toMatchObject({
        phase,
        decision,
        reasonCode,
        approvedAmountRaw: 0n,
        approvedTokenRaw: 0n,
        approvedQuoteRaw: 0n,
      });
    },
  );

  it("projects structured optional Risk evidence without interpreting it", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE risk_decisions
       SET decision = 'RESIZE', reason_code = 'SINGLE_TRADE_LIMIT',
           relevant_limit_raw = '9007199254740995',
           relevant_evidence_json = '{"capacitySource":"policy","version":1}'
       WHERE phase = 'PRE_QUOTE' AND intent_id = 'exec-buy'`,
    );

    expect(
      new StrategyEvaluationReadModel().readSnapshot({ databasePath })
        .riskDecisions[0],
    ).toMatchObject({
      decision: "RESIZE",
      reasonCode: "SINGLE_TRADE_LIMIT",
      relevantLimitRaw: 9_007_199_254_740_995n,
      relevantEvidence: { capacitySource: "policy", version: 1 },
      policyVersion: "RISK_TEST_V1",
    });
  });

  it("allows a PRE decision without a POST decision", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      "DELETE FROM risk_decisions WHERE phase = 'POST_QUOTE'",
    );

    expect(
      new StrategyEvaluationReadModel()
        .readSnapshot({ databasePath })
        .riskDecisions.map(({ phase }) => phase),
    ).toEqual(["PRE_QUOTE"]);
  });

  it("fails closed for malformed Risk economic raw TEXT", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE risk_decisions
       SET requested_quote_raw = 'not-a-decimal-integer'
       WHERE decision_id = 'risk-pre-buy'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("MALFORMED_ECONOMIC_RAW:requested_quote_raw");
  });

  it("fails closed when Risk evidence has no follower trade", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `DELETE FROM jupiter_shadow_quotes WHERE execution_key = 'exec-buy';
       DELETE FROM follower_trades WHERE execution_key = 'exec-buy';`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("MISSING_FOLLOWER_TRADE_FOR_RISK:risk-pre-buy");
  });

  it("fails closed when Risk evidence has no leader trade", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `DELETE FROM jupiter_shadow_quotes WHERE execution_key = 'exec-buy';
       DELETE FROM leader_trades WHERE id = 'leader-buy';`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("MISSING_LEADER_TRADE_FOR_RISK:risk-pre-buy");
  });

  it("fails closed when Risk evidence has no follower wallet", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `DELETE FROM jupiter_shadow_quotes WHERE execution_key = 'exec-buy';
       DELETE FROM wallets WHERE id = 2;`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("MISSING_FOLLOWER_WALLET_FOR_RISK:risk-pre-buy");
  });

  it("fails closed when Risk evidence has no leader wallet", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `DELETE FROM jupiter_shadow_quotes WHERE execution_key = 'exec-buy';
       DELETE FROM wallets WHERE id = 1;`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("MISSING_LEADER_WALLET_FOR_RISK:risk-pre-buy");
  });

  it.each([
    ["quote mint", `quote_mint = '${TOKEN_MINT}'`],
    ["leader wallet", "leader_wallet = 'other-leader-wallet'"],
    ["follower wallet", "follower_wallet = 'other-follower-wallet'"],
    ["side", "side = 'SELL'"],
  ])("fails closed for a Risk/%s identity mismatch", (_case, update) => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE risk_decisions SET ${update} WHERE decision_id = 'risk-pre-buy'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("CONFLICTING_RISK_IDENTITY_EVIDENCE:risk-pre-buy");
  });

  it("fails closed for incomplete legacy Risk identity columns", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      "UPDATE risk_decisions SET leader_wallet = NULL WHERE decision_id = 'risk-pre-buy'",
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("MISSING_RISK_IDENTITY_EVIDENCE:risk-pre-buy");
  });

  it("fails closed for WSOL in domain Risk identity", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `DELETE FROM jupiter_shadow_quotes WHERE execution_key = 'exec-buy';
       UPDATE follower_trades SET quote_mint = '${WSOL_MINT}'
         WHERE execution_key = 'exec-buy';
       UPDATE leader_trades SET quote_mint = '${WSOL_MINT}'
         WHERE id = 'leader-buy';
       UPDATE risk_decisions SET quote_mint = '${WSOL_MINT}'
         WHERE intent_id = 'exec-buy';`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("NON_CANONICAL_DOMAIN_QUOTE_MINT:risk-pre-buy");
  });

  it("fails closed for duplicate phase and intent evidence in a corrupted database", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `ALTER TABLE risk_decisions RENAME TO corrupt_risk_decisions;
       CREATE TABLE risk_decisions AS
         SELECT * FROM corrupt_risk_decisions WHERE 0;
       INSERT INTO risk_decisions SELECT * FROM corrupt_risk_decisions;
       INSERT INTO risk_decisions
         SELECT 'risk-pre-duplicate', phase, intent_id, leader_trade_id,
                leader_wallet, follower_wallet, side, token_mint, quote_mint,
                pre_decision_id, quote_request_id, decision,
                requested_amount_raw, approved_amount_raw,
                requested_token_raw, approved_token_raw, requested_quote_raw,
                approved_quote_raw, reason_code, policy_version,
                relevant_limit_raw, relevant_evidence_json, decided_at_ms
         FROM corrupt_risk_decisions WHERE decision_id = 'risk-pre-buy';
       DROP TABLE corrupt_risk_decisions;`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("DUPLICATE_RISK_DECISION_EVIDENCE:PRE_QUOTE:exec-buy");
  });

  it("fails closed when POST points to the wrong PRE decision id", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      "UPDATE risk_decisions SET pre_decision_id = 'wrong-pre' WHERE decision_id = 'risk-post-buy'",
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("POST_RISK_PRE_DECISION_MISMATCH:risk-post-buy");
  });

  it("fails closed when POST exists without PRE", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      "DELETE FROM risk_decisions WHERE decision_id = 'risk-pre-buy'",
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("POST_RISK_WITHOUT_PRE:risk-post-buy");
  });

  it("fails closed when POST references a PRE from another execution", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE risk_decisions
       SET intent_id = 'exec-sell', leader_trade_id = 'leader-sell', side = 'SELL'
       WHERE decision_id = 'risk-pre-buy'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("POST_RISK_PRE_DECISION_CROSS_INTENT:risk-post-buy");
  });

  it("fails closed for an unsupported structured Risk reason without text recovery", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE risk_decisions
       SET reason_code = 'LEGACY_UNKNOWN_RISK_REASON'
       WHERE decision_id = 'risk-pre-buy';
       INSERT INTO execution_events(
         execution_key, sequence, type, status, details_json,
         wall_timestamp_ms, monotonic_timestamp_ns
       ) VALUES (
         'exec-buy', 99, 'RISK_TEXT_HINT', 'INFO',
         '{"reasonCode":"ALLOW"}', 1002, '1002'
       );`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError(
      "UNSUPPORTED_RISK_REASON_CODE:risk-pre-buy:LEGACY_UNKNOWN_RISK_REASON",
    );
  });

  it("uses structured Risk reason instead of conflicting free text", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `INSERT INTO execution_events(
         execution_key, sequence, type, status, details_json,
         wall_timestamp_ms, monotonic_timestamp_ns
       ) VALUES (
         'exec-buy', 99, 'RISK_TEXT_HINT', 'INFO',
         '{"reasonCode":"PRICE_IMPACT_TOO_HIGH"}', 1002, '1002'
       );`,
    );

    expect(
      new StrategyEvaluationReadModel()
        .readSnapshot({ databasePath })
        .riskDecisions.map(({ reasonCode }) => reasonCode),
    ).toEqual(["ALLOW", "ALLOW"]);
  });

  it("orders multiple Risk identities deterministically with PRE before POST", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `INSERT INTO risk_decisions(
         decision_id, phase, intent_id, leader_trade_id, leader_wallet,
         follower_wallet, side, token_mint, quote_mint, decision,
         requested_amount_raw, approved_amount_raw, requested_token_raw,
         approved_token_raw, requested_quote_raw, approved_quote_raw,
         reason_code, policy_version, relevant_evidence_json, decided_at_ms
       ) VALUES (
         'risk-pre-sell', 'PRE_QUOTE', 'exec-sell', 'leader-sell',
         '${LEADER_WALLET}', '${FOLLOWER_WALLET}', 'SELL', '${TOKEN_MINT}',
         '${NATIVE_SOL}', 'REJECT', '10', '0', '10', '0',
         '9007199254741020', '0', 'SELL_NOT_RISK_REDUCING',
         'RISK_TEST_V1', '{}', 3900
       );`,
    );
    const reader = new StrategyEvaluationReadModel();

    const first = reader.readSnapshot({ databasePath }).riskDecisions;
    const second = reader.readSnapshot({ databasePath }).riskDecisions;

    expect(second).toEqual(first);
    expect(
      first.map(({ intentId, phase, decisionId }) => ({
        intentId,
        phase,
        decisionId,
      })),
    ).toEqual([
      {
        intentId: "exec-buy",
        phase: "PRE_QUOTE",
        decisionId: "risk-pre-buy",
      },
      {
        intentId: "exec-buy",
        phase: "POST_QUOTE",
        decisionId: "risk-post-buy",
      },
      {
        intentId: "exec-sell",
        phase: "PRE_QUOTE",
        decisionId: "risk-pre-sell",
      },
    ]);
  });

  it("projects follower-scoped Jupiter evidence for existing Execution Quality", () => {
    const databasePath = roundTripFixture();

    const attempts = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    }).jupiterAttempts;

    expect(attempts).toEqual([
      {
        validationEventId: "validation-buy",
        executionKey: "exec-buy",
        followerWallet: FOLLOWER_WALLET,
        leaderWallet: LEADER_WALLET,
        quoteMint: NATIVE_SOL,
        httpStatus: 200,
        schemaValid: true,
        expectedOutputRaw: 10n,
        route: [{ swapInfo: { label: "Raydium" } }],
      },
    ]);
    expect(
      calculateJupiterSuccessRate(
        {
          followerWallet: FOLLOWER_WALLET,
          leaderWallet: LEADER_WALLET,
          quoteMint: NATIVE_SOL,
        },
        attempts,
      ),
    ).toEqual({
      followerWallet: FOLLOWER_WALLET,
      leaderWallet: LEADER_WALLET,
      quoteMint: NATIVE_SOL,
      attemptCount: 1,
      successCount: 1,
      successRate: "1",
      status: "AVAILABLE",
    });
  });

  it("fails closed when Jupiter evidence has no follower trade", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      "DELETE FROM follower_trades WHERE execution_key = 'exec-buy'",
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("MISSING_FOLLOWER_TRADE_FOR_JUPITER:exec-buy");
  });

  it.each([
    ["429", "http_status = 429", { httpStatus: 429 }],
    ["5xx", "http_status = 503", { httpStatus: 503 }],
    ["null HTTP status", "http_status = NULL", { httpStatus: null }],
    ["schema invalid", "schema_valid = 0", { schemaValid: false }],
  ])("faithfully projects a %s Jupiter outcome", (_case, update, expected) => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE jupiter_shadow_quotes SET ${update} WHERE execution_key = 'exec-buy'`,
    );

    expect(
      new StrategyEvaluationReadModel().readSnapshot({ databasePath })
        .jupiterAttempts[0],
    ).toMatchObject(expected);
  });

  it("fails closed for malformed Jupiter expected output raw TEXT", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE jupiter_shadow_quotes
       SET expected_output_raw = 'not-a-decimal-integer'
       WHERE execution_key = 'exec-buy'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("MALFORMED_ECONOMIC_RAW:expected_output_raw");
  });

  it("fails closed for malformed Jupiter route JSON", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE jupiter_shadow_quotes
       SET route_json = '{malformed'
       WHERE execution_key = 'exec-buy'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("MALFORMED_JUPITER_ROUTE_JSON:exec-buy");
  });

  it("fails closed when Jupiter evidence has no leader trade", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      "DELETE FROM leader_trades WHERE id = 'leader-buy'",
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("MISSING_LEADER_TRADE_FOR_JUPITER:exec-buy");
  });

  it("fails closed when Jupiter evidence has no follower wallet", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(databasePath, "DELETE FROM wallets WHERE id = 2");

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("MISSING_FOLLOWER_WALLET_FOR_JUPITER:exec-buy");
  });

  it("fails closed when Jupiter evidence has no leader wallet", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(databasePath, "DELETE FROM wallets WHERE id = 1");

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("MISSING_LEADER_WALLET_FOR_JUPITER:exec-buy");
  });

  it("fails closed when follower and leader quote mints conflict", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE follower_trades
       SET quote_mint = '${TOKEN_MINT}'
       WHERE execution_key = 'exec-buy'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("CONFLICTING_JUPITER_JOIN_EVIDENCE:exec-buy");
  });

  it("preserves follower and leader isolation with deterministic ordering", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `INSERT INTO wallets(
         id, address, role, enabled, copy_ratio_bps, created_at_ms, updated_at_ms
       ) VALUES
         (3, 'z-follower-wallet', 'FOLLOWER', 1, 10000, 1, 1),
         (4, 'z-leader-wallet', 'LEADER', 1, 10000, 1, 1);

       INSERT INTO leader_trades(
         id, leader_wallet_id, signature, event_index, slot, side,
         token_mint, quote_mint, token_raw, quote_raw, leader_pre_token_raw,
         source_timestamp_ms, source_timestamp_precision,
         source_timestamp_provenance, stream_received_timestamp_ms,
         detected_timestamp_ms, decoded_timestamp_ms,
         stream_received_monotonic_ns, detected_monotonic_ns,
         decoded_monotonic_ns, evidence_json, created_at_ms
       ) VALUES (
         'leader-other', 4, 'signature-other-leader', 0, '3', 'BUY',
         '${TOKEN_MINT}', '${NATIVE_SOL}', '10', '20', '0',
         5000, 'SECOND', 'CHAIN_BLOCK_TIME', 5000, 5001, 5002,
         '5000', '5001', '5002', '[]', 5002
       );

       INSERT INTO follower_trades(
         id, execution_key, leader_trade_id, follower_wallet_id, state, side,
         token_mint, quote_mint, theoretical_token_raw, theoretical_quote_raw,
         copy_ratio_bps, order_created_timestamp_ms, order_created_monotonic_ns,
         created_at_ms, updated_at_ms
       ) VALUES
         (
           'exec-other-follower', 'exec-other-follower', 'leader-buy', 3,
           'CREATED', 'BUY', '${TOKEN_MINT}', '${NATIVE_SOL}', '10', '20',
           10000, 5000, '5000', 5000, 5000
         ),
         (
           'exec-other-leader', 'exec-other-leader', 'leader-other', 2,
           'CREATED', 'BUY', '${TOKEN_MINT}', '${NATIVE_SOL}', '10', '20',
           10000, 5000, '5000', 5000, 5000
         );

       INSERT INTO outbox(
         event_key, aggregate_type, aggregate_id, event_type, payload_json,
         status, attempts, available_at_ms, created_at_ms
       ) VALUES
         (
           'exec-other-follower:reserved', 'EXECUTION',
           'exec-other-follower', 'INTENT_RESERVED',
           '{"executionKey":"exec-other-follower","mode":"PAPER"}',
           'PENDING', 0, 5000, 5000
         ),
         (
           'exec-other-leader:reserved', 'EXECUTION', 'exec-other-leader',
           'INTENT_RESERVED',
           '{"executionKey":"exec-other-leader","mode":"PAPER"}',
           'PENDING', 0, 5000, 5000
         );

       INSERT INTO live_validation_events(
         id, signature, event_index, slot, leader, primary_provider,
         program_ids_json, system_classification, ground_truth_classification,
         ground_truth_source, token_mint, quote_mint, balance_deltas_json,
         classifier_evidence_json,
         capture_path, is_duplicate, created_at_ms
       ) VALUES
         (
           'validation-other-follower', 'signature-other-follower', 0, '4',
           '${LEADER_WALLET}', 'PRIMARY', '[]', 'BUY', 'BUY', 'AUTO_RULE',
           '${TOKEN_MINT}', '${NATIVE_SOL}', '[]', '{}', 'fixture', 0, 5000
         ),
         (
           'validation-other-leader', 'signature-other-leader', 0, '3',
           'z-leader-wallet', 'PRIMARY', '[]', 'BUY', 'BUY', 'AUTO_RULE',
           '${TOKEN_MINT}', '${NATIVE_SOL}', '[]', '{}', 'fixture', 0, 5000
         );

       INSERT INTO jupiter_shadow_quotes(
         validation_event_id, execution_key, request_timestamp_ms,
         response_timestamp_ms, request_monotonic_ns, response_monotonic_ns,
         http_status, schema_valid, input_mint, output_mint, input_raw,
         expected_output_raw, router, route_json, created_at_ms
       ) VALUES
         (
           'validation-buy', 'exec-other-follower', 5000, 5010,
           '5000', '5010', 429, 0, '${NATIVE_SOL}', '${TOKEN_MINT}',
           '20', NULL, NULL, NULL, 5010
         ),
         (
           'validation-other-leader', 'exec-other-leader', 5000, 5010,
           '5000', '5010', 503, 0, '${NATIVE_SOL}', '${TOKEN_MINT}',
           '20', NULL, NULL, NULL, 5010
         );`,
    );

    const reader = new StrategyEvaluationReadModel();
    const first = reader.readSnapshot({ databasePath }).jupiterAttempts;
    const second = reader.readSnapshot({ databasePath }).jupiterAttempts;

    expect(second).toEqual(first);
    expect(
      first.map(
        ({ executionKey, followerWallet, leaderWallet, quoteMint }) => ({
          executionKey,
          followerWallet,
          leaderWallet,
          quoteMint,
        }),
      ),
    ).toEqual([
      {
        executionKey: "exec-buy",
        followerWallet: FOLLOWER_WALLET,
        leaderWallet: LEADER_WALLET,
        quoteMint: NATIVE_SOL,
      },
      {
        executionKey: "exec-other-leader",
        followerWallet: FOLLOWER_WALLET,
        leaderWallet: "z-leader-wallet",
        quoteMint: NATIVE_SOL,
      },
      {
        executionKey: "exec-other-follower",
        followerWallet: "z-follower-wallet",
        leaderWallet: LEADER_WALLET,
        quoteMint: NATIVE_SOL,
      },
    ]);
  });

  it("fails closed when Jupiter side evidence uses WSOL for domain SOL", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE jupiter_shadow_quotes
       SET input_mint = '${WSOL_MINT}'
       WHERE execution_key = 'exec-buy'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("JUPITER_SIDE_EVIDENCE_MISMATCH:exec-buy");
  });

  it("fails closed for conflicting side join evidence", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      "UPDATE leader_trades SET side = 'SELL' WHERE id = 'leader-buy'",
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("CONFLICTING_JUPITER_JOIN_EVIDENCE:exec-buy");
  });

  it("relies on the persisted execution-key uniqueness constraint", () => {
    const databasePath = roundTripFixture();

    expect(() =>
      mutateDatabase(
        databasePath,
        `INSERT INTO jupiter_shadow_quotes(
           validation_event_id, execution_key, request_timestamp_ms,
           request_monotonic_ns, schema_valid, input_mint, output_mint,
           input_raw, created_at_ms
         ) VALUES (
           'validation-buy', 'exec-buy', 2000, '2000', 0,
           '${NATIVE_SOL}', '${TOKEN_MINT}', '1', 2000
         )`,
      ),
    ).toThrowError(
      /UNIQUE constraint failed: jupiter_shadow_quotes.execution_key/,
    );
  });

  it("fails closed for duplicate Jupiter execution evidence in a corrupted database", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `ALTER TABLE jupiter_shadow_quotes RENAME TO corrupt_jupiter_shadow_quotes;
       CREATE TABLE jupiter_shadow_quotes AS
         SELECT * FROM corrupt_jupiter_shadow_quotes WHERE 0;
       INSERT INTO jupiter_shadow_quotes
         SELECT * FROM corrupt_jupiter_shadow_quotes;
       INSERT INTO jupiter_shadow_quotes
         SELECT id + 100, validation_event_id, execution_key,
                request_timestamp_ms, response_timestamp_ms,
                request_monotonic_ns, response_monotonic_ns, http_status,
                schema_valid, input_mint, output_mint, input_raw,
                expected_output_raw, router, route_json, price_impact_pct,
                quote_age_ms, rtt_ms, source_price, expected_execution_price,
                theoretical_price_difference_pct,
                adverse_price_difference_pct, provider, dex, token_mint,
                leader, observed_hour, 'conflicting duplicate', created_at_ms
         FROM corrupt_jupiter_shadow_quotes;
       DROP TABLE corrupt_jupiter_shadow_quotes;`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("DUPLICATE_JUPITER_EXECUTION_EVIDENCE:exec-buy");
  });

  it("does not parse failure_reason into structured Jupiter evidence", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE jupiter_shadow_quotes
       SET failure_reason = 'HTTP 429 route invalid outAmount=0'
       WHERE execution_key = 'exec-buy'`,
    );

    const attempts = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    }).jupiterAttempts;
    expect(attempts).toEqual([
      {
        validationEventId: "validation-buy",
        executionKey: "exec-buy",
        followerWallet: FOLLOWER_WALLET,
        leaderWallet: LEADER_WALLET,
        quoteMint: NATIVE_SOL,
        httpStatus: 200,
        schemaValid: true,
        expectedOutputRaw: 10n,
        route: [{ swapInfo: { label: "Raydium" } }],
      },
    ]);
    expect(
      calculateJupiterSuccessRate(
        {
          followerWallet: FOLLOWER_WALLET,
          leaderWallet: LEADER_WALLET,
          quoteMint: NATIVE_SOL,
        },
        attempts,
      ).successCount,
    ).toBe(1);
  });

  it("projects ordered OPEN and CLOSE application evidence from an existing database", () => {
    const databasePath = roundTripFixture();

    expect(
      new StrategyEvaluationReadModel().readSnapshot({ databasePath })
        .roundTripApplications,
    ).toEqual([
      {
        fillId: "fill-z-open",
        positionId: 10,
        followerWallet: FOLLOWER_WALLET,
        leaderWallet: LEADER_WALLET,
        tokenMint: TOKEN_MINT,
        quoteMint: NATIVE_SOL,
        side: "BUY",
        transition: "OPEN",
        inputAmountRaw: 9_007_199_254_740_993n,
        outputAmountRaw: 10n,
        quantityBeforeRaw: 0n,
        quantityAfterRaw: 10n,
        allocatedCostBasisRaw: 0n,
        proceedsRaw: 0n,
        realizedPnlDeltaRaw: 0n,
        positionVersionAfter: 1,
        quoteTimestampMs: 1_000,
      },
      {
        fillId: "fill-a-close",
        positionId: 10,
        followerWallet: FOLLOWER_WALLET,
        leaderWallet: LEADER_WALLET,
        tokenMint: TOKEN_MINT,
        quoteMint: NATIVE_SOL,
        side: "SELL",
        transition: "CLOSE",
        inputAmountRaw: 10n,
        outputAmountRaw: 9_007_199_254_741_020n,
        quantityBeforeRaw: 10n,
        quantityAfterRaw: 0n,
        allocatedCostBasisRaw: 9_007_199_254_740_993n,
        proceedsRaw: 9_007_199_254_741_020n,
        realizedPnlDeltaRaw: 27n,
        positionVersionAfter: 2,
        quoteTimestampMs: 4_000,
      },
    ]);
  });

  it("projects independent PaperFill and application outcome evidence", () => {
    const databasePath = roundTripFixture();
    const reader = new StrategyEvaluationReadModel();
    const snapshot = reader.readSnapshot({
      databasePath,
    });

    expect(snapshot.paperFills).toEqual([
      {
        id: "fill-z-open",
        intentId: "exec-buy",
        leaderWallet: LEADER_WALLET,
        followerWallet: FOLLOWER_WALLET,
        side: "BUY",
        inputMint: NATIVE_SOL,
        outputMint: TOKEN_MINT,
        feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
        provider: "JUPITER_SWAP_V2_ORDER",
        fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
      },
      {
        id: "fill-a-close",
        intentId: "exec-sell",
        leaderWallet: LEADER_WALLET,
        followerWallet: FOLLOWER_WALLET,
        side: "SELL",
        inputMint: TOKEN_MINT,
        outputMint: NATIVE_SOL,
        feeEvidence: { status: "AMOUNT_UNAVAILABLE" },
        provider: "JUPITER_SWAP_V2_ORDER",
        fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
      },
    ]);
    expect(snapshot.paperFillApplications).toEqual([
      {
        fillId: "fill-z-open",
        positionId: 10,
        transition: "OPEN",
        positionVersionAfter: 1,
        appliedAtMs: 1_000,
      },
      {
        fillId: "fill-a-close",
        positionId: 10,
        transition: "CLOSE",
        positionVersionAfter: 2,
        appliedAtMs: 4_000,
      },
    ]);
    expect(
      calculatePaperFillOutcome(
        { leaderWallet: LEADER_WALLET, quoteMint: NATIVE_SOL },
        snapshot.paperFills,
        snapshot.paperFillApplications,
      ),
    ).toEqual({
      leaderWallet: LEADER_WALLET,
      quoteMint: NATIVE_SOL,
      paperFillCount: 2,
      paperFillApplicationCount: 2,
      paperFillApplicationRate: "1",
      status: "AVAILABLE",
    });
    const repeated = reader.readSnapshot({ databasePath });
    expect(repeated.paperFills).toEqual(snapshot.paperFills);
    expect(repeated.paperFillApplications).toEqual(
      snapshot.paperFillApplications,
    );
  });

  it("projects production-like unavailable fee evidence for cost completeness", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE paper_fills
       SET fee_bps = 0, fee_mint = '${NATIVE_SOL}'
       WHERE id = 'fill-z-open'`,
    );
    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });

    expect(evaluatePaperFillCostCompleteness(snapshot.paperFills[0]!)).toEqual({
      definitionVersion: "COST_COMPLETENESS_V1",
      status: "COST_INCOMPLETE",
      reasons: ["FEE_AMOUNT_UNAVAILABLE"],
      reference: { fillId: "fill-z-open" },
    });
  });

  it("projects available fee evidence with exact bigint raw amount", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE paper_fills
       SET fee_evidence_status = 'AVAILABLE',
           fee_evidence_contract_id = 'FEE_EVIDENCE_CONTRACT_V1',
           fee_bps = 5,
           fee_mint = '${NATIVE_SOL}',
           fee_amount_raw = '9223372036854775807'
       WHERE id = 'fill-z-open'`,
    );

    const fill = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    }).paperFills[0]!;
    expect(fill).toMatchObject({
      followerWallet: FOLLOWER_WALLET,
      feeEvidence: {
        status: "AVAILABLE",
        feeEvidenceContractId: "FEE_EVIDENCE_CONTRACT_V1",
        feeBps: 5,
        feeMint: NATIVE_SOL,
        feeAmountRaw: 9_223_372_036_854_775_807n,
      },
      provider: "JUPITER_SWAP_V2_ORDER",
      fillPolicyVersion: "JUPITER_ORDER_QUOTE_AS_FILL_V1",
    });
    expect(evaluatePaperFillCostCompleteness(fill).status).toBe(
      "COST_COMPLETE",
    );
  });

  it("fails closed for an invalid persisted fee evidence status", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `PRAGMA ignore_check_constraints = ON;
       UPDATE paper_fills
       SET fee_evidence_status = 'UNKNOWN'
       WHERE id = 'fill-z-open'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("INVALID_FEE_EVIDENCE_STATUS:fill-z-open");
  });

  it.each([
    ["leader trade", "leader_trade_id = 'missing-leader-trade'"],
    ["follower wallet", "follower_wallet = 'other-follower-wallet'"],
    ["leader wallet", "leader_wallet = 'other-leader-wallet'"],
    ["side", "side = 'SELL'"],
    ["token mint", `output_mint = '${NATIVE_SOL}'`],
    ["quote mint", `input_mint = '${TOKEN_MINT}'`],
  ])("fails closed for a PaperFill %s mismatch", (_case, update) => {
    const databasePath = completeBuyOpportunityFixture();
    mutateDatabase(
      databasePath,
      `UPDATE paper_fills SET ${update} WHERE id = 'fill-z-open'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("CONFLICTING_OPPORTUNITY_PAPER_FILL:exec-buy");
  });

  it("relies on persisted PaperFill intent uniqueness", () => {
    const databasePath = completeBuyOpportunityFixture();

    expect(() =>
      mutateDatabase(
        databasePath,
        `INSERT INTO paper_fills(
           id, intent_id, leader_trade_id, leader_tx_signature, leader_wallet,
           follower_wallet, side, input_mint, output_mint, token_decimals,
           quote_decimals, input_amount_raw, output_amount_raw,
           quote_request_timestamp_ms, quote_timestamp_ms, quote_rtt_ms,
           fee_evidence_status, provider, request_id, fill_policy_version,
           created_at_ms
         )
         SELECT
           'fill-duplicate', intent_id, leader_trade_id, leader_tx_signature,
           leader_wallet, follower_wallet, side, input_mint, output_mint,
           token_decimals, quote_decimals, input_amount_raw, output_amount_raw,
           quote_request_timestamp_ms, quote_timestamp_ms, quote_rtt_ms,
           fee_evidence_status, provider, request_id, fill_policy_version,
           created_at_ms
         FROM paper_fills WHERE id = 'fill-z-open'`,
      ),
    ).toThrowError(/UNIQUE constraint failed/);
  });

  it("relies on persisted PaperFillApplication fill identity uniqueness", () => {
    const databasePath = completeBuyOpportunityFixture();

    expect(() =>
      mutateDatabase(
        databasePath,
        `INSERT INTO paper_fill_applications(
           fill_id, position_id, transition, quantity_before_raw,
           quantity_after_raw, total_cost_before_raw, total_cost_after_raw,
           allocated_cost_basis_raw, proceeds_raw, realized_pnl_delta_raw,
           realized_pnl_after_raw, position_version_after, applied_at_ms
         )
         SELECT
           fill_id, position_id, transition, quantity_before_raw,
           quantity_after_raw, total_cost_before_raw, total_cost_after_raw,
           allocated_cost_basis_raw, proceeds_raw, realized_pnl_delta_raw,
           realized_pnl_after_raw, position_version_after, applied_at_ms
         FROM paper_fill_applications WHERE fill_id = 'fill-z-open'`,
      ),
    ).toThrowError(/UNIQUE constraint failed/);
  });

  it("fails closed for an application whose PaperFill is missing", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `INSERT INTO paper_fill_applications(
         fill_id, position_id, transition, quantity_before_raw,
         quantity_after_raw, total_cost_before_raw, total_cost_after_raw,
         allocated_cost_basis_raw, proceeds_raw, realized_pnl_delta_raw,
         realized_pnl_after_raw, position_version_after, applied_at_ms
       ) VALUES (
         'orphan-fill', 10, 'CLOSE', '10', '0', '10', '0',
         '10', '11', '1', '1', 3, 5000
       )`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("ORPHAN_PAPER_FILL_APPLICATION_EVIDENCE:orphan-fill");
  });

  it("does not synthesize an application for a PaperFill without one", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      "DELETE FROM paper_fill_applications WHERE fill_id = 'fill-z-open'",
    );

    const snapshot = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    });
    expect(snapshot.roundTripApplications.map(({ fillId }) => fillId)).toEqual([
      "fill-a-close",
    ]);
    expect(snapshot.paperFills.map(({ id }) => id)).toEqual([
      "fill-z-open",
      "fill-a-close",
    ]);
    expect(snapshot.paperFillApplications.map(({ fillId }) => fillId)).toEqual([
      "fill-a-close",
    ]);
    expect(
      calculatePaperFillOutcome(
        { leaderWallet: LEADER_WALLET, quoteMint: NATIVE_SOL },
        snapshot.paperFills,
        snapshot.paperFillApplications,
      ),
    ).toMatchObject({
      paperFillCount: 2,
      paperFillApplicationCount: 1,
      paperFillApplicationRate: "0.5",
    });
  });

  it("fails closed when a domain PaperFill contains WSOL identity", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE paper_fills
       SET input_mint = '${WSOL_MINT}'
       WHERE id = 'fill-z-open'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("NON_CANONICAL_DOMAIN_QUOTE_MINT:fill-z-open");
  });

  it("fails closed for malformed economic raw TEXT", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE paper_fills
       SET input_amount_raw = 'not-a-decimal-integer'
       WHERE id = 'fill-z-open'`,
    );

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("MALFORMED_ECONOMIC_RAW:input_amount_raw");
  });

  it.each(["not-a-decimal-integer", "-1"])(
    "fails closed for malformed fee amount raw TEXT %s",
    (feeAmountRaw) => {
      const databasePath = roundTripFixture();
      mutateDatabase(
        databasePath,
        `UPDATE paper_fills
         SET fee_amount_raw = '${feeAmountRaw}'
         WHERE id = 'fill-z-open'`,
      );

      expect(() =>
        new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
      ).toThrowError("MALFORMED_ECONOMIC_RAW:fee_amount_raw");
    },
  );

  it("projects a position-version gap without repairing lifecycle evidence", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE paper_fill_applications
       SET position_version_after = 3
       WHERE fill_id = 'fill-a-close'`,
    );

    const applications = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    }).roundTripApplications;
    expect(
      applications.map(({ positionVersionAfter }) => positionVersionAfter),
    ).toEqual([1, 3]);
    expect(matchFollowerRoundTrips(applications).completed).toEqual([]);
  });

  it("keeps lifecycle matching outside the Reader projection", () => {
    const databasePath = roundTripFixture();
    const applications = new StrategyEvaluationReadModel().readSnapshot({
      databasePath,
    }).roundTripApplications;

    expect(applications.map(({ positionId }) => positionId)).toEqual([10, 10]);
    const detailed = matchFollowerRoundTripsDetailed(applications);
    expect(detailed.limitations).toEqual([]);

    expect(matchFollowerRoundTrips(applications)).toEqual({
      completed: detailed.completed,
      incomplete: detailed.incomplete,
    });
    expect(detailed.completed).toEqual([
      {
        followerWallet: FOLLOWER_WALLET,
        leaderWallet: LEADER_WALLET,
        tokenMint: TOKEN_MINT,
        quoteMint: NATIVE_SOL,
        openFillId: "fill-z-open",
        closeFillId: "fill-a-close",
        fillIds: ["fill-z-open", "fill-a-close"],
        entryCostQuoteRaw: 9_007_199_254_740_993n,
        proceedsQuoteRaw: 9_007_199_254_741_020n,
        realizedPnlQuoteRaw: 27n,
        openedAtMs: 1_000,
        closedAtMs: 4_000,
        holdingTimeMs: 3_000,
      },
    ]);
  });

  it("fails fast for missing, empty, and directory database paths", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "strategy-path-"));
    const nonexistent = resolve(directory, "nonexistent.sqlite");
    const missingParent = resolve(directory, "missing-parent");
    const nestedNonexistent = resolve(missingParent, "nonexistent.sqlite");
    const reader = new StrategyEvaluationReadModel();

    expect(() =>
      reader.readSnapshot(
        {} as Parameters<StrategyEvaluationReadModel["readSnapshot"]>[0],
      ),
    ).toThrowError("DATABASE_PATH_REQUIRED");
    expect(() => reader.readSnapshot({ databasePath: "" })).toThrowError(
      "DATABASE_PATH_REQUIRED",
    );
    expect(() => reader.readSnapshot({ databasePath: directory })).toThrowError(
      "DATABASE_PATH_NOT_FILE",
    );
    expect(() =>
      reader.readSnapshot({ databasePath: nonexistent }),
    ).toThrowError("DATABASE_NOT_FOUND");
    expect(() =>
      reader.readSnapshot({ databasePath: nestedNonexistent }),
    ).toThrowError("DATABASE_NOT_FOUND");
    expect(existsSync(nonexistent)).toBe(false);
    expect(existsSync(missingParent)).toBe(false);
  });

  it("uses a connection that rejects INSERT, UPDATE, and DELETE", () => {
    const databasePath = roundTripFixture();
    const database = new SqliteDatabase({
      path: databasePath,
      migrationsDirectory: "",
      readOnly: true,
    });
    try {
      expect(database.sqlite.readonly).toBe(true);
      expect(database.sqlite.pragma("query_only", { simple: true })).toBe(1);
      expect(
        sqliteErrorCode(() =>
          database.sqlite
            .prepare(
              `INSERT INTO schema_migrations(version, checksum, applied_at_ms)
               VALUES ('write-probe', 'write-probe', 0)`,
            )
            .run(),
        ),
      ).toBe("SQLITE_READONLY");
      expect(
        sqliteErrorCode(() =>
          database.sqlite
            .prepare(
              "UPDATE paper_fills SET provider = 'write-probe' WHERE id = 'fill-z-open'",
            )
            .run(),
        ),
      ).toBe("SQLITE_READONLY");
      expect(
        sqliteErrorCode(() =>
          database.sqlite.prepare("DELETE FROM paper_fill_applications").run(),
        ),
      ).toBe("SQLITE_READONLY");
    } finally {
      database.close();
    }
  });

  it("is deterministic and performs no application write or checkpoint", () => {
    const databasePath = roundTripFixture();
    const walPath = `${databasePath}-wal`;
    const shmPath = `${databasePath}-shm`;
    expect(existsSync(walPath)).toBe(false);
    expect(existsSync(shmPath)).toBe(false);
    const mainFileBefore = statSync(databasePath, { bigint: true });
    const before = persistedEvidence(databasePath);
    const reader = new StrategyEvaluationReadModel();

    const first = reader.readSnapshot({ databasePath });
    const second = reader.readSnapshot({ databasePath });

    expect(second).toEqual(first);
    expect(persistedEvidence(databasePath)).toEqual(before);
    const mainFileAfter = statSync(databasePath, { bigint: true });
    expect(mainFileAfter.size).toBe(mainFileBefore.size);
    expect(mainFileAfter.mtimeNs).toBe(mainFileBefore.mtimeNs);
    if (existsSync(walPath)) {
      expect(statSync(walPath).size).toBe(0);
    }
  });

  it("rejects an incompatible migration set without repairing it", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      "DELETE FROM schema_migrations WHERE version = '0006_risk_authorization_hardening.sql'",
    );
    const before = persistedEvidence(databasePath).migrations;

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("STRATEGY_EVALUATION_SCHEMA_INCOMPATIBLE");
    expect(persistedEvidence(databasePath).migrations).toEqual(before);
  });

  it("rejects an incompatible migration checksum without repairing it", () => {
    const databasePath = roundTripFixture();
    mutateDatabase(
      databasePath,
      `UPDATE schema_migrations
       SET checksum = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
       WHERE version = '0006_risk_authorization_hardening.sql'`,
    );
    const before = persistedEvidence(databasePath).migrations;

    expect(() =>
      new StrategyEvaluationReadModel().readSnapshot({ databasePath }),
    ).toThrowError("STRATEGY_EVALUATION_SCHEMA_INCOMPATIBLE");
    expect(persistedEvidence(databasePath).migrations).toEqual(before);
  });
});
