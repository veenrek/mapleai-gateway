import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth.ts";
import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";
import { extractApiKey } from "@/sse/services/auth.ts";
import type { AuthOutcome, PolicyContext, RoutePolicy } from "../context";
import { allow, reject } from "../context";

function extractBearer(request: Request): string | null {
  const raw = request.headers.get("authorization") ?? request.headers.get("Authorization");
  const xApiKey = request.headers.get("x-api-key") ?? request.headers.get("X-Api-Key");
  if (raw) {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase().startsWith("bearer ")) {
      const token = trimmed.slice(7).trim();
      if (token) return token;
    }
    // A non-"Bearer <token>" Authorization header (an empty "Bearer ", or a
    // client's own non-MapleAI token — VS Code Copilot sends one even when the
    // MapleAI key lives in the URL path of a /vscode tokenized endpoint) must
    // NOT short-circuit auth. Fall through to x-api-key and the path-scoped URL
    // token below instead of rejecting the request with "Authentication required".
  }

  if (xApiKey) {
    return xApiKey.trim() || null;
  }

  return extractApiKey(request);
}

function maskKeyId(apiKey: string): string {
  const tail = apiKey.slice(-4);
  return `key_${tail}`;
}

export const clientApiPolicy: RoutePolicy = {
  routeClass: "CLIENT_API",
  async evaluate(ctx: PolicyContext): Promise<AuthOutcome> {
    const bearer = extractBearer(ctx.request as Request);
    if (!bearer) {
      if (await isDashboardSessionAuthenticated(ctx.request)) {
        return allow({ kind: "dashboard_session", id: "dashboard" });
      }

      if (!isRequireApiKeyEnabled()) {
        return allow({ kind: "anonymous", id: "local" });
      }

      return reject(401, "AUTH_002", "Authentication required");
    }

    // Marketplace prepaid buyer keys (oms_buy_*) are issued/administered in the
    // marketplace buyer-key store, not in the platform api_keys table. Accept
    // them here so the pipeline lets the request through; the route layer then
    // dispatches to the prepaid/marketplace billing handler and enforces budget.
    if (bearer.startsWith("oms_buy_")) {
      const { getMarketplaceBuyerKeyByApiKey, findMarketplaceBuyerKeyByApiKeyAnyStatus } =
        await import("@/lib/db/marketplace");
      const buyerKey = getMarketplaceBuyerKeyByApiKey(bearer);
      if (!buyerKey) {
        // The self-service status endpoint must stay reachable for exhausted or
        // disabled keys — that is where the holder learns why the key stopped
        // working. Every other route keeps rejecting non-active keys here.
        if (ctx.classification.normalizedPath === "/api/v1/prepaid/status") {
          const anyStatusKey = findMarketplaceBuyerKeyByApiKeyAnyStatus(bearer);
          if (anyStatusKey) {
            return allow({ kind: "client_api_key", id: maskKeyId(bearer) });
          }
        }
        return reject(401, "AUTH_002", "Invalid marketplace buyer key");
      }
      return allow({ kind: "client_api_key", id: maskKeyId(bearer) });
    }

    const { validateApiKey } = await import("../../../lib/db/apiKeys");
    const ok = await validateApiKey(bearer);
    if (!ok) {
      // Issue #2257: when REQUIRE_API_KEY is off, a stale CLI config (Codex
      // Desktop auto-config, Hermes, etc.) carrying an invalid Bearer
      // shouldn't 401 the whole request — REQUIRE_API_KEY=false means
      // "anonymous traffic is allowed", so an invalid key should degrade to
      // anonymous instead of rejecting. We log a warning so the bad key is
      // still observable in the request log.
      if (!isRequireApiKeyEnabled()) {
        console.warn(
          `[clientApiPolicy] invalid bearer presented to ${ctx.classification.normalizedPath} ` +
            `but REQUIRE_API_KEY=false — falling through to anonymous (key_id=${maskKeyId(bearer)})`
        );
        return allow({ kind: "anonymous", id: "local" });
      }
      return reject(401, "AUTH_002", "Invalid API key");
    }

    return allow({ kind: "client_api_key", id: maskKeyId(bearer) });
  },
};
