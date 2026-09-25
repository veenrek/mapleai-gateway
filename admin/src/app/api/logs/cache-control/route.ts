import { readFile, rm, stat } from "node:fs/promises";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { EXPORT_CACHE_FILENAME, parseExportCacheFile } from "@/lib/logs/requestLogExport";
import type { RequestLogCacheStatus } from "@/shared/types/requestLog";

/**
 * GET /api/logs/cache-control — status of the persisted export snapshot
 * (management auth). DELETE removes the snapshot.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const base: RequestLogCacheStatus = { available: false, file: EXPORT_CACHE_FILENAME };
  try {
    const info = await stat(EXPORT_CACHE_FILENAME);
    const raw = await readFile(EXPORT_CACHE_FILENAME, "utf-8");
    const cached = parseExportCacheFile(raw);
    if (!cached) {
      return Response.json({ ...base, available: false, reason: "unparseable" }, { status: 200 });
    }
    const status: RequestLogCacheStatus = {
      ...base,
      available: true,
      count: cached.count,
      type: cached.type,
      hours: cached.hours,
      savedAt: cached.generatedAt,
      bytes: info.size,
    };
    return Response.json(status, { status: 200 });
  } catch {
    return Response.json(base, { status: 200 });
  }
}

export async function DELETE(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  await rm(EXPORT_CACHE_FILENAME, { force: true });
  return Response.json({ ok: true }, { status: 200 });
}
