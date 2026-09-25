import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mkt-watcher-treasury-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const users = await import("../../../src/lib/db/marketplaceUsers.ts");
const watcher = await import("../../../src/lib/marketplace/crypto/watcher.ts");
import type { TransferLog } from "../../../src/lib/marketplace/crypto/erc20.ts";

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

const USER_WALLET = "0xaaa0000000000000000000000000000000000001";
const TREASURY_ADDRESS = "0xtreasury000000000000000000000000000000beef";

const TREASURY_CHAIN = {
  chainId: 11155111,
  name: "sepolia-treasury",
  rpcUrl: "https://rpc.example",
  tokenAddress: "0xtoken",
  tokenDecimals: 6,
  minConfirmations: 5,
  usdPerToken: 1,
  reorgRecheckBlocks: 64,
  chainlinkFeed: null,
  cexSymbol: null,
  priceMaxAgeSec: 3600,
  treasuryAddress: TREASURY_ADDRESS,
};

const LEGACY_CHAIN = {
  chainId: 137,
  name: "polygon-legacy",
  rpcUrl: "https://rpc.example",
  tokenAddress: "0xtoken",
  tokenDecimals: 6,
  minConfirmations: 5,
  usdPerToken: 1,
  reorgRecheckBlocks: 64,
  chainlinkFeed: null,
  cexSymbol: null,
  priceMaxAgeSec: 3600,
  treasuryAddress: null,
};

function makeRpc(
  head: number,
  logs: TransferLog[],
  receipts: Record<string, { blockNumber: number | null; status: number | null }> = {}
) {
  return {
    getBlockNumber: async () => head,
    getDepositTransferLogs: async () => logs,
    getTransactionReceipt: async (_rpcUrl: string, txHash: string) =>
      receipts[txHash] ?? { blockNumber: null, status: null },
    isTransactionKnown: async (_rpcUrl: string, txHash: string) => Boolean(receipts[txHash]),
  };
}

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── Treasury mode ───────────────────────────────────────────────────────────

test("treasury mode: attributes deposit by log.from for a known wallet", async () => {
  const user = users.getOrCreateMarketplaceUserByWallet(USER_WALLET);
  const log: TransferLog = {
    txHash: "0xtreasury1",
    logIndex: 0,
    blockNumber: 100,
    tokenAddress: TREASURY_CHAIN.tokenAddress,
    from: USER_WALLET,
    to: TREASURY_ADDRESS,
    amount: "5000000", // 5 USDC
  };

  // head=110 → 11 confirmations (>= 5): credited.
  const r = await watcher.runChainCycle(
    TREASURY_CHAIN,
    makeRpc(110, [log], { "0xtreasury1": { blockNumber: 100, status: 1 } })
  );
  assert.equal(r.newDeposits, 1);
  assert.equal(r.credited, 1);
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 5_000_000);
});

test("treasury mode: auto-creates user for a deposit from an unknown wallet", async () => {
  const unknownWallet = "0xnewuser00000000000000000000000000000000babe";
  assert.equal(users.getMarketplaceUserByWallet(unknownWallet), null);

  const log: TransferLog = {
    txHash: "0xnewuser",
    logIndex: 0,
    blockNumber: 50,
    tokenAddress: TREASURY_CHAIN.tokenAddress,
    from: unknownWallet,
    to: TREASURY_ADDRESS,
    amount: "10000000",
  };

  const r = await watcher.runChainCycle(
    TREASURY_CHAIN,
    makeRpc(100, [log], { "0xnewuser": { blockNumber: 50, status: 1 } })
  );
  assert.equal(r.credited, 1);

  const newUser = users.getMarketplaceUserByWallet(unknownWallet);
  assert.notEqual(newUser, null);
  assert.equal(newUser?.walletAddress, unknownWallet);
  assert.equal(newUser?.balanceMicroUsd, 10_000_000);
});

test("treasury mode: ignores transfer from zero address (mint/burn)", async () => {
  const log: TransferLog = {
    txHash: "0xzero",
    logIndex: 0,
    blockNumber: 10,
    tokenAddress: TREASURY_CHAIN.tokenAddress,
    from: "0x0000000000000000000000000000000000000000",
    to: TREASURY_ADDRESS,
    amount: "999999999999",
  };

  const r = await watcher.runChainCycle(
    TREASURY_CHAIN,
    makeRpc(100, [log])
  );
  assert.equal(r.newDeposits, 0);
  // No auto-created user for zero address.
  assert.equal(users.getMarketplaceUserByWallet("0x0000000000000000000000000000000000000000"), null);
});

test("treasury mode: does not double-credit across repeated cycles", async () => {
  const user = users.getOrCreateMarketplaceUserByWallet(USER_WALLET);
  const log: TransferLog = {
    txHash: "0xdouble",
    logIndex: 0,
    blockNumber: 50,
    tokenAddress: TREASURY_CHAIN.tokenAddress,
    from: USER_WALLET,
    to: TREASURY_ADDRESS,
    amount: "3000000",
  };
  const receipts = { "0xdouble": { blockNumber: 50, status: 1 } };
  await watcher.runChainCycle(TREASURY_CHAIN, makeRpc(100, [log], receipts));
  await watcher.runChainCycle(TREASURY_CHAIN, makeRpc(101, [log], receipts));
  await watcher.runChainCycle(TREASURY_CHAIN, makeRpc(102, [], receipts));

  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 3_000_000);
});

test("treasury mode: ledger reconciliation reports zero drift", async () => {
  users.getOrCreateMarketplaceUserByWallet(USER_WALLET);
  const log: TransferLog = {
    txHash: "0xrec",
    logIndex: 0,
    blockNumber: 100,
    tokenAddress: TREASURY_CHAIN.tokenAddress,
    from: USER_WALLET,
    to: TREASURY_ADDRESS,
    amount: "1500000",
  };
  await watcher.runChainCycle(
    TREASURY_CHAIN,
    makeRpc(110, [log], { "0xrec": { blockNumber: 100, status: 1 } })
  );
  assert.deepEqual(users.reconcileMarketplaceUserBalances(), []);

  // Reverse via reorg.
  await watcher.runChainCycle(TREASURY_CHAIN, makeRpc(111, [], {}));
  assert.deepEqual(users.reconcileMarketplaceUserBalances(), []);
});

// ─── Legacy mode still works ─────────────────────────────────────────────────

test("legacy mode (no treasury): attributes by log.to to a known deposit address", async () => {
  const user = users.getOrCreateMarketplaceUserByWallet("0xlegacy000000000000000000000000000000dead");
  const depositAddr = "0xdeposita0000000000000000000000000000beef";
  users.createMarketplaceDepositAddress({
    userId: user.id,
    chainId: LEGACY_CHAIN.chainId,
    tokenAddress: LEGACY_CHAIN.tokenAddress,
    depositAddress: depositAddr,
    derivationIndex: 1,
  });

  const log: TransferLog = {
    txHash: "0legacy1",
    logIndex: 0,
    blockNumber: 100,
    tokenAddress: LEGACY_CHAIN.tokenAddress,
    from: "0xsender",
    to: depositAddr,
    amount: "2000000",
  };

  const r = await watcher.runChainCycle(
    LEGACY_CHAIN,
    makeRpc(110, [log], { "0legacy1": { blockNumber: 100, status: 1 } })
  );
  assert.equal(r.credited, 1);
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 2_000_000);
});

// ─── resolveTreasuryDepositOwner ─────────────────────────────────────────────

test("resolveTreasuryDepositOwner returns user for known wallet", () => {
  const user = users.getOrCreateMarketplaceUserByWallet(USER_WALLET);
  const owner = watcher.__watcherInternals.resolveTreasuryDepositOwner(USER_WALLET);
  assert.notEqual(owner, null);
  assert.equal(owner?.userId, user.id);
});

test("resolveTreasuryDepositOwner auto-creates user for unknown wallet", () => {
  const wallet = "0xbrandnew000000000000000000000000000000c0ffee";
  assert.equal(users.getMarketplaceUserByWallet(wallet), null);
  const owner = watcher.__watcherInternals.resolveTreasuryDepositOwner(wallet);
  assert.notEqual(owner, null);
  const created = users.getMarketplaceUserByWallet(wallet);
  assert.notEqual(created, null);
  assert.equal(created?.walletAddress, wallet);
  assert.equal(owner?.userId, created?.id);
});

test("resolveTreasuryDepositOwner auto-creates despite zero-ish address (filtered by watcher)", () => {
  // resolveTreasuryDepositOwner does not validate the address — it auto-creates a
  // user for anything that normalizes to a non-empty string. The watcher filters
  // the zero address before calling this function, so the auto-create is harmless.
  const owner = watcher.__watcherInternals.resolveTreasuryDepositOwner(
    "0x0000000000000000000000000000000000000000"
  );
  assert.notEqual(owner, null);
  const created = users.getMarketplaceUserByWallet("0x0000000000000000000000000000000000000000");
  assert.notEqual(created, null);
});
