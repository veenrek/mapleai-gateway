/**
 * Kill-switch middleware (edge-safe).
 *
 * Cannot import better-sqlite3, so global kill state is read from:
 *   1. `OMNI_KILL_SWITCH=1` env var (operator emergency brake), and
 *   2. the process-global flag `__omnirouteGlobalKill` maintained by
 *      src/server/killSwitch/manager.ts in the server process.
 * Scoped kills (provider/combo/model) are enforced by the manager inside
 * the request pipeline.
 */
import { NextRequest, NextResponse } from "next/server";

export function isGlobalKillActive(): boolean {
  if (process.env.OMNI_KILL_SWITCH === "1" || process.env.OMNI_KILL_SWITCH === "true") return true;
  return (globalThis as Record<string, unknown>).__omnirouteGlobalKill === true;
}

export function applyKillSwitch(req: NextRequest): NextResponse | null {
  if (!isGlobalKillActive()) return null;
  return NextResponse.json(
    {
      error: {
        code: "kill_switch_active",
        message: "Service temporarily disabled by operator kill switch.",
      },
    },
    { status: 503 }
  );
}
