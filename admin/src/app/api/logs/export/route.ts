import { readFile } from "node:fs/promises";
import { exportCallLogsSince } from "@/lib/usage/callLogs";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { exportProxyLogsSince } from "@/lib/db/proxyLogs";
import {
  buildExportBody,
  buildPayload,
  EXPORT_CACHE_FILENAME,
  parseExportCacheFile,
  parseExportParams,
  persistExportSnapshot,
  type ExportFormat,
} from "@/lib/logs/requestLogExport";
import type { RequestLogEntry } from "@/shared/types/requestLog";

const CONTENT_TYPES: Record<ExportFormat, string> = {
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv",
  txt: "text/plain",
};

function attachmentResponse(body: string, format: ExportFormat, filename: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": CONTENT_TYPES[format],
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

/**
 * GET /api/logs/export — export logs as JSON / XML / CSV / TXT.
 * Query params:
 *   ?hours=24          (1..720; default 24)
 *   &type=call-logs|request-logs|proxy-logs|error (default call-logs)
 *   &format=json|xml|csv|txt (default json)
 *   &cached=1          — serve the last persisted export snapshot (if any).
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const { params, errorResponse } = parseExportParams({
      format: searchParams.get("format"),
      hours: searchParams.get("hours"),
      type: searchParams.get("type"),
      cached: searchParams.get("cached"),
    });
    if (errorResponse) return errorResponse;
    const { format, hours, useCache, logType } = params!;

    const datePart = new Date().toISOString().slice(0, 10);

    // Read-through cache: re-serve the last export without hitting the DB.
    if (useCache) {
      const raw = await readFile(EXPORT_CACHE_FILENAME, "utf-8").catch(() => null);
      const cached = parseExportCacheFile(raw);
      if (!cached) {
        return Response.json({ error: "No cached export available" }, { status: 404 });
      }
      return attachmentResponse(
        buildExportBody(cached, format),
        format,
        `omniroute-cached-${datePart}.${format}`
      );
    }

    const logTypeAlias = logType === "all" ? "call-logs" : logType;
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    let rows: unknown[] = [];
    let tableName = logTypeAlias;

    if (
      logTypeAlias === "call-logs" ||
      logTypeAlias === "request-logs" ||
      logTypeAlias === "error"
    ) {
      tableName = "call_logs";
      rows = await exportCallLogsSince(since);
      if (logTypeAlias === "error") {
        rows = rows.filter((row) => {
          const status = Number((row as Record<string, unknown>)?.status ?? 0);
          const errorMessage = (row as Record<string, unknown>)?.errorMessage;
          return status >= 400 || (typeof errorMessage === "string" && errorMessage.length > 0);
        });
      }
    } else if (logTypeAlias === "proxy-logs") {
      // NOTE: exportProxyLogsSince returns the historical `public_ip` column, NOT `clientIp`.
      // This intentionally differs from GET /api/usage/proxy-logs which exposes the
      // value as `clientIp`. Callers of this export endpoint should read `public_ip`.
      rows = exportProxyLogsSince(since);
    }

    const payload = buildPayload(rows as RequestLogEntry[], { hours, logType: tableName });
    // Persist a snapshot so the export survives refresh/restart (never throws).
    await persistExportSnapshot(payload);

    return attachmentResponse(
      buildExportBody(payload, format),
      format,
      `omniroute-${tableName}-${hours}h-${datePart}.${format}`
    );
  } catch (error) {
    return Response.json(
      { error: { message: (error as Error).message, type: "server_error" } },
      { status: 500 }
    );
  }
}
