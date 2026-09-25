/**
 * Canonical request-log types.
 *
 * Shared by the logs dashboard (LogTable / LogDetailModal), the export route
 * (src/app/api/logs/export/route.ts), and the persisted export cache
 * (src/lib/logs/requestLogExport.ts). Keep this file dependency-free so it can
 * be imported from both server and client code.
 */

/** JSON primitives and containers used by the octra JSON viewer. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A single row in the request-log table. */
export interface RequestLogEntry {
  id: string;
  timestamp: string;
  status?: number | null;
  method?: string;
  provider?: string | null;
  model?: string | null;
  requestedModel?: string | null;
  durationMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  cost?: number | null;
  errorType?: string | null;
  errorMessage?: string | null;
  [key: string]: unknown;
}

/** Full detail payload for a single request log (detail endpoint). */
export interface RequestLogDetail extends RequestLogEntry {
  requestBody?: JsonValue | null;
  responseBody?: JsonValue | null;
  streamEvents?: JsonValue[] | null;
}

/** Request body accepted by GET /api/logs/export (query params mirrored). */
export interface RequestLogExportRequest {
  /** Export window in hours. */
  hours?: number;
  /** Log type filter (`"error"` for failures only). */
  type?: string;
  /** When `1`, allow serving the persisted export cache (read-through). */
  cached?: boolean;
}

/** Envelope written to disk so an export survives page refreshes/restarts. */
export interface RequestLogExportPayload {
  logs: RequestLogEntry[];
  count: number;
  hours: number;
  type: string;
  generatedAt: string;
}

/** Persisted cache file: payload plus the metadata needed to invalidate it. */
export interface RequestLogExportCacheFile {
  version: 1;
  savedAt: string;
  payload: RequestLogExportPayload;
}

/** Status reported by GET /api/logs/cache-control. */
export interface RequestLogCacheStatus {
  available: boolean;
  file: string;
  count?: number;
  type?: string;
  hours?: number;
  savedAt?: string;
  bytes?: number;
}
