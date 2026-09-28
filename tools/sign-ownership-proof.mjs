// Signs x402scan ownership proofs with the treasury keys.
//
// Usage:
//   node tools/sign-ownership-proof.mjs --svm-key <base58> --evm-key <0x...>
//   or read keys from .secrets/treasury-keys.json:
//     {"svm":"base58...","evm":"0x..."}
//
// Prints only signatures and verification results — never the keys.
// The resulting proofs go into the gateway env var X402_OWNERSHIP_PROOFS.

import { readFileSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";

const ORIGINS = {
  svm: ["https://sol.mapleai.shop"],
  evm: [
    "https://base.mapleai.shop",
    "https://polygon.mapleai.shop",
    "https://arc.mapleai.shop",
  ],
};

function readFlag(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

let keys = {};
try {
  keys = JSON.parse(readFileSync(".secrets/treasury-keys.json", "utf8"));
} catch { /* flags below */ }
const svmKey = readFlag("--svm-key") ?? keys.svm;
const evmKey = readFlag("--evm-key") ?? keys.evm;
if (!svmKey && !evmKey) {
  console.error("Provide --svm-key and/or --evm-key, or .secrets/treasury-keys.json");
  process.exit(1);
}

const proofs = [];

if (svmKey) {
  const secret = base58.decode(svmKey.trim());
  const seed = secret.length === 64 ? secret.slice(0, 32) : secret;
  if (seed.length !== 32) throw new Error("SVM key must be 32-byte seed or 64-byte secret key");
  const publicKey = ed25519.getPublicKey(seed);
  const address = base58.encode(publicKey);
  for (const origin of ORIGINS.svm) {
    const message = new TextEncoder().encode(origin);
    const signature = ed25519.sign(message, seed);
    const sig58 = base58.encode(signature);
    const ok = ed25519.verify(signature, message, publicKey);
    console.log(`[svm] ${origin}\n  address: ${address}\n  signature(base58): ${sig58}\n  self-check: ${ok}`);
    proofs.push(sig58);
  }
}

if (evmKey) {
  const account = privateKeyToAccount(evmKey.trim().startsWith("0x") ? evmKey.trim() : ("0x" + evmKey.trim()));
  console.log(`[evm] address: ${account.address}`);
  for (const origin of ORIGINS.evm) {
    const signature = await account.signMessage({ message: origin });
    const recovered = await recoverMessageAddress({ message: origin, signature });
    const ok = recovered.toLowerCase() === account.address.toLowerCase();
    console.log(`[evm] ${origin}\n  signature(hex): ${signature}\n  self-check: ${ok}`);
    proofs.push(signature);
  }
}

writeFileSync(
  ".secrets/ownership-proofs.json",
  JSON.stringify(
    {
      note: "x402scan ownership proofs (signatures, not keys) from tools/sign-ownership-proof.mjs",
      proofs,
      envLine: "X402_OWNERSHIP_PROOFS=" + proofs.join(","),
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log("\nwrote .secrets/ownership-proofs.json (signatures only, mode 600)");
