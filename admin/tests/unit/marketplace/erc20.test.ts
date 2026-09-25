import test from "node:test";
import assert from "node:assert/strict";

const config = await import("../../../src/lib/marketplace/crypto/config.ts");
const erc20 = await import("../../../src/lib/marketplace/crypto/erc20.ts");

test("Transfer topic0 is the keccak of the event signature", () => {
  // Well-known constant for Transfer(address,address,uint256).
  assert.equal(
    erc20.TRANSFER_TOPIC0,
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  );
});

test("tokenBaseUnitsToMicroUsd applies decimals and price", () => {
  // 1 USDC (6 decimals) at $1 => 1_000_000 micro-USD.
  assert.equal(config.tokenBaseUnitsToMicroUsd("1000000", 6, 1), 1_000_000);
  // 2.5 tokens (6 decimals) at $1 => 2_500_000 micro-USD.
  assert.equal(config.tokenBaseUnitsToMicroUsd("2500000", 6, 1), 2_500_000);
  // 1 token (18 decimals) at $2 => 2_000_000 micro-USD.
  assert.equal(config.tokenBaseUnitsToMicroUsd("1000000000000000000", 18, 2), 2_000_000);
  // Zero / negative / garbage => 0.
  assert.equal(config.tokenBaseUnitsToMicroUsd("0", 6, 1), 0);
  assert.equal(config.tokenBaseUnitsToMicroUsd("notanumber", 6, 1), 0);
});

test("getMarketplaceCryptoConfig parses chains and gates on seed", () => {
  const prevChains = process.env.MARKETPLACE_EVM_CHAINS;
  const prevSeed = process.env.MARKETPLACE_DEPOSIT_MNEMONIC;
  try {
    process.env.MARKETPLACE_EVM_CHAINS = JSON.stringify([
      {
        chainId: 11155111,
        name: "sepolia",
        rpcUrl: "https://rpc.example",
        tokenAddress: "0xAAA",
        tokenDecimals: 6,
        minConfirmations: 3,
      },
    ]);

    delete process.env.MARKETPLACE_DEPOSIT_MNEMONIC;
    const withoutSeed = config.getMarketplaceCryptoConfig();
    assert.equal(withoutSeed.chains.length, 1);
    assert.equal(withoutSeed.chains[0].tokenAddress, "0xaaa"); // lowercased
    assert.equal(withoutSeed.enabled, false); // no seed → disabled

    process.env.MARKETPLACE_DEPOSIT_MNEMONIC = "test seed phrase";
    const withSeed = config.getMarketplaceCryptoConfig();
    assert.equal(withSeed.enabled, true);
  } finally {
    if (prevChains === undefined) delete process.env.MARKETPLACE_EVM_CHAINS;
    else process.env.MARKETPLACE_EVM_CHAINS = prevChains;
    if (prevSeed === undefined) delete process.env.MARKETPLACE_DEPOSIT_MNEMONIC;
    else process.env.MARKETPLACE_DEPOSIT_MNEMONIC = prevSeed;
  }
});

test("malformed MARKETPLACE_EVM_CHAINS yields no chains", () => {
  const prev = process.env.MARKETPLACE_EVM_CHAINS;
  try {
    process.env.MARKETPLACE_EVM_CHAINS = "{not json";
    assert.equal(config.getMarketplaceCryptoConfig().chains.length, 0);
  } finally {
    if (prev === undefined) delete process.env.MARKETPLACE_EVM_CHAINS;
    else process.env.MARKETPLACE_EVM_CHAINS = prev;
  }
});
