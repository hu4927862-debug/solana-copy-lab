CREATE TABLE wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('LEADER', 'FOLLOWER')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  copy_ratio_bps INTEGER NOT NULL DEFAULT 10000 CHECK (copy_ratio_bps BETWEEN 0 AND 100000),
  max_quote_raw TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  decimals INTEGER CHECK (decimals BETWEEN 0 AND 255),
  token_program TEXT,
  is_quote INTEGER NOT NULL DEFAULT 0 CHECK (is_quote IN (0, 1)),
  unsupported_reason TEXT,
  first_seen_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE leader_trades (
  id TEXT PRIMARY KEY,
  leader_wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL DEFAULT 0,
  slot TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  token_mint TEXT NOT NULL REFERENCES tokens(mint),
  quote_mint TEXT NOT NULL REFERENCES tokens(mint),
  token_raw TEXT NOT NULL,
  quote_raw TEXT NOT NULL,
  leader_pre_token_raw TEXT NOT NULL,
  source_price TEXT,
  source_timestamp_ms INTEGER,
  source_timestamp_precision TEXT NOT NULL DEFAULT 'UNKNOWN',
  stream_received_timestamp_ms INTEGER NOT NULL,
  detected_timestamp_ms INTEGER NOT NULL,
  decoded_timestamp_ms INTEGER NOT NULL,
  stream_received_monotonic_ns TEXT NOT NULL,
  detected_monotonic_ns TEXT NOT NULL,
  decoded_monotonic_ns TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (leader_wallet_id, signature, event_index)
);

CREATE TABLE follower_trades (
  id TEXT PRIMARY KEY,
  execution_key TEXT NOT NULL UNIQUE,
  leader_trade_id TEXT NOT NULL REFERENCES leader_trades(id),
  follower_wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  state TEXT NOT NULL CHECK (state IN ('CREATED', 'RESERVED', 'PAPER_EXECUTED', 'CONFIRMED', 'SKIPPED', 'UNCERTAIN', 'FAILED')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  token_mint TEXT NOT NULL REFERENCES tokens(mint),
  quote_mint TEXT NOT NULL REFERENCES tokens(mint),
  theoretical_token_raw TEXT NOT NULL,
  theoretical_quote_raw TEXT NOT NULL,
  executed_token_raw TEXT,
  executed_quote_raw TEXT,
  copy_ratio_bps INTEGER NOT NULL,
  sell_ratio_numerator TEXT,
  sell_ratio_denominator TEXT,
  skip_reason TEXT,
  source_price TEXT,
  execution_price TEXT,
  price_difference_pct TEXT,
  order_created_timestamp_ms INTEGER NOT NULL,
  order_created_monotonic_ns TEXT NOT NULL,
  order_signed_timestamp_ms INTEGER,
  order_signed_monotonic_ns TEXT,
  order_sent_timestamp_ms INTEGER,
  order_sent_monotonic_ns TEXT,
  confirmed_timestamp_ms INTEGER,
  confirmed_monotonic_ns TEXT,
  finalized_timestamp_ms INTEGER,
  finalized_monotonic_ns TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (leader_trade_id, follower_wallet_id)
);

CREATE TABLE leader_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leader_wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  token_mint TEXT NOT NULL REFERENCES tokens(mint),
  raw_amount TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSED')),
  last_trade_id TEXT REFERENCES leader_trades(id),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (leader_wallet_id, token_mint)
);

CREATE TABLE follower_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  leader_wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  token_mint TEXT NOT NULL REFERENCES tokens(mint),
  raw_amount TEXT NOT NULL,
  reserved_raw_amount TEXT NOT NULL DEFAULT '0',
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSED')),
  last_execution_key TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (follower_wallet_id, leader_wallet_id, token_mint)
);

CREATE TABLE execution_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_key TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT NOT NULL,
  wall_timestamp_ms INTEGER NOT NULL,
  monotonic_timestamp_ns TEXT NOT NULL,
  UNIQUE (execution_key, sequence)
);

CREATE TABLE system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('DEBUG', 'INFO', 'WARN', 'ERROR')),
  component TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL,
  wall_timestamp_ms INTEGER NOT NULL,
  monotonic_timestamp_ns TEXT NOT NULL
);

CREATE TABLE stream_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  subscription_key TEXT NOT NULL,
  slot TEXT NOT NULL,
  signature TEXT,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (provider, subscription_key)
);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  published_at_ms INTEGER
);

CREATE INDEX idx_leader_trades_signature ON leader_trades(signature);
CREATE INDEX idx_leader_trades_wallet_slot ON leader_trades(leader_wallet_id, slot);
CREATE INDEX idx_follower_trades_state ON follower_trades(state);
CREATE INDEX idx_execution_events_key ON execution_events(execution_key);
CREATE INDEX idx_outbox_pending ON outbox(status, available_at_ms);
