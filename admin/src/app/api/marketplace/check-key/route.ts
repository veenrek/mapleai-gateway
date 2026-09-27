import { z } from "zod";
import { getMarketplacePrepaidKeyStatus } from "@/lib/db/marketplace";
import { resolveAllowedModels } from "@/lib/marketplace/allCombos";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
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
 * Public prepaid-key checker — no authentication. The key is supplied in the
 * POST body (never a URL, so it does not leak into access logs or history).
 * Rate-limited per client IP to blunt brute-force key guessing.
 */
export async function POST(request: Request) {
  const limit = rateLimitHit(`check-key:${clientIp(request)}`, { limit: 10, windowMs: 60_000 });
  if (!limit.allowed) {
    return marketplaceJson(
      { error: { message: "Too many key checks, try again later", type: "rate_limited" } },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds ?? 60) } }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  const parsed = z.object({ key: z.string().trim().min(1) }).safeParse(rawBody);
  if (!parsed.success) {
    return marketplaceError(400, "key is required", "invalid_request");
  }

  const status = getMarketplacePrepaidKeyStatus(parsed.data.key);
  if (!status) {
    // Same shape as an invalid key — no information about which keys exist.
    return marketplaceJson({ valid: false, reason: "not_found" });
  }

  const allowedModels = await resolveAllowedModels(status.allowedModels);
  return marketplaceJson({ ...status, allowedModels });
}
