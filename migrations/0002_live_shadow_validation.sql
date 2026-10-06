CREATE TABLE provider_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL,
  provider TEXT NOT NULL,
  slot TEXT NOT NULL,
  received_timestamp_ms INTEGER NOT NULL,
  received_monotonic_ns TEXT NOT NULL,
  is_replay INTEGER NOT NULL DEFAULT 0 CHECK (is_replay IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (signature, provider)
);

CREATE TABLE provider_event_comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL UNIQUE,
  primary_provider TEXT NOT NULL,
  secondary_provider TEXT NOT NULL,
  primary_received_timestamp_ms INTEGER,
  secondary_received_timestamp_ms INTEGER,
  arrival_delta_ms REAL,
  status TEXT NOT NULL CHECK (status IN ('MATCHED', 'PRIMARY_MISSING', 'SECONDARY_MISSING')),
  compared_at_ms INTEGER NOT NULL
);

CREATE TABLE stream_health_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('CONNECTED', 'DISCONNECTED', 'RECONNECTED', 'DEGRADED', 'REPLAY_STARTED', 'REPLAY_COMPLETED', 'REPLAY_FAILED')),
  duration_ms REAL,
  details_json TEXT NOT NULL,
  wall_timestamp_ms INTEGER NOT NULL,
  monotonic_timestamp_ns TEXT NOT NULL
);

CREATE TABLE live_validation_events (
  id TEXT PRIMARY KEY,
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL DEFAULT 0,
  slot TEXT NOT NULL,
  block_time_ms INTEGER,
  leader TEXT NOT NULL,
  primary_provider TEXT NOT NULL,
  program_ids_json TEXT NOT NULL,
  system_classification TEXT NOT NULL CHECK (system_classification IN ('BUY', 'SELL', 'TRANSFER', 'LP', 'STAKE', 'LENDING', 'UNKNOWN', 'UNSUPPORTED')),
  ground_truth_classification TEXT NOT NULL CHECK (ground_truth_classification IN ('BUY', 'SELL', 'TRANSFER', 'LP', 'STAKE', 'LENDING', 'UNKNOWN', 'UNSUPPORTED')),
  ground_truth_source TEXT NOT NULL CHECK (ground_truth_source IN ('AUTO_RULE', 'HUMAN_REVIEW')),
  dex TEXT,
  token_mint TEXT,
  quote_mint TEXT,
  balance_deltas_json TEXT NOT NULL,
  classifier_evidence_json TEXT NOT NULL,
  skip_reason TEXT,
  capture_path TEXT NOT NULL,
  decode_error TEXT,
  is_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (is_duplicate IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  reviewed_at_ms INTEGER,
  UNIQUE (signature, leader, event_index)
);

CREATE TABLE review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  validation_event_id TEXT NOT NULL UNIQUE REFERENCES live_validation_events(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'REVIEWED', 'DISMISSED')),
  proposed_classification TEXT,
  human_classification TEXT CHECK (human_classification IN ('BUY', 'SELL', 'TRANSFER', 'LP', 'STAKE', 'LENDING', 'UNKNOWN', 'UNSUPPORTED')),
  notes TEXT,
  created_at_ms INTEGER NOT NULL,
  reviewed_at_ms INTEGER
);

CREATE TABLE live_latency_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  validation_event_id TEXT NOT NULL UNIQUE REFERENCES live_validation_events(id),
  stream_received_monotonic_ns TEXT NOT NULL,
  detected_monotonic_ns TEXT,
  normalized_monotonic_ns TEXT,
  classified_monotonic_ns TEXT,
  copy_intent_created_monotonic_ns TEXT,
  jupiter_request_started_monotonic_ns TEXT,
  jupiter_response_received_monotonic_ns TEXT,
  shadow_execution_completed_monotonic_ns TEXT,
  stream_to_decode_ms REAL,
  decode_to_decision_ms REAL,
  decision_to_jupiter_request_ms REAL,
  jupiter_rtt_ms REAL,
  full_shadow_pipeline_ms REAL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE jupiter_shadow_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  validation_event_id TEXT NOT NULL REFERENCES live_validation_events(id),
  execution_key TEXT NOT NULL UNIQUE,
  request_timestamp_ms INTEGER NOT NULL,
  response_timestamp_ms INTEGER,
  request_monotonic_ns TEXT NOT NULL,
  response_monotonic_ns TEXT,
  http_status INTEGER,
  schema_valid INTEGER NOT NULL DEFAULT 0 CHECK (schema_valid IN (0, 1)),
  input_mint TEXT NOT NULL,
  output_mint TEXT NOT NULL,
  input_raw TEXT NOT NULL,
  expected_output_raw TEXT,
  router TEXT,
  route_json TEXT,
  price_impact_pct TEXT,
  quote_age_ms REAL,
  rtt_ms REAL,
  source_price TEXT,
  expected_execution_price TEXT,
  theoretical_price_difference_pct TEXT,
  adverse_price_difference_pct TEXT,
  provider TEXT,
  dex TEXT,
  token_mint TEXT,
  leader TEXT,
  observed_hour TEXT,
  failure_reason TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE soak_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sampled_at_ms INTEGER NOT NULL,
  db_size_bytes INTEGER NOT NULL,
  wal_size_bytes INTEGER NOT NULL,
  writer_queue_size INTEGER NOT NULL,
  writer_pending INTEGER NOT NULL,
  busy_error_count INTEGER NOT NULL,
  write_latency_average_ms REAL NOT NULL,
  write_latency_p95_ms REAL NOT NULL,
  wal_checkpoint_duration_ms REAL,
  wal_checkpoint_busy INTEGER,
  wal_checkpoint_log_frames INTEGER,
  wal_checkpointed_frames INTEGER
);

CREATE TABLE recovery_validation_runs (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL CHECK (scenario IN ('STREAM_15S_DISCONNECT', 'KILL_9_RESTART', 'PRIMARY_DOWN')),
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  events_during_outage INTEGER NOT NULL DEFAULT 0,
  recovered_events INTEGER NOT NULL DEFAULT 0,
  lost_events INTEGER NOT NULL DEFAULT 0,
  duplicate_events INTEGER NOT NULL DEFAULT 0,
  replay_count INTEGER NOT NULL DEFAULT 0,
  replay_success_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'PASS', 'FAIL', 'INCONCLUSIVE')),
  details_json TEXT NOT NULL
);

CREATE INDEX idx_provider_receipts_signature ON provider_receipts(signature);
CREATE INDEX idx_provider_receipts_provider_time ON provider_receipts(provider, received_timestamp_ms);
CREATE INDEX idx_provider_comparison_status ON provider_event_comparisons(status);
CREATE INDEX idx_stream_health_provider_time ON stream_health_events(provider, wall_timestamp_ms);
CREATE INDEX idx_live_validation_classification ON live_validation_events(system_classification, ground_truth_classification);
CREATE INDEX idx_live_validation_dex ON live_validation_events(dex);
CREATE INDEX idx_review_queue_status ON review_queue(status, created_at_ms);
CREATE INDEX idx_jupiter_quotes_event ON jupiter_shadow_quotes(validation_event_id);
CREATE INDEX idx_soak_metrics_time ON soak_metrics(sampled_at_ms);
