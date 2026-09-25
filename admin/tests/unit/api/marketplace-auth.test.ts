import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mkt-authapi-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.JWT_SECRET = "test-jwt-secret-marketplace-auth";

const core = await import("../../../src/lib/db/core.ts");
const nonceRoute = await import("../../../src/app/api/marketplace/auth/nonce/route.ts");
const verifyRoute = await import("../../../src/app/api/marketplace/auth/verify/route.ts");
const meRoute = await import("../../../src/app/api/marketplace/wallet/me/route.ts");
const addr = await import("../../../src/lib/marketplace/crypto/address.ts");

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

const PRIV = Uint8Array.from(Buffer.from(
  "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
  "hex"
));
const WALLET = addr.publicKeyToAddress(secp256k1.getPublicKey(PRIV, false)).toLowerCase();

function personalSign(message: string): string {
  const mb = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${mb.length}`);
  const composed = new Uint8Array(prefix.length + mb.length);
  composed.set(prefix, 0);
  composed.set(mb, prefix.length);
  const digest = keccak_256(composed);
  const sig = secp256k1.sign(digest, PRIV);
  const v = (sig.recovery + 27).toString(16).padStart(2, "0");
  return "0x" + Buffer.from(sig.toCompactRawBytes()).toString("hex") + v;
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "market.test", ...headers },
    body: JSON.stringify(body),
  });
}

async function issueNonce(): Promise<{ nonce: string; issuedAt: string; message: string }> {
  const res = await nonceRoute.POST(
    jsonRequest("https://market.test/api/marketplace/auth/nonce", { wallet: WALLET })
  );
  assert.equal(res.status, 200);
  return res.json();
}

test("nonce → verify sets a session cookie and /me returns the user", async () => {
  const { nonce, issuedAt, message } = await issueNonce();
  const signature = personalSign(message);

  const verifyRes = await verifyRoute.POST(
    jsonRequest("https://market.test/api/marketplace/auth/verify", {
      wallet: WALLET,
      signature,
      nonce,
      issuedAt,
    })
  );
  assert.equal(verifyRes.status, 200);
  const setCookie = verifyRes.headers.get("set-cookie") || "";
  assert.match(setCookie, /mkt_session=/);
  assert.match(setCookie, /HttpOnly/i);

  // Extract cookie value and call /me with it.
  const token = setCookie.split("mkt_session=")[1].split(";")[0];
  const meRes = await meRoute.GET(
    new Request("https://market.test/api/marketplace/wallet/me", {
      headers: { cookie: `mkt_session=${token}` },
    })
  );
  assert.equal(meRes.status, 200);
  const me = await meRes.json();
  assert.equal(me.user.walletAddress, WALLET);
});

test("verify rejects a bad signature and does not leak a stack trace", async () => {
  const { nonce, issuedAt } = await issueNonce();
  const res = await verifyRoute.POST(
    jsonRequest("https://market.test/api/marketplace/auth/verify", {
      wallet: WALLET,
      signature: "0x" + "11".repeat(65),
      nonce,
      issuedAt,
    })
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.ok(!String(body.error?.message || "").includes("at /"));
});

test("verify rejects a replayed nonce", async () => {
  const { nonce, issuedAt, message } = await issueNonce();
  const signature = personalSign(message);
  const ok = await verifyRoute.POST(
    jsonRequest("https://market.test/api/marketplace/auth/verify", {
      wallet: WALLET,
      signature,
      nonce,
      issuedAt,
    })
  );
  assert.equal(ok.status, 200);

  const replay = await verifyRoute.POST(
    jsonRequest("https://market.test/api/marketplace/auth/verify", {
      wallet: WALLET,
      signature,
      nonce,
      issuedAt,
    })
  );
  assert.equal(replay.status, 401);
});

test("/me without a session returns 401", async () => {
  const res = await meRoute.GET(new Request("https://market.test/api/marketplace/wallet/me"));
  assert.equal(res.status, 401);
});
