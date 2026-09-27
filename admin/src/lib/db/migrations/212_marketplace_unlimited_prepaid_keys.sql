-- Operator-issued prepaid keys may be uncapped while still tracking token usage.
ALTER TABLE marketplace_buyer_keys ADD COLUMN is_unlimited INTEGER NOT NULL DEFAULT 0;
