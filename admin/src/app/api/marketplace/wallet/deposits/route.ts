import { listMarketplaceDeposits } from "@/lib/db/marketplaceUsers";
import { authenticateMarketplaceUser } from "@/lib/marketplace/auth";
import { microUsdToUsd } from "@/lib/marketplace/pricing";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

/** List the authenticated user's on-chain deposit history. */
export async function GET(request: Request) {
  const user = await authenticateMarketplaceUser(request);
  if (!user) return marketplaceError(401, "Not authenticated", "unauthorized");

  const deposits = listMarketplaceDeposits(user.id).map((d) => ({
    ...d,
    amountUsd: microUsdToUsd(d.amountMicroUsd),
  }));
  return marketplaceJson({ deposits });
}
