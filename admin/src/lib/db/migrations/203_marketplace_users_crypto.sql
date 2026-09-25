-- Marketplace unified user + crypto wallet auth & on-chain deposits.
--
-- Adds a single user identity that can both sell and buy, a wallet-based
-- balance, EVM deposit addresses, recorded on-chain deposits (idempotent per
-- tx log), and SIWE auth nonces. Existing seller/buyer/ledger rows are linked
-- back to a user via nullable user_id columns for backward compatibility.

-- Unified marketplace user (wallet is the identity).
CREATE TABLE IF NOT EXISTS marketplace_users (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  balance_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_marketplace_users_status ON marketplace_users(status);

-- Per-user EVM deposit addresses (one per chain, derived deterministically).
CREATE TABLE IF NOT EXISTS marketplace_deposit_addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  deposit_address TEXT NOT NULL,
  derivation_index INTEGER NOT NULL,
  encrypted_private_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(deposit_address, chain_id),
  UNIQUE(user_id, chain_id, token_address),
  FOREIGN KEY (user_id) REFERENCES marketplace_users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_marketplace_deposit_addresses_user
  ON marketplace_deposit_addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_deposit_addresses_lookup
  ON marketplace_deposit_addresses(chain_id, deposit_address);

-- On-chain deposits observed by the watcher. Idempotent per (chain, tx, log).
CREATE TABLE IF NOT EXISTS marketplace_deposits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  from_address TEXT,
  to_address TEXT NOT NULL,
  amount_token TEXT NOT NULL,
  amount_micro_usd INTEGER NOT NULL DEFAULT 0,
  confirmations INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'seen',
  credited_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(chain_id, tx_hash, log_index),
  FOREIGN KEY (user_id) REFERENCES marketplace_users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_marketplace_deposits_user
  ON marketplace_deposits(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_marketplace_deposits_status
  ON marketplace_deposits(status);

-- SIWE auth nonces (single-use, time-bounded) to prevent signature replay.
CREATE TABLE IF NOT EXISTS marketplace_auth_nonces (
  nonce TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_marketplace_auth_nonces_wallet
  ON marketplace_auth_nonces(wallet_address);
CREATE INDEX IF NOT EXISTS idx_marketplace_auth_nonces_expiry
  ON marketplace_auth_nonces(expires_at);

-- Link existing seller / buyer-key / ledger rows to a unified user.
ALTER TABLE marketplace_sellers ADD COLUMN user_id TEXT;
ALTER TABLE marketplace_buyer_keys ADD COLUMN user_id TEXT;
ALTER TABLE marketplace_ledger_entries ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_marketplace_sellers_user ON marketplace_sellers(user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_buyer_keys_user ON marketplace_buyer_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_ledger_user
  ON marketplace_ledger_entries(user_id, created_at);
