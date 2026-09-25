import {
  createMarketplaceListing,
  listMarketplaceSellerListings,
  MarketplaceDbError,
} from "@/lib/db/marketplace";
import { resolveMarketplaceSeller } from "@/lib/marketplace/auth";
import { priceUsdPerMillionToMicroUsd } from "@/lib/marketplace/pricing";
import { createListingSchema } from "@/lib/marketplace/schemas";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: Request) {
  const seller = await resolveMarketplaceSeller(request);
  if (!seller) return marketplaceError(401, "Invalid seller credentials", "unauthorized");
  return marketplaceJson({ listings: listMarketplaceSellerListings(seller.id) });
}

export async function POST(request: Request) {
  const seller = await resolveMarketplaceSeller(request);
  if (!seller) return marketplaceError(401, "Invalid seller credentials", "unauthorized");

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  const parsed = createListingSchema.safeParse(rawBody);
  if (!parsed.success) {
    return marketplaceError(400, parsed.error.issues[0]?.message || "Invalid listing payload");
  }

  try {
    const listing = createMarketplaceListing({
      sellerId: seller.id,
      connectionId: parsed.data.connectionId,
      upstreamModel: parsed.data.upstreamModel,
      publicModel: parsed.data.publicModel,
      inputPriceMicroUsdPerMillionTokens: priceUsdPerMillionToMicroUsd(
        parsed.data.inputPriceUsdPerMillionTokens
      ),
      outputPriceMicroUsdPerMillionTokens: priceUsdPerMillionToMicroUsd(
        parsed.data.outputPriceUsdPerMillionTokens
      ),
      platformFeeBps: parsed.data.platformFeeBps,
      maxRequestsPerMinute: parsed.data.maxRequestsPerMinute,
      maxDailyTokens: parsed.data.maxDailyTokens,
      comboId: parsed.data.comboId ?? null,
    });
    return marketplaceJson({ listing }, { status: 201 });
  } catch (error) {
    if (error instanceof MarketplaceDbError) return marketplaceError(error.status, error.message);
    return marketplaceError(500, "Failed to create marketplace listing", "server_error");
  }
}
