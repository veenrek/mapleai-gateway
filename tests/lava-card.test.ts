import test from "node:test";
import assert from "node:assert/strict";

const {
  lavaCardModels,
  lavaCardOffers,
  lavaCardPackPrice,
  lavaCardPackTiers,
  lavaMinInvoiceUsd,
  prepaidModelOffers,
  sellablePrepaidModels,
} = await import("../src/prepaid-codes.ts");

test("card tiers are fixed at 10M/30M/50M", () => {
  assert.deepEqual([...lavaCardPackTiers], [10_000_000, 30_000_000, 50_000_000]);
});

test("sub-$5 models are excluded from the card channel", () => {
  for (const model of lavaCardModels) {
    const price = lavaCardPackPrice(model, lavaCardPackTiers[0]);
    assert.ok(price >= lavaMinInvoiceUsd, `${model} 10M pack must clear the $${lavaMinInvoiceUsd} Lava minimum (got $${price})`);
  }
  const luna = "openai/gpt-6-luna";
  if (sellablePrepaidModels.includes(luna)) {
    assert.ok(!lavaCardModels.includes(luna), "gpt-6-luna must not be sold via cards");
  }
});

test("pack price scales linearly with the input rate", () => {
  const offers = lavaCardOffers();
  assert.equal(offers.length, lavaCardModels.length);
  for (const offer of offers) {
    assert.deepEqual(offer.tiers.map((t) => t.tokens), [...lavaCardPackTiers]);
    const [price10, price30, price50] = offer.tiers.map((t) => t.usd);
    assert.ok(Math.abs(price30 - price10 * 3) < 1e-9, `30M = 3 x 10M for ${offer.model}`);
    assert.ok(Math.abs(price50 - price30 * 5 / 3) < 1e-9, `50M = 30M x 5/3 for ${offer.model}`);
    const input = prepaidModelOffers().find((o) => o.model === offer.model)?.inputUsdPerMillion ?? 0;
    assert.ok(Math.abs(price10 - lavaCardPackTiers[0] / 1_000_000 * input) < 1e-9,
      `${offer.model}: 10M price must equal input rate (${input})`);
  }
});

test("every card model has a positive price at the smallest tier", () => {
  assert.ok(lavaCardModels.length > 0);
  for (const model of lavaCardModels) {
    const offer = prepaidModelOffers().find((o) => o.model === model);
    assert.ok(offer && offer.inputUsdPerMillion > 0, model);
  }
});

