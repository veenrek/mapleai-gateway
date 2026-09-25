import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  createMarketplaceBuyerKey,
  listMarketplaceBuyerKeys,
  listMarketplaceBuyerKeysByUserId,
} from "@/lib/db/marketplace";
import { authenticateMarketplaceUser } from "@/lib/marketplace/auth";
import { usdToMicroUsd } from "@/lib/marketplace/pricing";
import { createBuyerKeySchema } from "@/lib/marketplace/schemas";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: Request) {
  // A logged-in marketplace user sees only their own buyer keys; management auth
  // (admin/API key) sees all.
  const user = await authenticateMarketplaceUser(request);
  if (user) {
    return marketplaceJson({ buyerKeys: listMarketplaceBuyerKeysByUserId(user.id) });
  }
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return marketplaceJson({ buyerKeys: listMarketplaceBuyerKeys() });
}

export async function POST(request: Request) {
  // Either a wallet-session user (creates a key owned by them) or management auth.
  const user = await authenticateMarketplaceUser(request);
  if (!user) {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  const parsed = createBuyerKeySchema.safeParse(rawBody);
  if (!parsed.success) {
    return marketplaceError(400, parsed.error.issues[0]?.message || "Invalid buyer key payload");
  }

  // A user-created key cannot be pre-funded out of thin air; balance is added by
  // funding from the wallet (see /wallet/fund-buyer-key). Admins may seed balance.
  const result = createMarketplaceBuyerKey({
    name: parsed.data.name,
    balanceMicroUsd: user ? 0 : usdToMicroUsd(parsed.data.balanceUsd || 0),
    allowedModels: parsed.data.allowedModels || [],
    userId: user?.id ?? null,
  });
  return marketplaceJson(result, { status: 201 });
}
