ALTER TABLE marketplace_listings ADD COLUMN cooldown_until TEXT;
ALTER TABLE marketplace_listings ADD COLUMN last_error_code TEXT;
ALTER TABLE marketplace_listings ADD COLUMN last_error_message TEXT;
ALTER TABLE marketplace_listings ADD COLUMN last_error_at TEXT;
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_cooldown ON marketplace_listings(cooldown_until);
