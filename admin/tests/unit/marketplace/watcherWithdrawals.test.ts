import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mkt-watcher-withdraw-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

// A single treasury chain so settleWithdrawals can resolve the rpcUrl by chainId.
const CHAIN_ID = 11155111;
process.env.MARKETPLACE_EVM_CHAINS = JSON.stringify([
  {
    chainId: CHAIN_ID,
    name: "sepolia",
    rpcUrl: "https://rpc.example",
    tokenAddress: "0xtoken000000000000000000000000000000beef",
    tokenDecimals: 6,
    minConfirmations: 3,
    treasuryAddress: "0x000000000000000000000000000000000000beef",
  },
]);

const core = await import("../../../src/lib/db/core.ts");
const users = await import("../../../src/lib/db/marketplaceUsers.ts");
const watcher = await import("../../../src/lib/marketplace/crypto/watcher.ts");

const { settleWithdrawals, WITHDRAWAL_DROP_GRACE_MS } = watcher.__watcherInternals;

const USER_WALLET = "0xaaa0000000000000000000000000000000000001";

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

/** Fund a user and put a submitted withdrawal of `amountMicroUsd` on-chain as `txHash`. */
function submittedWithdrawal(amountMicroUsd: number, txHash: string) {
  const user = users.getOrCreateMarketplaceUserByWallet(USER_WALLET);
  users.creditMarketplaceUserBalance(user.id, amountMicroUsd, "test_seed");
  const w = users.recordUserWithdrawal({
    userId: user.id,
    chainId: CHAIN_ID,
    tokenAddress: "0xtoken000000000000000000000000000000beef",
    toAddress: USER_WALLET,
    amountMicroUsd,
    amountToken: String(amountMicroUsd),
  });
  users.markWithdrawalSubmitted(w.id, txHash);
  return { userId: user.id, withdrawalId: w.id };
}

interface Receipt {
  blockNumber: number | null;
  status: number | null;
}

function makeRpc(receipt: Receipt, known: boolean) {
  return {
    getBlockNumber: async () => 0,
    getDepositTransferLogs: async () => [],
    getTransactionReceipt: async () => receipt,
    isTransactionKnown: async () => known,
  };
}

function statusOf(id: string): string {
  return users.listUserWithdrawals(users.getOrCreateMarketplaceUserByWallet(USER_WALLET).id).find(
    (w) => w.id === id
  )!.status;
}

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("settleWithdrawals: confirms a mined+successful tx and does NOT refund", async () => {
  const { userId, withdrawalId } = submittedWithdrawal(5_000_000, "0xmined");
  const balanceAfterDebit = users.getMarketplaceUserById(userId)!.balanceMicroUsd;

  await settleWithdrawals(makeRpc({ blockNumber: 100, status: 1 }, true), Date.now());

  assert.equal(statusOf(withdrawalId), "confirmed");
  // No refund: balance stays at the post-debit amount.
  assert.equal(users.getMarketplaceUserById(userId)!.balanceMicroUsd, balanceAfterDebit);
});

test("settleWithdrawals: refunds a mined-but-reverted tx (funds did not move)", async () => {
  const { userId, withdrawalId } = submittedWithdrawal(5_000_000, "0xreverted");
  const balanceAfterDebit = users.getMarketplaceUserById(userId)!.balanceMicroUsd;

  await settleWithdrawals(makeRpc({ blockNumber: 100, status: 0 }, false), Date.now());

  assert.equal(statusOf(withdrawalId), "failed");
  assert.equal(users.getMarketplaceUserById(userId)!.balanceMicroUsd, balanceAfterDebit + 5_000_000);
});

test("settleWithdrawals: leaves a not-mined tx still in the mempool as 'submitted' (no double-pay)", async () => {
  const { userId, withdrawalId } = submittedWithdrawal(5_000_000, "0xpending");
  const balanceAfterDebit = users.getMarketplaceUserById(userId)!.balanceMicroUsd;

  // Not mined (null receipt) but still known to the node → must wait, never refund.
  await settleWithdrawals(makeRpc({ blockNumber: null, status: null }, true), Date.now());

  assert.equal(statusOf(withdrawalId), "submitted");
  assert.equal(users.getMarketplaceUserById(userId)!.balanceMicroUsd, balanceAfterDebit);
});

test("settleWithdrawals: does NOT refund a freshly-dropped tx before the grace window", async () => {
  const { userId, withdrawalId } = submittedWithdrawal(5_000_000, "0xdropped-fresh");
  const balanceAfterDebit = users.getMarketplaceUserById(userId)!.balanceMicroUsd;

  // Not mined and unknown to the node, but submitted just now → within grace → wait.
  await settleWithdrawals(makeRpc({ blockNumber: null, status: null }, false), Date.now());

  assert.equal(statusOf(withdrawalId), "submitted");
  assert.equal(users.getMarketplaceUserById(userId)!.balanceMicroUsd, balanceAfterDebit);
});

test("settleWithdrawals: refunds a dropped tx only after the grace window elapses", async () => {
  const { userId, withdrawalId } = submittedWithdrawal(5_000_000, "0xdropped-aged");
  const balanceAfterDebit = users.getMarketplaceUserById(userId)!.balanceMicroUsd;

  // Advance the clock past the grace window: not mined + unknown → safe to refund.
  const future = Date.now() + WITHDRAWAL_DROP_GRACE_MS + 1000;
  await settleWithdrawals(makeRpc({ blockNumber: null, status: null }, false), future);

  assert.equal(statusOf(withdrawalId), "failed");
  assert.equal(users.getMarketplaceUserById(userId)!.balanceMicroUsd, balanceAfterDebit + 5_000_000);
});
