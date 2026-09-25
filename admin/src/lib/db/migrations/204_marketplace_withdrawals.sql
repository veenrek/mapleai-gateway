-- Marketplace crypto withdrawals (treasury hot-wallet → user/seller wallet).
--
-- Both marketplace users and sellers can withdraw their off-chain balance to
-- their login wallet. Withdrawals are hold-then-send: the balance is debited
-- when recorded, the tx is signed and broadcast by the backend, the watcher
-- confirms the receipt, and a failed tx is refunded.
--
-- Status lifecycle: pending → submitted → confirmed | failed (reversed)

CREATE TABLE IF NOT EXISTS marketplace_withdrawals (
  id TEXT PRIMARY KEY,
  -- Either user_id or seller_id is set, never both.
  user_id TEXT,
  seller_id TEXT,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount_micro_usd INTEGER NOT NULL,
  amount_token TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES marketplace_users(id) ON DELETE SET NULL,
  FOREIGN KEY (seller_id) REFERENCES marketplace_sellers(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_marketplace_withdrawals_status
  ON marketplace_withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_withdrawals_user
  ON marketplace_withdrawals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_withdrawals_seller
  ON marketplace_withdrawals(seller_id, created_at DESC);
