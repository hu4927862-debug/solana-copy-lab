ALTER TABLE leader_trades
ADD COLUMN source_timestamp_provenance TEXT NOT NULL DEFAULT 'UNKNOWN'
CHECK (source_timestamp_provenance IN ('CHAIN_BLOCK_TIME', 'UNKNOWN'));

ALTER TABLE risk_decisions ADD COLUMN leader_trade_id TEXT;
ALTER TABLE risk_decisions ADD COLUMN leader_wallet TEXT;
ALTER TABLE risk_decisions ADD COLUMN follower_wallet TEXT;
ALTER TABLE risk_decisions ADD COLUMN side TEXT CHECK (side IN ('BUY', 'SELL'));
ALTER TABLE risk_decisions ADD COLUMN token_mint TEXT;
ALTER TABLE risk_decisions ADD COLUMN quote_mint TEXT;
