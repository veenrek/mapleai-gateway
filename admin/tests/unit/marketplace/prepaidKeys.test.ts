import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Prepaid buyer keys (token-budgeted, anonymous): issuance, reserve/finalize
// token settlement, expiry, and the public checker snapshot. Isolated DATA_DIR
// per test; the DB handle is closed in test.after.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-prepaid-keys-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const marketplace = await import("../../../src/lib/db/marketplace.ts");

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

async function createListingFixture(publicModel = "market/test/gpt-5") {
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
    upstreamModel: "gpt-5",
    publicModel,
    inputPriceMicroUsdPerMillionTokens: 1000,
    outputPriceMicroUsdPerMillionTokens: 2000,
    platformFeeBps: 1500,
  });
  return { seller, listing };
}

function issuePrepaid(models: string[], tokens: number, expiresAt?: string) {
  return marketplace.createMarketplaceBuyerKey({
    name: `prepaid ${models.join("/")}`,
    allowedModels: models,
    tokenBudgetTotal: tokens,
    expiresAt: expiresAt ?? null,
    userId: null,
    balanceMicroUsd: 0,
  });
}

const RESERVE = {
  publicModel: "market/test/gpt-5",
  requestId: "",
  reservedPromptTokens: 1_000_000,
  reservedCompletionTokens: 500_000,
  // Ignored in prepaid-token mode (forced to 0 inside reserve); USD keys pass
  // their real estimate here.
  reservedMicroUsd: 0,
};

test("prepaid key issues with zero USD and a full token budget", () => {
  const { buyerKey, apiKey } = issuePrepaid(["market/test/gpt-5"], 50_000_000);
  assert.match(apiKey, /^oms_buy_/);
  assert.equal(buyerKey.tokenBudgetTotal, 50_000_000);
  assert.equal(buyerKey.tokensUsed, 0);
  assert.equal(buyerKey.tokensReserved, 0);
  assert.equal(buyerKey.balanceMicroUsd, 0);
  assert.equal(buyerKey.userId, null);
});

test("unlimited prepaid key tracks usage without exhausting or disabling", () => {
  const { buyerKey, apiKey } = marketplace.createMarketplaceBuyerKey({
    name: "unlimited combos",
    allowedModels: ["combo-a", "combo-b"],
    isUnlimited: true,
    userId: null,
    balanceMicroUsd: 0,
  });

  assert.match(apiKey, /^oms_buy_/);
  assert.equal(buyerKey.isUnlimited, true);
  assert.equal(buyerKey.tokenBudgetTotal, null);
  marketplace.reservePrepaidTokens(buyerKey.id, 100_000_000);
  marketplace.settlePrepaidTokens(buyerKey.id, 100_000_000, 75_000_000, true);

  const after = marketplace.getMarketplaceBuyerKeyById(buyerKey.id)!;
  assert.equal(after.tokensUsed, 75_000_000);
  assert.equal(after.tokensReserved, 0);
  assert.equal(after.status, "active");
  assert.equal(marketplace.getMarketplacePrepaidKeyStatus(apiKey)?.unlimited, true);
  assert.ok(marketplace.listPrepaidMarketplaceBuyerKeys().some((key) => key.id === buyerKey.id));
});

test("reserve in prepaid mode debits tokens, not USD", async () => {
  await createListingFixture();
  const { buyerKey } = issuePrepaid(["market/test/gpt-5"], 10_000_000);

  RESERVE.requestId = crypto.randomUUID();
  const result = marketplace.reserveMarketplaceUsage({ ...RESERVE, buyerKeyId: buyerKey.id });
  assert.equal(result.buyerKey.balanceMicroUsd, 0, "USD untouched in prepaid mode");
  assert.equal(result.usageEvent.reservedMicroUsd, 0);
  assert.equal(result.buyerKey.tokensReserved, 1_500_000);
});

test("reserve rejects only when the prepaid budget is actually exhausted (402)", async () => {
  await createListingFixture();
  const { buyerKey } = issuePrepaid(["market/test/gpt-5"], 2_000_000);

  // До набора фактического used резерв даже «внисло» за бюджет допускаем:
  RESERVE.requestId = crypto.randomUUID();
  marketplace.reserveMarketplaceUsage({ ...RESERVE, buyerKeyId: buyerKey.id });
  marketplace.reserveMarketplaceUsage({
    ...RESERVE,
    buyerKeyId: buyerKey.id,
    requestId: crypto.randomUUID(),
  });

  // Имитируем полное потращивание — следующий резерв блокируется.
  marketplace.settlePrepaidTokens(buyerKey.id, 3_000_000, 2_000_000, true);
  assert.throws(
    () =>
      marketplace.reserveMarketplaceUsage({
        ...RESERVE,
        buyerKeyId: buyerKey.id,
        requestId: crypto.randomUUID(),
      }),
    (err: unknown) =>
      err instanceof marketplace.MarketplaceDbError && (err.status === 402 || err.status === 401)
  );
});

test("expired prepaid key is rejected at reserve (401)", async () => {
  await createListingFixture();
  const { buyerKey } = issuePrepaid(
    ["market/test/gpt-5"],
    10_000_000,
    new Date(Date.now() - 1000).toISOString()
  );

  RESERVE.requestId = crypto.randomUUID();
  assert.throws(
    () => marketplace.reserveMarketplaceUsage({ ...RESERVE, buyerKeyId: buyerKey.id }),
    (err: unknown) =>
      err instanceof marketplace.MarketplaceDbError &&
      err.status === 401 &&
      /expired/i.test(err.message)
  );
});

test("finalize success moves tokens from reserved to used", async () => {
  await createListingFixture();
  const { buyerKey } = issuePrepaid(["market/test/gpt-5"], 10_000_000);

  RESERVE.requestId = crypto.randomUUID();
  const { usageEvent } = marketplace.reserveMarketplaceUsage({
    ...RESERVE,
    buyerKeyId: buyerKey.id,
  });
  const finalized = marketplace.finalizeMarketplaceUsage({
    usageEventId: usageEvent.id,
    status: "succeeded",
    promptTokens: 900_000,
    completionTokens: 400_000,
    totalTokens: 1_300_000,
    chargedMicroUsd: 999_999, // ignored in prepaid mode (reserved was 0)
  });

  const after = marketplace.getMarketplaceBuyerKeyById(buyerKey.id)!;
  assert.equal(after.tokensUsed, 1_300_000, "actual tokens consumed");
  assert.equal(after.tokensReserved, 0, "reservation released");
  assert.equal(finalized.chargedMicroUsd, 0, "no USD charged in prepaid mode");
});

test("finalize failure releases the full reservation", async () => {
  await createListingFixture();
  const { buyerKey } = issuePrepaid(["market/test/gpt-5"], 10_000_000);

  RESERVE.requestId = crypto.randomUUID();
  const { usageEvent } = marketplace.reserveMarketplaceUsage({
    ...RESERVE,
    buyerKeyId: buyerKey.id,
  });
  marketplace.finalizeMarketplaceUsage({
    usageEventId: usageEvent.id,
    status: "failed",
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    chargedMicroUsd: 0,
  });

  const after = marketplace.getMarketplaceBuyerKeyById(buyerKey.id)!;
  assert.equal(after.tokensUsed, 0);
  assert.equal(after.tokensReserved, 0, "failed request must not consume the budget");
});

test("public checker: valid key exposes models + remaining tokens, never the hash", async () => {
  await createListingFixture();
  const { buyerKey, apiKey } = issuePrepaid(["market/test/gpt-5"], 50_000_000);

  RESERVE.requestId = crypto.randomUUID();
  marketplace.reserveMarketplaceUsage({ ...RESERVE, buyerKeyId: buyerKey.id });

  const status = marketplace.getMarketplacePrepaidKeyStatus(apiKey)!;
  assert.equal(status.valid, true);
  assert.equal(status.reason, null);
  assert.deepEqual(status.allowedModels, ["market/test/gpt-5"]);
  assert.equal(status.tokens!.total, 50_000_000);
  assert.equal(status.tokens!.used, 0);
  assert.equal(status.tokens!.remaining, 48_500_000);
  assert.ok(!JSON.stringify(status).includes(apiKey), "raw key never echoed back");
});

test("public checker: unknown key → not_found with no detail leak", () => {
  const status = marketplace.getMarketplacePrepaidKeyStatus("mk_buyer_does_not_exist");
  assert.equal(status, null);
});

test("public checker: expired key reports reason=expired", () => {
  issuePrepaid(["market/test/gpt-5"], 1_000_000, new Date(Date.now() - 60_000).toISOString());
  const { apiKey } = issuePrepaid(
    ["market/test/gpt-5"],
    1_000_000,
    new Date(Date.now() - 60_000).toISOString()
  );
  const status = marketplace.getMarketplacePrepaidKeyStatus(apiKey)!;
  assert.equal(status.valid, false);
  assert.equal(status.reason, "expired");
});

test("listPrepaidMarketplaceBuyerKeys returns only token-budget keys", async () => {
  await createListingFixture();
  issuePrepaid(["market/test/gpt-5"], 5_000_000);
  marketplace.createMarketplaceBuyerKey({
    name: "regular-usd-buyer",
    balanceMicroUsd: 5_000_000,
    userId: null,
  });

  const prepaid = marketplace.listPrepaidMarketplaceBuyerKeys();
  assert.equal(prepaid.length, 1);
  assert.equal(prepaid[0].tokenBudgetTotal, 5_000_000);
});
