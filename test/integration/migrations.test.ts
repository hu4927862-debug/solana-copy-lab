import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDatabase } from "../../src/persistence/database.js";
import { testStore } from "../helpers/database.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const REQUIRED_TABLES = [
  "wallets",
  "leader_trades",
  "follower_trades",
  "leader_positions",
  "follower_positions",
  "tokens",
  "execution_events",
  "system_events",
  "stream_checkpoints",
  "stream_pending_deliveries",
  "schema_migrations",
  "outbox",
  "provider_receipts",
  "provider_event_comparisons",
  "stream_health_events",
  "live_validation_events",
  "review_queue",
  "live_latency_samples",
  "jupiter_shadow_quotes",
  "paper_fills",
  "paper_fill_applications",
  "risk_decisions",
  "risk_state",
  "risk_global_state",
  "risk_buy_reservations",
  "risk_provider_health",
  "soak_metrics",
  "recovery_validation_runs",
  "leader_research_evidence",
  "leader_research_account_balances",
  "leader_research_instructions",
  "execution_realism_delayed_quotes",
];

describe("SQLite migrations", () => {
  it("creates the complete schema and required safety pragmas", () => {
    const { database } = testStore("migration-");
    try {
      const tables = database.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);
      for (const table of REQUIRED_TABLES) expect(tables).toContain(table);
      expect(database.sqlite.pragma("journal_mode", { simple: true })).toBe(
        "wal",
      );
      expect(database.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.sqlite.pragma("busy_timeout", { simple: true })).toBe(
        5_000,
      );
      expect(
        database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
          .get(),
      ).toEqual({ count: 11 });
      expect(
        database.sqlite
          .prepare(
            `SELECT type, "notnull" AS is_not_null, dflt_value
             FROM pragma_table_info('paper_fills')
             WHERE name = 'fee_evidence_contract_id'`,
          )
          .get(),
      ).toEqual({ type: "TEXT", is_not_null: 0, dflt_value: null });
      expect(
        database.sqlite
          .prepare(
            `SELECT type, "notnull" AS is_not_null
             FROM pragma_table_info('leader_trades')
             WHERE name = 'source_timestamp_provenance'`,
          )
          .get(),
      ).toEqual({ type: "TEXT", is_not_null: 1 });
    } finally {
      database.close();
    }
  });

  it("is idempotent and rejects a modified applied migration", () => {
    const first = testStore("migration-idempotent-");
    const path = first.path;
    first.database.close();
    const second = new SqliteDatabase({
      path,
      migrationsDirectory: new URL("../../migrations", import.meta.url)
        .pathname,
    });
    expect(
      second.sqlite
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toEqual({ count: 11 });
    second.close();
  });

  it("adds nullable fee provenance without backfilling 255 legacy fills", () => {
    const directory = mkdtempSync(
      resolve(tmpdir(), "fee-provenance-migration-"),
    );
    const legacyMigrations = resolve(directory, "legacy-migrations");
    const databasePath = resolve(directory, "legacy.sqlite");
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
        resolve(projectRoot, "migrations", file),
        resolve(legacyMigrations, file),
      );
    }

    const legacy = new SqliteDatabase({
      path: databasePath,
      migrationsDirectory: legacyMigrations,
    });
    legacy.sqlite.pragma("foreign_keys = OFF");
    const insert = legacy.sqlite.prepare(`
      INSERT INTO paper_fills(
        id, intent_id, leader_trade_id, leader_tx_signature, leader_wallet,
        follower_wallet, side, input_mint, output_mint, token_decimals,
        quote_decimals, input_amount_raw, output_amount_raw,
        quote_request_timestamp_ms, quote_timestamp_ms, quote_rtt_ms,
        fee_evidence_status, fee_bps, fee_mint, fee_amount_raw,
        provider, request_id, fill_policy_version, created_at_ms
      ) VALUES (?, ?, ?, ?, 'leader', 'follower', 'BUY', 'SOL_NATIVE',
                'token', 6, 9, '100', '50', 1, 2, 1,
                'AMOUNT_UNAVAILABLE', 5, 'SOL_NATIVE', NULL,
                'JUPITER_SWAP_V2_ORDER', ?,
                'JUPITER_ORDER_QUOTE_AS_FILL_V1', 2)
    `);
    legacy.sqlite.transaction(() => {
      for (let index = 0; index < 255; index += 1) {
        insert.run(
          `fill-${index}`,
          `intent-${index}`,
          `leader-trade-${index}`,
          `signature-${index}`,
          `request-${index}`,
        );
      }
    })();
    const before = legacy.sqlite
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(fee_evidence_status = 'AMOUNT_UNAVAILABLE') AS unavailable,
                SUM(fee_evidence_status = 'AVAILABLE') AS available,
                SUM(fee_amount_raw IS NOT NULL) AS fee_amount_present,
                SUM(CAST(input_amount_raw AS INTEGER)) AS input_total,
                SUM(CAST(output_amount_raw AS INTEGER)) AS output_total
         FROM paper_fills`,
      )
      .get();
    legacy.close();

    const migrated = new SqliteDatabase({
      path: databasePath,
      migrationsDirectory: resolve(projectRoot, "migrations"),
    });
    try {
      expect(
        migrated.sqlite
          .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(fee_evidence_status = 'AMOUNT_UNAVAILABLE') AS unavailable,
                    SUM(fee_evidence_status = 'AVAILABLE') AS available,
                    SUM(fee_amount_raw IS NOT NULL) AS fee_amount_present,
                    SUM(CAST(input_amount_raw AS INTEGER)) AS input_total,
                    SUM(CAST(output_amount_raw AS INTEGER)) AS output_total
             FROM paper_fills`,
          )
          .get(),
      ).toEqual(before);
      expect(
        migrated.sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM paper_fills
             WHERE fee_evidence_contract_id IS NOT NULL`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      migrated.close();
    }
  });

  it("stores every Paper Trading economic raw amount as SQLite TEXT", () => {
    const { database } = testStore("migration-bigint-text-");
    try {
      const expected = {
        follower_positions: [
          "raw_amount",
          "reserved_raw_amount",
          "total_cost_quote_raw",
          "realized_pnl_quote_raw",
        ],
        paper_fills: [
          "input_amount_raw",
          "output_amount_raw",
          "fee_amount_raw",
        ],
        paper_fill_applications: [
          "quantity_before_raw",
          "quantity_after_raw",
          "total_cost_before_raw",
          "total_cost_after_raw",
          "allocated_cost_basis_raw",
          "proceeds_raw",
          "realized_pnl_delta_raw",
          "realized_pnl_after_raw",
        ],
        risk_decisions: [
          "requested_amount_raw",
          "approved_amount_raw",
          "requested_token_raw",
          "approved_token_raw",
          "requested_quote_raw",
          "approved_quote_raw",
          "relevant_limit_raw",
        ],
        risk_state: ["daily_realized_pnl_raw"],
        risk_buy_reservations: [
          "follower_wallet",
          "leader_wallet",
          "approved_quote_raw",
        ],
      } as const;
      for (const [table, columns] of Object.entries(expected)) {
        const types = new Map(
          (
            database.sqlite.pragma(`table_info(${table})`) as {
              name: string;
              type: string;
            }[]
          ).map((column) => [column.name, column.type]),
        );
        for (const column of columns) expect(types.get(column)).toBe("TEXT");
      }
    } finally {
      database.close();
    }
  });

  it("preserves positive legacy positions without inventing cost basis", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "legacy-migration-"));
    const legacyMigrations = resolve(directory, "legacy-migrations");
    const databasePath = resolve(directory, "legacy.sqlite");
    mkdirSync(legacyMigrations);
    for (const file of [
      "0001_initial.sql",
      "0002_live_shadow_validation.sql",
    ]) {
      copyFileSync(
        resolve(projectRoot, "migrations", file),
        resolve(legacyMigrations, file),
      );
    }
    const legacy = new SqliteDatabase({
      path: databasePath,
      migrationsDirectory: legacyMigrations,
    });
    legacy.sqlite.exec(`
      INSERT INTO wallets(id, address, role, enabled, copy_ratio_bps, created_at_ms, updated_at_ms)
      VALUES (1, 'leader-legacy', 'LEADER', 1, 1000, 1, 1),
             (2, 'follower-legacy', 'FOLLOWER', 1, 1000, 1, 1);
      INSERT INTO tokens(mint, decimals, is_quote, first_seen_at_ms, updated_at_ms)
      VALUES ('token-legacy', 6, 0, 1, 1);
      INSERT INTO follower_positions(
        follower_wallet_id, leader_wallet_id, token_mint, raw_amount,
        reserved_raw_amount, state, version, updated_at_ms
      ) VALUES (2, 1, 'token-legacy', '9007199254740993', '0', 'OPEN', 7, 1);
    `);
    legacy.close();

    const migrated = new SqliteDatabase({
      path: databasePath,
      migrationsDirectory: resolve(projectRoot, "migrations"),
    });
    try {
      expect(
        migrated.sqlite
          .prepare(
            `
            SELECT raw_amount, quote_mint, total_cost_quote_raw,
                   realized_pnl_quote_raw, accounting_policy_version,
                   version, state
            FROM follower_positions
          `,
          )
          .get(),
      ).toEqual({
        raw_amount: "9007199254740993",
        quote_mint: null,
        total_cost_quote_raw: null,
        realized_pnl_quote_raw: null,
        accounting_policy_version: null,
        version: 7,
        state: "OPEN",
      });
    } finally {
      migrated.close();
    }
  });
});
