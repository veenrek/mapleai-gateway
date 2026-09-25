import { authenticateMarketplaceUser } from "@/lib/marketplace/auth";
import { MarketplaceDbError } from "@/lib/db/marketplace";
import { getMarketplaceChain } from "@/lib/marketplace/crypto/config";
import { provisionDepositAddress } from "@/lib/marketplace/crypto/provision";
import { depositAddressSchema } from "@/lib/marketplace/schemas";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * Return the user's deposit address for a chain.
 * In treasury mode, the address is the shared chain treasury — no per-user
 * address derivation is required. In legacy mode, a per-user derived address
 * is provisioned (or the existing one returned).
 */
export async function POST(request: Request) {
  const user = await authenticateMarketplaceUser(request);
  if (!user) return marketplaceError(401, "Not authenticated", "unauthorized");

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  const parsed = depositAddressSchema.safeParse(rawBody);
  if (!parsed.success) {
    return marketplaceError(400, parsed.error.issues[0]?.message || "Invalid payload");
  }

  try {
    const chain = getMarketplaceChain(parsed.data.chainId);
    if (!chain) {
      return marketplaceError(400, `Chain ${parsed.data.chainId} is not configured`);
    }
    // Treasury mode: return the shared chain address directly — no derivation needed.
    if (chain.treasuryAddress) {
      return marketplaceJson({
        depositAddress: {
          chainId: chain.chainId,
          tokenAddress: chain.tokenAddress,
          depositAddress: chain.treasuryAddress,
          treasuryMode: true,
        },
      });
    }
    // Legacy mode: provision a per-user derived deposit address.
    const address = provisionDepositAddress(user.id, parsed.data.chainId);
    return marketplaceJson({ depositAddress: { ...address, treasuryMode: false } }, { status: 201 });
  } catch (error) {
    if (error instanceof MarketplaceDbError) return marketplaceError(error.status, error.message);
    return marketplaceError(500, "Failed to provision deposit address", "server_error");
  }
}
