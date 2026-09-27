import { handleChat } from "@/sse/handlers/chat";
import { withEarlyStreamKeepalive } from "@omniroute/open-sse/utils/earlyStreamKeepalive";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { resolveResponsesApiModel } from "@/app/api/internal/codex-responses-ws/modelResolution";
import { getModelInfo } from "@/sse/services/model";
import { getComboByName } from "@/lib/db/combos";
import { resolveKeepaliveThreshold } from "@omniroute/open-sse/utils/keepaliveThreshold";
import { authenticateMarketplaceBuyer } from "@/lib/marketplace/auth";
import { handleMarketplaceChatCompletion } from "@/lib/marketplace/proxyChat";
import { handlePrepaidChatCompletion } from "@/lib/marketplace/prepaidChat";
import { marketplaceError } from "@/lib/marketplace/response";
import { authenticatePrepaidGatewayBuyer, isPrepaidGatewayRequest } from "@/lib/marketplace/prepaidGateway";

// NOTE: We do NOT call initTranslators() here — the translator registry is
// bootstrapped at module level inside open-sse/translator/index.ts when it
// is first imported. Calling it again from a Next.js Route Handler caused a
// "the worker has exited" uncaughtException crash on Codex CLI requests (#450)
// because the dynamic import runs in a Next.js server worker context where
// certain Node APIs used by the translator bootstrap are not available.
// The translators are always initialized via the open-sse side (chatCore),
// so /v1/responses just delegates to handleChat which handles everything.

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * Rewrite a bare ChatGPT-style model id to the codex/ prefix when the model
 * resolves to a codex provider. This fixes the Codex CLI WS→HTTP fallback path:
 * the CLI sends bare "gpt-5.5" over HTTP after WS closes (1008 Policy), and
 * without this rewrite MapleAI routes it to openrouter instead of codex.
 *
 * Safe: only rewrites when codex/model is genuinely registered; all other models
 * pass through unchanged. Errors are caught and the original request is returned.
 */
export async function withCodexPreferredModel(request: Request): Promise<Request> {
  try {
    const clone = request.clone();
    const body = await clone.json().catch(() => null);
    if (!body || typeof body !== "object" || typeof body.model !== "string") {
      return request;
    }
    const { model, changed } = await resolveResponsesApiModel(
      body.model,
      getModelInfo,
      async (name) => !!(await getComboByName(name))
    );
    if (!changed) return request;

    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify({ ...body, model }),
      signal: request.signal,
    });
  } catch {
    return request;
  }
}

/**
 * POST /v1/responses - OpenAI Responses API format
 * Handled by the unified chat handler (openai-responses format auto-detected).
 */
async function postHandler(request, context) {
  // Marketplace buyer keys (oms_buy_*) — billing pipeline. Prepaid keys settle
  // token budget directly; account-based keys go through listings.
  const authHeader = request.headers.get("authorization") || "";
  if (isPrepaidGatewayRequest(request)) {
    const buyerKey = authenticatePrepaidGatewayBuyer(request);
    if (!buyerKey) return marketplaceError(401, "Invalid prepaid buyer key", "unauthorized");
    return handlePrepaidChatCompletion(request, buyerKey);
  }
  if (authHeader.startsWith("Bearer oms_buy_")) {
    const buyerKey = authenticateMarketplaceBuyer(request);
    if (!buyerKey) {
      return marketplaceError(401, "Invalid marketplace buyer key", "unauthorized");
    }
    if (buyerKey.tokenBudgetTotal != null) {
      return handlePrepaidChatCompletion(request, buyerKey);
    }
    return handleMarketplaceChatCompletion(request, buyerKey);
  }

  // Codex CLI (wire_api="responses") consumes this endpoint over SSE and its reqwest
  // client drops the connection if no bytes arrive within ~5s. Keep the connection
  // warm with early keepalives while the upstream produces its first token (#2544).
  // Non-streaming callers (JSON) keep the original verbatim path untouched.
  const resolved = await withCodexPreferredModel(request);
  const accept = String(request.headers?.get?.("accept") || "").toLowerCase();
  if (accept.includes("text/event-stream")) {
    // Adaptive threshold: web-session and anonymous-fallback providers are slower
    // to produce the first byte, so use a longer keepalive threshold (15s vs 2s).
    let model;
    try {
      const body = await resolved.clone().json().catch(() => null);
      model = body?.model;
    } catch {
    }
    const thresholdMs = resolveKeepaliveThreshold(model);
    return await withEarlyStreamKeepalive(handleChat(resolved), {
      signal: request.signal,
      thresholdMs,
    });
  }
  return await handleChat(resolved);
}

export const POST = withInjectionGuard(postHandler);
