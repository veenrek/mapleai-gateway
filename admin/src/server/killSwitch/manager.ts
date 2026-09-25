/**
 * Kill-switch manager (national production).
 *
 * DB-backed with a 5s read cache. Sets a process-global flag so the
 * edge-safe middleware stub (src/middleware/killSwitch.ts) can deny
 * requests without importing better-sqlite3.
 */
import { getDbInstance } from "@/lib/db/core";

export type KillLevel = "global" | "provider" | "combo" | "model";

export interface KillSwitchHit {
  active: boolean;
  level?: KillLevel;
  target?: string | null;
  reason?: string | null;
}

const CACHE_TTL_MS = 5_000;
let cache: {
  at: number;
  rows: Array<{ level: KillLevel; target: string | null; reason: string | null }>;
} = { at: 0, rows: [] };

function loadActive(): Array<{ level: KillLevel; target: string | null; reason: string | null }> {
  const now = Date.now();
  if (now - cache.at < CACHE_TTL_MS) return cache.rows;
  try {
    const db = getDbInstance();
    const rows = db
      .prepare("SELECT level, target, reason FROM kill_switches WHERE enabled = 1")
      .all() as Array<{ level: KillLevel; target: string | null; reason: string | null }>;
    cache = { at: now, rows };
  } catch {
    return cache.rows; // stale-on-error: never crash the pipeline
  }
  return cache.rows;
}

function syncGlobalFlag(): void {
  const g = globalThis as Record<string, unknown>;
  g.__omnirouteGlobalKill = cache.rows.some((r) => r.level === "global");
}

export function checkKillSwitch(scope: {
  provider?: string | null;
  combo?: string | null;
  model?: string | null;
}): KillSwitchHit {
  const rows = loadActive();
  syncGlobalFlag();
  for (const r of rows) {
    if (r.level === "global") return { active: true, level: r.level, reason: r.reason };
    if (r.level === "provider" && scope.provider && r.target === scope.provider)
      return { active: true, level: r.level, target: r.target, reason: r.reason };
    if (r.level === "combo" && scope.combo && r.target === scope.combo)
      return { active: true, level: r.level, target: r.target, reason: r.reason };
    if (r.level === "model" && scope.model && r.target === scope.model)
      return { active: true, level: r.level, target: r.target, reason: r.reason };
  }
  return { active: false };
}

export function setKillSwitch(
  level: KillLevel,
  target: string | null,
  enabled: boolean,
  reason?: string
): void {
  const db = getDbInstance();
  db.prepare(
    `INSERT INTO kill_switches (level, target, enabled, reason, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(level, target) DO UPDATE SET enabled = excluded.enabled,
       reason = excluded.reason, updated_at = excluded.updated_at`
  ).run(level, target ?? null, enabled ? 1 : 0, reason ?? null);
  cache.at = 0; // invalidate
  loadActive();
  syncGlobalFlag();
}

export function listKillSwitches(): Array<{
  level: KillLevel;
  target: string | null;
  enabled: boolean;
  reason: string | null;
  updatedAt: string;
}> {
  const db = getDbInstance();
  const rows = db
    .prepare(
      "SELECT level, target, enabled, reason, updated_at FROM kill_switches ORDER BY level, target"
    )
    .all() as Array<{
    level: KillLevel;
    target: string | null;
    enabled: number;
    reason: string | null;
    updated_at: string;
  }>;
  return rows.map((r) => ({
    level: r.level,
    target: r.target,
    enabled: r.enabled === 1,
    reason: r.reason,
    updatedAt: r.updated_at,
  }));
}
