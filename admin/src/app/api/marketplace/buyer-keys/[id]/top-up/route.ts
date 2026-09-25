import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { MarketplaceDbError, topUpMarketplaceBuyerKey } from "@/lib/db/marketplace";
import { usdToMicroUsd } from "@/lib/marketplace/pricing";
import { topUpBuyerKeySchema } from "@/lib/marketplace/schemas";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  const parsed = topUpBuyerKeySchema.safeParse(rawBody);
  if (!parsed.success) {
    return marketplaceError(400, parsed.error.issues[0]?.message || "Invalid top-up payload");
  }

  try {
    const { id } = await context.params;
    const buyerKey = topUpMarketplaceBuyerKey(
      id,
      usdToMicroUsd(parsed.data.amountUsd),
      parsed.data.metadata
    );
    return marketplaceJson({ buyerKey });
  } catch (error) {
    if (error instanceof MarketplaceDbError) return marketplaceError(error.status, error.message);
    return marketplaceError(500, "Failed to top up buyer key", "server_error");
  }
}
