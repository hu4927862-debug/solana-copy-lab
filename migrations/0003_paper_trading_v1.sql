ALTER TABLE follower_positions RENAME TO follower_positions_legacy;

CREATE TABLE follower_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  leader_wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  token_mint TEXT NOT NULL REFERENCES tokens(mint),
  quote_mint TEXT REFERENCES tokens(mint),
  raw_amount TEXT NOT NULL,
  reserved_raw_amount TEXT NOT NULL DEFAULT '0',
  total_cost_quote_raw TEXT,
  realized_pnl_quote_raw TEXT,
  accounting_policy_version TEXT,
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSED')),
  last_execution_key TEXT,
  last_fill_id TEXT,
  opened_at_ms INTEGER,
  closed_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (follower_wallet_id, leader_wallet_id, token_mint, quote_mint)
);

INSERT INTO follower_positions(
  id, follower_wallet_id, leader_wallet_id, token_mint, quote_mint,
  raw_amount, reserved_raw_amount, total_cost_quote_raw,
  realized_pnl_quote_raw, accounting_policy_version, state,
  last_execution_key, last_fill_id, opened_at_ms, closed_at_ms,
  version, updated_at_ms
)
SELECT id, follower_wallet_id, leader_wallet_id, token_mint, NULL,
       raw_amount, reserved_raw_amount, NULL, NULL, NULL, state,
       last_execution_key, NULL, NULL, NULL, version, updated_at_ms
FROM follower_positions_legacy;

DROP TABLE follower_positions_legacy;

CREATE TABLE paper_fills (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES follower_trades(execution_key),
  leader_trade_id TEXT NOT NULL REFERENCES leader_trades(id),
  leader_tx_signature TEXT NOT NULL,
  leader_wallet TEXT NOT NULL,
  follower_wallet TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  input_mint TEXT NOT NULL,
  output_mint TEXT NOT NULL,
  token_decimals INTEGER NOT NULL CHECK (token_decimals BETWEEN 0 AND 255),
  quote_decimals INTEGER NOT NULL CHECK (quote_decimals BETWEEN 0 AND 255),
  input_amount_raw TEXT NOT NULL,
  output_amount_raw TEXT NOT NULL,
  quote_request_timestamp_ms INTEGER NOT NULL,
  quote_timestamp_ms INTEGER NOT NULL,
  quote_rtt_ms REAL NOT NULL,
  fee_evidence_status TEXT NOT NULL CHECK (fee_evidence_status IN ('AVAILABLE', 'AMOUNT_UNAVAILABLE')),
  fee_bps INTEGER,
  fee_mint TEXT,
  fee_amount_raw TEXT,
  provider TEXT NOT NULL,
  request_id TEXT,
  fill_policy_version TEXT NOT NULL CHECK (fill_policy_version = 'JUPITER_ORDER_QUOTE_AS_FILL_V1'),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (leader_trade_id, follower_wallet, fill_policy_version)
);

CREATE TABLE paper_fill_applications (
  fill_id TEXT PRIMARY KEY REFERENCES paper_fills(id),
  position_id INTEGER NOT NULL REFERENCES follower_positions(id),
  transition TEXT NOT NULL CHECK (transition IN ('OPEN', 'ADD', 'REDUCE', 'CLOSE')),
  quantity_before_raw TEXT NOT NULL,
  quantity_after_raw TEXT NOT NULL,
  total_cost_before_raw TEXT NOT NULL,
  total_cost_after_raw TEXT NOT NULL,
  allocated_cost_basis_raw TEXT NOT NULL,
  proceeds_raw TEXT NOT NULL,
  realized_pnl_delta_raw TEXT NOT NULL,
  realized_pnl_after_raw TEXT NOT NULL,
  position_version_after INTEGER NOT NULL,
  applied_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_paper_fills_application_order ON paper_fills(created_at_ms, id);
CREATE INDEX idx_paper_fills_position_identity ON paper_fills(follower_wallet, leader_wallet, output_mint, input_mint);
