-- Relay Pool — upstream account rotation pool (ported from anthropic-api-relay).
-- Each row is one upstream account: an Anthropic-compatible, OpenAI-compatible,
-- or Codex (chatgpt.com backend) endpoint with its own credentials, optional
-- proxy, model affinity, cooldown state, and usage counters. The relay-pool
-- executor rotates through these accounts per request.
CREATE TABLE IF NOT EXISTS relay_accounts (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  provider_type       TEXT NOT NULL DEFAULT 'anthropic' CHECK (provider_type IN ('anthropic', 'openai', 'codex')),
  base_url            TEXT,
  api_key             TEXT,
  auth_header         TEXT NOT NULL DEFAULT 'x-api-key',
  model               TEXT,
  models_cache        TEXT,
  proxy_url           TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1,
  active              INTEGER NOT NULL DEFAULT 0,
  max_messages        INTEGER NOT NULL DEFAULT 0,
  max_tokens          INTEGER NOT NULL DEFAULT 0,
  cooldown_until      TEXT,
  disabled_until      TEXT,
  last_error          TEXT,
  last_status         INTEGER,
  success_count       INTEGER NOT NULL DEFAULT 0,
  error_count         INTEGER NOT NULL DEFAULT 0,
  tokens_in           INTEGER NOT NULL DEFAULT 0,
  tokens_out          INTEGER NOT NULL DEFAULT 0,
  codex_refresh_token TEXT,
  codex_expires_at    TEXT,
  codex_account_id    TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relay_accounts_enabled ON relay_accounts(enabled);
CREATE INDEX IF NOT EXISTS idx_relay_accounts_provider ON relay_accounts(provider_type);
