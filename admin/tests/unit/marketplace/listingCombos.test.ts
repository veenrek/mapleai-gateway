import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Combo-backed marketplace listings: a listing can route through an omniroute
// combo instead of a single pinned provider connection. Isolated DATA_DIR per
// test; the DB handle is closed in test.after.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-listing-combos-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const marketplace = await import("../../../src/lib/db/marketplace.ts");
const combos = await import("../../../src/lib/db/combos.ts");

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

async function createSellerWithConnection() {
  const { seller } = marketplace.createMarketplaceSeller({ name: "Seller" });
  const connection = await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "seller-openai",
    apiKey: "sk-test",
    isActive: true,
  });
  marketplace.attachMarketplaceSellerConnection(seller.id, String(connection?.id));
  return { seller, connectionId: String(connection?.id) };
}

async function createComboFixture(name: string) {
  await combos.createCombo({
    name,
    models: [
      { provider: "openai", model: "gpt-5", priority: 1 },
      { provider: "openai", model: "gpt-5-mini", priority: 2 },
    ],
    strategy: "priority",
  });
  const combo = await combos.getComboByName(name);
  assert.ok(combo);
  return combo as unknown as { id: string; name: string };
}

test("combo-backed listing stores comboId and defaults upstream model to the combo name", async () => {
  const { seller, connectionId } = await createSellerWithConnection();
  const combo = await createComboFixture("gpt-fallback");

  const listing = marketplace.createMarketplaceListing({
    sellerId: seller.id,
    connectionId,
    upstreamModel: "",
    publicModel: "market/test/combo-model",
    inputPriceMicroUsdPerMillionTokens: 1000,
    outputPriceMicroUsdPerMillionTokens: 2000,
    comboId: combo.id,
  });

  assert.equal(listing.comboId, combo.id);
  assert.equal(listing.upstreamModel, "gpt-fallback", "combo name used as routing target");
});

test("combo listing creation rejects an unknown comboId (400)", async () => {
  const { seller, connectionId } = await createSellerWithConnection();
  assert.throws(
    () =>
      marketplace.createMarketplaceListing({
        sellerId: seller.id,
        connectionId,
        upstreamModel: "whatever",
        publicModel: "market/test/bad-combo",
        inputPriceMicroUsdPerMillionTokens: 1000,
        outputPriceMicroUsdPerMillionTokens: 2000,
        comboId: "nonexistent-combo-id",
      }),
    (err: unknown) =>
      err instanceof marketplace.MarketplaceDbError &&
      err.status === 400 &&
      /combo not found/i.test(err.message)
  );
});

test("failover for a combo listing returns exactly one target (combo owns fallback)", async () => {
  const { seller, connectionId } = await createSellerWithConnection();
  // A second connection in the same account group would normally join failover.
  const second = await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "seller-openai-2",
    apiKey: "sk-test-2",
    isActive: true,
  });
  marketplace.attachMarketplaceSellerConnection(seller.id, String(second?.id));

  const combo = await createComboFixture("failover-combo");
  const listing = marketplace.createMarketplaceListing({
    sellerId: seller.id,
    connectionId,
    upstreamModel: "",
    publicModel: "market/test/combo-failover",
    inputPriceMicroUsdPerMillionTokens: 1000,
    outputPriceMicroUsdPerMillionTokens: 2000,
    comboId: combo.id,
  });

  const targets = marketplace.resolveMarketplaceFailoverTargets(listing.id);
  assert.equal(targets.length, 1, "combo handles failover internally — no marketplace retries");
  assert.equal(targets[0].listing.comboId, combo.id);
});

test("plain (non-combo) listing keeps account-group failover", async () => {
  const { seller, connectionId } = await createSellerWithConnection();
  const second = await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "seller-openai-plain-2",
    apiKey: "sk-test-2",
    isActive: true,
  });
  marketplace.attachMarketplaceSellerConnection(seller.id, String(second?.id));

  const listing = marketplace.createMarketplaceListing({
    sellerId: seller.id,
    connectionId,
    upstreamModel: "gpt-5",
    publicModel: "market/test/plain-failover",
    inputPriceMicroUsdPerMillionTokens: 1000,
    outputPriceMicroUsdPerMillionTokens: 2000,
  });

  const targets = marketplace.resolveMarketplaceFailoverTargets(listing.id);
  assert.equal(targets.length, 2, "both same-group connections join the failover chain");
  assert.equal(targets[0].listing.comboId, null);
});
