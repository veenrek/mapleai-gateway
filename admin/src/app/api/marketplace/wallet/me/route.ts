import { listMarketplaceDepositAddresses } from "@/lib/db/marketplaceUsers";
import { authenticateMarketplaceUser } from "@/lib/marketplace/auth";
import { microUsdToUsd } from "@/lib/marketplace/pricing";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { getMarketplaceCryptoConfig } from "@/lib/marketplace/crypto/config";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * Current marketplace user: wallet balance, deposit addresses, and the chains
 * available for deposits. Requires a valid wallet session.
 */
export async function GET(request: Request) {
  const user = await authenticateMarketplaceUser(request);
  if (!user) return marketplaceError(401, "Not authenticated", "unauthorized");

  const config = getMarketplaceCryptoConfig();
  return marketplaceJson({
    user: {
      id: user.id,
      walletAddress: user.walletAddress,
      displayName: user.displayName,
      balanceMicroUsd: user.balanceMicroUsd,
      balanceUsd: microUsdToUsd(user.balanceMicroUsd),
    },
    depositAddresses: listMarketplaceDepositAddresses(user.id),
    chains: config.chains.map((c) => ({
      chainId: c.chainId,
      name: c.name,
      tokenAddress: c.tokenAddress,
      tokenDecimals: c.tokenDecimals,
      minConfirmations: c.minConfirmations,
      treasuryAddress: c.treasuryAddress,
      isTestnet: c.isTestnet,
    })),
    cryptoEnabled: config.enabled,
    testnetMode: config.testnetMode,
  });
}
