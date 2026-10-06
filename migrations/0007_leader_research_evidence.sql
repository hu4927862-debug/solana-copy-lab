CREATE TABLE leader_research_evidence (
  evidence_id TEXT PRIMARY KEY,
  leader_wallet_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot TEXT NOT NULL,
  block_time_ms INTEGER,
  block_time_status TEXT NOT NULL CHECK (block_time_status IN ('AVAILABLE','PARTIAL','UNAVAILABLE')),
  transaction_index INTEGER,
  transaction_index_status TEXT NOT NULL CHECK (transaction_index_status IN ('OBSERVED','DERIVED','UNAVAILABLE')),
  event_ordinal INTEGER,
  event_ordinal_status TEXT NOT NULL CHECK (event_ordinal_status IN ('OBSERVED','DERIVED','UNAVAILABLE')),
  signer TEXT,
  signers_json TEXT NOT NULL,
  fee_payer TEXT,
  source_provider TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  input_mint TEXT,
  output_mint TEXT,
  input_mint_canonical TEXT,
  output_mint_canonical TEXT,
  canonical_quote_mint TEXT,
  input_amount_raw TEXT,
  output_amount_raw TEXT,
  input_decimals INTEGER,
  output_decimals INTEGER,
  input_decimals_provenance TEXT NOT NULL CHECK (input_decimals_provenance IN ('TRANSACTION_TOKEN_BALANCE','NATIVE_SOL_FIXED_9','UNAVAILABLE')),
  output_decimals_provenance TEXT NOT NULL CHECK (output_decimals_provenance IN ('TRANSACTION_TOKEN_BALANCE','NATIVE_SOL_FIXED_9','UNAVAILABLE')),
  fee_raw TEXT,
  fee_mint TEXT NOT NULL,
  fee_attribution_status TEXT NOT NULL CHECK (fee_attribution_status IN ('UNKNOWN','LEADER_FEE_PAYER')),
  priority_fee_raw TEXT,
  priority_fee_status TEXT NOT NULL CHECK (priority_fee_status IN ('AVAILABLE','UNAVAILABLE')),
  classification_code TEXT NOT NULL,
  trading_authorization TEXT NOT NULL CHECK (trading_authorization IN ('AUTHORIZED','NOT_AUTHORIZED')),
  coverage_status TEXT NOT NULL CHECK (coverage_status IN ('AVAILABLE','PARTIAL','UNAVAILABLE')),
  gap_status TEXT NOT NULL CHECK (gap_status IN ('NONE','ORDERING_UNAVAILABLE','MULTI_SWAP_UNAVAILABLE','OWNER_UNAVAILABLE')),
  conflict_status TEXT NOT NULL CHECK (conflict_status IN ('NONE','CONFLICT')),
  backfill_status TEXT NOT NULL CHECK (backfill_status IN ('NOT_ATTEMPTED','BACKFILLED')),
  schema_version TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  decoder_version TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (leader_wallet_id, signature, source_fingerprint, extractor_version)
);

CREATE INDEX leader_research_evidence_leader_slot_idx
  ON leader_research_evidence(leader_wallet_id, slot);
CREATE INDEX leader_research_evidence_signature_idx
  ON leader_research_evidence(signature);

CREATE TABLE leader_research_account_balances (
  evidence_id TEXT NOT NULL REFERENCES leader_research_evidence(evidence_id),
  account_index INTEGER NOT NULL,
  account_address TEXT,
  mint TEXT NOT NULL,
  token_program TEXT NOT NULL,
  pre_raw TEXT,
  post_raw TEXT,
  delta_raw TEXT,
  decimals INTEGER,
  decimals_status TEXT NOT NULL CHECK (decimals_status IN ('AVAILABLE','PARTIAL','UNAVAILABLE')),
  decimals_provenance TEXT NOT NULL CHECK (decimals_provenance IN ('TRANSACTION_TOKEN_BALANCE','NATIVE_SOL_FIXED_9','UNAVAILABLE')),
  pre_owner TEXT,
  post_owner TEXT,
  owner_status TEXT NOT NULL CHECK (owner_status IN ('AVAILABLE','PARTIAL','UNAVAILABLE')),
  owner_provenance TEXT NOT NULL CHECK (owner_provenance IN ('TRANSACTION_BALANCE','UNAVAILABLE')),
  PRIMARY KEY (evidence_id, account_index, mint)
);

CREATE INDEX leader_research_balances_evidence_idx
  ON leader_research_account_balances(evidence_id);

CREATE TABLE leader_research_instructions (
  evidence_id TEXT NOT NULL REFERENCES leader_research_evidence(evidence_id),
  capture_ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('OUTER','INNER')),
  outer_ordinal INTEGER,
  inner_ordinal INTEGER,
  ordering_status TEXT NOT NULL CHECK (ordering_status IN ('OBSERVED','DERIVED','UNAVAILABLE')),
  program_id TEXT NOT NULL,
  accounts_json TEXT NOT NULL,
  data TEXT,
  parsed_type TEXT,
  stack_height INTEGER,
  PRIMARY KEY (evidence_id, capture_ordinal)
);

CREATE INDEX leader_research_instructions_evidence_idx
  ON leader_research_instructions(evidence_id);

CREATE TRIGGER leader_research_evidence_append_only_update
BEFORE UPDATE ON leader_research_evidence
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
CREATE TRIGGER leader_research_evidence_append_only_delete
BEFORE DELETE ON leader_research_evidence
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
CREATE TRIGGER leader_research_balances_append_only_update
BEFORE UPDATE ON leader_research_account_balances
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
CREATE TRIGGER leader_research_balances_append_only_delete
BEFORE DELETE ON leader_research_account_balances
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
CREATE TRIGGER leader_research_instructions_append_only_update
BEFORE UPDATE ON leader_research_instructions
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
CREATE TRIGGER leader_research_instructions_append_only_delete
BEFORE DELETE ON leader_research_instructions
BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
