import { listUserWithdrawals } from "@/lib/db/marketplaceUsers";
import { authenticateMarketplaceUser } from "@/lib/marketplace/auth";
import { microUsdToUsd } from "@/lib/marketplace/pricing";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

/** List the authenticated user's withdrawal history. */
export async function GET(request: Request) {
  const user = await authenticateMarketplaceUser(request);
  if (!user) return marketplaceError(401, "Not authenticated", "unauthorized");

  const withdrawals = listUserWithdrawals(user.id).map((w) => ({
    id: w.id,
    chainId: w.chainId,
    toAddress: w.toAddress,
    amountUsd: microUsdToUsd(w.amountMicroUsd),
    txHash: w.txHash,
    status: w.status,
    createdAt: w.createdAt,
  }));
  return marketplaceJson({ withdrawals });
}
