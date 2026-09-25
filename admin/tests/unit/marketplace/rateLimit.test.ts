import test from "node:test";
import assert from "node:assert/strict";

const rl = await import("../../../src/lib/marketplace/rateLimit.ts");

test.beforeEach(() => rl.resetMarketplaceRateLimitForTests());

test("allows up to the limit then blocks", () => {
  const opts = { limit: 3, windowMs: 60_000 };
  assert.equal(rl.rateLimitHit("k", opts).allowed, true);
  assert.equal(rl.rateLimitHit("k", opts).allowed, true);
  assert.equal(rl.rateLimitHit("k", opts).allowed, true);
  const blocked = rl.rateLimitHit("k", opts);
  assert.equal(blocked.allowed, false);
  assert.ok((blocked.retryAfterSeconds || 0) > 0);
});

test("separate keys have independent budgets", () => {
  const opts = { limit: 1, windowMs: 60_000 };
  assert.equal(rl.rateLimitHit("a", opts).allowed, true);
  assert.equal(rl.rateLimitHit("b", opts).allowed, true);
  assert.equal(rl.rateLimitHit("a", opts).allowed, false);
});

test("window reset re-allows after it elapses", async () => {
  const opts = { limit: 1, windowMs: 20 };
  assert.equal(rl.rateLimitHit("w", opts).allowed, true);
  assert.equal(rl.rateLimitHit("w", opts).allowed, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rl.rateLimitHit("w", opts).allowed, true);
});
