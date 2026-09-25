import { issueMarketplaceAuthNonce, normalizeWalletAddress } from "@/lib/db/marketplaceUsers";
import { buildSiweMessage } from "@/lib/marketplace/crypto/siwe";
import { rateLimitHit } from "@/lib/marketplace/rateLimit";
import { authNonceSchema } from "@/lib/marketplace/schemas";
import { marketplaceError, marketplaceJson, marketplaceRateLimited } from "@/lib/marketplace/response";
import { getClientIpFromRequest } from "@/lib/ipUtils";
import { handleCorsOptions } from "@/shared/utils/cors";

// Cap nonce issuance per client so an attacker cannot flood the nonce table.
const NONCE_LIMIT = 20;
const NONCE_WINDOW_MS = 60_000;

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * Issue a single-use SIWE nonce and the exact message the wallet should sign.
 * The client signs `message` with personal_sign and posts it to /auth/verify.
 */
export async function POST(request: Request) {
  const ip = getClientIpFromRequest(request);
  const limit = rateLimitHit(`nonce:${ip}`, { limit: NONCE_LIMIT, windowMs: NONCE_WINDOW_MS });
  if (!limit.allowed) return marketplaceRateLimited(limit.retryAfterSeconds);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  const parsed = authNonceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return marketplaceError(400, parsed.error.issues[0]?.message || "Invalid payload");
  }

  const wallet = normalizeWalletAddress(parsed.data.wallet);
  const nonce = issueMarketplaceAuthNonce(wallet);
  const issuedAt = new Date().toISOString();
  const domain = request.headers.get("host") || "omniroute.local";
  const message = buildSiweMessage({ domain, walletAddress: wallet, nonce, issuedAt });

  return marketplaceJson({ nonce, issuedAt, message });
}
