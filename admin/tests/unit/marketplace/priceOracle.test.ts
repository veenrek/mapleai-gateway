import test from "node:test";
import assert from "node:assert/strict";

const oracle = await import("../../../src/lib/marketplace/crypto/priceOracle.ts");
import type { MarketplaceChainConfig } from "../../../src/lib/marketplace/crypto/config.ts";
import type { OracleDeps } from "../../../src/lib/marketplace/crypto/priceOracle.ts";

const NOW_SEC = 1_700_000_000;

function chain(overrides: Partial<MarketplaceChainConfig> = {}): MarketplaceChainConfig {
  return {
    chainId: 1,
    name: "eth",
    rpcUrl: "https://rpc.example",
    tokenAddress: "0xtoken",
    tokenDecimals: 18,
    minConfirmations: 12,
    usdPerToken: 1,
    reorgRecheckBlocks: 64,
    chainlinkFeed: null,
    cexSymbol: null,
    priceMaxAgeSec: 3600,
    ...overrides,
  };
}

function deps(overrides: Partial<OracleDeps> = {}): OracleDeps {
  return {
    readChainlinkPrice: async () => null,
    getCexUsdPrice: async () => null,
    nowSec: () => NOW_SEC,
    ...overrides,
  };
}

test("no oracle configured → static usdPerToken", async () => {
  const price = await oracle.resolveTokenUsdPrice(chain({ usdPerToken: 1 }), deps());
  assert.deepEqual(price, { usdPerToken: 1, source: "static" });
});

test("fresh Chainlink feed wins", async () => {
  const price = await oracle.resolveTokenUsdPrice(
    chain({ chainlinkFeed: "0xfeed", cexSymbol: "ETH-USD" }),
    deps({
      readChainlinkPrice: async () => ({ usd: 2500, updatedAt: NOW_SEC - 10, decimals: 8 }),
      getCexUsdPrice: async () => 9999, // must not be used
    })
  );
  assert.deepEqual(price, { usdPerToken: 2500, source: "chainlink" });
});

test("stale Chainlink falls back to CEX", async () => {
  const price = await oracle.resolveTokenUsdPrice(
    chain({ chainlinkFeed: "0xfeed", cexSymbol: "ETH-USD", priceMaxAgeSec: 3600 }),
    deps({
      readChainlinkPrice: async () => ({ usd: 2500, updatedAt: NOW_SEC - 7200, decimals: 8 }),
      getCexUsdPrice: async () => 2490,
    })
  );
  assert.deepEqual(price, { usdPerToken: 2490, source: "cex" });
});

test("Chainlink error falls back to CEX", async () => {
  const price = await oracle.resolveTokenUsdPrice(
    chain({ chainlinkFeed: "0xfeed", cexSymbol: "ETH-USD" }),
    deps({
      readChainlinkPrice: async () => {
        throw new Error("rpc down");
      },
      getCexUsdPrice: async () => 2480,
    })
  );
  assert.equal(price?.source, "cex");
  assert.equal(price?.usdPerToken, 2480);
});

test("oracle configured but all sources unavailable → null (defer)", async () => {
  const price = await oracle.resolveTokenUsdPrice(
    chain({ chainlinkFeed: "0xfeed", cexSymbol: "ETH-USD" }),
    deps() // both return null
  );
  assert.equal(price, null);
});

test("CEX-only chain uses CEX", async () => {
  const price = await oracle.resolveTokenUsdPrice(
    chain({ cexSymbol: "ETH-USD" }),
    deps({ getCexUsdPrice: async () => 2475 })
  );
  assert.deepEqual(price, { usdPerToken: 2475, source: "cex" });
});
