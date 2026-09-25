/**
 * Request-log export: param parse/validation, JSON/XML/CSV/TXT serialization,
 * and an atomic on-disk snapshot so an export survives page refreshes and
 * server restarts. The snapshot is a cache of the last successful export —
 * the usage_logs table remains the source of truth.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "@/lib/db/core";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import type {
  RequestLogEntry,
  RequestLogExportCacheFile,
  RequestLogExportPayload,
} from "@/shared/types/requestLog";

export const EXPORT_CACHE_FILENAME = path.join(DATA_DIR, "logs-last-export.json");

export type ExportFormat = "json" | "xml" | "csv" | "txt";
export const EXPORT_FORMATS: readonly ExportFormat[] = ["json", "xml", "csv", "txt"];

export interface ParsedExportParams {
  format: ExportFormat;
  hours: number;
  includeErrorsOnly: boolean;
  useCache: boolean;
  /** Normalized log-type query value stored in the export payload. */
  logType: string;
}

export interface ParseExportParamsResult {
  params?: ParsedExportParams;
  errorResponse?: Response;
}

function jsonError(status: number, err: unknown): Response {
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as any).status === "number"
  ) {
    return Response.json(err, { status: (err as { status: number }).status });
  }
  return Response.json(
    buildErrorBody(status, err instanceof Error ? err.message : "Invalid export request"),
    { status }
  );
}

/** Parse and validate ?format / ?hours / ?type / ?cached for the export route. */
export function parseExportParams(query: {
  format?: string | null;
  hours?: string | null;
  type?: string | null;
  cached?: string | null;
}): ParseExportParamsResult {
  const type = (query.type || "").trim();
  try {
    const format = (query.format || "json").toLowerCase() as ExportFormat;
    if (!EXPORT_FORMATS.includes(format)) {
      throw {
        error: `Unsupported format. Supported: ${EXPORT_FORMATS.join(", ")}`,
        status: 400,
      };
    }

    const hours = parseInt(query.hours || "24", 10);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) {
      throw { error: "Hours must be between 1 and 720", status: 400 };
    }

    return {
      params: {
        format,
        hours,
        includeErrorsOnly: type === "error",
        useCache: query.cached === "1",
        logType: type || "all",
      },
    };
  } catch (err) {
    return { errorResponse: jsonError(400, err) };
  }
}

/* ------------------------------- serializers ------------------------------ */

const CSV_COLUMNS = [
  "id",
  "timestamp",
  "status",
  "method",
  "provider",
  "model",
  "requestedModel",
  "durationMs",
  "tokensIn",
  "tokensOut",
  "cost",
  "errorType",
  "errorMessage",
] as const;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Serialize the export payload in the requested file format. */
export function buildExportBody(payload: RequestLogExportPayload, format: ExportFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(payload, null, 2);
    case "csv": {
      const rows = payload.logs.map((log) =>
        CSV_COLUMNS.map((col) => csvEscape(log[col])).join(",")
      );
      return [CSV_COLUMNS.join(","), ...rows].join("\n");
    }
    case "txt":
      return payload.logs
        .map((log) =>
          [
            log.timestamp ?? "",
            log.method ?? "",
            log.status ?? "",
            log.provider ?? "",
            log.model ?? "",
            `${log.durationMs ?? ""}ms`,
            log.errorMessage ?? "",
          ]
            .join(" | ")
            .trim()
        )
        .join("\n");
    case "xml": {
      const esc = (value: unknown) =>
        String(value ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      const entries = payload.logs
        .map((log) => {
          const fields = Object.entries(log)
            .map(([key, value]) => `<${key}>${esc(value)}</${key}>`)
            .join("");
          return `<log id="${esc(log.id)}">${fields}</log>`;
        })
        .join("");
      return `<requestLogs generatedAt="${esc(payload.generatedAt)}">${entries}</requestLogs>`;
    }
  }
}

/* ------------------------------ disk snapshot ----------------------------- */

function isValidPayload(value: unknown): value is RequestLogExportPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as RequestLogExportPayload;
  return (
    Array.isArray(payload.logs) &&
    typeof payload.count === "number" &&
    typeof payload.hours === "number" &&
    typeof payload.type === "string" &&
    typeof payload.generatedAt === "string"
  );
}

/** Read-and-validate helper so callers never deal with a partial/missing file. */
export function parseExportCacheFile(
  raw: string | undefined | null
): RequestLogExportPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RequestLogExportCacheFile | RequestLogExportPayload;
    const candidate =
      parsed && typeof parsed === "object" && "payload" in parsed ? parsed.payload : parsed;
    return isValidPayload(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Persist the export payload snapshot atomically (write-then-rename) so the
 * export can be re-downloaded after a refresh/restart without regenerating.
 * Never throws — a cache-write failure must not fail the export itself.
 */
export async function persistExportSnapshot(payload: RequestLogExportPayload): Promise<void> {
  try {
    const wrapped: RequestLogExportCacheFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      payload,
    };
    await mkdir(path.dirname(EXPORT_CACHE_FILENAME), { recursive: true });
    const tempPath = `${EXPORT_CACHE_FILENAME}.tmp`;
    await writeFile(tempPath, JSON.stringify(wrapped), "utf-8");
    await rename(tempPath, EXPORT_CACHE_FILENAME);
  } catch (err) {
    console.warn(
      `[Export] Cache save failed: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }
}

/** Mint a fresh export payload envelope around the provided log rows. */
export function buildPayload(
  entries: RequestLogEntry[],
  params: Pick<ParsedExportParams, "hours" | "logType">
): RequestLogExportPayload {
  return {
    logs: entries,
    count: entries.length,
    hours: params.hours,
    type: params.logType,
    generatedAt: new Date().toISOString(),
  };
}
