-- Prepaid buyer keys: token-denominated budgets for unauthenticated users.
-- A key with token_budget_total set operates in prepaid-token mode: usage
-- debits tokens instead of the USD balance (the operator collected payment
-- out-of-band when issuing the key). expires_at optionally retires the key.
ALTER TABLE marketplace_buyer_keys ADD COLUMN token_budget_total INTEGER;
ALTER TABLE marketplace_buyer_keys ADD COLUMN tokens_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketplace_buyer_keys ADD COLUMN tokens_reserved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketplace_buyer_keys ADD COLUMN expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_marketplace_buyer_keys_prepaid
  ON marketplace_buyer_keys(token_budget_total);
