// EVM address helpers — keccak256 hashing, checksum formatting, and
// deterministic deposit-address derivation from a master seed.
//
// Ethereum uses keccak256 (original Keccak padding), which differs from the
// NIST SHA3-256 exposed by Node's crypto module. We therefore rely on
// @noble/hashes (keccak_256) and @noble/curves (secp256k1) rather than built-ins.
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

/** keccak256 of arbitrary bytes, returned as a 0x-prefixed hex string. */
export function keccak256Hex(data: Uint8Array): string {
  return "0x" + Buffer.from(keccak_256(data)).toString("hex");
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Derive the 20-byte EVM address from an uncompressed secp256k1 public key.
 * The public key may be 65 bytes (0x04 prefix) or 64 bytes (no prefix).
 */
export function publicKeyToAddress(publicKey: Uint8Array): string {
  const pub = publicKey.length === 65 ? publicKey.slice(1) : publicKey;
  const hash = keccak_256(pub);
  return "0x" + bytesToHex(hash.slice(-20));
}

/**
 * Apply EIP-55 mixed-case checksum to a lowercase (or any-case) hex address.
 */
export function toChecksumAddress(address: string): string {
  const addr = address.toLowerCase().replace(/^0x/, "");
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(addr)));
  let out = "0x";
  for (let i = 0; i < addr.length; i += 1) {
    out += parseInt(hash[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i];
  }
  return out;
}

export function isValidEvmAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address.trim());
}

/**
 * Derive a deterministic private key for a deposit slot from the master seed
 * and an integer index using HKDF-SHA256. This is intentionally simple (not
 * BIP-32/44) but deterministic and domain-separated: the same seed + index
 * always yields the same key, so deposit addresses survive restarts and the
 * private key need not be the only persisted copy.
 *
 * Returns the 32-byte private key, lowercase deposit address, and the
 * uncompressed public key.
 */
export function deriveDepositKey(
  masterSeed: string,
  index: number
): { privateKey: Uint8Array; address: string; publicKey: Uint8Array } {
  const ikm = new TextEncoder().encode(masterSeed);
  const info = new TextEncoder().encode(`marketplace-deposit:${index}`);
  const salt = new TextEncoder().encode("omniroute-marketplace-deposit-v1");

  // HKDF can, with negligible probability, produce a value outside the curve
  // order; re-derive with a counter suffix until valid.
  let key: Uint8Array | null = null;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const infoN =
      attempt === 0 ? info : new TextEncoder().encode(`marketplace-deposit:${index}:${attempt}`);
    const candidate = hkdf(sha256, ikm, salt, infoN, 32);
    try {
      if (secp256k1.utils.isValidPrivateKey(candidate)) {
        key = candidate;
        break;
      }
    } catch {
      // fall through to next attempt
    }
  }
  if (!key) {
    throw new Error("Failed to derive a valid deposit private key");
  }

  const publicKey = secp256k1.getPublicKey(key, false);
  return { privateKey: key, address: publicKeyToAddress(publicKey).toLowerCase(), publicKey };
}
