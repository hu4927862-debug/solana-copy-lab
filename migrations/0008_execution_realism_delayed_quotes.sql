CREATE TABLE execution_realism_delayed_quotes (
  evidence_id TEXT PRIMARY KEY,
  parent_execution_key TEXT NOT NULL,
  validation_event_id TEXT NOT NULL,
  policy_version TEXT NOT NULL CHECK (policy_version = 'EXECUTION_REALISM_DELAY_POLICY_V1'),
  reference_timestamp_ms INTEGER NOT NULL,
  intended_delay_ms INTEGER NOT NULL CHECK (intended_delay_ms IN (3000, 10000)),
  actual_request_timestamp_ms INTEGER NOT NULL,
  actual_response_timestamp_ms INTEGER,
  actual_observed_delay_ms INTEGER NOT NULL,
  request_monotonic_ns TEXT,
  response_monotonic_ns TEXT,
  input_mint TEXT NOT NULL,
  output_mint TEXT NOT NULL,
  input_amount_raw TEXT NOT NULL,
  returned_input_amount_raw TEXT,
  returned_input_amount_status TEXT NOT NULL CHECK (returned_input_amount_status IN ('AVAILABLE', 'UNAVAILABLE')),
  returned_output_amount_raw TEXT,
  jupiter_request_id TEXT,
  swap_mode TEXT,
  http_status INTEGER,
  schema_valid INTEGER NOT NULL CHECK (schema_valid IN (0, 1)),
  router TEXT,
  route_json TEXT,
  route_status TEXT NOT NULL CHECK (route_status IN ('AVAILABLE', 'UNAVAILABLE')),
  price_impact_pct TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE')),
  failure_code TEXT,
  failure_detail TEXT,
  source_fingerprint TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (parent_execution_key, policy_version, intended_delay_ms),
  CHECK (
    (outcome = 'SUCCESS' AND schema_valid = 1 AND returned_input_amount_raw IS NULL
      AND returned_input_amount_status = 'UNAVAILABLE'
      AND returned_output_amount_raw IS NOT NULL AND jupiter_request_id IS NOT NULL
      AND swap_mode IS NOT NULL AND http_status BETWEEN 200 AND 299
      AND failure_code IS NULL)
    OR
    (outcome = 'FAILURE' AND returned_input_amount_raw IS NULL
      AND returned_input_amount_status = 'UNAVAILABLE'
      AND returned_output_amount_raw IS NULL AND jupiter_request_id IS NULL
      AND swap_mode IS NULL AND router IS NULL
      AND route_json IS NULL AND price_impact_pct IS NULL
      AND failure_code IS NOT NULL)
  ),
  CHECK (
    (route_status = 'AVAILABLE' AND route_json IS NOT NULL)
    OR (route_status = 'UNAVAILABLE' AND route_json IS NULL)
  )
);

CREATE INDEX execution_realism_delayed_quotes_parent_idx
  ON execution_realism_delayed_quotes(parent_execution_key, intended_delay_ms);

CREATE TRIGGER execution_realism_delayed_quotes_append_only_update
BEFORE UPDATE ON execution_realism_delayed_quotes
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;

CREATE TRIGGER execution_realism_delayed_quotes_append_only_delete
BEFORE DELETE ON execution_realism_delayed_quotes
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
