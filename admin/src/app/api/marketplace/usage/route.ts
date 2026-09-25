import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { listMarketplaceUsageEvents } from "@/lib/db/marketplace";
import { marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") || "100", 10);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
  return marketplaceJson({ events: listMarketplaceUsageEvents(limit) });
}
