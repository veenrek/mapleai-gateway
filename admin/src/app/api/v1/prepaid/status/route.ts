import { getMarketplacePrepaidKeyStatus } from "@/lib/db/marketplace";
import { marketplaceJson } from "@/lib/marketplace/response";
import { rateLimitHit } from "@/lib/marketplace/rateLimit";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") || "unknown";
}

/**
 * Self-service status for a prepaid buyer key (oms_buy_...). The key itself is
 * the credential: send it as the Bearer token and get back validity, the
 * allowed models and the token budget with used/reserved/remaining counters.
 */
export async function GET(request: Request) {
  const limit = rateLimitHit(`prepaid-status:${clientIp(request)}`, { limit: 30, windowMs: 60_000 });
  if (!limit.allowed) {
    return marketplaceJson(
      { error: { message: "Too many status checks, try again later", type: "rate_limited" } },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds ?? 60) } }
    );
  }

  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const rawKey = match?.[1]?.trim();
  if (!rawKey) {
    return marketplaceJson(
      { error: { message: "Bearer prepaid key is required", type: "unauthorized" } },
      { status: 401 }
    );
  }

  const status = getMarketplacePrepaidKeyStatus(rawKey);
  if (!status) {
    return marketplaceJson(
      { error: { message: "Invalid prepaid key", type: "unauthorized" } },
      { status: 401 }
    );
  }

  return marketplaceJson({ object: "prepaid_key_status", ...status });
}
