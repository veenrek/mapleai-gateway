import { authenticateMarketplaceBuyer } from "@/lib/marketplace/auth";
import { handleMarketplaceChatCompletion } from "@/lib/marketplace/proxyChat";
import { marketplaceError } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function POST(request: Request) {
  const buyerKey = authenticateMarketplaceBuyer(request);
  if (!buyerKey) return marketplaceError(401, "Invalid marketplace buyer key", "unauthorized");
  return handleMarketplaceChatCompletion(request, buyerKey);
}
