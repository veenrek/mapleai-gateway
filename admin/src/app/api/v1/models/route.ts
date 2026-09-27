import { getUnifiedModelsResponse } from "./catalog";
import { authenticatePrepaidGatewayBuyer, isPrepaidGatewayRequest } from "@/lib/marketplace/prepaidGateway";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list
 */
export async function GET(request: Request) {
  if (!isPrepaidGatewayRequest(request)) return getUnifiedModelsResponse(request);

  const buyerKey = authenticatePrepaidGatewayBuyer(request);
  if (!buyerKey) return marketplaceError(401, "Invalid prepaid buyer key", "unauthorized");
  if (buyerKey.allowedModels.length === 0) {
    return marketplaceError(403, "This prepaid key has no allowed models", "forbidden");
  }
  return marketplaceJson({
    object: "list",
    data: buyerKey.allowedModels.map((id) => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "mapleai",
    })),
  });
}
