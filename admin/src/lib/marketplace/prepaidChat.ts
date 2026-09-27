import { handleChat } from "@/sse/handlers/chat";
import { createInjectionGuard } from "@/middleware/promptInjectionGuard";
import {
  reservePrepaidTokens,
  settlePrepaidTokens,
  MarketplaceDbError,
  type MarketplaceBuyerKey,
} from "@/lib/db/marketplace";
import { getComboByName } from "@/lib/localDb";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import {
  estimateCompletionReserveTokens,
  estimatePromptTokens,
  extractUsageFromResponseBody,
  type TokenUsage,
} from "./pricing";
import { marketplaceError } from "./response";
import { resolveAllowedModels } from "./allCombos";
import { checkKillSwitch } from "@/server/killSwitch/manager";

const injectionGuard = createInjectionGuard();

let initPromise: Promise<unknown> | null = null;
function ensureInitialized(): Promise<unknown> {
  if (!initPromise) initPromise = Promise.resolve(initTranslators());
  return initPromise;
}

/** Extract token usage from an SSE "data: {...}" line (mirrors proxyChat logic). */
function extractUsageFromSseLine(line: string): TokenUsage | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload) as {
      type?: string;
      usage?: Record<string, unknown>;
      response?: { usage?: Record<string, unknown> };
    };
    // Chat Completions chunks carry { usage } at top level; Responses API's
    // terminal `response.completed` event nests it under `response.usage`.
    const usage =
      parsed.usage ?? (parsed.type === "response.completed" ? parsed.response?.usage : undefined);
    if (!usage || typeof usage !== "object") return null;
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
    const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
    const total = Number(usage.total_tokens ?? prompt + completion) || prompt + completion;
    return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
  } catch {
    return null;
  }
}

function ensureObjectBody(body: unknown): body is Record<string, unknown> {
  return !!body && typeof body === "object" && !Array.isArray(body);
}

/**
 * Direct prepaid pipeline: no marketplace listing, no USD billing.
 *
 * buyer prepaid key (tokens budget) ──> combo by name ──> upstream accounts
 *   reserve(request) → proxy → settle(actual usage)
 */
export async function handlePrepaidChatCompletion(
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
    return marketplaceError(400, "Missing model", "invalid_request");
  }
  const injection = injectionGuard(body);
  if (injection.blocked) {
    return marketplaceError(
      400,
      "Request blocked: potential prompt injection detected",
      "security"
    );
  }

  const publicModel = body.model.trim();
  if (publicModel === "jev-latest" || publicModel.startsWith("gpt-image-") || publicModel === "grok-imagine-image") {
    return marketplaceError(403, "Prepaid keys are not available for this model", "forbidden");
  }

  // Kill switch: global is already checked in the route layer; enforce the
  // scoped (model) level here where the resolved model name is known.
  const ksHit = checkKillSwitch({ model: publicModel });
  if (ksHit.active) {
    return marketplaceError(
      503,
      ksHit.reason || "Service temporarily disabled by operator kill switch",
      "kill_switch_active"
    );
  }

  // Whitelist enforcement at the key level.
  // Bypass-proof: клиент может прислать "by/gpt-5.6-sol" вместо "gpt-5.6-sol".
  // Сравниваем БЕЗ провайдер-префикса — иначе whitelist пропускает
  // любой nexo/ttm/… путь, хотя запись разрешала только публичное имя.
  // The __all_combos__ marker resolves to every active combo at request time.
  const allowedModels = await resolveAllowedModels(buyerKey.allowedModels);
  if (allowedModels.length > 0) {
    const baseModel = publicModel.includes("/")
      ? (publicModel.split("/").pop() as string)
      : publicModel;
    if (!allowedModels.includes(baseModel) && !allowedModels.includes(publicModel)) {
      return marketplaceError(403, "Buyer key is not allowed to use this model", "forbidden");
    }
  }

  // Route target: a combo whose name matches the requested model. Plain
  // provider-prefixed ids (ttm/gpt-5.6-sol) work too — core routing resolves them.
  const combo = await getComboByName(publicModel);
  const isProviderModel = publicModel.includes("/");
  if (!combo && !isProviderModel) {
    return marketplaceError(404, "Model not available", "not_found");
  }

  const promptEstimate = estimatePromptTokens(body);
  const completionReserve = estimateCompletionReserveTokens(body);
  const reservedTokens = promptEstimate + completionReserve;

  try {
    reservePrepaidTokens(buyerKey.id, reservedTokens);
  } catch (error) {
    if (error instanceof MarketplaceDbError) return marketplaceError(error.status, error.message);
    throw error;
  }

  const settle = (actual: number | null, ok: boolean) => {
    try {
      settlePrepaidTokens(buyerKey.id, reservedTokens, actual, ok);
    } catch (e) {
      console.error("[prepaid] settle failed:", e);
    }
  };

  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("x-prepaid-request", "1");
  // Preserve the buyer key on the internal call so usage_history rows get
  // api_key_id attribution (per-buyer / per-upstream stats).
  const buyerBearer = request.headers.get("authorization") || request.headers.get("Authorization");
  if (buyerBearer) headers.set("authorization", buyerBearer);
  const internalRequest = new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify({ ...body, model: publicModel }),
    signal: request.signal,
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await handleChat(internalRequest, null, body);
  } catch (error) {
    settle(null, false);
    console.error("[prepaid] upstream call failed:", error);
    return marketplaceError(502, "Upstream call failed", "upstream_error");
  }

  if (!upstreamResponse.ok) {
    settle(null, false);
    return upstreamResponse;
  }

  const contentType = upstreamResponse.headers.get("content-type") || "";

  // --- Non-stream: read the body, charge actual usage, pass through. ---
  if (!contentType.includes("text/event-stream")) {
    try {
      const text = await upstreamResponse.text();
      let usage: TokenUsage | null = null;
      try {
        usage = extractUsageFromResponseBody(JSON.parse(text));
      } catch {
        // Non-JSON success body — charge the full reservation below.
      }
      settle(usage?.totalTokens ?? null, true);
      return new Response(text, {
        status: upstreamResponse.status,
        headers: upstreamResponse.headers,
      });
    } catch (error) {
      settle(null, false);
      return marketplaceError(502, "Failed to read upstream response", "upstream_error");
    }
  }

  // --- Stream: wrap SSE, capture usage from the trailer chunk, settle at EOF. ---
  if (!upstreamResponse.body) {
    settle(null, false);
    return marketplaceError(502, "Empty upstream stream", "upstream_error");
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let captured: TokenUsage | null = null;
  let finished = false;

  const finalize = (ok: boolean) => {
    if (finished) return;
    finished = true;
    // When the usage trailer is lost but the request succeeded, charge the
    // full reservation — dropping it provably under-billed TTM traffic
    // (24.5M uncounted while upstream burned real tokens).
    settle(captured?.totalTokens ?? null, ok);
  };

  // Abort/cancel cleanup: the upstream cost is incurred regardless of when the
  // client disconnects, so NEVER release the reservation for free. Instead, keep
  // draining the upstream stream in the background to capture the real usage
  // trailer (Responses API sends it in `response.completed`), then settle with
  // actual tokens (falling back to the reservation when usage never arrives).
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let clientGone = false;

  const startBackgroundDrain = () => {
    if (finished || clientGone) return;
    clientGone = true;
    // Safety net: settle no later than 3 minutes even if the stream hangs.
    drainTimer = setTimeout(() => finalize(true), 180_000);
    (async () => {
      try {
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const idx = buffer.lastIndexOf("\n\n");
          if (idx < 0) continue;
          const complete = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of complete.split("\n")) {
            const usage = extractUsageFromSseLine(line);
            if (usage) captured = usage;
          }
        }
      } catch {
        /* upstream died — settle with whatever usage we have */
      } finally {
        finalize(true);
      }
    })();
  };

  request.signal.addEventListener("abort", startBackgroundDrain, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (clientGone) return; // background drain owns the upstream reader now
      try {
        const { done, value } = await reader.read();
        if (done) {
          for (const line of buffer.split("\n")) {
            const usage = extractUsageFromSseLine(line);
            if (usage) captured = usage;
          }
          controller.close();
          if (drainTimer) clearTimeout(drainTimer);
          finalize(true);
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const idx = buffer.lastIndexOf("\n\n");
        if (idx >= 0) {
          const complete = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of complete.split("\n")) {
            const usage = extractUsageFromSseLine(line);
            if (usage) captured = usage;
          }
        }
        controller.enqueue(value);
      } catch (error) {
        // Client-cancelled controllers throw on enqueue() — that is an expected
        // transition, the background drain keeps billing from real usage.
        if (clientGone) return;
        controller.error(error);
        if (drainTimer) clearTimeout(drainTimer);
        finalize(false);
      }
    },
    cancel() {
      startBackgroundDrain();
    },
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  return new Response(stream, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}
