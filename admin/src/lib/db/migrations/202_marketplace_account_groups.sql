ALTER TABLE marketplace_seller_connections ADD COLUMN account_group TEXT NOT NULL DEFAULT 'default';
ALTER TABLE marketplace_seller_connections ADD COLUMN cooldown_until TEXT;
ALTER TABLE marketplace_seller_connections ADD COLUMN last_error_code TEXT;
ALTER TABLE marketplace_seller_connections ADD COLUMN last_error_message TEXT;
ALTER TABLE marketplace_seller_connections ADD COLUMN last_error_at TEXT;
CREATE INDEX IF NOT EXISTS idx_marketplace_seller_connections_group
  ON marketplace_seller_connections(seller_id, provider, account_group, cooldown_until);
