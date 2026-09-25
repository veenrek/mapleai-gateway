import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-marketplace-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const marketplace = await import("../../../src/lib/db/marketplace.ts");
const pricing = await import("../../../src/lib/marketplace/pricing.ts");

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

async function createListingFixture(
  options: { maxRequestsPerMinute?: number; maxDailyTokens?: number } = {}
) {
  const { seller } = marketplace.createMarketplaceSeller({ name: "Seller" });
  const connection = await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "seller-openai",
    apiKey: "sk-test",
    isActive: true,
  });
  marketplace.attachMarketplaceSellerConnection(seller.id, String(connection?.id));
  const listing = marketplace.createMarketplaceListing({
    sellerId: seller.id,
    connectionId: String(connection?.id),
    upstreamModel: "gpt-4o-mini",
    publicModel: "market/test/gpt-4o-mini",
    inputPriceMicroUsdPerMillionTokens: pricing.usdToMicroUsd(1),
    outputPriceMicroUsdPerMillionTokens: pricing.usdToMicroUsd(2),
    platformFeeBps: 1000,
    maxRequestsPerMinute: options.maxRequestsPerMinute,
    maxDailyTokens: options.maxDailyTokens,
  });
  return { seller, listing };
}

async function createGroupedListingFixture() {
  const { seller } = marketplace.createMarketplaceSeller({ name: "Seller" });
  const first = await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "seller-openai-a",
    apiKey: "sk-test-a",
    isActive: true,
  });
  const second = await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "seller-openai-b",
    apiKey: "sk-test-b",
    isActive: true,
  });
  marketplace.attachMarketplaceSellerConnection(seller.id, String(first?.id));
  marketplace.attachMarketplaceSellerConnection(seller.id, String(second?.id));
  marketplace.updateMarketplaceSellerConnection({
    sellerId: seller.id,
    connectionId: String(first?.id),
    accountGroup: "pool-a",
  });
  marketplace.updateMarketplaceSellerConnection({
    sellerId: seller.id,
    connectionId: String(second?.id),
    accountGroup: "pool-a",
  });
  const listing = marketplace.createMarketplaceListing({
    sellerId: seller.id,
    connectionId: String(first?.id),
    upstreamModel: "gpt-4o-mini",
    publicModel: "market/group/gpt-4o-mini",
    inputPriceMicroUsdPerMillionTokens: pricing.usdToMicroUsd(1),
    outputPriceMicroUsdPerMillionTokens: pricing.usdToMicroUsd(2),
    platformFeeBps: 1000,
  });
  return {
    seller,
    listing,
    firstConnectionId: String(first?.id),
    secondConnectionId: String(second?.id),
  };
}

test("seller and buyer keys are returned once and validated by hash", () => {
  const sellerResult = marketplace.createMarketplaceSeller({ name: "Alice" });
  assert.equal(sellerResult.seller.name, "Alice");
  assert.equal(
    marketplace.getMarketplaceSellerByApiKey(sellerResult.apiKey)?.id,
    sellerResult.seller.id
  );
  assert.equal(marketplace.getMarketplaceSellerByApiKey("wrong"), null);

  const buyerResult = marketplace.createMarketplaceBuyerKey({
    name: "Buyer",
    balanceMicroUsd: pricing.usdToMicroUsd(10),
  });
  assert.equal(
    marketplace.getMarketplaceBuyerKeyByApiKey(buyerResult.apiKey)?.id,
    buyerResult.buyerKey.id
  );
  assert.equal(marketplace.getMarketplaceBuyerKeyByApiKey("wrong"), null);
});

test("reserve + finalize succeeded charges buyer and credits seller", async () => {
  const { seller, listing } = await createListingFixture();
  const { buyerKey } = marketplace.createMarketplaceBuyerKey({
    name: "Buyer",
    balanceMicroUsd: pricing.usdToMicroUsd(10),
  });

  const reservedMicroUsd = pricing.calculateMarketplaceChargeMicroUsd(listing, {
    promptTokens: 1000,
    completionTokens: 1000,
  });
  const reservation = marketplace.reserveMarketplaceUsage({
    buyerKeyId: buyerKey.id,
    publicModel: listing.publicModel,
    requestId: "req-1",
    reservedPromptTokens: 1000,
    reservedCompletionTokens: 1000,
    reservedMicroUsd,
  });
  assert.equal(reservation.buyerKey.balanceMicroUsd, pricing.usdToMicroUsd(10) - reservedMicroUsd);

  const chargedMicroUsd = pricing.calculateMarketplaceChargeMicroUsd(listing, {
    promptTokens: 500,
    completionTokens: 250,
  });
  const event = marketplace.finalizeMarketplaceUsage({
    usageEventId: reservation.usageEvent.id,
    status: "succeeded",
    promptTokens: 500,
    completionTokens: 250,
    totalTokens: 750,
    chargedMicroUsd,
    upstreamStatus: 200,
  });

  const updatedBuyer = marketplace.getMarketplaceBuyerKeyById(buyerKey.id);
  const updatedSeller = marketplace.getMarketplaceSellerById(seller.id);
  assert.equal(event.chargedMicroUsd, chargedMicroUsd);
  assert.equal(updatedBuyer?.balanceMicroUsd, pricing.usdToMicroUsd(10) - chargedMicroUsd);
  assert.equal(updatedSeller?.balanceMicroUsd, Math.floor(chargedMicroUsd * 0.9));
});

test("failed usage refunds the full reservation", async () => {
  const { listing } = await createListingFixture();
  const { buyerKey } = marketplace.createMarketplaceBuyerKey({
    name: "Buyer",
    balanceMicroUsd: pricing.usdToMicroUsd(1),
  });
  const reservedMicroUsd = pricing.calculateMarketplaceChargeMicroUsd(listing, {
    promptTokens: 1000,
    completionTokens: 1000,
  });

  const reservation = marketplace.reserveMarketplaceUsage({
    buyerKeyId: buyerKey.id,
    publicModel: listing.publicModel,
    requestId: "req-2",
    reservedPromptTokens: 1000,
    reservedCompletionTokens: 1000,
    reservedMicroUsd,
  });
  marketplace.finalizeMarketplaceUsage({
    usageEventId: reservation.usageEvent.id,
    status: "failed",
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    chargedMicroUsd: 0,
    upstreamStatus: 500,
  });

  const updatedBuyer = marketplace.getMarketplaceBuyerKeyById(buyerKey.id);
  assert.equal(updatedBuyer?.balanceMicroUsd, pricing.usdToMicroUsd(1));
});

test("buyer allowedModels restrict marketplace reservations", async () => {
  const { listing } = await createListingFixture();
  const { buyerKey } = marketplace.createMarketplaceBuyerKey({
    name: "Buyer",
    balanceMicroUsd: pricing.usdToMicroUsd(1),
    allowedModels: ["market/other/model"],
  });

  assert.throws(
    () =>
      marketplace.reserveMarketplaceUsage({
        buyerKeyId: buyerKey.id,
        publicModel: listing.publicModel,
        requestId: "req-3",
        reservedPromptTokens: 1,
        reservedCompletionTokens: 1,
        reservedMicroUsd: 1,
      }),
    /not allowed/
  );
});

test("listing maxRequestsPerMinute blocks excess reservations", async () => {
  const { listing } = await createListingFixture({ maxRequestsPerMinute: 1 });
  const { buyerKey } = marketplace.createMarketplaceBuyerKey({
    name: "Buyer",
    balanceMicroUsd: pricing.usdToMicroUsd(1),
  });

  marketplace.reserveMarketplaceUsage({
    buyerKeyId: buyerKey.id,
    publicModel: listing.publicModel,
    requestId: "rpm-1",
    reservedPromptTokens: 1,
    reservedCompletionTokens: 1,
    reservedMicroUsd: 1,
  });

  assert.throws(
    () =>
      marketplace.reserveMarketplaceUsage({
        buyerKeyId: buyerKey.id,
        publicModel: listing.publicModel,
        requestId: "rpm-2",
        reservedPromptTokens: 1,
        reservedCompletionTokens: 1,
        reservedMicroUsd: 1,
      }),
    /rate limit exceeded/
  );
});

test("listing maxDailyTokens includes active reservations", async () => {
  const { listing } = await createListingFixture({ maxDailyTokens: 10 });
  const { buyerKey } = marketplace.createMarketplaceBuyerKey({
    name: "Buyer",
    balanceMicroUsd: pricing.usdToMicroUsd(1),
  });

  marketplace.reserveMarketplaceUsage({
    buyerKeyId: buyerKey.id,
    publicModel: listing.publicModel,
    requestId: "daily-1",
    reservedPromptTokens: 5,
    reservedCompletionTokens: 4,
    reservedMicroUsd: 1,
  });

  assert.throws(
    () =>
      marketplace.reserveMarketplaceUsage({
        buyerKeyId: buyerKey.id,
        publicModel: listing.publicModel,
        requestId: "daily-2",
        reservedPromptTokens: 1,
        reservedCompletionTokens: 1,
        reservedMicroUsd: 1,
      }),
    /daily token limit exceeded/
  );
});

test("buyer and seller usage summaries aggregate finalized events", async () => {
  const { seller, listing } = await createListingFixture();
  const { buyerKey } = marketplace.createMarketplaceBuyerKey({
    name: "Buyer",
    balanceMicroUsd: pricing.usdToMicroUsd(1),
  });

  const reservation = marketplace.reserveMarketplaceUsage({
    buyerKeyId: buyerKey.id,
    publicModel: listing.publicModel,
    requestId: "summary-1",
    reservedPromptTokens: 10,
    reservedCompletionTokens: 10,
    reservedMicroUsd: 100,
  });
  marketplace.finalizeMarketplaceUsage({
    usageEventId: reservation.usageEvent.id,
    status: "succeeded",
    promptTokens: 3,
    completionTokens: 4,
    totalTokens: 7,
    chargedMicroUsd: 70,
    upstreamStatus: 200,
  });

  const buyerSummary = marketplace.getMarketplaceBuyerUsageSummary(buyerKey.id);
  const sellerSummary = marketplace.getMarketplaceSellerUsageSummary(seller.id);
  assert.equal(buyerSummary.requestCount, 1);
  assert.equal(buyerSummary.totalTokens, 7);
  assert.equal(buyerSummary.chargedMicroUsd, 70);
  assert.equal(sellerSummary.sellerAmountMicroUsd, 63);
  assert.equal(sellerSummary.platformFeeMicroUsd, 7);
  assert.equal(marketplace.listMarketplaceBuyerUsageEvents(buyerKey.id, 10).length, 1);
  assert.equal(marketplace.listMarketplaceSellerUsageEvents(seller.id, 10).length, 1);
});

test("cooling down a listing hides it from buyers and blocks reservation", async () => {
  const { listing } = await createListingFixture();
  const { buyerKey } = marketplace.createMarketplaceBuyerKey({
    name: "Buyer",
    balanceMicroUsd: pricing.usdToMicroUsd(1),
  });

  marketplace.markMarketplaceListingCoolingDown({
    listingId: listing.id,
    cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
    errorCode: "UPSTREAM_QUOTA_EXHAUSTED",
    errorMessage: "quota exhausted",
  });

  assert.equal(marketplace.getActiveMarketplaceListingByPublicModel(listing.publicModel), null);
  assert.equal(
    marketplace.listActiveMarketplaceListings().some((entry) => entry.id === listing.id),
    false
  );
  assert.throws(
    () =>
      marketplace.reserveMarketplaceUsage({
        buyerKeyId: buyerKey.id,
        publicModel: listing.publicModel,
        requestId: "cooldown-1",
        reservedPromptTokens: 1,
        reservedCompletionTokens: 1,
        reservedMicroUsd: 1,
      }),
    /not found/
  );

  const sellerListings = marketplace.listMarketplaceSellerListings(listing.sellerId);
  assert.equal(sellerListings[0].lastErrorCode, "UPSTREAM_QUOTA_EXHAUSTED");
  assert.equal(sellerListings[0].lastErrorMessage, "quota exhausted");
});

test("failover targets include healthy accounts from the same group", async () => {
  const { listing, firstConnectionId, secondConnectionId } = await createGroupedListingFixture();

  let targets = marketplace.resolveMarketplaceFailoverTargets(listing.id);
  assert.deepEqual(
    targets.map((target) => target.connection.connectionId),
    [firstConnectionId, secondConnectionId]
  );

  marketplace.markMarketplaceSellerConnectionCoolingDown({
    sellerId: listing.sellerId,
    connectionId: firstConnectionId,
    cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
    errorCode: "UPSTREAM_LIMIT_EXHAUSTED",
    errorMessage: "rate limit",
  });

  targets = marketplace.resolveMarketplaceFailoverTargets(listing.id);
  assert.deepEqual(
    targets.map((target) => target.connection.connectionId),
    [secondConnectionId]
  );
  assert.equal(targets[0].listing.connectionId, secondConnectionId);

  const connections = marketplace.listMarketplaceSellerConnections(listing.sellerId);
  const first = connections.find((connection) => connection.connectionId === firstConnectionId);
  assert.equal(first?.accountGroup, "pool-a");
  assert.equal(first?.lastErrorCode, "UPSTREAM_LIMIT_EXHAUSTED");
});
