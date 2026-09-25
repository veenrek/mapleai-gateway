import { recordSellerWithdrawal } from "@/lib/db/marketplaceUsers";
import { MarketplaceDbError } from "@/lib/db/marketplace";
import { authenticateMarketplaceUser, resolveMarketplaceSeller } from "@/lib/marketplace/auth";
import {
  getMarketplaceChain,
  getMarketplaceCryptoConfig,
  microUsdToTokenBaseUnits,
} from "@/lib/marketplace/crypto/config";
import { broadcastAndFinalizeWithdrawal } from "@/lib/marketplace/crypto/withdrawalExecutor";
import { microUsdToUsd, usdToMicroUsd } from "@/lib/marketplace/pricing";
import { rateLimitHit } from "@/lib/marketplace/rateLimit";
import { withdrawSchema } from "@/lib/marketplace/schemas";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

const WITHDRAW_LIMIT = 5;
const WITHDRAW_WINDOW_MS = 60 * 1000;

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * Withdraw a seller's accumulated earnings to their login wallet on-chain.
 * The payout address is the wallet the user signed in with (seller identity is
 * tied to a unified user). Same hold-then-send flow as the wallet withdrawal.
 */
export async function POST(request: Request) {
  const seller = await resolveMarketplaceSeller(request);
  if (!seller) return marketplaceError(401, "Invalid seller credentials", "unauthorized");

  // Resolve the login wallet to pay out to. Sellers acting via a unified-user
  // wallet session have a wallet; legacy API-key sellers do not.
  const user = await authenticateMarketplaceUser(request);
  if (!user) {
    return marketplaceError(
      400,
      "Seller withdrawals require a wallet session (sign in with your wallet)",
      "wallet_required"
    );
  }

  const limit = rateLimitHit(`seller-withdraw:${seller.id}`, {
    limit: WITHDRAW_LIMIT,
    windowMs: WITHDRAW_WINDOW_MS,
  });
  if (!limit.allowed) {
    return marketplaceError(429, "Too many withdrawal attempts. Please wait.", "rate_limited");
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  const parsed = withdrawSchema.safeParse(rawBody);
  if (!parsed.success) {
    return marketplaceError(400, parsed.error.issues[0]?.message || "Invalid payload");
  }

  const config = getMarketplaceCryptoConfig();
  if (!config.withdrawalsEnabled) {
    return marketplaceError(503, "Withdrawals are not configured on this server", "unavailable");
  }
  const chain = getMarketplaceChain(parsed.data.chainId);
  if (!chain || !chain.treasuryAddress) {
    return marketplaceError(400, `Chain ${parsed.data.chainId} does not support withdrawals`);
  }

  const amountMicroUsd = usdToMicroUsd(parsed.data.amountUsd);
  const amountToken = microUsdToTokenBaseUnits(
    amountMicroUsd,
    chain.tokenDecimals,
    chain.usdPerToken
  );
  if (amountToken === "0") {
    return marketplaceError(400, "Withdrawal amount is too small");
  }

  let withdrawal;
  try {
    withdrawal = recordSellerWithdrawal({
      sellerId: seller.id,
      toAddress: user.walletAddress,
      chainId: chain.chainId,
      tokenAddress: chain.tokenAddress,
      amountMicroUsd,
      amountToken,
    });
  } catch (error) {
    if (error instanceof MarketplaceDbError) return marketplaceError(error.status, error.message);
    return marketplaceError(500, "Failed to record withdrawal", "server_error");
  }

  // Broadcast the transfer and resolve the withdrawal state via the shared
  // executor, which enforces the double-pay invariant: refund only before the
  // tx is broadcast, never after (the watcher reconciles a post-broadcast
  // DB-write failure rather than refunding funds already in flight).
  const result = await broadcastAndFinalizeWithdrawal(withdrawal.id, {
    rpcUrl: chain.rpcUrl,
    chainId: chain.chainId,
    tokenAddress: chain.tokenAddress,
    toAddress: user.walletAddress,
    amountBaseUnits: amountToken,
  });

  if (result.outcome === "broadcast_failed") {
    return marketplaceError(
      502,
      "Withdrawal could not be broadcast. Your balance was refunded.",
      "broadcast_failed"
    );
  }

  return marketplaceJson({
    withdrawal: {
      id: withdrawal.id,
      status: "submitted",
      txHash: result.txHash,
      amountUsd: microUsdToUsd(withdrawal.amountMicroUsd),
      toAddress: withdrawal.toAddress,
    },
  });
}
