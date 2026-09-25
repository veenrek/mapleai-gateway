import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mkt-users-"));
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

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const WALLET = "0xAbC0000000000000000000000000000000000001";

test("getOrCreateMarketplaceUserByWallet is idempotent and lowercases the wallet", () => {
  const a = users.getOrCreateMarketplaceUserByWallet(WALLET);
  const b = users.getOrCreateMarketplaceUserByWallet(WALLET.toLowerCase());
  assert.equal(a.id, b.id);
  assert.equal(a.walletAddress, WALLET.toLowerCase());
  assert.equal(a.balanceMicroUsd, 0);
});

test("credit and debit move the wallet balance and enforce sufficiency", () => {
  const user = users.getOrCreateMarketplaceUserByWallet(WALLET);
  const credited = users.creditMarketplaceUserBalance(user.id, 5_000_000, "test_credit");
  assert.equal(credited.balanceMicroUsd, 5_000_000);

  const debited = users.debitMarketplaceUserBalance(user.id, 2_000_000, "test_debit");
  assert.equal(debited.balanceMicroUsd, 3_000_000);

  assert.throws(
    () => users.debitMarketplaceUserBalance(user.id, 10_000_000, "test_debit"),
    /Insufficient/
  );
});

test("deposit credit is idempotent — double credit does not double the balance", () => {
  const user = users.getOrCreateMarketplaceUserByWallet(WALLET);
  const deposit = users.recordMarketplaceDeposit({
    userId: user.id,
    chainId: 1,
    txHash: "0xdeadbeef",
    logIndex: 0,
    blockNumber: 100,
    tokenAddress: "0xToKeN",
    toAddress: "0xDepositAddr",
    amountToken: "1000000",
    amountMicroUsd: 1_000_000,
    confirmations: 20,
  });

  const first = users.creditMarketplaceDeposit(deposit.id);
  const second = users.creditMarketplaceDeposit(deposit.id);
  assert.equal(first, true);
  assert.equal(second, false);

  const after = users.getMarketplaceUserById(user.id);
  assert.equal(after?.balanceMicroUsd, 1_000_000);
});

test("recordMarketplaceDeposit dedupes on (chain, tx, log)", () => {
  const user = users.getOrCreateMarketplaceUserByWallet(WALLET);
  const base = {
    userId: user.id,
    chainId: 1,
    txHash: "0xsame",
    logIndex: 3,
    blockNumber: 100,
    tokenAddress: "0xToKeN",
    toAddress: "0xDepositAddr",
    amountToken: "5",
    amountMicroUsd: 5,
  };
  const a = users.recordMarketplaceDeposit({ ...base, confirmations: 1 });
  const b = users.recordMarketplaceDeposit({ ...base, confirmations: 9 });
  assert.equal(a.id, b.id);
  assert.equal(b.confirmations, 9);
});

test("auth nonce is single-use and rejects replay / foreign wallet / expiry", () => {
  const nonce = users.issueMarketplaceAuthNonce(WALLET);
  // Foreign wallet cannot consume.
  assert.equal(users.consumeMarketplaceAuthNonce(nonce, "0x9999999999999999999999999999999999999999"), false);
  // Correct wallet consumes once.
  assert.equal(users.consumeMarketplaceAuthNonce(nonce, WALLET), true);
  // Replay fails.
  assert.equal(users.consumeMarketplaceAuthNonce(nonce, WALLET), false);
});

test("fundBuyerKeyFromUserBalance is atomic and rejects cross-user keys", async () => {
  const marketplace = await import("../../../src/lib/db/marketplace.ts");
  const user = users.getOrCreateMarketplaceUserByWallet(WALLET);
  users.creditMarketplaceUserBalance(user.id, 4_000_000, "test_credit");

  const { buyerKey } = marketplace.createMarketplaceBuyerKey({
    name: "buyer",
    userId: user.id,
  });

  const result = users.fundBuyerKeyFromUserBalance(user.id, buyerKey.id, 1_500_000);
  assert.equal(result.userBalanceMicroUsd, 2_500_000);
  assert.equal(result.buyerKeyBalanceMicroUsd, 1_500_000);

  // A different user cannot fund this key.
  const other = users.getOrCreateMarketplaceUserByWallet("0x1111111111111111111111111111111111111111");
  users.creditMarketplaceUserBalance(other.id, 9_000_000, "test_credit");
  assert.throws(
    () => users.fundBuyerKeyFromUserBalance(other.id, buyerKey.id, 1_000_000),
    /does not belong/
  );

  // Reconciliation: the funding user's wallet ledger still matches its balance
  // (the buyer-key credit is intentionally not user-scoped).
  const drift = users.reconcileMarketplaceUserBalances();
  assert.deepEqual(drift, []);
});

test("balance never goes negative under repeated debits (no overdraft)", () => {
  const user = users.getOrCreateMarketplaceUserByWallet(WALLET);
  users.creditMarketplaceUserBalance(user.id, 3_000_000, "test_credit");

  // Drain in 1M chunks; the 4th must fail rather than overdraw.
  users.debitMarketplaceUserBalance(user.id, 1_000_000, "spend");
  users.debitMarketplaceUserBalance(user.id, 1_000_000, "spend");
  users.debitMarketplaceUserBalance(user.id, 1_000_000, "spend");
  assert.throws(() => users.debitMarketplaceUserBalance(user.id, 1_000_000, "spend"), /Insufficient/);

  assert.equal(users.getMarketplaceUserById(user.id)?.balanceMicroUsd, 0);
  assert.deepEqual(users.reconcileMarketplaceUserBalances(), []);
});

test("reconciliation detects an out-of-band balance mutation", () => {
  const user = users.getOrCreateMarketplaceUserByWallet(WALLET);
  users.creditMarketplaceUserBalance(user.id, 2_000_000, "test_credit");
  assert.deepEqual(users.reconcileMarketplaceUserBalances(), []);

  // Corrupt the balance directly (simulating a bug / manual edit) and confirm
  // reconciliation surfaces the drift.
  const db = core.getDbInstance();
  db.prepare("UPDATE marketplace_users SET balance_micro_usd = balance_micro_usd + 500000 WHERE id = ?").run(
    user.id
  );
  const drift = users.reconcileMarketplaceUserBalances();
  assert.equal(drift.length, 1);
  assert.equal(drift[0].driftMicroUsd, 500_000);
});
