import { recordUserWithdrawal } from "@/lib/db/marketplaceUsers";
import { MarketplaceDbError } from "@/lib/db/marketplace";
import { authenticateMarketplaceUser } from "@/lib/marketplace/auth";
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

// Cap withdrawal attempts per user to limit hot-wallet exposure / accidental spam.
const WITHDRAW_LIMIT = 5;
const WITHDRAW_WINDOW_MS = 60 * 1000;

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * Withdraw the user's wallet balance to their login wallet address on-chain.
 * Hold-then-send: the balance is debited first, the ERC-20 transfer is signed
 * and broadcast from the treasury hot-wallet, and the watcher confirms the
 * receipt. A broadcast failure refunds the balance immediately.
 */
export async function POST(request: Request) {
  const user = await authenticateMarketplaceUser(request);
  if (!user) return marketplaceError(401, "Not authenticated", "unauthorized");

  const limit = rateLimitHit(`withdraw:${user.id}`, {
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

  // 1. Debit balance + create a pending withdrawal (throws 402 if insufficient).
  let withdrawal;
  try {
    withdrawal = recordUserWithdrawal({
      userId: user.id,
      chainId: chain.chainId,
      tokenAddress: chain.tokenAddress,
      toAddress: user.walletAddress, // pay out to the login wallet
      amountMicroUsd,
      amountToken,
    });
  } catch (error) {
    if (error instanceof MarketplaceDbError) return marketplaceError(error.status, error.message);
    return marketplaceError(500, "Failed to record withdrawal", "server_error");
  }

  // 2. Broadcast the transfer and resolve the withdrawal state. The shared
  //    executor enforces the double-pay invariant: refund only before broadcast,
  //    never after (the watcher reconciles a post-broadcast DB-write failure).
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
