import {
  getMarketplaceSellerUsageSummary,
  listMarketplaceSellerConnections,
  listMarketplaceSellerListings,
  listMarketplaceSellerUsageEvents,
} from "@/lib/db/marketplace";
import { resolveMarketplaceSeller } from "@/lib/marketplace/auth";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: Request) {
  const seller = await resolveMarketplaceSeller(request);
  if (!seller) return marketplaceError(401, "Invalid seller credentials", "unauthorized");

  return marketplaceJson({
    seller,
    usage: getMarketplaceSellerUsageSummary(seller.id),
    connections: listMarketplaceSellerConnections(seller.id),
    listings: listMarketplaceSellerListings(seller.id),
    recentEvents: listMarketplaceSellerUsageEvents(seller.id, 25),
  });
}
