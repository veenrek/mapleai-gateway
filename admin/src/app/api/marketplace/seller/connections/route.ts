import { randomUUID } from "crypto";
import { createProviderConnection, getProviderConnections } from "@/lib/db/providers";
import {
  attachMarketplaceSellerConnection,
  listMarketplaceSellerConnections,
  MarketplaceDbError,
  updateMarketplaceSellerConnection,
} from "@/lib/db/marketplace";
import { isManagedProviderConnectionId } from "@/lib/providers/catalog";
import { resolveMarketplaceSeller } from "@/lib/marketplace/auth";
import {
  attachConnectionSchema,
  createSellerProviderConnectionSchema,
  updateSellerConnectionSchema,
} from "@/lib/marketplace/schemas";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import {
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { parseAndValidatePublicUrl } from "@/shared/network/outboundUrlGuard";
import { handleCorsOptions } from "@/shared/utils/cors";

/**
 * Validate a seller-supplied custom endpoint: must be a public HTTPS URL.
 * Rejects http, private/loopback hosts, and cloud-metadata endpoints (SSRF).
 * Returns the normalized URL string, or throws with a safe message.
 */
function validateSellerBaseUrl(raw: string): string {
  const url = parseAndValidatePublicUrl(raw); // throws on private/metadata host
  if (url.protocol !== "https:") {
    throw new Error("baseUrl must use https");
  }
  return url.toString();
}

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: Request) {
  const seller = await resolveMarketplaceSeller(request);
  if (!seller) return marketplaceError(401, "Invalid seller credentials", "unauthorized");
  return marketplaceJson({ connections: listMarketplaceSellerConnections(seller.id) });
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

  const attachParsed = attachConnectionSchema.safeParse(rawBody);
  if (attachParsed.success) {
    try {
      let connection = attachMarketplaceSellerConnection(seller.id, attachParsed.data.connectionId);
      if (attachParsed.data.accountGroup) {
        connection = updateMarketplaceSellerConnection({
          sellerId: seller.id,
          connectionId: connection.connectionId,
          accountGroup: attachParsed.data.accountGroup,
        });
      }
      return marketplaceJson({ connection }, { status: 201 });
    } catch (error) {
      if (error instanceof MarketplaceDbError) return marketplaceError(error.status, error.message);
      return marketplaceError(500, "Failed to attach provider connection", "server_error");
    }
  }

  const createParsed = createSellerProviderConnectionSchema.safeParse(rawBody);
  if (!createParsed.success) {
    return marketplaceError(
      400,
      createParsed.error.issues[0]?.message || "Invalid provider connection payload"
    );
  }

  try {
    const body = createParsed.data;
    const isValidProvider =
      isManagedProviderConnectionId(body.provider) ||
      isOpenAICompatibleProvider(body.provider) ||
      isAnthropicCompatibleProvider(body.provider);
    if (!isValidProvider) return marketplaceError(400, "Invalid provider", "invalid_request");

    // Validate a custom endpoint (public HTTPS only) and fold it into the
    // provider-specific data the executor reads (providerSpecificData.baseUrl).
    let providerSpecificData = body.providerSpecificData || null;
    if (body.baseUrl) {
      let validatedBaseUrl: string;
      try {
        validatedBaseUrl = validateSellerBaseUrl(body.baseUrl);
      } catch {
        return marketplaceError(
          400,
          "baseUrl must be a public HTTPS endpoint",
          "invalid_request"
        );
      }
      providerSpecificData = { ...(providerSpecificData || {}), baseUrl: validatedBaseUrl };
    }

    const existingConnections = await getProviderConnections({ provider: body.provider });
    const existingByApiKey = existingConnections.find(
      (connection) =>
        typeof connection.apiKey === "string" && connection.apiKey.trim() === body.apiKey.trim()
    );
    if (existingByApiKey?.id) {
      let connection = attachMarketplaceSellerConnection(seller.id, String(existingByApiKey.id));
      if (body.accountGroup) {
        connection = updateMarketplaceSellerConnection({
          sellerId: seller.id,
          connectionId: connection.connectionId,
          accountGroup: body.accountGroup,
        });
      }
      return marketplaceJson({ connection }, { status: 201 });
    }

    const providerConnection = await createProviderConnection({
      provider: body.provider,
      authType: "apikey",
      name: `marketplace:${seller.id}:${body.name || body.provider}:${randomUUID()}`,
      apiKey: body.apiKey,
      defaultModel: body.defaultModel || null,
      providerSpecificData,
      isActive: true,
      testStatus: "unknown",
    });
    if (!providerConnection?.id) {
      return marketplaceError(500, "Provider connection was not created", "server_error");
    }
    let connection = attachMarketplaceSellerConnection(seller.id, String(providerConnection.id));
    if (body.accountGroup) {
      connection = updateMarketplaceSellerConnection({
        sellerId: seller.id,
        connectionId: connection.connectionId,
        accountGroup: body.accountGroup,
      });
    }
    return marketplaceJson({ connection }, { status: 201 });
  } catch (error) {
    if (error instanceof MarketplaceDbError) return marketplaceError(error.status, error.message);
    return marketplaceError(500, "Failed to create provider connection", "server_error");
  }
}

export async function PATCH(request: Request) {
  const seller = await resolveMarketplaceSeller(request);
  if (!seller) return marketplaceError(401, "Invalid seller credentials", "unauthorized");

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  const parsed = attachConnectionSchema.merge(updateSellerConnectionSchema).safeParse(rawBody);
  if (!parsed.success) {
    return marketplaceError(400, parsed.error.issues[0]?.message || "Invalid connection payload");
  }

  try {
    const connection = updateMarketplaceSellerConnection({
      sellerId: seller.id,
      connectionId: parsed.data.connectionId,
      accountGroup: parsed.data.accountGroup,
    });
    return marketplaceJson({ connection });
  } catch (error) {
    if (error instanceof MarketplaceDbError) return marketplaceError(error.status, error.message);
    return marketplaceError(500, "Failed to update seller connection", "server_error");
  }
}
