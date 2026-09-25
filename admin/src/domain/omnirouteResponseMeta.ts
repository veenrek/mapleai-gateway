import { getProviderAlias } from "@/shared/constants/providers";
import { OMNIROUTE_RESPONSE_HEADERS } from "@/shared/constants/headers";
import { APP_CONFIG } from "@/shared/constants/appConfig";

type UsageLike = Record<string, unknown> | null | undefined;

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toNonNegativeInteger(value: unknown): number {
  return Math.max(0, Math.round(toFiniteNumber(value)));
}

export function getMapleAITokenCounts(usage: UsageLike): { input: number; output: number } {
  if (!usage || typeof usage !== "object") {
    return { input: 0, output: 0 };
  }

  return {
    input: toNonNegativeInteger(
      usage.input ??
        usage.prompt_tokens ??
        usage.input_tokens ??
        usage.promptTokens ??
        usage.inputTokens
    ),
    output: toNonNegativeInteger(
      usage.output ??
        usage.completion_tokens ??
        usage.output_tokens ??
        usage.completionTokens ??
        usage.outputTokens
    ),
  };
}

export function formatMapleAICost(costUsd: unknown): string {
  const normalized = toFiniteNumber(costUsd);
  return normalized > 0 ? normalized.toFixed(10) : "0.0000000000";
}

export function buildMapleAIResponseMetaHeaders({
  cacheHit = false,
  costUsd = 0,
  costSavedUsd = undefined,
  fallbackAttempts = 0,
  latencyMs = 0,
  model = null,
  provider = null,
  requestId = null,
  usage = null,
}: {
  cacheHit?: boolean;
  costUsd?: unknown;
  /**
   * Cost the cache AVOIDED. A semantic-cache HIT serves at ≈0 incremental cost
   * (`costUsd: 0`) but saved the original call's cost — surface it here so billing
   * consumers don't charge for hits while analytics can still see what was saved.
   * Emitted as `X-MapleAI-Cost-Saved` only when provided (omitted on normal
   * responses); pass `0` to explicitly mark a free-model HIT that saved nothing.
   */
  costSavedUsd?: unknown;
  fallbackAttempts?: number;
  latencyMs?: unknown;
  model?: string | null;
  provider?: string | null;
  requestId?: string | null;
  usage?: UsageLike;
}): Record<string, string> {
  const tokens = getMapleAITokenCounts(usage);
  const headers: Record<string, string> = {
    [OMNIROUTE_RESPONSE_HEADERS.cacheHit]: String(cacheHit),
    [OMNIROUTE_RESPONSE_HEADERS.latencyMs]: String(toNonNegativeInteger(latencyMs)),
    [OMNIROUTE_RESPONSE_HEADERS.responseCost]: formatMapleAICost(costUsd),
    [OMNIROUTE_RESPONSE_HEADERS.tokensIn]: String(tokens.input),
    [OMNIROUTE_RESPONSE_HEADERS.tokensOut]: String(tokens.output),
    [OMNIROUTE_RESPONSE_HEADERS.version]: APP_CONFIG.version,
  };

  if (typeof model === "string" && model.trim().length > 0) {
    headers[OMNIROUTE_RESPONSE_HEADERS.model] = model;
  }

  if (typeof requestId === "string" && requestId.trim().length > 0) {
    headers[OMNIROUTE_RESPONSE_HEADERS.requestId] = requestId;
  }

  if (typeof provider === "string" && provider.trim().length > 0) {
    headers[OMNIROUTE_RESPONSE_HEADERS.provider] = getProviderAlias(provider);
  }

  // Cache-saved cost: emitted only when the caller passes a value (cache HITs), so
  // non-cache responses keep their existing header shape. `0` is a valid saved cost.
  if (costSavedUsd != null) {
    headers[OMNIROUTE_RESPONSE_HEADERS.costSaved] = formatMapleAICost(costSavedUsd);
  }

  const attempts = toNonNegativeInteger(fallbackAttempts);
  if (attempts > 0) {
    headers[OMNIROUTE_RESPONSE_HEADERS.fallbackAttempts] = String(attempts);
  }

  return headers;
}

export function buildMapleAISseMetadataComment(
  options: Parameters<typeof buildMapleAIResponseMetaHeaders>[0]
): string {
  const headers = buildMapleAIResponseMetaHeaders(options);
  const lines = Object.entries(headers)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([name, value]) => `: ${name.toLowerCase()}=${value}`);

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Single choke-point for attaching the X-MapleAI-* response meta headers.
 * Mutates `headers` in place (accepts a Headers instance OR a plain Record).
 * Use at EVERY non-streaming success return so no route forgets the telemetry.
 */
export function attachMapleAIMetaHeaders(
  headers: Headers | Record<string, string>,
  meta: Parameters<typeof buildMapleAIResponseMetaHeaders>[0]
): void {
  const built = buildMapleAIResponseMetaHeaders(meta);
  if (headers instanceof Headers) {
    for (const [name, value] of Object.entries(built)) headers.set(name, value);
  } else {
    Object.assign(headers, built);
  }
}

/**
 * Attach the X-MapleAI-* meta headers onto an already-built Response, ADDING
 * (never replacing) headers so the original Content-Type / body stay intact.
 * Tries to mutate in place; if the Response headers are immutable, clones the
 * Response carrying over body + status + headers (mirrors
 * `chatHelpers.ts::withSessionHeader`). Use for opaque handler-built Responses
 * (audio streams, passthrough proxies) where the body cannot be re-serialized.
 */
export function attachMapleAIMetaToResponse(
  response: Response,
  meta: Parameters<typeof buildMapleAIResponseMetaHeaders>[0]
): Response {
  if (!response) return response;

  try {
    attachMapleAIMetaHeaders(response.headers, meta);
    return response;
  } catch {
    const cloned = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    attachMapleAIMetaHeaders(cloned.headers, meta);
    return cloned;
  }
}

// ───── Backward-compat aliases (open-sse код пока на старых именах) ─────
export {
  getMapleAITokenCounts as getOmniRouteTokenCounts,
  formatMapleAICost as formatOmniRouteCost,
  buildMapleAIResponseMetaHeaders as buildOmniRouteResponseMetaHeaders,
  buildMapleAISseMetadataComment as buildOmniRouteSseMetadataComment,
  attachMapleAIMetaHeaders as attachOmniRouteMetaHeaders,
  attachMapleAIMetaToResponse as attachOmniRouteMetaToResponse,
};
