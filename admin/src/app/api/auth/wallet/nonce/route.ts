import { issueMarketplaceAuthNonce, normalizeWalletAddress } from "@/lib/db/marketplaceUsers";
import { buildSiweMessage } from "@/lib/marketplace/crypto/siwe";
import { rateLimitHit } from "@/lib/marketplace/rateLimit";
import { authNonceSchema } from "@/lib/marketplace/schemas";
import { isAdminWalletLoginEnabled } from "@/lib/auth/adminWallets";
import { getClientIpFromRequest } from "@/lib/ipUtils";
import { handleCorsOptions } from "@/shared/utils/cors";
import { NextResponse } from "next/server";

// Cap nonce issuance per client so an attacker cannot flood the nonce table.
const NONCE_LIMIT = 20;
const NONCE_WINDOW_MS = 60_000;

export async function OPTIONS() {
  return handleCorsOptions();
}

function error(status: number, message: string) {
  return NextResponse.json({ error: { message, type: "invalid_request" } }, { status });
}

/**
 * Admin wallet login, step 1: issue a single-use SIWE nonce and the exact
 * message to sign. Shares the nonce store with the marketplace flow — the
 * scope is decided by whichever verify endpoint consumes the nonce, so a
 * marketplace verify can never mint an admin session and vice versa.
 */
export async function POST(request: Request) {
  if (!isAdminWalletLoginEnabled()) {
    return error(403, "Wallet login is not configured on this server");
  }

  const ip = getClientIpFromRequest(request);
  const limit = rateLimitHit(`admin-wallet-nonce:${ip}`, {
    limit: NONCE_LIMIT,
    windowMs: NONCE_WINDOW_MS,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: { message: "Too many requests, try again later", type: "rate_limited" } },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 60) } }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return error(400, "Invalid JSON body");
  }

  const parsed = authNonceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return error(400, parsed.error.issues[0]?.message || "Invalid payload");
  }

  const wallet = normalizeWalletAddress(parsed.data.wallet);
  const nonce = issueMarketplaceAuthNonce(wallet);
  const issuedAt = new Date().toISOString();
  const domain = request.headers.get("host") || "omniroute.local";
  const message = buildSiweMessage({
    domain,
    walletAddress: wallet,
    nonce,
    issuedAt,
    statement: "Sign in to MapleAI",
  });

  return NextResponse.json({ nonce, issuedAt, message });
}
