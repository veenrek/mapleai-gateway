import { NextResponse } from "next/server";
import { listActiveMarketplaceListings, getMarketplaceSellerById } from "@/lib/db/marketplace";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

function microUsdToUsd(m: number): number {
  return Math.round(m) / 1_000_000;
}

/**
 * Public storefront catalog — NO authentication.
 * Returns active listings (the "lots"): model, per-million-token prices,
 * seller name. Public-safe fields only.
 */
export async function GET() {
  const listings = listActiveMarketplaceListings();
  const lots = listings.map((l) => {
    const seller = getMarketplaceSellerById(l.sellerId);
    return {
      id: l.id,
      publicModel: l.publicModel,
      seller: seller?.name ?? "unknown",
      inputUsdPerMillionTokens: microUsdToUsd(l.inputPriceMicroUsdPerMillionTokens),
      outputUsdPerMillionTokens: microUsdToUsd(l.outputPriceMicroUsdPerMillionTokens),
    };
  });
  return NextResponse.json(
    { lots, count: lots.length },
    { headers: { "Cache-Control": "no-store" } }
  );
}
