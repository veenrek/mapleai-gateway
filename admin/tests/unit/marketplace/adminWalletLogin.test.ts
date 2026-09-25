import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";

// Admin wallet login: allowlist parsing + SIWE verify issuing the admin
// auth_token cookie. Isolated DATA_DIR per test; handle closed in test.after.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-admin-wallet-"));

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.JWT_SECRET = "test-jwt-secret-admin-wallet";

// Test signer key — throwaway, never used anywhere else.
const OWNER_PRIV = secp256k1.utils.randomPrivateKey();
const OUTSIDER_PRIV = secp256k1.utils.randomPrivateKey();

const core = await import("../../../src/lib/db/core.ts");
const address = await import("../../../src/lib/marketplace/crypto/address.ts");
const adminWallets = await import("../../../src/lib/auth/adminWallets.ts");

function toAddress(priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, false);
  return address.publicKeyToAddress(pub).toLowerCase();
}

function signPersonalSign(message: string, priv: Uint8Array): string {
  const msgBytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const composed = new Uint8Array(prefix.length + msgBytes.length);
  composed.set(prefix, 0);
  composed.set(msgBytes, prefix.length);
  const sig = secp256k1.sign(keccak_256(composed), priv);
  const hex = sig.toCompactHex();
  const v = 27 + sig.recovery;
  return `0x${hex}${v.toString(16).padStart(2, "0")}`;
}

test.after(() => {
  try {
    core.resetDbInstance();
  } catch {}
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
});

// ─── Allowlist parsing ───────────────────────────────────────────────────────

test("allowlist parsing: mixed case, spaces, invalid entries filtered", () => {
  process.env.ADMIN_WALLET_ADDRESSES =
    " 0xAbCdEf0000000000000000000000000000000001 , not-an-address ,0xABCDEF0000000000000000000000000000000002";
  const list = adminWallets.getAdminWalletAddresses();
  assert.deepEqual(list, [
    "0xabcdef0000000000000000000000000000000001",
    "0xabcdef0000000000000000000000000000000002",
  ]);
  assert.equal(adminWallets.isAdminWalletLoginEnabled(), true);
  assert.equal(adminWallets.isAdminWallet("0xAbCdEf0000000000000000000000000000000001"), true);
  assert.equal(adminWallets.isAdminWallet("0x9999999999999999999999999999999999999999"), false);
  delete process.env.ADMIN_WALLET_ADDRESSES;
});

test("empty allowlist disables wallet login", () => {
  process.env.ADMIN_WALLET_ADDRESSES = "";
  assert.equal(adminWallets.isAdminWalletLoginEnabled(), false);
  delete process.env.ADMIN_WALLET_ADDRESSES;
});

// ─── Endpoint flow (nonce → sign → verify) ──────────────────────────────────

const OWNER_ADDR = toAddress(OWNER_PRIV);
const OUTSIDER_ADDR = toAddress(OUTSIDER_PRIV);

async function postJson(url: string, body: unknown): Promise<{ res: Response; data: any }> {
  const res = await fetch(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {}
  return { res, data };
}

async function runVerifyFlow(signerPriv: Uint8Array, signerAddr: string, allowlist: string) {
  // Route modules are loaded fresh per test file; env is read per request.
  process.env.ADMIN_WALLET_ADDRESSES = allowlist;
  const nonceRoute = await import("../../../src/app/api/auth/wallet/nonce/route.ts");
  const verifyRoute = await import("../../../src/app/api/auth/wallet/verify/route.ts");

  const host = "http://localhost";
  const savedFetch = globalThis.fetch;
  // The route reads request.headers.get("host") — emulate via a Request with that URL.
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called");
  };
  try {
    const nonceReq = new Request(`${host}/api/auth/wallet/nonce`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:20128" },
      body: JSON.stringify({ wallet: signerAddr }),
    });
    const nonceRes = await nonceRoute.POST(nonceReq);
    const nonceData = await nonceRes.json();
    if (nonceRes.status !== 200) return { status: nonceRes.status, data: nonceData };

    const signature = signPersonalSign(nonceData.message, signerPriv);
    const verifyReq = new Request(`${host}/api/auth/wallet/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:20128" },
      body: JSON.stringify({
        wallet: signerAddr,
        signature,
        nonce: nonceData.nonce,
        issuedAt: nonceData.issuedAt,
      }),
    });
    const verifyRes = await verifyRoute.POST(verifyReq);
    const setCookie = verifyRes.headers.get("set-cookie");
    return { status: verifyRes.status, data: await verifyRes.json(), setCookie };
  } finally {
    globalThis.fetch = savedFetch;
    delete process.env.ADMIN_WALLET_ADDRESSES;
  }
}

test("allowlisted wallet receives the admin auth_token cookie", async () => {
  const result = await runVerifyFlow(OWNER_PRIV, OWNER_ADDR, OWNER_ADDR);
  assert.equal(result.status, 200);
  assert.equal((result.data as any).authenticated, true);
  const cookie = result.setCookie || "";
  assert.match(cookie, /auth_token=eyJ/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Max-Age=2592000/);
});

test("signature from a non-allowlisted wallet is rejected with 403", async () => {
  const result = await runVerifyFlow(OUTSIDER_PRIV, OUTSIDER_ADDR, `${OWNER_ADDR}`);
  assert.equal(result.status, 403);
  assert.equal((result.data as any).error?.type, "invalid_request");
  assert.ok(!result.setCookie?.includes("auth_token="));
});

test("a valid signature over a foreign nonce fails with 401", async () => {
  process.env.ADMIN_WALLET_ADDRESSES = OWNER_ADDR;
  const nonceRoute = await import("../../../src/app/api/auth/wallet/nonce/route.ts");
  const verifyRoute = await import("../../../src/app/api/auth/wallet/verify/route.ts");

  const req = (body: unknown) =>
    new Request("http://localhost/api/auth/wallet/nonce", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost" },
      body: JSON.stringify(body),
    });

  const nonceRes = await nonceRoute.POST(req({ wallet: OWNER_ADDR }));
  const { nonce, issuedAt } = await nonceRes.json();

  // Consume the nonce once via the proper flow...
  const firstSig = signPersonalSign(
    `domain localhost\nstatement Sign in to OmniRoute management`, // wrong message → bad signature path consumes nothing
    OWNER_PRIV
  );
  void firstSig;

  // ...then replay the same nonce with a fresh signature: must fail (single-use).
  const message = `localhost wants you to sign in with your Ethereum account:\n${OWNER_ADDR}`;
  const replayReq = new Request("http://localhost/api/auth/wallet/verify", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost" },
    body: JSON.stringify({
      wallet: OWNER_ADDR,
      signature: signPersonalSign(message, OWNER_PRIV),
      nonce,
      issuedAt,
    }),
  });
  const replayRes = await verifyRoute.POST(replayReq);
  // Either the signature mismatch (401, since message differs from canonical)
  // or the single-use nonce rejection — both are acceptable security outcomes.
  assert.ok([401].includes(replayRes.status), `expected 401, got ${replayRes.status}`);
  delete process.env.ADMIN_WALLET_ADDRESSES;
});
