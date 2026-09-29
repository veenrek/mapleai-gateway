// Full MapleAI agent scenario:
//   1. free embeddings probe
//   2. x402-paid prepaid key purchase (tap)
//   3. prepaid key status check
//   4. chat completion through the prepaid key
//
// Usage: SVM_PRIVATE_KEY=<base58> node src/scenario.mjs --network solana
//        EVM_PRIVATE_KEY=0x...   node src/scenario.mjs --network base
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import { privateKeyToAccount } from "viem/accounts";

const arg = (name, fallback) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const network = arg("network", process.env.MCP_NETWORK ?? "base");
const domains = {
  solana: { uid: "sol", origin: "https://sol.mapleai.shop", svm: true },
  base: { uid: "base", origin: "https://base.mapleai.shop", svm: false },
};
const domain = domains[network];
if (!domain) { console.error("unknown --network, use solana|base"); process.exit(1); }

const prepaidApi = "https://mapleai.shop/v1";
const spendCapAtoms = 1_000_000n; // hard cap per payment: 1.00 USDC

function step(name) { console.log("\n=== " + name + " ==="); }
function fail(message) { console.error("FAIL: " + message); process.exit(1); }

async function pay(request) {
  const first = await fetch(request.url, {
    method: request.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(30_000),
  });
  if (first.status !== 402) fail(`expected 402 challenge, got HTTP ${first.status}`);
  const header = first.headers.get("payment-required");
  const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const accept = challenge.accepts?.[0];
  if (!accept) fail("empty challenge accepts");
  const amount = BigInt(accept.amount);
  if (amount > spendCapAtoms) fail(`amount ${accept.amount} exceeds cap ${spendCapAtoms}`);

  const client = new x402Client().setSpendControls({
    allowedAssets: [{ network: accept.network, asset: accept.asset, maxAmountPerPayment: spendCapAtoms }],
  });
  if (domain.svm) {
    const key = process.env.SVM_PRIVATE_KEY;
    if (!key) fail("SVM_PRIVATE_KEY is required for --network solana");
    const signer = await createKeyPairSignerFromBytes(base58.decode(key));
    registerExactSvmScheme(client, { signer, networks: [accept.network] });
  } else {
    const key = process.env.EVM_PRIVATE_KEY;
    if (!key) fail("EVM_PRIVATE_KEY is required for --network base");
    registerExactEvmScheme(client, { signer: privateKeyToAccount(key), networks: [accept.network] });
  }
  const payload = await client.createPaymentPayload(challenge);
  delete payload.extensions?.quote;

  return fetch(request.url, {
    method: request.method ?? "POST",
    headers: { "content-type": "application/json",
      "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64") },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(180_000),
  });
}

// 1. Free embeddings probe — no payment, no key.
step("1/4 free embeddings");
const emb = await fetch(domain.origin + "/v1/embeddings", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ input: "duplicate charge on my order" }),
  signal: AbortSignal.timeout(30_000),
});
if (!emb.ok) fail(`embeddings HTTP ${emb.status}`);
const embData = await emb.json();
const dims = embData.data?.[0]?.embedding?.length;
if (dims !== 2048) fail(`expected 2048-dim vector, got ${dims}`);
console.log("embedding ok, dims:", dims, "| suggested next:", emb.headers.get("x-mapleai-next"));

// 2. Buy a prepaid key via the agent tap (cheapest available model, 0.1M token budget).
step("2/4 buy prepaid key (tap)");
const purchase = await pay({ url: domain.origin + "/prepaid/codes/auto" });
if (!purchase.ok) fail(`tap purchase HTTP ${purchase.status}: ${(await purchase.text()).slice(0, 300)}`);
const receipt = purchase.headers.get("payment-response");
if (receipt) {
  const settled = JSON.parse(Buffer.from(receipt, "base64").toString("utf8"));
  console.log("settled:", settled.success, "tx:", settled.transaction);
}
const pack = await purchase.json();
const key = pack.code;
if (typeof key !== "string" || !key.startsWith("oms_buy_")) fail("tap did not return a prepaid key");
console.log("key issued for model:", pack.model, "| budget:", pack.tokens?.total, "tokens");

// 3. Verify the key at the prepaid status endpoint.
step("3/4 prepaid key status");
const status = await fetch(prepaidApi + "/prepaid/status", {
  headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(30_000),
});
if (!status.ok) fail(`status HTTP ${status.status}`);
const statusData = await status.json();
if (!statusData.valid) fail("key is not valid right after purchase");
console.log("valid:", statusData.valid, "| models:", statusData.allowedModels.join(", "),
  "| remaining:", statusData.tokens.remaining);
const model = statusData.allowedModels[0];

// 4. Run one chat completion through the prepaid gateway.
step("4/4 chat through prepaid key");
const chat = await fetch(prepaidApi + "/chat/completions", {
  method: "POST",
  headers: { authorization: "Bearer " + key, "content-type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: OK" }], stream: false }),
  signal: AbortSignal.timeout(120_000),
});
if (!chat.ok) fail(`chat HTTP ${chat.status}: ${(await chat.text()).slice(0, 300)}`);
const chatData = await chat.json();
console.log("chat model:", chatData.model ?? model);
console.log("assistant:", JSON.stringify(chatData.choices?.[0]?.message?.content).slice(0, 200));
console.log("usage:", JSON.stringify(chatData.usage ?? null));

console.log("\nSCENARIO PASSED — keep the key for further calls:");
console.log("  curl " + prepaidApi + "/prepaid/status -H 'Authorization: Bearer " + key + "'");
