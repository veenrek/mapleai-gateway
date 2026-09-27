import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { callCloudWithMachineId } from "@/shared/utils/cloud";
import { handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { createInjectionGuard } from "@/middleware/promptInjectionGuard";
import { authenticateMarketplaceBuyer } from "@/lib/marketplace/auth";
import { handleMarketplaceChatCompletion } from "@/lib/marketplace/proxyChat";
import { handlePrepaidChatCompletion } from "@/lib/marketplace/prepaidChat";
import { marketplaceError } from "@/lib/marketplace/response";
import { checkKillSwitch } from "@/server/killSwitch/manager";
import { authenticatePrepaidGatewayBuyer, isPrepaidGatewayRequest } from "@/lib/marketplace/prepaidGateway";

let initPromise = null;

// Singleton injection guard instance
const injectionGuard = createInjectionGuard();

/**
 * Initialize translators once (Promise-based singleton — no race condition)
 */
function ensureInitialized() {
  if (!initPromise) {
    initPromise = Promise.resolve(initTranslators()).then(() => {
      console.log("[SSE] Translators initialized");
    });
  }
  return initPromise;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return handleCorsOptions();
}

export async function POST(request) {
  await ensureInitialized();

  // Operator kill switch (global) — cheap DB-cached check before any work.
  if (checkKillSwitch({}).active) {
    return new Response(
      JSON.stringify({
        error: {
          code: "kill_switch_active",
          message: "Service temporarily disabled by operator kill switch.",
        },
      }),
      { status: 503, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

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
    // Admin-issued prepaid keys (token budget) bypass marketplace listings
    // entirely — model name resolves directly to a combo or provider model.
    if (buyerKey.tokenBudgetTotal != null) {
      return handlePrepaidChatCompletion(request, buyerKey);
    }
    return handleMarketplaceChatCompletion(request, buyerKey);
  }

  // One-line marker for diagnosing 413 / Server-Action interceptions.
  // Logs only when Content-Length is present so debug noise stays low for
  // typical chat payloads. Toggle off via OMNIROUTE_LOG_REQUEST_SHAPE=0.
  if (process.env.OMNIROUTE_LOG_REQUEST_SHAPE !== "0") {
    const ct = request.headers.get("content-type") ?? "";
    const cl = request.headers.get("content-length");
    if (cl && Number(cl) > 256 * 1024) {
      console.error(`[CHAT-ROUTE] large body content-type="${ct}" content-length=${cl}`);
    }
  }

  // Prompt injection guard — inspect body before forwarding. Parse the body ONCE here
  // and thread it to handleChat so the handler does not JSON-parse the (often 270-550 KB)
  // coding-agent payload a second time — the double parse doubled the body's heap
  // residency on the hot path and fed the OOM crash-loop (#4380).
  let parsedBody = null;
  try {
    const cloned = request.clone();
    parsedBody = await cloned.json().catch(() => null);
    if (parsedBody) {
      // Scoped kill switch (model-level) — body is already parsed here, so
      // this costs nothing extra on the hot path.
      const ksHit = checkKillSwitch({ model: parsedBody?.model });
      if (ksHit.active) {
        return new Response(
          JSON.stringify({
            error: {
              code: "kill_switch_active",
              message: ksHit.reason || "Service temporarily disabled by operator kill switch.",
            },
          }),
          { status: 503, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }
      const { blocked, result } = injectionGuard(parsedBody);
      if (blocked) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Request blocked: potential prompt injection detected",
              type: "injection_detected",
              code: "SECURITY_001",
              detections: result.detections.length,
            },
          }),
          { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }
    }
  } catch (error) {
    console.error("[SECURITY] Prompt injection guard failed:", error);
  }

  return await handleChat(request, null, parsedBody);
}
