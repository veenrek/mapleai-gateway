// Provision a per-user EVM deposit address from the configured master seed.
//
// The private key is derived deterministically (seed + index) and also stored
// encrypted at rest so sweeping funds later does not depend solely on the seed.
import { encrypt } from "@/lib/db/encryption";
import {
  createMarketplaceDepositAddress,
  getMarketplaceDepositAddress,
  getNextDepositDerivationIndex,
  type MarketplaceDepositAddress,
} from "@/lib/db/marketplaceUsers";
import { MarketplaceDbError } from "@/lib/db/marketplace";
import { deriveDepositKey } from "./address";
import { getMarketplaceChain } from "./config";

function getMasterSeed(): string {
  return (process.env.MARKETPLACE_DEPOSIT_MNEMONIC || process.env.MARKETPLACE_DEPOSIT_SEED || "").trim();
}

/**
 * Return the user's deposit address for a chain, creating it on first use.
 * Throws MarketplaceDbError(503) when crypto is not configured.
 */
export function provisionDepositAddress(
  userId: string,
  chainId: number
): MarketplaceDepositAddress {
  const chain = getMarketplaceChain(chainId);
  if (!chain) {
    throw new MarketplaceDbError(400, `Chain ${chainId} is not configured`);
  }
  const seed = getMasterSeed();
  if (!seed) {
    throw new MarketplaceDbError(503, "Crypto deposits are not configured on this server");
  }

  const existing = getMarketplaceDepositAddress(userId, chainId, chain.tokenAddress);
  if (existing) return existing;

  const index = getNextDepositDerivationIndex();
  const derived = deriveDepositKey(seed, index);
  const encryptedPrivateKey = encrypt(Buffer.from(derived.privateKey).toString("hex")) || null;

  return createMarketplaceDepositAddress({
    userId,
    chainId,
    tokenAddress: chain.tokenAddress,
    depositAddress: derived.address,
    derivationIndex: index,
    encryptedPrivateKey,
  });
}
