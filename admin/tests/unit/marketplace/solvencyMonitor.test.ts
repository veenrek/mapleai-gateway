import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Solvency monitor: DB liabilities must be covered by the on-chain treasury.
// Isolated DATA_DIR per test; handle closed in test.after.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-solvency-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const marketplace = await import("../../../src/lib/db/marketplace.ts");
const users = await import("../../../src/lib/db/marketplaceUsers.ts");
const monitor = await import("../../../src/lib/marketplace/crypto/solvencyMonitor.ts");

test.after(() => {
  try {
    core.resetDbInstance();
  } catch {}
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
});

test("liabilities sum users + sellers + USD buyer keys", async () => {
  const user = users.getOrCreateMarketplaceUserByWallet(
    "0x1111111111111111111111111111111111111111"
  );
  users.creditMarketplaceUserBalance(user.id, 5_000_000, "deposit"); // $5
  marketplace.createMarketplaceSeller({ name: "s1" });
  // Seller balance starts at 0; credit one via the ledger helper:
  marketplace.createMarketplaceBuyerKey({
    name: "usd-key",
    balanceMicroUsd: 2_500_000, // $2.50
    userId: null,
  });

  const liabilities = monitor.sumMarketplaceLiabilities();
  assert.equal(liabilities.users >= 5_000_000, true);
  assert.equal(liabilities.buyerKeys >= 2_500_000, true);
  assert.ok(liabilities.sellers >= 0);
  assert.equal(liabilities.total, liabilities.users + liabilities.sellers + liabilities.buyerKeys);
});

test("report without configured chains is skipped-but-persisted", async () => {
  delete process.env.MARKETPLACE_EVM_CHAINS;
  const report = await monitor.runSolvencyCheck();
  assert.equal(report.skippedReason, "marketplace crypto not configured");
  assert.equal(report.healthy, true);

  const last = monitor.getLastSolvencyReport();
  assert.ok(last);
  assert.equal(last!.checkedAt, report.checkedAt);
});

test("shortfall is detected when liabilities exceed assets (mocked chain read)", async () => {
  process.env.MARKETPLACE_EVM_CHAINS = JSON.stringify([
    {
      chainId: 84532,
      name: "base-sepolia",
      rpcUrl: "http://127.0.0.1:1", // unreachable — asset read fails → unhealthy
      tokenAddress: "0x0000000000000000000000000000000000000001",
      tokenDecimals: 6,
      usdPerToken: 1,
      treasuryAddress: "0x2222222222222222222222222222222222222222",
    },
  ]);
  try {
    const report = await monitor.runSolvencyCheck();
    assert.equal(report.skippedReason, undefined);
    assert.equal(report.healthy, false, "unreachable RPC must fail the check, not pass silently");
    assert.ok(report.assets.chains[0].error);
    assert.equal(report.assets.totalMicroUsd, 0);
    if (report.liabilities.total > 0) {
      assert.equal(report.shortfallMicroUsd, report.liabilities.total);
    }
  } finally {
    delete process.env.MARKETPLACE_EVM_CHAINS;
  }
});
