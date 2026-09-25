import { NextResponse } from "next/server";
import { getDbInstance } from "@/lib/db/core";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { handleCorsOptions } from "@/shared/utils/cors";

export const dynamic = "force-dynamic";

/**
 * Semantic response cache metrics (persisted in cache_metrics):
 * hits / misses / tokens_saved + computed hit rate.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const db = getDbInstance() as unknown as {
    prepare: (sql: string) => { all: (...a: unknown[]) => Record<string, unknown>[] };
  };

  let hits = 0;
  let misses = 0;
  let tokensSaved = 0;
  try {
    const rows = db.prepare("SELECT key, value FROM cache_metrics").all();
    for (const r of rows) {
      const v = Number(r.value || 0);
      if (r.key === "hits") hits = v;
      else if (r.key === "misses") misses = v;
      else if (r.key === "tokens_saved") tokensSaved = v;
    }
  } catch {
    // table missing → zeros
  }

  const total = hits + misses;

  return NextResponse.json({
    hits,
    misses,
    tokensSaved,
    hitRate: total > 0 ? Math.round((hits / total) * 100) : null,
  });
}

export async function OPTIONS() {
  return handleCorsOptions();
}
