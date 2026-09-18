PRAGMA foreign_keys = ON;

CREATE TABLE payment_methods (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_ciphertext TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE orders ADD COLUMN payment_method_id TEXT REFERENCES payment_methods(id);
ALTER TABLE orders ADD COLUMN payment_provider TEXT;
ALTER TABLE orders ADD COLUMN external_trade_no TEXT;

CREATE INDEX idx_payment_methods_enabled ON payment_methods(enabled, provider);
CREATE UNIQUE INDEX idx_orders_provider_trade_no ON orders(payment_provider, external_trade_no) WHERE external_trade_no IS NOT NULL;
