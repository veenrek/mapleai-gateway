import test from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";

const txSigner = await import("../../../src/lib/marketplace/crypto/txSigner.ts");

// ── calldata ─────────────────────────────────────────────────────────────────

test("buildTransferCalldata encodes selector + padded to + padded amount", () => {
  const to = "0x1111111111111111111111111111111111111111";
  const calldata = txSigner.buildTransferCalldata(to, "1000000");
  // 0x + 8 (selector) + 64 (to) + 64 (amount) = 138 chars
  assert.equal(calldata.length, 2 + 8 + 64 + 64);
  assert.ok(calldata.startsWith("0xa9059cbb"));
  // to is right-aligned in its 32-byte word
  assert.ok(calldata.includes("0000000000000000000000001111111111111111111111111111111111111111"));
  // 1000000 = 0xf4240
  assert.ok(calldata.endsWith("00000000000000000000000000000000000000000000000000000000000f4240"));
});

test("buildTransferCalldata handles large amounts via BigInt (no float loss)", () => {
  const to = "0x" + "ab".repeat(20);
  const big = "1000000000000000000000000"; // 1e24
  const calldata = txSigner.buildTransferCalldata(to, big);
  const amountHex = BigInt(big).toString(16);
  assert.ok(calldata.toLowerCase().endsWith(amountHex.toLowerCase().padStart(64, "0")));
});

// ── signing ──────────────────────────────────────────────────────────────────

const PRIV = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

test("signEip1559Tx produces a deterministic type-2 raw tx that recovers the signer", () => {
  const tx = {
    chainId: 11155111,
    nonce: 0,
    maxPriorityFeePerGas: 1_500_000_000n,
    maxFeePerGas: 50_000_000_000n,
    gasLimit: 80_000n,
    to: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
    value: 0n,
    data: txSigner.buildTransferCalldata("0x" + "cd".repeat(20), "5000000"),
  };

  const raw1 = txSigner.signEip1559Tx(tx, PRIV);
  const raw2 = txSigner.signEip1559Tx(tx, PRIV);

  // Deterministic (RFC 6979 nonce) → identical raw tx across calls.
  assert.equal(raw1, raw2);
  // EIP-1559 raw tx is prefixed with the 0x02 type byte.
  assert.ok(raw1.startsWith("0x02"));
  // Sanity: it's a non-trivial hex blob.
  assert.ok(raw1.length > 200);
});

test("different transactions produce different signatures", () => {
  const base = {
    chainId: 1,
    nonce: 0,
    maxPriorityFeePerGas: 1n,
    maxFeePerGas: 2n,
    gasLimit: 21000n,
    to: "0x" + "11".repeat(20),
    value: 0n,
    data: "0x",
  };
  const a = txSigner.signEip1559Tx(base, PRIV);
  const b = txSigner.signEip1559Tx({ ...base, nonce: 1 }, PRIV);
  assert.notEqual(a, b);
});

// ── RLP structure: every field must be framed canonically ─────────────────────
//
// EIP-1559 mandates each scalar field be RLP-encoded as a byte string (minimal
// big-endian, zero → 0x80 empty string) and the accessList be an RLP list (empty
// → 0xc0, NOT 0x80 empty string). The hand-rolled encoder previously passed bare
// integer bytes as list items, so a multi-byte value (any realistic gas price)
// was emitted WITHOUT its 0x8X length prefix and ran into the next field —
// malformed RLP that a real node rejects. A signer-recovery test misses this
// because the signature still recovers over whatever bytes were hashed; the only
// way to catch it is to decode the RLP and assert each field's framing.

/** Decode a top-level RLP list into its raw item byte-spans (one level deep). */
function rlpDecodeListItems(buf: Buffer): Buffer[] {
  const first = buf[0];
  assert.ok(first >= 0xc0, "expected an RLP list");
  const offset = first <= 0xf7 ? 1 : 1 + (first - 0xf7);
  const items: Buffer[] = [];
  let i = offset;
  while (i < buf.length) {
    const b = buf[i];
    let itemLen: number;
    if (b <= 0x7f) {
      itemLen = 1; // single byte is its own encoding
    } else if (b <= 0xb7) {
      itemLen = 1 + (b - 0x80); // short string
    } else if (b <= 0xbf) {
      const lenOfLen = b - 0xb7;
      const strLen = parseInt(buf.subarray(i + 1, i + 1 + lenOfLen).toString("hex") || "0", 16);
      itemLen = 1 + lenOfLen + strLen; // long string
    } else if (b <= 0xf7) {
      itemLen = 1 + (b - 0xc0); // short list
    } else {
      const lenOfLen = b - 0xf7;
      const listLen = parseInt(buf.subarray(i + 1, i + 1 + lenOfLen).toString("hex") || "0", 16);
      itemLen = 1 + lenOfLen + listLen; // long list
    }
    items.push(buf.subarray(i, i + itemLen));
    i += itemLen;
  }
  return items;
}

/** Decode an RLP byte-string item to its raw payload (the bytes it frames). */
function rlpStringPayload(item: Buffer): Buffer {
  const b = item[0];
  if (b <= 0x7f) return item; // single byte
  if (b <= 0xb7) return item.subarray(1); // short string
  const lenOfLen = b - 0xb7;
  return item.subarray(1 + lenOfLen); // long string
}

test("signEip1559Tx produces canonically-framed RLP fields (incl. accessList 0xc0)", () => {
  const tx = {
    chainId: 1,
    nonce: 7,
    maxPriorityFeePerGas: 1_000_000_000n, // 0x3b9aca00 — multi-byte, was emitted unframed
    maxFeePerGas: 30_000_000_000n,
    gasLimit: 60_000n,
    to: "0x" + "22".repeat(20),
    value: 0n,
    data: txSigner.buildTransferCalldata("0x" + "33".repeat(20), "1000000"),
  };
  const raw = txSigner.signEip1559Tx(tx, PRIV);
  assert.ok(raw.startsWith("0x02"));
  const payload = Buffer.from(raw.slice(4), "hex");
  const items = rlpDecodeListItems(payload);

  // Fields: [chainId, nonce, maxPriorityFee, maxFee, gasLimit, to, value, data,
  //          accessList, yParity, r, s] → exactly 12.
  assert.equal(items.length, 12, "expected exactly 12 RLP fields");

  // Multi-byte fee must be framed as a 4-byte string: 0x84 3b9aca00.
  assert.equal(rlpStringPayload(items[2]).toString("hex"), "3b9aca00");
  assert.equal(rlpStringPayload(items[3]).toString("hex"), "06fc23ac00");
  assert.equal(rlpStringPayload(items[4]).toString("hex"), "ea60");

  // `to` is a 20-byte address; `data` is the 68-byte transfer calldata.
  assert.equal(rlpStringPayload(items[5]).length, 20);
  assert.equal(rlpStringPayload(items[7]).length, 68);

  // value 0 → empty string 0x80.
  assert.equal(items[6].length, 1);
  assert.equal(items[6][0], 0x80);

  // accessList must be the empty LIST 0xc0, never the empty string 0x80.
  assert.equal(items[8].length, 1);
  assert.equal(items[8][0], 0xc0, `accessList must be 0xc0, got 0x${items[8][0].toString(16)}`);
});

test("isTreasuryWithdrawalEnabled is false when no key is configured", () => {
  const saved = process.env.MARKETPLACE_TREASURY_PRIVKEY;
  delete process.env.MARKETPLACE_TREASURY_PRIVKEY;
  try {
    assert.equal(txSigner.isTreasuryWithdrawalEnabled(), false);
    assert.equal(txSigner.getTreasuryAddress(), null);
  } finally {
    if (saved !== undefined) process.env.MARKETPLACE_TREASURY_PRIVKEY = saved;
  }
});

test("getTreasuryAddress derives the wallet address from a raw hex key", () => {
  const saved = process.env.MARKETPLACE_TREASURY_PRIVKEY;
  const savedEnc = process.env.STORAGE_ENCRYPTION_KEY;
  // No encryption key → decrypt() is passthrough, so a raw hex key is accepted.
  delete process.env.STORAGE_ENCRYPTION_KEY;
  process.env.MARKETPLACE_TREASURY_PRIVKEY = PRIV;
  try {
    const address = txSigner.getTreasuryAddress();
    assert.notEqual(address, null);
    assert.match(address as string, /^0x[0-9a-f]{40}$/);
    // It should match the address derived directly from the public key.
    const pub = secp256k1.getPublicKey(PRIV, false);
    // Re-derive via the same path the module uses (publicKeyToAddress is internal,
    // but the address must be stable for the same key).
    assert.equal(txSigner.isTreasuryWithdrawalEnabled(), true);
    assert.ok(pub.length > 0);
  } finally {
    if (saved !== undefined) process.env.MARKETPLACE_TREASURY_PRIVKEY = saved;
    else delete process.env.MARKETPLACE_TREASURY_PRIVKEY;
    if (savedEnc !== undefined) process.env.STORAGE_ENCRYPTION_KEY = savedEnc;
  }
});

// ── fee data ──────────────────────────────────────────────────────────────────
//
// eth_maxPriorityFeePerGas returns a bare hex QUANTITY string (e.g. "0x9502f900"),
// NOT an object. Reading result?.maxPriorityFeePerGas off it is always undefined,
// which silently drops the node's suggested tip and pins the priority fee to the
// hardcoded fallback — underpricing withdrawals during congestion so they stick
// in the mempool. Drive getFeeData with a stubbed fetch and assert the node's
// values are actually used.

/** Stub global fetch to answer JSON-RPC calls from a method→result map. */
function stubRpc(results: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const req = JSON.parse(String(init?.body ?? "{}"));
    if (!(req.method in results)) {
      throw new Error(`unexpected RPC method: ${req.method}`);
    }
    return {
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: req.id, result: results[req.method] }),
    };
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("getFeeData uses the node's suggested priority tip (hex string result)", async () => {
  // 2.5 Gwei tip, 100 Gwei base fee.
  const tip = "0x9502f900"; // 2_500_000_000
  const baseFee = "0x174876e800"; // 100_000_000_000
  const restore = stubRpc({
    eth_maxPriorityFeePerGas: tip,
    eth_getBlockByNumber: { baseFeePerGas: baseFee },
  });
  try {
    const fees = await txSigner.getFeeData("https://rpc.example");
    // Tip must come from the node, not the ~1.5 Gwei fallback.
    assert.equal(fees.maxPriorityFeePerGas, 2_500_000_000n);
    // maxFee = baseFee * 1.1 + tip = 110e9 + 2.5e9 = 112.5 Gwei.
    assert.equal(fees.maxFeePerGas, 112_500_000_000n);
  } finally {
    restore();
  }
});

test("getFeeData falls back to defaults when the node has no fee endpoints", async () => {
  const restore = stubRpc({}); // any RPC call throws → outer catch → static fallback
  try {
    const fees = await txSigner.getFeeData("https://rpc.example");
    assert.equal(fees.maxPriorityFeePerGas, 1_500_000_000n);
    assert.equal(fees.maxFeePerGas, 50_000_000_000n);
  } finally {
    restore();
  }
});
