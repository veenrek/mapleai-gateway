import { fundBuyerKeyFromUserBalance } from "@/lib/db/marketplaceUsers";
import { MarketplaceDbError } from "@/lib/db/marketplace";
import { authenticateMarketplaceUser } from "@/lib/marketplace/auth";
import { microUsdToUsd, usdToMicroUsd } from "@/lib/marketplace/pricing";
import { fundBuyerKeyFromWalletSchema } from "@/lib/marketplace/schemas";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * Transfer USD from the user's wallet balance into one of their buyer keys so it
 * can be spent on chat completions. Atomic; requires a wallet session.
 */
export async function POST(request: Request) {
  const user = await authenticateMarketplaceUser(request);
  if (!user) return marketplaceError(401, "Not authenticated", "unauthorized");

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  const parsed = fundBuyerKeyFromWalletSchema.safeParse(rawBody);
  if (!parsed.success) {
    return marketplaceError(400, parsed.error.issues[0]?.message || "Invalid payload");
  }

  try {
    const result = fundBuyerKeyFromUserBalance(
      user.id,
      parsed.data.buyerKeyId,
      usdToMicroUsd(parsed.data.amountUsd)
    );
    return marketplaceJson({
      userBalanceMicroUsd: result.userBalanceMicroUsd,
      userBalanceUsd: microUsdToUsd(result.userBalanceMicroUsd),
      buyerKeyBalanceMicroUsd: result.buyerKeyBalanceMicroUsd,
      buyerKeyBalanceUsd: microUsdToUsd(result.buyerKeyBalanceMicroUsd),
    });
  } catch (error) {
    if (error instanceof MarketplaceDbError) return marketplaceError(error.status, error.message);
    return marketplaceError(500, "Failed to fund buyer key", "server_error");
  }
}
