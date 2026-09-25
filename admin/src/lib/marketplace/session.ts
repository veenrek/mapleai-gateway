// Marketplace user session tokens (wallet-based login).
//
// Distinct from the admin dashboard `auth_token`: marketplace users authenticate
// by wallet signature (SIWE) and receive a `mkt_session` JWT carrying their
// marketplace user id. Reuses the same `jose` HS256 primitives and JWT_SECRET as
// the admin login route.
import { SignJWT, jwtVerify } from "jose";

export const MARKETPLACE_SESSION_COOKIE = "mkt_session";
const SESSION_TTL = "30d";

function getJwtSecret(): Uint8Array {
  return new TextEncoder().encode(process.env.JWT_SECRET || "");
}

export interface MarketplaceSessionClaims {
  marketplaceUserId: string;
  walletAddress: string;
}

/**
 * Sign a marketplace session JWT. Throws if JWT_SECRET is not configured so the
 * caller can fail closed rather than issue an unverifiable token.
 */
export async function signMarketplaceSession(claims: MarketplaceSessionClaims): Promise<string> {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured");
  }
  return new SignJWT({
    marketplaceUserId: claims.marketplaceUserId,
    walletAddress: claims.walletAddress,
    scope: "marketplace",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(getJwtSecret());
}

/**
 * Verify a marketplace session token and return its claims, or null when the
 * token is missing/invalid/expired or JWT_SECRET is unset.
 */
export async function verifyMarketplaceSession(
  token: string | null | undefined
): Promise<MarketplaceSessionClaims | null> {
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (payload.scope !== "marketplace") return null;
    const marketplaceUserId = typeof payload.marketplaceUserId === "string" ? payload.marketplaceUserId : "";
    const walletAddress = typeof payload.walletAddress === "string" ? payload.walletAddress : "";
    if (!marketplaceUserId || !walletAddress) return null;
    return { marketplaceUserId, walletAddress };
  } catch {
    return null;
  }
}
