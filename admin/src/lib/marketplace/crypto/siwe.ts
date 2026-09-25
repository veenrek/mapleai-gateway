// Sign-In With Ethereum (EIP-4361-style) message + EIP-191 personal_sign
// verification. Kept deliberately small: we build a deterministic human-readable
// message containing a server-issued nonce, then recover the signer address from
// the signature and compare it to the claimed wallet.
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { publicKeyToAddress } from "./address";

export interface SiweMessageParams {
  domain: string;
  walletAddress: string;
  nonce: string;
  issuedAt: string;
  statement?: string;
}

/**
 * Build the canonical message a wallet signs. The exact text must be reproduced
 * verbatim on verify, so both the client and `verifySiweSignature` derive it
 * from these params rather than trusting a client-sent string.
 */
export function buildSiweMessage(params: SiweMessageParams): string {
  const statement = params.statement || "Sign in to the MapleAI. This will not cost gas.";
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.walletAddress,
    "",
    statement,
    "",
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
  ].join("\n");
}

/**
 * EIP-191 personal_sign digest: keccak256("\x19Ethereum Signed Message:\n" + len + msg).
 */
function personalSignDigest(message: string): Uint8Array {
  const msgBytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const composed = new Uint8Array(prefix.length + msgBytes.length);
  composed.set(prefix, 0);
  composed.set(msgBytes, prefix.length);
  return keccak_256(composed);
}

function stripHex(value: string): string {
  return value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
}

/**
 * Recover the signer address from a 65-byte (r||s||v) personal_sign signature.
 * Returns the lowercase address, or null if the signature is malformed.
 */
export function recoverPersonalSignAddress(message: string, signature: string): string | null {
  const hex = stripHex(signature.trim());
  if (hex.length !== 130) return null; // 65 bytes
  let sigBytes: Uint8Array;
  try {
    sigBytes = Uint8Array.from(Buffer.from(hex, "hex"));
  } catch {
    return null;
  }
  if (sigBytes.length !== 65) return null;

  const r = sigBytes.slice(0, 32);
  const s = sigBytes.slice(32, 64);
  let v = sigBytes[64];
  // Normalize v to recovery id {0,1}. Wallets send 27/28 (or 0/1, or EIP-155).
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;

  const digest = personalSignDigest(message);
  try {
    const sig = secp256k1.Signature.fromCompact(
      Buffer.concat([Buffer.from(r), Buffer.from(s)])
    ).addRecoveryBit(v);
    const point = sig.recoverPublicKey(digest);
    const publicKey = point.toRawBytes(false); // uncompressed
    return publicKeyToAddress(publicKey).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Verify that `signature` over the canonical SIWE message was produced by
 * `walletAddress`. Constant-ish comparison on lowercased hex.
 */
export function verifySiweSignature(params: {
  message: string;
  signature: string;
  walletAddress: string;
}): boolean {
  const recovered = recoverPersonalSignAddress(params.message, params.signature);
  if (!recovered) return false;
  return recovered === params.walletAddress.trim().toLowerCase();
}
