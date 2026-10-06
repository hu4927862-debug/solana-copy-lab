CREATE TABLE stream_pending_deliveries (
  provider TEXT NOT NULL,
  subscription_key TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot TEXT NOT NULL,
  PRIMARY KEY (provider, subscription_key, signature)
);
