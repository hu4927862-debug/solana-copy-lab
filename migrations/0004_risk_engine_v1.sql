CREATE TABLE risk_decisions (
  decision_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL CHECK (phase IN ('PRE_QUOTE', 'POST_QUOTE')),
  intent_id TEXT NOT NULL,
  pre_decision_id TEXT,
  quote_request_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('ALLOW', 'RESIZE', 'REJECT', 'HALT')),
  requested_amount_raw TEXT NOT NULL,
  approved_amount_raw TEXT NOT NULL,
  requested_token_raw TEXT NOT NULL,
  approved_token_raw TEXT NOT NULL,
  requested_quote_raw TEXT NOT NULL,
  approved_quote_raw TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  relevant_limit_raw TEXT,
  relevant_evidence_json TEXT NOT NULL DEFAULT '{}',
  decided_at_ms INTEGER NOT NULL,
  UNIQUE (phase, intent_id)
);

CREATE TABLE risk_state (
  quote_mint TEXT PRIMARY KEY,
  quote_state TEXT NOT NULL CHECK (quote_state IN ('RUNNING', 'HALT_NEW_RISK')),
  utc_day TEXT NOT NULL,
  daily_realized_pnl_raw TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE risk_global_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  global_state TEXT NOT NULL CHECK (global_state IN ('RUNNING', 'HALT_NEW_RISK')),
  reason_code TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

INSERT INTO risk_global_state(
  singleton_id, global_state, reason_code, updated_at_ms, version
) VALUES (1, 'RUNNING', 'INITIAL_STATE', 0, 0);

CREATE TABLE risk_buy_reservations (
  intent_id TEXT PRIMARY KEY,
  token_mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  approved_quote_raw TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'RELEASED', 'APPLIED')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX risk_buy_reservations_active_quote_idx
  ON risk_buy_reservations(quote_mint, state);

CREATE TABLE risk_provider_health (
  provider TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
