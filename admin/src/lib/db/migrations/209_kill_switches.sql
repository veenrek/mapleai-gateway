-- Kill-switch state (national production).
CREATE TABLE IF NOT EXISTS kill_switches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK (level IN ('global', 'provider', 'combo', 'model')),
  target TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(level, target)
);
CREATE INDEX IF NOT EXISTS idx_kill_switches_enabled ON kill_switches(enabled);
