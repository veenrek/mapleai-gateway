import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createMarketplaceSeller, listMarketplaceSellers } from "@/lib/db/marketplace";
import { createSellerSchema } from "@/lib/marketplace/schemas";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return marketplaceJson({ sellers: listMarketplaceSellers() });
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  const parsed = createSellerSchema.safeParse(rawBody);
  if (!parsed.success) {
    return marketplaceError(400, parsed.error.issues[0]?.message || "Invalid seller payload");
  }

  const result = createMarketplaceSeller(parsed.data);
  return marketplaceJson(result, { status: 201 });
}
