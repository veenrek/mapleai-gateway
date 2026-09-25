CREATE TABLE IF NOT EXISTS marketplace_sellers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  api_key_hash TEXT NOT NULL UNIQUE,
  api_key_prefix TEXT NOT NULL,
  balance_micro_usd INTEGER NOT NULL DEFAULT 0,
  payout_details_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketplace_sellers_status ON marketplace_sellers(status);

CREATE TABLE IF NOT EXISTS marketplace_seller_connections (
  seller_id TEXT NOT NULL,
  connection_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (seller_id) REFERENCES marketplace_sellers(id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_marketplace_seller_connections_seller ON marketplace_seller_connections(seller_id);

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  public_model TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  input_price_micro_usd_per_million_tokens INTEGER NOT NULL,
  output_price_micro_usd_per_million_tokens INTEGER NOT NULL,
  platform_fee_bps INTEGER NOT NULL DEFAULT 1500,
  max_requests_per_minute INTEGER,
  max_daily_tokens INTEGER,
  tokens_sold INTEGER NOT NULL DEFAULT 0,
  revenue_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (seller_id) REFERENCES marketplace_sellers(id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_status ON marketplace_listings(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_seller ON marketplace_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_connection ON marketplace_listings(connection_id);

CREATE TABLE IF NOT EXISTS marketplace_buyer_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  balance_micro_usd INTEGER NOT NULL DEFAULT 0,
  allowed_models_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_marketplace_buyer_keys_status ON marketplace_buyer_keys(status);

CREATE TABLE IF NOT EXISTS marketplace_usage_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  buyer_key_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  public_model TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  reserved_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_completion_tokens INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0,
  charged_micro_usd INTEGER NOT NULL DEFAULT 0,
  seller_amount_micro_usd INTEGER NOT NULL DEFAULT 0,
  platform_fee_micro_usd INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  upstream_status INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (buyer_key_id) REFERENCES marketplace_buyer_keys(id),
  FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id),
  FOREIGN KEY (seller_id) REFERENCES marketplace_sellers(id),
  FOREIGN KEY (connection_id) REFERENCES provider_connections(id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_usage_buyer ON marketplace_usage_events(buyer_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_marketplace_usage_seller ON marketplace_usage_events(seller_id, created_at);
CREATE INDEX IF NOT EXISTS idx_marketplace_usage_listing ON marketplace_usage_events(listing_id, created_at);

CREATE TABLE IF NOT EXISTS marketplace_ledger_entries (
  id TEXT PRIMARY KEY,
  buyer_key_id TEXT,
  seller_id TEXT,
  listing_id TEXT,
  usage_event_id TEXT,
  kind TEXT NOT NULL,
  amount_micro_usd INTEGER NOT NULL DEFAULT 0,
  seller_amount_micro_usd INTEGER NOT NULL DEFAULT 0,
  platform_fee_micro_usd INTEGER NOT NULL DEFAULT 0,
  balance_after_micro_usd INTEGER,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (buyer_key_id) REFERENCES marketplace_buyer_keys(id),
  FOREIGN KEY (seller_id) REFERENCES marketplace_sellers(id),
  FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id),
  FOREIGN KEY (usage_event_id) REFERENCES marketplace_usage_events(id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_ledger_buyer ON marketplace_ledger_entries(buyer_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_marketplace_ledger_seller ON marketplace_ledger_entries(seller_id, created_at);
