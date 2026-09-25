import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mkt-watcher-"));
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

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── Cross-instance cycle lock ───────────────────────────────────────────────

const LOCK_NS = "marketplaceDepositWatcher";
const LOCK_KEY = "__cycle_lock__";

function readLockValue(): string | undefined {
  const db = core.getDbInstance() as unknown as {
    prepare: (sql: string) => { get: (...p: unknown[]) => { value: string } | undefined };
  };
  return db.prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?").get(
    LOCK_NS,
    LOCK_KEY
  )?.value;
}

function writeLockValue(value: string): void {
  const db = core.getDbInstance() as unknown as {
    prepare: (sql: string) => { run: (...p: unknown[]) => unknown };
  };
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    LOCK_NS,
    LOCK_KEY,
    value
  );
}

test("acquireCycleLock takes a free/stale lock and blocks while held", () => {
  const now = 1_000_000;
  assert.equal(watcher.acquireCycleLock(now), true);
  // A second instance (same now) sees a live lease → blocked.
  assert.equal(watcher.acquireCycleLock(now), false);
  // Far in the future the lease is stale → reclaimable.
  assert.equal(watcher.acquireCycleLock(now + 10 * 60 * 1000), true);
  watcher.releaseCycleLock();
});

test("releaseCycleLock does not delete a lock another instance has reclaimed", () => {
  const now = 2_000_000;
  assert.equal(watcher.acquireCycleLock(now), true);

  // Simulate our lease expiring and another instance reclaiming the lock with
  // its own token.
  const foreign = `${now + 999_999}:foreign-token`;
  writeLockValue(foreign);

  // Our cycle finishes and releases — it must NOT clear the foreign lock.
  watcher.releaseCycleLock();
  assert.equal(readLockValue(), foreign);
});

test("releaseCycleLock clears our own lock", () => {
  assert.equal(watcher.acquireCycleLock(3_000_000), true);
  watcher.releaseCycleLock();
  assert.equal(readLockValue(), undefined);
});

const CHAIN = {
  chainId: 11155111,
  name: "sepolia",
  rpcUrl: "https://rpc.example",
  tokenAddress: "0xtoken",
  tokenDecimals: 6,
  minConfirmations: 5,
  usdPerToken: 1,
  reorgRecheckBlocks: 64,
  chainlinkFeed: null,
  cexSymbol: null,
  priceMaxAgeSec: 3600,
};

const DEPOSIT_ADDR = "0xdeposita0000000000000000000000000000beef";

function setupUserWithDepositAddress() {
  const user = users.getOrCreateMarketplaceUserByWallet("0xaaa0000000000000000000000000000000000001");
  users.createMarketplaceDepositAddress({
    userId: user.id,
    chainId: CHAIN.chainId,
    tokenAddress: CHAIN.tokenAddress,
    depositAddress: DEPOSIT_ADDR,
    derivationIndex: 0,
  });
  return user;
}

function makeRpc(
  head: number,
  logs: TransferLog[],
  receipts: Record<string, { blockNumber: number | null; status: number | null }> = {},
  known: Record<string, boolean> = {}
) {
  return {
    getBlockNumber: async () => head,
    getDepositTransferLogs: async () => logs,
    getTransactionReceipt: async (_rpcUrl: string, txHash: string) =>
      receipts[txHash] ?? { blockNumber: null, status: null },
    // A tx is "known" to the node when it has a receipt or is explicitly listed
    // in `known`. With neither, treat it as gone (dropped from chain + mempool).
    isTransactionKnown: async (_rpcUrl: string, txHash: string) =>
      known[txHash] ?? Boolean(receipts[txHash]),
  };
}

test("records a deposit but does not credit until confirmations are met", async () => {
  const user = setupUserWithDepositAddress();
  const log: TransferLog = {
    txHash: "0xtx1",
    logIndex: 0,
    blockNumber: 100,
    tokenAddress: CHAIN.tokenAddress,
    from: "0xsender",
    to: DEPOSIT_ADDR,
    amount: "2000000", // 2 USDC
  };

  // head=102 → only 3 confirmations (< 5): recorded, not credited.
  const r1 = await watcher.runChainCycle(CHAIN, makeRpc(102, [log]));
  assert.equal(r1.newDeposits, 1);
  assert.equal(r1.credited, 0);
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 0);

  // head=110 → 11 confirmations (>= 5): credited once. Receipt confirms the tx
  // is still on its original block, so the reorg re-check leaves it credited.
  const r2 = await watcher.runChainCycle(
    CHAIN,
    makeRpc(110, [], { "0xtx1": { blockNumber: 100, status: 1 } })
  );
  assert.equal(r2.credited, 1);
  assert.equal(r2.reversed, 0);
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 2_000_000);
});

test("does not double-credit across repeated cycles", async () => {
  const user = setupUserWithDepositAddress();
  const log: TransferLog = {
    txHash: "0xtx2",
    logIndex: 1,
    blockNumber: 50,
    tokenAddress: CHAIN.tokenAddress,
    from: "0xsender",
    to: DEPOSIT_ADDR,
    amount: "1000000",
  };
  const receipts = { "0xtx2": { blockNumber: 50, status: 1 } };
  await watcher.runChainCycle(CHAIN, makeRpc(100, [log], receipts));
  // Re-deliver the same log on a later cycle (re-org lookback could resurface it).
  await watcher.runChainCycle(CHAIN, makeRpc(101, [log], receipts));
  await watcher.runChainCycle(CHAIN, makeRpc(102, [], receipts));

  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 1_000_000);
});

test("ignores transfers to unknown addresses", async () => {
  const user = setupUserWithDepositAddress();
  const log: TransferLog = {
    txHash: "0xtx3",
    logIndex: 0,
    blockNumber: 10,
    tokenAddress: CHAIN.tokenAddress,
    from: "0xsender",
    to: "0xnotours000000000000000000000000000000000",
    amount: "5000000",
  };
  const r = await watcher.runChainCycle(CHAIN, makeRpc(100, [log]));
  assert.equal(r.newDeposits, 0);
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 0);
});

test("reverses a credited deposit when a reorg drops its tx", async () => {
  const user = setupUserWithDepositAddress();
  const log: TransferLog = {
    txHash: "0xreorg",
    logIndex: 0,
    blockNumber: 100,
    tokenAddress: CHAIN.tokenAddress,
    from: "0xsender",
    to: DEPOSIT_ADDR,
    amount: "3000000",
  };
  // Credit it with a valid receipt.
  await watcher.runChainCycle(
    CHAIN,
    makeRpc(110, [log], { "0xreorg": { blockNumber: 100, status: 1 } })
  );
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 3_000_000);

  // Next cycle: the receipt is gone (reorg dropped the tx) → reversed.
  const r = await watcher.runChainCycle(CHAIN, makeRpc(111, [], {}));
  assert.equal(r.reversed, 1);
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 0);
});

test("does NOT reverse a credited deposit on a transient null receipt while the tx is still known", async () => {
  const user = setupUserWithDepositAddress();
  const log: TransferLog = {
    txHash: "0xtransient",
    logIndex: 0,
    blockNumber: 100,
    tokenAddress: CHAIN.tokenAddress,
    from: "0xsender",
    to: DEPOSIT_ADDR,
    amount: "3000000",
  };
  await watcher.runChainCycle(
    CHAIN,
    makeRpc(110, [log], { "0xtransient": { blockNumber: 100, status: 1 } })
  );
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 3_000_000);

  // RPC momentarily returns no receipt, but the node still knows the tx (mined
  // or mempool) → ambiguous gap, must NOT claw back the credit.
  const r = await watcher.runChainCycle(
    CHAIN,
    makeRpc(111, [], {}, { "0xtransient": true })
  );
  assert.equal(r.reversed, 0);
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 3_000_000);
});

test("ledger reconciliation reports zero drift after credit and reversal", async () => {
  const user = setupUserWithDepositAddress();
  const log: TransferLog = {
    txHash: "0xrec",
    logIndex: 0,
    blockNumber: 100,
    tokenAddress: CHAIN.tokenAddress,
    from: "0xsender",
    to: DEPOSIT_ADDR,
    amount: "1500000",
  };
  await watcher.runChainCycle(
    CHAIN,
    makeRpc(110, [log], { "0xrec": { blockNumber: 100, status: 1 } })
  );
  assert.deepEqual(users.reconcileMarketplaceUserBalances(), []);

  // Reverse via reorg, then reconcile again — books still balance.
  await watcher.runChainCycle(CHAIN, makeRpc(111, [], {}));
  assert.deepEqual(users.reconcileMarketplaceUserBalances(), []);
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 0);
});

// ─── Oracle-priced chain ──────────────────────────────────────────────────

const ORACLE_CHAIN = {
  ...CHAIN,
  tokenDecimals: 18,
  cexSymbol: "ETH-USD", // marks this as an oracle-priced (volatile) token
};

function oracleDeps(usd: number | null) {
  return {
    readChainlinkPrice: async () => null,
    getCexUsdPrice: async () => usd,
    nowSec: () => 1_700_000_000,
  };
}

test("defers credit when the oracle has no price, credits once it returns", async () => {
  const user = setupUserWithDepositAddress();
  const log: TransferLog = {
    txHash: "0xeth",
    logIndex: 0,
    blockNumber: 100,
    tokenAddress: ORACLE_CHAIN.tokenAddress,
    from: "0xsender",
    to: DEPOSIT_ADDR,
    amount: "1000000000000000000", // 1 token (18 decimals)
  };
  const receipts = { "0xeth": { blockNumber: 100, status: 1 } };

  // Confirmed but oracle down → not credited, balance stays 0.
  const r1 = await watcher.runChainCycle(
    ORACLE_CHAIN,
    makeRpc(110, [log], receipts),
    oracleDeps(null)
  );
  assert.equal(r1.credited, 0);
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 0);

  // Oracle now returns $2000 → 1 token credited as 2000 USD.
  const r2 = await watcher.runChainCycle(
    ORACLE_CHAIN,
    makeRpc(111, [], receipts),
    oracleDeps(2000)
  );
  assert.equal(r2.credited, 1);
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 2000 * 1_000_000);
  assert.deepEqual(users.reconcileMarketplaceUserBalances(), []);
});

test("prices the deposit at credit time, not ingest time", async () => {
  const user = setupUserWithDepositAddress();
  const log: TransferLog = {
    txHash: "0xeth2",
    logIndex: 0,
    blockNumber: 100,
    tokenAddress: ORACLE_CHAIN.tokenAddress,
    from: "0xsender",
    to: DEPOSIT_ADDR,
    amount: "500000000000000000", // 0.5 token
  };
  const receipts = { "0xeth2": { blockNumber: 100, status: 1 } };

  // Seen at < minConfirmations (head 102 → 3 conf): recorded, not credited.
  await watcher.runChainCycle(ORACLE_CHAIN, makeRpc(102, [log], receipts), oracleDeps(1000));
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 0);

  // Later cycle prices at $3000 → 0.5 * 3000 = 1500 USD.
  const r = await watcher.runChainCycle(ORACLE_CHAIN, makeRpc(110, [], receipts), oracleDeps(3000));
  assert.equal(r.credited, 1);
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 1500 * 1_000_000);
});
