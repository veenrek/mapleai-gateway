import { NextResponse } from "next/server";
import { SignJWT } from "jose";
import {
  consumeMarketplaceAuthNonce,
  getOrCreateMarketplaceUserByWallet,
  normalizeWalletAddress,
  touchMarketplaceUserLogin,
} from "@/lib/db/marketplaceUsers";
import { buildSiweMessage, verifySiweSignature } from "@/lib/marketplace/crypto/siwe";
import { rateLimitHit } from "@/lib/marketplace/rateLimit";
import { authVerifySchema } from "@/lib/marketplace/schemas";
import { isAdminWallet, isAdminWalletLoginEnabled } from "@/lib/auth/adminWallets";
import { MARKETPLACE_SESSION_COOKIE, signMarketplaceSession } from "@/lib/marketplace/session";
import { getClientIpFromRequest } from "@/lib/ipUtils";
import { logAuditEvent } from "@/lib/compliance/index";
import { handleCorsOptions } from "@/shared/utils/cors";

// Cap signature-verification attempts per client (brute-force defense).
const VERIFY_LIMIT = 10;
const VERIFY_WINDOW_MS = 60_000;

function getJwtSecret(): Uint8Array | null {
  const secret = process.env.JWT_SECRET?.trim();
  return secret ? new TextEncoder().encode(secret) : null;
}

export async function OPTIONS() {
  return handleCorsOptions();
}

function error(status: number, message: string) {
  return NextResponse.json({ error: { message, type: "invalid_request" } }, { status });
}

/**
 * Admin wallet login, step 2: verify the SIWE signature and — only when the
 * signer address is on the `ADMIN_WALLET_ADDRESSES` allowlist — issue the same
 * admin session cookie (`auth_token`) the password flow produces. The password
 * remains valid as break-glass access.
 */
export async function POST(request: Request) {
  if (!isAdminWalletLoginEnabled()) {
    return error(403, "Wallet login is not configured on this server");
  }

  const ip = getClientIpFromRequest(request);
  const limit = rateLimitHit(`admin-wallet-verify:${ip}`, {
    limit: VERIFY_LIMIT,
    windowMs: VERIFY_WINDOW_MS,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: { message: "Too many requests, try again later", type: "rate_limited" } },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 60) } }
    );
  }

  const secret = getJwtSecret();
  if (!secret) {
    return error(500, "Server misconfigured: JWT_SECRET not set");
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return error(400, "Invalid JSON body");
  }

  const parsed = authVerifySchema.safeParse(rawBody);
  if (!parsed.success) {
    return error(400, parsed.error.issues[0]?.message || "Invalid payload");
  }

  const wallet = normalizeWalletAddress(parsed.data.wallet);

  // Consume the nonce first (single-use); a replayed or foreign nonce fails here.
  if (!consumeMarketplaceAuthNonce(parsed.data.nonce, wallet)) {
    logAuditEvent({
      action: "auth.wallet_login.failed",
      actor: "anonymous",
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: ip || undefined,
      metadata: { reason: "invalid_nonce", wallet },
    });
    return error(401, "Invalid or expired nonce");
  }

  const domain = request.headers.get("host") || "aitoken.market";
  const message = buildSiweMessage({
    domain,
    walletAddress: wallet,
    nonce: parsed.data.nonce,
    issuedAt: parsed.data.issuedAt,
    statement: "Sign in to MapleAI",
  });

  if (!verifySiweSignature({ message, signature: parsed.data.signature, walletAddress: wallet })) {
    logAuditEvent({
      action: "auth.wallet_login.failed",
      actor: "anonymous",
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: ip || undefined,
      metadata: { reason: "bad_signature", wallet },
    });
    return error(401, "Signature verification failed");
  }

  // Signature is valid — but only allowlisted wallets may hold admin sessions.
  if (!isAdminWallet(wallet)) {
    logAuditEvent({
      action: "auth.wallet_login.denied",
      actor: "anonymous",
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: ip || undefined,
      metadata: { reason: "not_on_allowlist", wallet },
    });
    return error(403, "This wallet is not authorized for management access");
  }

  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = (request.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
  const useSecureCookie = forceSecureCookie || forwardedProto === "https";

  // Same token shape as the password login — downstream management auth
  // (`isDashboardSessionAuthenticated`) accepts both without distinction.
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("30d")
    .sign(secret);

  const cookieStoreHeaders = new Headers();
  cookieStoreHeaders.append(
    "Set-Cookie",
    [
      `auth_token=${token}`,
      "HttpOnly",
      "Path=/",
      "SameSite=Lax",
      "Max-Age=2592000",
      useSecureCookie ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; ")
  );

  // Unified account: one wallet signature also opens the marketplace session,
  // so the owner never has to sign twice (dashboard + wallet/billing panel).
  try {
    const marketplaceUser = getOrCreateMarketplaceUserByWallet(wallet);
    touchMarketplaceUserLogin(marketplaceUser.id);
    const marketplaceToken = await signMarketplaceSession({
      marketplaceUserId: marketplaceUser.id,
      walletAddress: marketplaceUser.walletAddress,
    });
    cookieStoreHeaders.append(
      "Set-Cookie",
      [
        `${MARKETPLACE_SESSION_COOKIE}=${marketplaceToken}`,
        "HttpOnly",
        "Path=/",
        "SameSite=Lax",
        "Max-Age=2592000",
        useSecureCookie ? "Secure" : "",
      ]
        .filter(Boolean)
        .join("; ")
    );
  } catch (marketplaceErr) {
    logAuditEvent({
      action: "auth.wallet_login.marketplace_session_failed",
      actor: wallet,
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: ip || undefined,
      metadata: {
        reason: marketplaceErr instanceof Error ? marketplaceErr.message : "unknown",
      },
    });
  }

  logAuditEvent({
    action: "auth.wallet_login.success",
    actor: wallet,
    target: "dashboard-auth",
    resourceType: "auth_session",
    status: "success",
    ipAddress: ip || undefined,
  });

  return NextResponse.json(
    { authenticated: true, method: "wallet", walletAddress: wallet },
    { headers: cookieStoreHeaders }
  );
}
