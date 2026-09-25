// Chainlink price-feed reader.
//
// Reads a Chainlink AggregatorV3 contract via eth_call on the chain's RPC:
//   - latestRoundData() → (roundId, answer, startedAt, updatedAt, answeredInRound)
//   - decimals()        → uint8
// The price (answer / 10^decimals) is the token's USD value. We also return
// updatedAt so the caller can reject a stale feed.
import { ethCall } from "./erc20";

// Function selectors (first 4 bytes of keccak of the signature).
const SELECTOR_LATEST_ROUND_DATA = "0xfeaf968c"; // latestRoundData()
const SELECTOR_DECIMALS = "0x313ce567"; // decimals()

export interface ChainlinkPrice {
  /** USD price per whole token. */
  usd: number;
  /** Unix seconds when the feed round was last updated. */
  updatedAt: number;
  /** Aggregator answer decimals (typically 8). */
  decimals: number;
}

function hexToBigInt(hexWord: string): bigint {
  return BigInt("0x" + hexWord);
}

/**
 * Parse a signed int256 from a 32-byte (64 hex char) word using two's complement.
 */
function parseInt256(word: string): bigint {
  const value = hexToBigInt(word);
  const MAX_INT256 = (1n << 255n) - 1n;
  return value > MAX_INT256 ? value - (1n << 256n) : value;
}

/** Split 0x-prefixed return data into 32-byte (64 hex char) words. */
function toWords(returnData: string): string[] {
  const clean = returnData.replace(/^0x/, "");
  const words: string[] = [];
  for (let i = 0; i + 64 <= clean.length; i += 64) {
    words.push(clean.slice(i, i + 64));
  }
  return words;
}

/**
 * Read a Chainlink feed and return the USD price and its freshness. Returns null
 * if the feed is unreadable or reports a non-positive answer. `call` is
 * injectable for tests; it defaults to a real eth_call.
 */
export async function readChainlinkPrice(
  rpcUrl: string,
  feedAddress: string,
  call: (rpcUrl: string, to: string, data: string) => Promise<string> = ethCall
): Promise<ChainlinkPrice | null> {
  const [roundRaw, decimalsRaw] = await Promise.all([
    call(rpcUrl, feedAddress, SELECTOR_LATEST_ROUND_DATA),
    call(rpcUrl, feedAddress, SELECTOR_DECIMALS),
  ]);

  const words = toWords(roundRaw);
  // latestRoundData returns 5 words: roundId, answer, startedAt, updatedAt, answeredInRound.
  if (words.length < 5) return null;
  const answer = parseInt256(words[1]);
  const updatedAt = Number(hexToBigInt(words[3]));
  if (answer <= 0n) return null;

  const decimals = Number(hexToBigInt(toWords(decimalsRaw)[0] || "0"));
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) return null;

  const usd = Number(answer) / 10 ** decimals;
  if (!Number.isFinite(usd) || usd <= 0) return null;

  return { usd, updatedAt, decimals };
}
