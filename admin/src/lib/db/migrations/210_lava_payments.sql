-- Lava.top fiat payment invoices (credited via invoice status polling).
CREATE TABLE IF NOT EXISTS lava_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL UNIQUE,
  invoice_id TEXT,
  buyer_key_id TEXT,
  amount_micro_usd INTEGER NOT NULL,
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lava_payments_status ON lava_payments(status);
CREATE INDEX IF NOT EXISTS idx_lava_payments_buyer_key ON lava_payments(buyer_key_id);
CREATE INDEX IF NOT EXISTS idx_lava_payments_invoice ON lava_payments(invoice_id);
