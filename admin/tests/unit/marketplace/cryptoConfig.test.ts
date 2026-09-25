import test from "node:test";
import assert from "node:assert/strict";

const config = await import("../../../src/lib/marketplace/crypto/config.ts");

const TREASURY = "0x" + "ab".repeat(20);

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("parses treasuryAddress (lowercased) from chain config", () => {
  withEnv(
    {
      MARKETPLACE_EVM_CHAINS: JSON.stringify([
        {
          chainId: 11155111,
          name: "Sepolia",
          rpcUrl: "https://rpc.example",
          tokenAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
          tokenDecimals: 6,
          minConfirmations: 5,
          treasuryAddress: TREASURY.toUpperCase(),
        },
      ]),
      MARKETPLACE_DEPOSIT_MNEMONIC: undefined,
      MARKETPLACE_DEPOSIT_SEED: undefined,
    },
    () => {
      const cfg = config.getMarketplaceCryptoConfig();
      assert.equal(cfg.chains.length, 1);
      assert.equal(cfg.chains[0].treasuryAddress, TREASURY); // lowercased
      assert.equal(cfg.hasTreasury, true);
    }
  );
});

test("enabled is true with a treasury address and no deposit seed", () => {
  withEnv(
    {
      MARKETPLACE_EVM_CHAINS: JSON.stringify([
        {
          chainId: 137,
          name: "Polygon",
          rpcUrl: "https://rpc.example",
          tokenAddress: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
          tokenDecimals: 6,
          minConfirmations: 12,
          treasuryAddress: TREASURY,
        },
      ]),
      MARKETPLACE_DEPOSIT_MNEMONIC: undefined,
      MARKETPLACE_DEPOSIT_SEED: undefined,
    },
    () => {
      const cfg = config.getMarketplaceCryptoConfig();
      assert.equal(cfg.enabled, true);
      assert.equal(cfg.hasDepositSeed, false);
      assert.equal(cfg.hasTreasury, true);
    }
  );
});

test("skips chain with an invalid treasuryAddress", () => {
  withEnv(
    {
      MARKETPLACE_EVM_CHAINS: JSON.stringify([
        {
          chainId: 1,
          name: "Mainnet",
          rpcUrl: "https://rpc.example",
          tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          tokenDecimals: 6,
          treasuryAddress: "0xnot-an-address",
        },
      ]),
    },
    () => {
      const cfg = config.getMarketplaceCryptoConfig();
      assert.equal(cfg.chains.length, 0);
      assert.equal(cfg.hasTreasury, false);
    }
  );
});

test("treasuryAddress is null when omitted (legacy mode)", () => {
  withEnv(
    {
      MARKETPLACE_EVM_CHAINS: JSON.stringify([
        {
          chainId: 1,
          name: "Mainnet",
          rpcUrl: "https://rpc.example",
          tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          tokenDecimals: 6,
        },
      ]),
      MARKETPLACE_DEPOSIT_MNEMONIC: undefined,
      MARKETPLACE_DEPOSIT_SEED: undefined,
      MARKETPLACE_TESTNET_MODE: undefined,
    },
    () => {
      const cfg = config.getMarketplaceCryptoConfig();
      assert.equal(cfg.chains.length, 1);
      assert.equal(cfg.chains[0].treasuryAddress, null);
      assert.equal(cfg.hasTreasury, false);
      // No seed and no treasury → disabled.
      assert.equal(cfg.enabled, false);
    }
  );
});

// ── Testnet mode ─────────────────────────────────────────────────────────────

test("auto-detects Sepolia as a testnet and sets testnetMode", () => {
  withEnv(
    {
      MARKETPLACE_EVM_CHAINS: JSON.stringify([
        {
          chainId: 11155111,
          name: "Sepolia",
          rpcUrl: "https://rpc.example",
          tokenAddress: TREASURY,
          tokenDecimals: 6,
          treasuryAddress: TREASURY,
        },
      ]),
      MARKETPLACE_TESTNET_MODE: undefined,
    },
    () => {
      const cfg = config.getMarketplaceCryptoConfig();
      assert.equal(cfg.chains[0].isTestnet, true);
      assert.equal(cfg.testnetMode, true);
    }
  );
});

test("mainnet chain is not a testnet and testnetMode is false", () => {
  withEnv(
    {
      MARKETPLACE_EVM_CHAINS: JSON.stringify([
        {
          chainId: 1,
          name: "Mainnet",
          rpcUrl: "https://rpc.example",
          tokenAddress: TREASURY,
          tokenDecimals: 6,
          treasuryAddress: TREASURY,
        },
      ]),
      MARKETPLACE_TESTNET_MODE: undefined,
    },
    () => {
      const cfg = config.getMarketplaceCryptoConfig();
      assert.equal(cfg.chains[0].isTestnet, false);
      assert.equal(cfg.testnetMode, false);
    }
  );
});

test("explicit isTestnet:true overrides auto-detection for an unknown chain id", () => {
  withEnv(
    {
      MARKETPLACE_EVM_CHAINS: JSON.stringify([
        {
          chainId: 31337, // local/anvil — not in the known set
          name: "Local",
          rpcUrl: "https://rpc.example",
          tokenAddress: TREASURY,
          tokenDecimals: 6,
          treasuryAddress: TREASURY,
          isTestnet: true,
        },
      ]),
      MARKETPLACE_TESTNET_MODE: undefined,
    },
    () => {
      const cfg = config.getMarketplaceCryptoConfig();
      assert.equal(cfg.chains[0].isTestnet, true);
      assert.equal(cfg.testnetMode, true);
    }
  );
});

test("MARKETPLACE_TESTNET_MODE=1 rejects mainnet chains", () => {
  withEnv(
    {
      MARKETPLACE_EVM_CHAINS: JSON.stringify([
        {
          chainId: 11155111,
          name: "Sepolia",
          rpcUrl: "https://rpc.example",
          tokenAddress: TREASURY,
          tokenDecimals: 6,
          treasuryAddress: TREASURY,
        },
        {
          chainId: 1,
          name: "Mainnet",
          rpcUrl: "https://rpc.example",
          tokenAddress: TREASURY,
          tokenDecimals: 6,
          treasuryAddress: TREASURY,
        },
      ]),
      MARKETPLACE_TESTNET_MODE: "1",
    },
    () => {
      const cfg = config.getMarketplaceCryptoConfig();
      // Mainnet (chainId 1) dropped; only Sepolia remains.
      assert.equal(cfg.chains.length, 1);
      assert.equal(cfg.chains[0].chainId, 11155111);
      assert.equal(cfg.testnetMode, true);
    }
  );
});

test("mixed testnet + mainnet (no force) → testnetMode false", () => {
  withEnv(
    {
      MARKETPLACE_EVM_CHAINS: JSON.stringify([
        { chainId: 11155111, name: "Sepolia", rpcUrl: "https://r", tokenAddress: TREASURY, treasuryAddress: TREASURY },
        { chainId: 1, name: "Mainnet", rpcUrl: "https://r", tokenAddress: TREASURY, treasuryAddress: TREASURY },
      ]),
      MARKETPLACE_TESTNET_MODE: undefined,
    },
    () => {
      const cfg = config.getMarketplaceCryptoConfig();
      assert.equal(cfg.chains.length, 2);
      assert.equal(cfg.testnetMode, false);
    }
  );
});
