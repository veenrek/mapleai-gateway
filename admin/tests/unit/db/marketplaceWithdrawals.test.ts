import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mkt-withdrawals-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const users = await import("../../../src/lib/db/marketplaceUsers.ts");

function resetDb() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => resetDb());
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const WALLET = "0xaaa0000000000000000000000000000000000001";
const TOKEN = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

function fundedUser(microUsd: number) {
  const user = users.getOrCreateMarketplaceUserByWallet(WALLET);
  if (microUsd > 0) {
    users.creditMarketplaceUserBalance(user.id, microUsd, "test_seed");
  }
  return users.getMarketplaceUserById(user.id)!;
}

test("recordUserWithdrawal debits balance and creates a pending withdrawal", () => {
  const user = fundedUser(10_000_000); // $10
  const w = users.recordUserWithdrawal({
    userId: user.id,
    chainId: 11155111,
    tokenAddress: TOKEN,
    toAddress: WALLET,
    amountMicroUsd: 4_000_000,
    amountToken: "4000000",
  });
  assert.equal(w.status, "pending");
  assert.equal(w.amountMicroUsd, 4_000_000);
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 6_000_000);
});

test("recordUserWithdrawal rejects an amount exceeding the balance (402)", () => {
  const user = fundedUser(1_000_000);
  assert.throws(
    () =>
      users.recordUserWithdrawal({
        userId: user.id,
        chainId: 1,
        tokenAddress: TOKEN,
        toAddress: WALLET,
        amountMicroUsd: 5_000_000,
        amountToken: "5000000",
      }),
    (err: { status?: number }) => err.status === 402
  );
  // Balance unchanged.
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 1_000_000);
});

test("markWithdrawalFailed refunds a pending withdrawal (broadcast never succeeded)", () => {
  const user = fundedUser(10_000_000);
  const w = users.recordUserWithdrawal({
    userId: user.id,
    chainId: 1,
    tokenAddress: TOKEN,
    toAddress: WALLET,
    amountMicroUsd: 3_000_000,
    amountToken: "3000000",
  });
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 7_000_000);

  const failed = users.markWithdrawalFailed(w.id, "broadcast error");
  assert.equal(failed.status, "failed");
  // Refunded back to the full balance.
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 10_000_000);
});

test("submitted → confirmed does not refund; balance stays debited", () => {
  const user = fundedUser(10_000_000);
  const w = users.recordUserWithdrawal({
    userId: user.id,
    chainId: 1,
    tokenAddress: TOKEN,
    toAddress: WALLET,
    amountMicroUsd: 2_000_000,
    amountToken: "2000000",
  });
  const submitted = users.markWithdrawalSubmitted(w.id, "0xdeadbeef");
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.txHash, "0xdeadbeef");

  const confirmed = users.markWithdrawalConfirmed(w.id);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 8_000_000);
});

test("markWithdrawalFailed refunds a submitted withdrawal (tx reverted/dropped)", () => {
  const user = fundedUser(10_000_000);
  const w = users.recordUserWithdrawal({
    userId: user.id,
    chainId: 1,
    tokenAddress: TOKEN,
    toAddress: WALLET,
    amountMicroUsd: 2_500_000,
    amountToken: "2500000",
  });
  users.markWithdrawalSubmitted(w.id, "0xabc");
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 7_500_000);

  users.markWithdrawalFailed(w.id, "reverted");
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 10_000_000);
});

test("markWithdrawalFailed is idempotent on an already-confirmed withdrawal", () => {
  const user = fundedUser(10_000_000);
  const w = users.recordUserWithdrawal({
    userId: user.id,
    chainId: 1,
    tokenAddress: TOKEN,
    toAddress: WALLET,
    amountMicroUsd: 1_000_000,
    amountToken: "1000000",
  });
  users.markWithdrawalSubmitted(w.id, "0xabc");
  users.markWithdrawalConfirmed(w.id);

  const noop = users.markWithdrawalFailed(w.id, "late failure");
  assert.equal(noop.status, "confirmed"); // unchanged
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 9_000_000);
});

test("ledger reconciliation reports zero drift after withdrawal + refund cycle", () => {
  const user = fundedUser(10_000_000);
  const w = users.recordUserWithdrawal({
    userId: user.id,
    chainId: 1,
    tokenAddress: TOKEN,
    toAddress: WALLET,
    amountMicroUsd: 4_000_000,
    amountToken: "4000000",
  });
  assert.deepEqual(users.reconcileMarketplaceUserBalances(), []);

  users.markWithdrawalSubmitted(w.id, "0xabc");
  users.markWithdrawalFailed(w.id, "reverted");
  assert.deepEqual(users.reconcileMarketplaceUserBalances(), []);
  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 10_000_000);
});

test("listSubmittedWithdrawals returns only submitted rows", () => {
  const user = fundedUser(10_000_000);
  const a = users.recordUserWithdrawal({
    userId: user.id,
    chainId: 1,
    tokenAddress: TOKEN,
    toAddress: WALLET,
    amountMicroUsd: 1_000_000,
    amountToken: "1000000",
  });
  const b = users.recordUserWithdrawal({
    userId: user.id,
    chainId: 1,
    tokenAddress: TOKEN,
    toAddress: WALLET,
    amountMicroUsd: 1_000_000,
    amountToken: "1000000",
  });
  users.markWithdrawalSubmitted(a.id, "0xa");
  // b stays pending
  const submitted = users.listSubmittedWithdrawals();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].id, a.id);
  assert.ok(b.id);
});
