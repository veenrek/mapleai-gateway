import {
  consumeMarketplaceAuthNonce,
  getOrCreateMarketplaceUserByWallet,
  normalizeWalletAddress,
  touchMarketplaceUserLogin,
} from "@/lib/db/marketplaceUsers";
import { buildSiweMessage, verifySiweSignature } from "@/lib/marketplace/crypto/siwe";
import { rateLimitHit } from "@/lib/marketplace/rateLimit";
import { authVerifySchema } from "@/lib/marketplace/schemas";
import { isAdminWallet } from "@/lib/auth/adminWallets";
import {
  marketplaceError,
  marketplaceJson,
  marketplaceRateLimited,
} from "@/lib/marketplace/response";
import { MARKETPLACE_SESSION_COOKIE, signMarketplaceSession } from "@/lib/marketplace/session";
import { getClientIpFromRequest } from "@/lib/ipUtils";
import { handleCorsOptions } from "@/shared/utils/cors";

// Cap signature-verification attempts per client (brute-force defense).
const VERIFY_LIMIT = 10;
const VERIFY_WINDOW_MS = 60_000;

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * Verify a SIWE signature and, on success, create/lookup the marketplace user
 * and set an httpOnly session cookie. The signed message is reconstructed from
 * the server-issued nonce so a client cannot substitute a different message.
 */
export async function POST(request: Request) {
  const ip = getClientIpFromRequest(request);
  const limit = rateLimitHit(`verify:${ip}`, { limit: VERIFY_LIMIT, windowMs: VERIFY_WINDOW_MS });
  if (!limit.allowed) return marketplaceRateLimited(limit.retryAfterSeconds);

  if (!process.env.JWT_SECRET) {
    return marketplaceError(500, "Server misconfigured: JWT_SECRET not set", "server_error");
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  const parsed = authVerifySchema.safeParse(rawBody);
  if (!parsed.success) {
    return marketplaceError(400, parsed.error.issues[0]?.message || "Invalid payload");
  }

  const wallet = normalizeWalletAddress(parsed.data.wallet);

  // Consume the nonce first (single-use); a replayed or foreign nonce fails here.
  if (!consumeMarketplaceAuthNonce(parsed.data.nonce, wallet)) {
    return marketplaceError(401, "Invalid or expired nonce", "unauthorized");
  }

  const domain = request.headers.get("host") || "omniroute.local";
  const message = buildSiweMessage({
    domain,
    walletAddress: wallet,
    nonce: parsed.data.nonce,
    issuedAt: parsed.data.issuedAt,
  });

  if (!verifySiweSignature({ message, signature: parsed.data.signature, walletAddress: wallet })) {
    return marketplaceError(401, "Signature verification failed", "unauthorized");
  }

  // Single-seller mode: only allowlisted operator wallets may hold a marketplace
  // account. Public registration stays closed until the platform opens to sellers.
  if (!isAdminWallet(wallet)) {
    return marketplaceError(
      403,
      "Registration is currently closed — only the operator wallet can sign in",
      "forbidden"
    );
  }

  const user = getOrCreateMarketplaceUserByWallet(wallet);
  touchMarketplaceUserLogin(user.id);

  const token = await signMarketplaceSession({
    marketplaceUserId: user.id,
    walletAddress: user.walletAddress,
  });

  const forceSecure = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = (request.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
  const secure = forceSecure || forwardedProto === "https";
  const cookie = [
    `${MARKETPLACE_SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=2592000",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");

  return marketplaceJson(
    {
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
        balanceMicroUsd: user.balanceMicroUsd,
      },
    },
    { headers: { "Set-Cookie": cookie } }
  );
}
