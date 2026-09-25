import {
  getMarketplaceBuyerUsageSummary,
  listMarketplaceBuyerUsageEvents,
} from "@/lib/db/marketplace";
import { authenticateMarketplaceBuyer } from "@/lib/marketplace/auth";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: Request) {
  const buyerKey = authenticateMarketplaceBuyer(request);
  if (!buyerKey) return marketplaceError(401, "Invalid marketplace buyer key", "unauthorized");

  return marketplaceJson({
    buyerKey,
    usage: getMarketplaceBuyerUsageSummary(buyerKey.id),
    recentEvents: listMarketplaceBuyerUsageEvents(buyerKey.id, 25),
  });
}
