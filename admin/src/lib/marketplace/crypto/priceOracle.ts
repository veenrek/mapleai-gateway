// Token → USD price oracle for crediting deposits.
//
// Resolution order per chain:
//   1. Chainlink feed (on-chain, via RPC) — primary, if `chainlinkFeed` is set
//      and the answer is fresh (within `priceMaxAgeSec`).
//   2. Coinbase spot price — fallback, if `cexSymbol` is set.
//   3. Static `usdPerToken` — ONLY when neither oracle source is configured
//      (i.e. the operator declared this a fixed-price/stablecoin token).
//   4. null — an oracle source is configured but all are unavailable/stale.
//      The caller must NOT credit; the deposit is retried next cycle.
import { getCexUsdPrice } from "./cexPrice";
import { readChainlinkPrice } from "./chainlink";
import type { MarketplaceChainConfig } from "./config";

export type PriceSource = "chainlink" | "cex" | "static";

export interface TokenPrice {
  usdPerToken: number;
  source: PriceSource;
}

export interface OracleDeps {
  readChainlinkPrice: typeof readChainlinkPrice;
  getCexUsdPrice: typeof getCexUsdPrice;
  /** Unix seconds "now" — injectable for deterministic tests. */
  nowSec: () => number;
}

const defaultDeps: OracleDeps = {
  readChainlinkPrice,
  getCexUsdPrice,
  nowSec: () => Math.floor(Date.now() / 1000),
};

/**
 * Resolve the live USD price for a chain's deposit token. Returns null when an
 * oracle is configured but no fresh price is available — the caller defers
 * crediting rather than booking a wrong amount.
 */
export async function resolveTokenUsdPrice(
  chain: MarketplaceChainConfig,
  deps: OracleDeps = defaultDeps
): Promise<TokenPrice | null> {
  const hasOracle = Boolean(chain.chainlinkFeed || chain.cexSymbol);

  // No oracle configured → operator-declared fixed price (e.g. a stablecoin).
  if (!hasOracle) {
    return { usdPerToken: chain.usdPerToken, source: "static" };
  }

  // 1. Chainlink (primary), rejected if stale.
  if (chain.chainlinkFeed) {
    try {
      const price = await deps.readChainlinkPrice(chain.rpcUrl, chain.chainlinkFeed);
      if (price) {
        const ageSec = deps.nowSec() - price.updatedAt;
        if (ageSec <= chain.priceMaxAgeSec && price.usd > 0) {
          return { usdPerToken: price.usd, source: "chainlink" };
        }
        console.warn(
          `[PriceOracle] chain ${chain.chainId}: Chainlink feed stale (${ageSec}s > ${chain.priceMaxAgeSec}s) — trying CEX`
        );
      }
    } catch (error) {
      console.warn(
        `[PriceOracle] chain ${chain.chainId}: Chainlink read failed:`,
        (error as Error).message
      );
    }
  }

  // 2. CEX fallback.
  if (chain.cexSymbol) {
    try {
      const usd = await deps.getCexUsdPrice(chain.cexSymbol);
      if (usd && usd > 0) {
        return { usdPerToken: usd, source: "cex" };
      }
    } catch (error) {
      console.warn(
        `[PriceOracle] chain ${chain.chainId}: CEX read failed:`,
        (error as Error).message
      );
    }
  }

  // 3. Oracle configured but unavailable → defer.
  console.warn(
    `[PriceOracle] chain ${chain.chainId}: no fresh price available — deferring deposit credit`
  );
  return null;
}
