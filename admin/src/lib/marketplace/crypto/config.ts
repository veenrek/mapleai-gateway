// Marketplace crypto configuration — chain-agnostic EVM.
//
// All chain/token/RPC settings come from environment variables so no secrets
// or endpoints are baked into the source. A deployment enables crypto deposits
// by setting MARKETPLACE_EVM_CHAINS (JSON) and MARKETPLACE_DEPOSIT_MNEMONIC.
// When unset, the deposit watcher and wallet endpoints degrade gracefully
// (report "disabled") instead of throwing.

export interface MarketplaceChainConfig {
  /** EIP-155 chain id, e.g. 1 (mainnet), 137 (polygon), 11155111 (sepolia). */
  chainId: number;
  /** Human-readable label for logs/UI. */
  name: string;
  /** JSON-RPC endpoint used by the deposit watcher. */
  rpcUrl: string;
  /** ERC-20 stablecoin contract address (lowercased on read). */
  tokenAddress: string;
  /** Token decimals (USDC/USDT = 6 on most chains, 18 on BSC). */
  tokenDecimals: number;
  /** Confirmations required before a deposit is credited. */
  minConfirmations: number;
  /**
   * Static fallback USD price per whole token, used only when no oracle source
   * is configured for this chain. Stablecoins are 1.0. When `chainlinkFeed` or
   * `cexSymbol` is set, the live oracle takes precedence (see priceOracle.ts).
   */
  usdPerToken: number;
  /**
   * How many blocks behind the head a credited deposit is still re-checked for
   * reorg reversal. Defaults to max(minConfirmations * 4, 64). After a deposit
   * is this deep it is treated as final and no longer re-checked.
   */
  reorgRecheckBlocks: number;
  /** Chainlink AggregatorV3 feed address for token→USD (optional). */
  chainlinkFeed: string | null;
  /** Coinbase spot symbol fallback, e.g. "ETH-USD" (optional). */
  cexSymbol: string | null;
  /**
   * Max age (seconds) a Chainlink feed answer may have before it is rejected as
   * stale. Defaults to 3600 (1h). Stale → fall back to CEX, then defer.
   */
  priceMaxAgeSec: number;
  /**
   * Single treasury address for this chain. When set, deposits are attributed
   * by the sender (log.from) instead of per-user derived addresses. The watcher
   * scans Transfer events where `to` equals this address. No per-user address
   * derivation or seed is needed when all chains use treasury mode.
   */
  treasuryAddress: string | null;
  /**
   * Whether this chain is a test network (Sepolia, Mumbai, etc.). Funds here
   * have no real value — surfaced in the UI as a "Testnet" badge so test
   * deposits/withdrawals are never confused with mainnet money. Auto-detected
   * from well-known testnet chain ids; an explicit `isTestnet` in the chain
   * config overrides the auto-detection.
   */
  isTestnet: boolean;
}

export interface MarketplaceCryptoConfig {
  enabled: boolean;
  chains: MarketplaceChainConfig[];
  /** Present only when address derivation is configured. */
  hasDepositSeed: boolean;
  /** True when at least one chain has a treasury address configured. */
  hasTreasury: boolean;
  /** True when treasury private key is configured (enables on-chain withdrawals). */
  withdrawalsEnabled: boolean;
  /**
   * Global testnet mode. True when every configured chain is a testnet, or when
   * MARKETPLACE_TESTNET_MODE is forced on. In this mode the UI shows a prominent
   * testnet banner and mainnet chains are rejected at config time so test funds
   * can never be confused with real money.
   */
  testnetMode: boolean;
}

/**
 * Well-known EVM test-network chain ids. Used to auto-flag a chain as a testnet
 * when its config doesn't set `isTestnet` explicitly. Not exhaustive — add ids
 * as needed; an explicit `isTestnet: true` always wins for chains not listed.
 */
const KNOWN_TESTNET_CHAIN_IDS = new Set<number>([
  11155111, // Ethereum Sepolia
  17000, // Ethereum Holesky
  80002, // Polygon Amoy
  97, // BSC testnet
  421614, // Arbitrum Sepolia
  11155420, // Optimism Sepolia
  84532, // Base Sepolia
  43113, // Avalanche Fuji
  59141, // Linea Sepolia
  534351, // Scroll Sepolia
]);

/** True when MARKETPLACE_TESTNET_MODE is explicitly forced on via env. */
function isTestnetModeForced(): boolean {
  const raw = (process.env.MARKETPLACE_TESTNET_MODE || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

function parseChains(raw: string | undefined): MarketplaceChainConfig[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[MarketplaceCrypto] MARKETPLACE_EVM_CHAINS is not valid JSON — ignoring");
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const chains: MarketplaceChainConfig[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const chainId = Number(e.chainId);
    const rpcUrl = typeof e.rpcUrl === "string" ? e.rpcUrl.trim() : "";
    const tokenAddress = typeof e.tokenAddress === "string" ? e.tokenAddress.trim().toLowerCase() : "";
    if (!Number.isInteger(chainId) || chainId <= 0 || !rpcUrl || !tokenAddress) {
      console.warn(`[MarketplaceCrypto] Skipping malformed chain entry: ${JSON.stringify(entry)}`);
      continue;
    }
    const minConfirmations =
      Number.isInteger(Number(e.minConfirmations)) && Number(e.minConfirmations) > 0
        ? Number(e.minConfirmations)
        : 12;
    const reorgRecheckBlocks =
      Number.isInteger(Number(e.reorgRecheckBlocks)) && Number(e.reorgRecheckBlocks) > 0
        ? Number(e.reorgRecheckBlocks)
        : Math.max(minConfirmations * 4, 64);
    const treasuryAddress =
      typeof e.treasuryAddress === "string" && e.treasuryAddress.trim()
        ? e.treasuryAddress.trim().toLowerCase()
        : null;
    if (treasuryAddress && !/^0x[0-9a-f]{40}$/.test(treasuryAddress)) {
      console.warn(`[MarketplaceCrypto] Skipping chain ${chainId}: treasuryAddress is not a valid EVM address`);
      continue;
    }
    // Explicit isTestnet wins; otherwise auto-detect from well-known testnet ids.
    const isTestnet =
      typeof e.isTestnet === "boolean"
        ? e.isTestnet
        : KNOWN_TESTNET_CHAIN_IDS.has(chainId);
    // In forced testnet mode, refuse mainnet chains so test funds can never be
    // confused with real money.
    if (isTestnetModeForced() && !isTestnet) {
      console.warn(
        `[MarketplaceCrypto] Skipping chain ${chainId}: MARKETPLACE_TESTNET_MODE is on but this chain is not a testnet`
      );
      continue;
    }
    chains.push({
      chainId,
      name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : `chain-${chainId}`,
      rpcUrl,
      tokenAddress,
      tokenDecimals: Number.isInteger(Number(e.tokenDecimals)) ? Number(e.tokenDecimals) : 6,
      minConfirmations,
      usdPerToken: Number.isFinite(Number(e.usdPerToken)) && Number(e.usdPerToken) > 0
        ? Number(e.usdPerToken)
        : 1,
      reorgRecheckBlocks,
      chainlinkFeed:
        typeof e.chainlinkFeed === "string" && e.chainlinkFeed.trim()
          ? e.chainlinkFeed.trim().toLowerCase()
          : null,
      cexSymbol: typeof e.cexSymbol === "string" && e.cexSymbol.trim() ? e.cexSymbol.trim() : null,
      priceMaxAgeSec:
        Number.isInteger(Number(e.priceMaxAgeSec)) && Number(e.priceMaxAgeSec) > 0
          ? Number(e.priceMaxAgeSec)
          : 3600,
      treasuryAddress,
      isTestnet,
    });
  }
  return chains;
}

/**
 * Read the full crypto configuration from the environment. Cheap enough to call
 * per request/cycle; reads are not cached so runtime env changes take effect.
 */
export function getMarketplaceCryptoConfig(): MarketplaceCryptoConfig {
  const chains = parseChains(process.env.MARKETPLACE_EVM_CHAINS);
  const hasDepositSeed = Boolean(
    (process.env.MARKETPLACE_DEPOSIT_MNEMONIC || process.env.MARKETPLACE_DEPOSIT_SEED || "").trim()
  );
  const hasTreasury = chains.some((c) => Boolean(c.treasuryAddress));
  const withdrawalsEnabled =
    hasTreasury && Boolean((process.env.MARKETPLACE_TREASURY_PRIVKEY || "").trim());
  // Global testnet mode: forced via env, or inferred when every configured
  // chain is a testnet. With no chains configured it follows the forced flag.
  const testnetMode =
    isTestnetModeForced() || (chains.length > 0 && chains.every((c) => c.isTestnet));
  return {
    // Crypto deposits are enabled when at least one chain is configured and we
    // can attribute deposits: either via per-user derived addresses (a seed) or
    // via a single treasury address (attribution by sender).
    enabled: chains.length > 0 && (hasDepositSeed || hasTreasury),
    chains,
    hasDepositSeed,
    hasTreasury,
    withdrawalsEnabled,
    testnetMode,
  };
}

export function getMarketplaceChain(chainId: number): MarketplaceChainConfig | null {
  return getMarketplaceCryptoConfig().chains.find((c) => c.chainId === chainId) || null;
}

/**
 * Convert a raw on-chain token amount (integer string in base units) to
 * integer micro-USD, applying the token's decimals and USD price.
 *
 * Uses BigInt for the base-unit math to avoid float precision loss on large
 * balances, then scales by usdPerToken (a small float) at the end.
 */
export function tokenBaseUnitsToMicroUsd(
  amountBaseUnits: string,
  tokenDecimals: number,
  usdPerToken: number
): number {
  let raw: bigint;
  try {
    raw = BigInt(amountBaseUnits);
  } catch {
    return 0;
  }
  if (raw <= 0n) return 0;

  // micro-USD = amount / 10^decimals * usdPerToken * 1e6
  // Compute (raw * 1_000_000) / 10^decimals exactly in BigInt, then * usdPerToken.
  const scaled = (raw * 1_000_000n) / 10n ** BigInt(tokenDecimals);
  const microUsd = Number(scaled) * usdPerToken;
  return Math.floor(microUsd);
}

/**
 * Convert integer micro-USD to a raw on-chain token amount (base units, as a
 * decimal string). Inverse of tokenBaseUnitsToMicroUsd — used to size a
 * withdrawal transfer. Rounds DOWN so a withdrawal never sends more than the
 * debited balance is worth.
 *
 *   tokenBaseUnits = microUsd / 1e6 / usdPerToken * 10^decimals
 */
export function microUsdToTokenBaseUnits(
  amountMicroUsd: number,
  tokenDecimals: number,
  usdPerToken: number
): string {
  if (!Number.isFinite(amountMicroUsd) || amountMicroUsd <= 0) return "0";
  if (!Number.isFinite(usdPerToken) || usdPerToken <= 0) return "0";
  // whole-token amount = microUsd / 1e6 / usdPerToken
  // base units = wholeTokens * 10^decimals
  // Compute via BigInt where possible: (microUsd * 10^decimals) / (1e6 * usdPerToken)
  const numerator = BigInt(Math.floor(amountMicroUsd)) * 10n ** BigInt(tokenDecimals);
  // usdPerToken is a small float (1.0 for stablecoins); scale it to an integer
  // with 1e6 precision to keep the division in BigInt.
  const priceScaled = BigInt(Math.round(usdPerToken * 1_000_000));
  if (priceScaled <= 0n) return "0";
  const baseUnits = numerator / priceScaled;
  return baseUnits.toString(10);
}
