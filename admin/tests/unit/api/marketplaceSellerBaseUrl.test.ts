import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mkt-baseurl-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.JWT_SECRET = "test-jwt-secret-marketplace-baseurl";

const core = await import("../../../src/lib/db/core.ts");
const nonceRoute = await import("../../../src/app/api/marketplace/auth/nonce/route.ts");
const verifyRoute = await import("../../../src/app/api/marketplace/auth/verify/route.ts");
const connectionsRoute = await import(
  "../../../src/app/api/marketplace/seller/connections/route.ts"
);
const providers = await import("../../../src/lib/db/providers.ts");
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

const PRIV = Uint8Array.from(
  Buffer.from("4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318", "hex")
);
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

async function loginCookie(): Promise<string> {
  const nonceRes = await nonceRoute.POST(
    jsonRequest("https://market.test/api/marketplace/auth/nonce", { wallet: WALLET })
  );
  const { nonce, issuedAt, message } = await nonceRes.json();
  const verifyRes = await verifyRoute.POST(
    jsonRequest("https://market.test/api/marketplace/auth/verify", {
      wallet: WALLET,
      signature: personalSign(message),
      nonce,
      issuedAt,
    })
  );
  const setCookie = verifyRes.headers.get("set-cookie") || "";
  return setCookie.split("mkt_session=")[1].split(";")[0];
}

function createConnection(cookie: string, baseUrl: string) {
  return connectionsRoute.POST(
    jsonRequest(
      "https://market.test/api/marketplace/seller/connections",
      {
        provider: "openai-compatible-acme",
        apiKey: "sk-test-key-123",
        name: "acme",
        baseUrl,
      },
      { cookie: `mkt_session=${cookie}` }
    )
  );
}

test("accepts a public https baseUrl and stores it in providerSpecificData", async () => {
  const cookie = await loginCookie();
  const res = await createConnection(cookie, "https://api.acme.example/v1");
  assert.equal(res.status, 201);

  const conns = await providers.getProviderConnections({ provider: "openai-compatible-acme" });
  assert.equal(conns.length, 1);
  assert.equal(conns[0].providerSpecificData?.baseUrl, "https://api.acme.example/v1");
});

test("rejects an http (non-TLS) baseUrl", async () => {
  const cookie = await loginCookie();
  const res = await createConnection(cookie, "http://api.acme.example/v1");
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(String(body.error?.message || ""), /https/i);
  assert.ok(!String(body.error?.message || "").includes("at /")); // no stack trace
});

test("rejects a loopback baseUrl (SSRF guard)", async () => {
  const cookie = await loginCookie();
  const res = await createConnection(cookie, "https://127.0.0.1/v1");
  assert.equal(res.status, 400);
});

test("rejects a cloud-metadata baseUrl (SSRF guard)", async () => {
  const cookie = await loginCookie();
  const res = await createConnection(cookie, "https://169.254.169.254/latest/meta-data");
  assert.equal(res.status, 400);
});

test("rejects a private-network baseUrl (SSRF guard)", async () => {
  const cookie = await loginCookie();
  const res = await createConnection(cookie, "https://192.168.0.15/v1");
  assert.equal(res.status, 400);
});
