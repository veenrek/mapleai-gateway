import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mkt-wexec-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const users = await import("../../../src/lib/db/marketplaceUsers.ts");
const executor = await import("../../../src/lib/marketplace/crypto/withdrawalExecutor.ts");

const CHAIN_ID = 11155111;
const TOKEN = "0xtoken000000000000000000000000000000beef";
const USER_WALLET = "0xaaa0000000000000000000000000000000000001";

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

/** Fund a user and create a 'pending' withdrawal of `amountMicroUsd`. */
function pendingWithdrawal(amountMicroUsd: number) {
  const user = users.getOrCreateMarketplaceUserByWallet(USER_WALLET);
  users.creditMarketplaceUserBalance(user.id, amountMicroUsd, "test_seed");
  const w = users.recordUserWithdrawal({
    userId: user.id,
    chainId: CHAIN_ID,
    tokenAddress: TOKEN,
    toAddress: USER_WALLET,
    amountMicroUsd,
    amountToken: String(amountMicroUsd),
  });
  return { userId: user.id, withdrawalId: w.id };
}

function balance(userId: string): number {
  return users.getMarketplaceUserById(userId)!.balanceMicroUsd;
}

function status(id: string, userId: string): string {
  return users.listUserWithdrawals(userId).find((w) => w.id === id)!.status;
}

const broadcast = {
  rpcUrl: "https://rpc.example",
  chainId: CHAIN_ID,
  tokenAddress: TOKEN,
  toAddress: USER_WALLET,
  amountBaseUnits: "5000000",
};

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("broadcast failure refunds the debit (no tx on-chain)", async () => {
  const { userId, withdrawalId } = pendingWithdrawal(5_000_000);
  const afterDebit = balance(userId); // 0 — full amount debited

  const result = await executor.broadcastAndFinalizeWithdrawal(withdrawalId, broadcast, {
    sendTransfer: async () => {
      throw new Error("RPC down");
    },
    markSubmitted: users.markWithdrawalSubmitted,
    markFailed: users.markWithdrawalFailed,
  });

  assert.equal(result.outcome, "broadcast_failed");
  assert.equal(status(withdrawalId, userId), "failed");
  // Refunded: balance restored above the post-debit amount.
  assert.equal(balance(userId), afterDebit + 5_000_000);
});

test("broadcast success then DB-write failure must NOT refund (double-pay guard)", async () => {
  const { userId, withdrawalId } = pendingWithdrawal(5_000_000);
  const afterDebit = balance(userId);

  // The treasury tx broadcast succeeds (hash returned), but persisting the
  // 'submitted' state throws. The funds are in flight — refunding here would
  // double-pay. The executor must swallow the DB error and report submitted.
  const result = await executor.broadcastAndFinalizeWithdrawal(withdrawalId, broadcast, {
    sendTransfer: async () => ({ txHash: "0xdeadbeef" }),
    markSubmitted: () => {
      throw new Error("SQLITE_BUSY");
    },
    markFailed: () => {
      throw new Error("markFailed must never be called after a successful broadcast");
    },
  });

  assert.equal(result.outcome, "submitted");
  assert.equal(result.outcome === "submitted" && result.persisted, false);
  assert.equal(result.outcome === "submitted" && result.txHash, "0xdeadbeef");
  // NOT refunded: balance stays at the post-debit amount.
  assert.equal(balance(userId), afterDebit);
});

test("broadcast success with a healthy DB marks the row submitted", async () => {
  const { userId, withdrawalId } = pendingWithdrawal(5_000_000);
  const afterDebit = balance(userId);

  const result = await executor.broadcastAndFinalizeWithdrawal(withdrawalId, broadcast, {
    sendTransfer: async () => ({ txHash: "0xfeed" }),
    markSubmitted: users.markWithdrawalSubmitted,
    markFailed: users.markWithdrawalFailed,
  });

  assert.equal(result.outcome, "submitted");
  assert.equal(result.outcome === "submitted" && result.persisted, true);
  assert.equal(status(withdrawalId, userId), "submitted");
  assert.equal(balance(userId), afterDebit); // never refunded
});
