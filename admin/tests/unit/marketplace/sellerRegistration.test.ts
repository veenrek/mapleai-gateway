import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Seller registration gate (single-seller mode). Uses an isolated DATA_DIR and
// a test JWT_SECRET for wallet-session signing; closes the DB handle in
// test.after (CLAUDE.md "Database Handles in Tests").
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-seller-reg-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.JWT_SECRET = "test-jwt-secret-seller-registration";

const core = await import("../../../src/lib/db/core.ts");
const db = await import("../../../src/lib/db/marketplace.ts");
const users = await import("../../../src/lib/db/marketplaceUsers.ts");
const auth = await import("../../../src/lib/marketplace/auth.ts");
const session = await import("../../../src/lib/marketplace/session.ts");

test.after(() => {
  try {
    core.resetDbInstance();
  } catch {}
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
});

function walletRequest(token: string): Request {
  return new Request("http://localhost/api/marketplace/seller/summary", {
    headers: { cookie: `${session.MARKETPLACE_SESSION_COOKIE}=${token}` },
  });
}

async function sessionFor(walletAddress: string): Promise<string> {
  const user = users.getOrCreateMarketplaceUserByWallet(walletAddress);
  const token = await session.signMarketplaceSession({
    marketplaceUserId: user.id,
    walletAddress: user.walletAddress,
  });
  return token;
}

test("seller registration mode defaults to closed (single-seller platform)", () => {
  assert.equal(db.getSellerRegistrationMode(), "closed");
});

test("closed mode: wallet session without an existing seller cannot become a seller", async () => {
  const token = await sessionFor("0x1111111111111111111111111111111111111111");
  const seller = await auth.resolveMarketplaceSeller(walletRequest(token));
  assert.equal(seller, null, "no seller identity may be provisioned while closed");
  assert.equal(db.listMarketplaceSellers().length, 0);
});

test("closed mode: an existing seller keeps full access via wallet session", async () => {
  // The operator (owner) provisions their seller through the management API.
  const owner = users.getOrCreateMarketplaceUserByWallet(
    "0x2222222222222222222222222222222222222222"
  );
  const { seller } = db.getOrCreateSellerForUser({ userId: owner.id, name: "owner" });

  const token = await sessionFor(owner.walletAddress);
  const resolved = await auth.resolveMarketplaceSeller(walletRequest(token));
  assert.ok(resolved);
  assert.equal(resolved.id, seller.id, "existing seller identity still resolves");
});

test("closed mode: seller API-key auth is unaffected by the gate", async () => {
  const created = db.createMarketplaceSeller({ name: "key-based" });
  const request = new Request("http://localhost/api/marketplace/seller/summary", {
    headers: { authorization: `Bearer ${created.apiKey}` },
  });
  const resolved = await auth.resolveMarketplaceSeller(request);
  assert.ok(resolved);
  assert.equal(resolved.id, created.seller.id);
});

test("open mode: wallet sessions auto-provision a seller again", async () => {
  db.setSellerRegistrationMode("open");
  assert.equal(db.getSellerRegistrationMode(), "open");

  const wallet = "0x3333333333333333333333333333333333333333";
  const token = await sessionFor(wallet);
  const resolved = await auth.resolveMarketplaceSeller(walletRequest(token));
  assert.ok(resolved, "open mode must provision the seller on first use");

  const user = users.getOrCreateMarketplaceUserByWallet(wallet);
  assert.equal(
    db.getMarketplaceSellerByUserId(user.id)?.id,
    resolved.id,
    "provisioned exactly once — bound to the wallet's user"
  );
});

test("mode persists across reads", () => {
  db.setSellerRegistrationMode("closed");
  assert.equal(db.getSellerRegistrationMode(), "closed");
  db.setSellerRegistrationMode("open");
  assert.equal(db.getSellerRegistrationMode(), "open");
  db.setSellerRegistrationMode("closed");
});
