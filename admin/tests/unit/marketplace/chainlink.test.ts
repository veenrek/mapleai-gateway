import test from "node:test";
import assert from "node:assert/strict";

const chainlink = await import("../../../src/lib/marketplace/crypto/chainlink.ts");

const SELECTOR_LATEST = "0xfeaf968c";
const SELECTOR_DECIMALS = "0x313ce567";

/** Encode a uint/int as a 32-byte (64 hex char) word. */
function word(n: bigint): string {
  const masked = n < 0n ? (1n << 256n) + n : n; // two's complement for negatives
  return masked.toString(16).padStart(64, "0");
}

function latestRoundData(answer: bigint, updatedAt: number): string {
  // roundId, answer, startedAt, updatedAt, answeredInRound
  return (
    "0x" +
    word(1n) +
    word(answer) +
    word(BigInt(updatedAt)) +
    word(BigInt(updatedAt)) +
    word(1n)
  );
}

function makeCall(answer: bigint, updatedAt: number, decimals: number) {
  return async (_rpc: string, _to: string, data: string): Promise<string> => {
    if (data === SELECTOR_LATEST) return latestRoundData(answer, updatedAt);
    if (data === SELECTOR_DECIMALS) return "0x" + word(BigInt(decimals));
    throw new Error("unexpected selector " + data);
  };
}

test("decodes a Chainlink price with 8 decimals", async () => {
  // answer = 2500.12345678 * 1e8
  const answer = 250012345678n;
  const price = await chainlink.readChainlinkPrice("rpc", "0xfeed", makeCall(answer, 1_700_000_000, 8));
  assert.ok(price);
  assert.equal(price!.decimals, 8);
  assert.equal(price!.updatedAt, 1_700_000_000);
  assert.ok(Math.abs(price!.usd - 2500.12345678) < 1e-6);
});

test("returns null on a non-positive answer", async () => {
  const price = await chainlink.readChainlinkPrice("rpc", "0xfeed", makeCall(0n, 1_700_000_000, 8));
  assert.equal(price, null);
});

test("returns null on a negative answer", async () => {
  const price = await chainlink.readChainlinkPrice("rpc", "0xfeed", makeCall(-5n, 1_700_000_000, 8));
  assert.equal(price, null);
});
