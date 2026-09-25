import {
  getMarketplaceBuyerKeyByApiKey,
  getMarketplaceSellerByApiKey,
  getMarketplaceSellerByUserId,
  getOrCreateSellerForUser,
  getSellerRegistrationMode,
  type MarketplaceSeller,
} from "@/lib/db/marketplace";
import { getMarketplaceUserById, type MarketplaceUser } from "@/lib/db/marketplaceUsers";
import { MARKETPLACE_SESSION_COOKIE, verifyMarketplaceSession } from "@/lib/marketplace/session";

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim() || null;
  }
  const apiKey = request.headers.get("x-api-key") || request.headers.get("X-Api-Key");
  return apiKey?.trim() || null;
}

export function authenticateMarketplaceBuyer(request: Request) {
  return getMarketplaceBuyerKeyByApiKey(extractBearerToken(request));
}

export function authenticateMarketplaceSeller(request: Request) {
  return getMarketplaceSellerByApiKey(extractBearerToken(request));
}

/** Read a named cookie value from the request's Cookie header. */
function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie") || request.headers.get("Cookie");
  if (!cookieHeader) return null;
  for (const segment of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = segment.split("=");
    if (!rawKey || rawValue.length === 0) continue;
    if (rawKey.trim() !== name) continue;
    return rawValue.join("=").trim();
  }
  return null;
}

/**
 * Authenticate a unified marketplace user via their wallet session. The session
 * token may be supplied as the `mkt_session` cookie or a Bearer token (for API
 * clients). Returns the user, or null when no valid session is present.
 *
 * Note: the marketplace session JWT is verified before any DB read, so a Bearer
 * token that is a seller/buyer API key (not a JWT) simply fails verification and
 * returns null — it never collides with API-key auth.
 */
export async function authenticateMarketplaceUser(
  request: Request
): Promise<MarketplaceUser | null> {
  const token = getCookie(request, MARKETPLACE_SESSION_COOKIE) || extractBearerToken(request);
  const claims = await verifyMarketplaceSession(token);
  if (!claims) return null;
  const user = getMarketplaceUserById(claims.marketplaceUserId);
  if (!user || user.status !== "active") return null;
  return user;
}

/**
 * Resolve the seller acting on this request. Accepts either a seller API key
 * (legacy) or a unified-user wallet session. Returns null when neither
 * authenticates.
 *
 * Seller registration gate: when `sellerRegistrationMode` is "closed"
 * (default — single-seller mode), a wallet session can only use a seller
 * identity it already owns; new seller identities are not provisioned.
 * The platform operator creates sellers via the management API
 * (POST /api/marketplace/sellers) regardless of this mode.
 */
export async function resolveMarketplaceSeller(
  request: Request
): Promise<MarketplaceSeller | null> {
  const byKey = authenticateMarketplaceSeller(request);
  if (byKey) return byKey;

  const user = await authenticateMarketplaceUser(request);
  if (!user) return null;

  const existing = getMarketplaceSellerByUserId(user.id);
  if (existing) return existing;
  if (getSellerRegistrationMode() === "closed") return null;

  const { seller } = getOrCreateSellerForUser({
    userId: user.id,
    name: user.displayName || `wallet:${user.walletAddress.slice(0, 10)}`,
  });
  return seller;
}
