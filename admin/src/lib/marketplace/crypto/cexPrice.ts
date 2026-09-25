// CEX spot-price fallback (Coinbase public API).
//
// Used only when the Chainlink feed is missing or stale. Results are cached with
// a short TTL to respect rate limits and avoid hammering the API on every
// deposit. No API key required for the public spot endpoint.

interface CacheEntry {
  usd: number;
  fetchedAtMs: number;
}

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 60_000;

function getTtlMs(): number {
  const raw = Number(process.env.MARKETPLACE_CEX_PRICE_TTL_MS);
  return Number.isFinite(raw) && raw >= 5_000 ? raw : DEFAULT_TTL_MS;
}

/**
 * Fetch a USD spot price for a Coinbase symbol (e.g. "ETH-USD", "USDC-USD").
 * Returns the cached value when fresh. Returns null on any failure (network,
 * shape, non-positive amount) so the caller can fall through / defer.
 */
export async function getCexUsdPrice(symbol: string): Promise<number | null> {
  const sym = symbol.trim().toUpperCase();
  if (!sym) return null;

  const cached = cache.get(sym);
  const now = Date.now();
  if (cached && now - cached.fetchedAtMs < getTtlMs()) {
    return cached.usd;
  }

  try {
    const response = await fetch(`https://api.coinbase.com/v2/prices/${encodeURIComponent(sym)}/spot`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return cached?.usd ?? null;
    const json = (await response.json()) as { data?: { amount?: string } };
    const amount = Number(json?.data?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return cached?.usd ?? null;
    cache.set(sym, { usd: amount, fetchedAtMs: now });
    return amount;
  } catch {
    // Network error — fall back to a cached value if we have one, else null.
    return cached?.usd ?? null;
  }
}

export function resetCexPriceCacheForTests(): void {
  cache.clear();
}

/** Test seam: inject a price into the cache so tests need no network. */
export function __setCexPriceForTests(symbol: string, usd: number, fetchedAtMs: number): void {
  cache.set(symbol.trim().toUpperCase(), { usd, fetchedAtMs });
}
