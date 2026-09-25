import test from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const siwe = await import("../../../src/lib/marketplace/crypto/siwe.ts");
const address = await import("../../../src/lib/marketplace/crypto/address.ts");

// A fixed private key for deterministic test vectors.
const PRIV = Uint8Array.from(Buffer.from(
  "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
  "hex"
));

function addressForPriv(priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, false);
  return address.publicKeyToAddress(pub).toLowerCase();
}

function personalSign(message: string, priv: Uint8Array): string {
  const mb = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${mb.length}`);
  const composed = new Uint8Array(prefix.length + mb.length);
  composed.set(prefix, 0);
  composed.set(mb, prefix.length);
  const digest = keccak_256(composed);
  const sig = secp256k1.sign(digest, priv);
  const compact = sig.toCompactRawBytes();
  const v = sig.recovery + 27;
  return "0x" + Buffer.from(compact).toString("hex") + v.toString(16).padStart(2, "0");
}

const WALLET = addressForPriv(PRIV);

function buildMessage(nonce = "abc12345") {
  return siwe.buildSiweMessage({
    domain: "market.test",
    walletAddress: WALLET,
    nonce,
    issuedAt: "2026-06-21T00:00:00.000Z",
  });
}

test("verifies a valid personal_sign signature", () => {
  const message = buildMessage();
  const signature = personalSign(message, PRIV);
  assert.equal(siwe.verifySiweSignature({ message, signature, walletAddress: WALLET }), true);
});

test("rejects a signature from a different wallet", () => {
  const message = buildMessage();
  const otherPriv = Uint8Array.from(Buffer.from(
    "0000000000000000000000000000000000000000000000000000000000000abc",
    "hex"
  ));
  const signature = personalSign(message, otherPriv);
  assert.equal(siwe.verifySiweSignature({ message, signature, walletAddress: WALLET }), false);
});

test("rejects a tampered message", () => {
  const signed = personalSign(buildMessage("abc12345"), PRIV);
  const tampered = buildMessage("different");
  assert.equal(
    siwe.verifySiweSignature({ message: tampered, signature: signed, walletAddress: WALLET }),
    false
  );
});

test("rejects malformed signatures", () => {
  const message = buildMessage();
  assert.equal(siwe.recoverPersonalSignAddress(message, "0x1234"), null);
  assert.equal(siwe.verifySiweSignature({ message, signature: "nothex", walletAddress: WALLET }), false);
});

test("checksum address round-trips to lowercase input", () => {
  const checksum = address.toChecksumAddress(WALLET);
  assert.equal(checksum.toLowerCase(), WALLET);
  assert.equal(address.isValidEvmAddress(checksum), true);
});
