import { NextResponse } from "next/server";
import { getDbInstance } from "@/lib/db/core";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { handleCorsOptions } from "@/shared/utils/cors";

export const dynamic = "force-dynamic";

/**
 * Per-provider latency aggregates from usage_history (last 24h).
 *
 *  - upstreamTtftMs  — avg time-to-first-token measured on the upstream call
 *                      ("нас → поставщик")
 *  - clientLatencyMs — avg total request duration as recorded when the stream
 *                      finished for the client ("нас → клиент")
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id: rawId } = await ctx.params;
  const providerId = decodeURIComponent(rawId);
  // Optional per-connection filter (?connection=<uuid>) for inline row badges.
  const connectionFilter = new URL(request.url).searchParams.get("connection");

  const db = getDbInstance() as unknown as {
    prepare: (sql: string) => { all: (...a: unknown[]) => Record<string, unknown>[] };
  };

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(AVG(latency_ms), 0) AS avg_latency,
              COALESCE(MAX(latency_ms), 0) AS max_latency,
              COALESCE(AVG(ttft_ms), 0) AS avg_ttft,
              SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS ok
       FROM usage_history
       WHERE provider = ? AND timestamp >= ?${connectionFilter ? " AND connection_id = ?" : ""}`
    )
    .all(...(connectionFilter ? [providerId, since, connectionFilter] : [providerId, since]));

  const r = (rows[0] ?? {}) as {
    n?: number;
    avg_latency?: number;
    max_latency?: number;
    avg_ttft?: number;
    ok?: number;
  };
  const n = Number(r.n || 0);

  return NextResponse.json({
    provider: providerId,
    windowHours: 24,
    requests: n,
    upstreamTtftMs: Math.round(Number(r.avg_ttft || 0)),
    clientLatencyMs: Math.round(Number(r.avg_latency || 0)),
    clientLatencyMaxMs: Math.round(Number(r.max_latency || 0)),
    successRate: n > 0 ? Math.round((Number(r.ok || 0) / n) * 100) : null,
  });
}

export async function OPTIONS() {
  return handleCorsOptions();
}
