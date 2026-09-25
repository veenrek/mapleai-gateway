import { randomUUID } from "crypto";
import { handleChat } from "@/sse/handlers/chat";
import { createInjectionGuard } from "@/middleware/promptInjectionGuard";
import {
  finalizeMarketplaceUsage,
  getActiveMarketplaceListingByPublicModel,
  markMarketplaceListingCoolingDown,
  markMarketplaceSellerConnectionCoolingDown,
  MarketplaceDbError,
  reserveMarketplaceUsage,
  resolveMarketplaceFailoverTargets,
  type MarketplaceBuyerKey,
  type MarketplaceFailoverTarget,
  type MarketplaceListing,
} from "@/lib/db/marketplace";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import {
  calculateMarketplaceChargeMicroUsd,
  estimateCompletionReserveTokens,
  estimatePromptTokens,
  extractUsageFromResponseBody,
  fallbackUsageFromReservation,
  type TokenUsage,
} from "./pricing";
import { marketplaceError } from "./response";

let initPromise: Promise<void> | null = null;
const injectionGuard = createInjectionGuard();

function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = Promise.resolve(initTranslators()).then(() => undefined);
  }
  return initPromise;
}

function cloneHeadersForInternalRequest(headers: Headers): Headers {
  const internalHeaders = new Headers(headers);
  internalHeaders.delete("authorization");
  internalHeaders.delete("Authorization");
  internalHeaders.delete("x-api-key");
  internalHeaders.delete("X-Api-Key");
  internalHeaders.delete("content-length");
  internalHeaders.delete("Content-Length");
  internalHeaders.delete("host");
  internalHeaders.delete("Host");
  return internalHeaders;
}

function jsonResponseFromError(error: unknown): Response {
  if (error instanceof MarketplaceDbError) {
    return marketplaceError(error.status, error.message);
  }
  return marketplaceError(500, "Marketplace proxy failed", "server_error");
}

function classifyUpstreamLimit(
  status: number,
  text: string
): { code: string; cooldownMs: number } | null {
  const normalized = text.toLowerCase();
  if (status === 429) {
    const quotaLike =
      normalized.includes("quota") ||
      normalized.includes("limit") ||
      normalized.includes("exceeded") ||
      normalized.includes("too many requests");
    return {
      code: quotaLike ? "UPSTREAM_LIMIT_EXHAUSTED" : "UPSTREAM_RATE_LIMITED",
      cooldownMs: 60 * 60 * 1000,
    };
  }
  if (
    status === 402 ||
    (status === 403 &&
      (normalized.includes("quota") ||
        normalized.includes("credit") ||
        normalized.includes("billing") ||
        normalized.includes("insufficient")))
  ) {
    return { code: "UPSTREAM_QUOTA_EXHAUSTED", cooldownMs: 24 * 60 * 60 * 1000 };
  }
  return null;
}

function applyListingCooldown(
  listing: MarketplaceListing,
  status: number,
  text: string
): string | null {
  const limit = classifyUpstreamLimit(status, text);
  if (!limit) return null;
  const cooldownUntil = new Date(Date.now() + limit.cooldownMs).toISOString();
  markMarketplaceListingCoolingDown({
    listingId: listing.id,
    cooldownUntil,
    errorCode: limit.code,
    errorMessage: text || `Upstream returned ${status}`,
  });
  return cooldownUntil;
}

function applyConnectionCooldown(
  target: MarketplaceFailoverTarget,
  status: number,
  text: string
): string | null {
  const limit = classifyUpstreamLimit(status, text);
  if (!limit) return null;
  const cooldownUntil = new Date(Date.now() + limit.cooldownMs).toISOString();
  markMarketplaceSellerConnectionCoolingDown({
    sellerId: target.connection.sellerId,
    connectionId: target.connection.connectionId,
    cooldownUntil,
    errorCode: limit.code,
    errorMessage: text || `Upstream returned ${status}`,
  });
  return cooldownUntil;
}

function ensureObjectBody(body: unknown): body is Record<string, unknown> {
  return Boolean(body && typeof body === "object" && !Array.isArray(body));
}

function buildMapleAIModel(listing: MarketplaceListing): string {
  // Combo-backed listing: the combo NAME is the routing target — omniroute's
  // handleChat resolves it through the combo engine (strategies + fallback).
  if (listing.comboId) return listing.upstreamModel;
  const providerPrefix = `${listing.provider}/`;
  return listing.upstreamModel.startsWith(providerPrefix)
    ? listing.upstreamModel
    : `${listing.provider}/${listing.upstreamModel}`;
}

function extractUsageFromSseLine(line: string): TokenUsage | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return extractUsageFromResponseBody(JSON.parse(payload));
  } catch {
    return null;
  }
}

function finalizeSucceededUsage(
  usageEventId: string,
  listing: MarketplaceListing,
  usage: TokenUsage,
  upstreamStatus: number
) {
  const charge = calculateMarketplaceChargeMicroUsd(listing, usage);
  return finalizeMarketplaceUsage({
    usageEventId,
    status: "succeeded",
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    chargedMicroUsd: charge,
    upstreamStatus,
  });
}

function createAccountingSseStream(
  upstreamBody: ReadableStream<Uint8Array>,
  usageEventId: string,
  listing: MarketplaceListing,
  reservedPromptTokens: number,
  reservedCompletionTokens: number,
  upstreamStatus: number
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  let latestUsage: TokenUsage | null = null;
  let finalized = false;

  const processText = (text: string, flush = false) => {
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = flush ? "" : lines.pop() || "";
    for (const line of lines) {
      latestUsage = extractUsageFromSseLine(line) || latestUsage;
    }
    if (flush && pending) {
      latestUsage = extractUsageFromSseLine(pending) || latestUsage;
      pending = "";
    }
  };

  const finalize = (status: "succeeded" | "failed", errorMessage?: string) => {
    if (finalized) return;
    if (status === "failed") {
      finalizeMarketplaceUsage({
        usageEventId,
        status: "failed",
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        chargedMicroUsd: 0,
        upstreamStatus,
        errorMessage,
      });
      finalized = true;
      return;
    }

    const usage =
      latestUsage || fallbackUsageFromReservation(reservedPromptTokens, reservedCompletionTokens);
    finalizeSucceededUsage(usageEventId, listing, usage, upstreamStatus);
    finalized = true;
  };

  const reader = upstreamBody.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          processText(decoder.decode(), true);
          finalize("succeeded");
          controller.close();
          return;
        }
        processText(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      } catch (error) {
        finalize("failed", error instanceof Error ? error.message : "SSE stream failed");
        throw error;
      }
    },
    async cancel(reason) {
      finalize("failed", reason instanceof Error ? reason.message : "SSE stream cancelled");
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

async function responseToFinalizedResponse(
  upstreamResponse: Response,
  usageEventId: string,
  listing: MarketplaceListing,
  target: MarketplaceFailoverTarget,
  canFailover: boolean,
  reservedPromptTokens: number,
  reservedCompletionTokens: number
): Promise<{ response: Response; retryableLimit: boolean }> {
  const contentType = upstreamResponse.headers.get("content-type") || "";
  const status = upstreamResponse.status;
  const headers = new Headers(upstreamResponse.headers);
  headers.set("x-marketplace-usage-event", usageEventId);

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text();
    const connectionCooldownUntil = applyConnectionCooldown(target, status, text);
    finalizeMarketplaceUsage({
      usageEventId,
      status: "failed",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      chargedMicroUsd: 0,
      upstreamStatus: status,
      errorMessage: text.slice(0, 500),
    });
    if (connectionCooldownUntil) {
      if (canFailover) {
        return {
          response: marketplaceError(503, "Retrying another seller account"),
          retryableLimit: true,
        };
      }
      const listingCooldownUntil =
        applyListingCooldown(listing, status, text) || connectionCooldownUntil;
      return {
        response: marketplaceError(
          429,
          `Seller account group limit reached. Listing is cooling down until ${listingCooldownUntil}. Reservation refunded.`,
          "upstream_limit_exhausted"
        ),
        retryableLimit: false,
      };
    }
    return { response: new Response(text, { status, headers }), retryableLimit: false };
  }

  if (contentType.includes("text/event-stream")) {
    if (!upstreamResponse.body) {
      finalizeMarketplaceUsage({
        usageEventId,
        status: "failed",
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        chargedMicroUsd: 0,
        upstreamStatus: status,
        errorMessage: "Upstream SSE response body is empty",
      });
      return { response: new Response(null, { status: 502, headers }), retryableLimit: false };
    }
    return {
      response: new Response(
        createAccountingSseStream(
          upstreamResponse.body,
          usageEventId,
          listing,
          reservedPromptTokens,
          reservedCompletionTokens,
          status
        ),
        { status, headers }
      ),
      retryableLimit: false,
    };
  }

  const text = await upstreamResponse.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  const usage =
    extractUsageFromResponseBody(parsed) ||
    fallbackUsageFromReservation(reservedPromptTokens, reservedCompletionTokens);
  const finalized = finalizeSucceededUsage(usageEventId, listing, usage, status);
  headers.set("x-marketplace-charged-micro-usd", String(finalized.chargedMicroUsd));
  return { response: new Response(text, { status, headers }), retryableLimit: false };
}

export async function handleMarketplaceChatCompletion(
  request: Request,
  buyerKey: MarketplaceBuyerKey
): Promise<Response> {
  await ensureInitialized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  if (!ensureObjectBody(body) || typeof body.model !== "string" || body.model.trim() === "") {
    return marketplaceError(400, "Missing marketplace model", "invalid_request");
  }

  const injectionResult = injectionGuard(body);
  if (injectionResult.blocked) {
    return marketplaceError(
      400,
      "Request blocked: potential prompt injection detected",
      "security"
    );
  }

  const publicModel = body.model.trim();
  const reservedPromptTokens = estimatePromptTokens(body);
  const reservedCompletionTokens = estimateCompletionReserveTokens(body);
  const requestId = request.headers.get("x-request-id") || randomUUID();

  const listing = getActiveMarketplaceListingByPublicModel(publicModel);
  if (!listing) return marketplaceError(404, "Marketplace model not found", "not_found");
  const reservedMicroUsd = calculateMarketplaceChargeMicroUsd(listing, {
    promptTokens: reservedPromptTokens,
    completionTokens: reservedCompletionTokens,
  });

  let targets = resolveMarketplaceFailoverTargets(listing.id);
  if (targets.length === 0) {
    targets = [
      {
        listing,
        connection: {
          sellerId: listing.sellerId,
          connectionId: listing.connectionId,
          provider: listing.provider,
          displayName: null,
          accountGroup: "default",
          cooldownUntil: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          lastErrorAt: null,
          createdAt: listing.createdAt,
        },
      },
    ];
  }

  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < targets.length; attempt += 1) {
    const target = targets[attempt];
    let reservation: ReturnType<typeof reserveMarketplaceUsage>;
    try {
      reservation = reserveMarketplaceUsage({
        buyerKeyId: buyerKey.id,
        publicModel,
        requestId: attempt === 0 ? requestId : `${requestId}:failover:${attempt}`,
        reservedPromptTokens,
        reservedCompletionTokens,
        reservedMicroUsd,
        connectionId: target.connection.connectionId,
        skipListingLimits: attempt > 0,
      });
    } catch (error) {
      return jsonResponseFromError(error);
    }

    const proxiedBody = {
      ...body,
      model: buildMapleAIModel(target.listing),
      ...(!("max_tokens" in body) && !("max_completion_tokens" in body)
        ? { max_tokens: reservedCompletionTokens }
        : {}),
    };
    const headers = cloneHeadersForInternalRequest(request.headers);
    headers.set("content-type", "application/json");
    // Combo-backed listings route freely through the combo engine — pinning a
    // single connection would defeat its strategy/fallback selection.
    if (!target.listing.comboId) {
      headers.set("x-omniroute-connection", target.connection.connectionId);
    }
    headers.set("x-marketplace-request-id", requestId);
    const internalRequest = new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(proxiedBody),
      signal: request.signal,
    });

    try {
      const upstreamResponse = await handleChat(internalRequest, null, proxiedBody);
      const result = await responseToFinalizedResponse(
        upstreamResponse,
        reservation.usageEvent.id,
        target.listing,
        target,
        attempt < targets.length - 1,
        reservedPromptTokens,
        reservedCompletionTokens
      );
      if (!result.retryableLimit) return result.response;
      lastResponse = result.response;
      continue;
    } catch (error) {
      try {
        finalizeMarketplaceUsage({
          usageEventId: reservation.usageEvent.id,
          status: "failed",
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          chargedMicroUsd: 0,
          errorMessage: error instanceof Error ? error.message : "Marketplace proxy failed",
        });
      } catch {
        // The request is already failing; do not mask the upstream error with accounting failure.
      }
      return jsonResponseFromError(error);
    }
  }

  if (lastResponse) return lastResponse;
  return marketplaceError(503, "No seller account in this group is currently available");
}
