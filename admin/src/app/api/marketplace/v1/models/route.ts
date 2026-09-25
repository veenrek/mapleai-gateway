import { listActiveMarketplaceListings } from "@/lib/db/marketplace";
import { authenticateMarketplaceBuyer } from "@/lib/marketplace/auth";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: Request) {
  const buyerKey = authenticateMarketplaceBuyer(request);
  if (!buyerKey) return marketplaceError(401, "Invalid marketplace buyer key", "unauthorized");

  const listings = listActiveMarketplaceListings().filter(
    (listing) =>
      buyerKey.allowedModels.length === 0 || buyerKey.allowedModels.includes(listing.publicModel)
  );

  return marketplaceJson({
    object: "list",
    data: listings.map((listing) => ({
      id: listing.publicModel,
      object: "model",
      owned_by: listing.sellerId,
      provider: listing.provider,
      pricing: {
        input_micro_usd_per_million_tokens: listing.inputPriceMicroUsdPerMillionTokens,
        output_micro_usd_per_million_tokens: listing.outputPriceMicroUsdPerMillionTokens,
      },
    })),
  });
}
