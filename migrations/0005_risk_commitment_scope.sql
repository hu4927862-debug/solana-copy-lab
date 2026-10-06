ALTER TABLE risk_buy_reservations ADD COLUMN follower_wallet TEXT;
ALTER TABLE risk_buy_reservations ADD COLUMN leader_wallet TEXT;

CREATE INDEX risk_buy_reservations_follower_quote_active_idx
  ON risk_buy_reservations(follower_wallet, quote_mint, state);

CREATE INDEX risk_buy_reservations_follower_token_quote_active_idx
  ON risk_buy_reservations(follower_wallet, token_mint, quote_mint, state);
