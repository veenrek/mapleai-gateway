import { readFileSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const url = "https://base.mapleai.shop/prepaid/codes/auto";
const wallet = JSON.parse(readFileSync(".secrets/base-buyer-wallet.json", "utf8"));

function decode(header) {
  if (!header) throw new Error("Missing x402 header");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

// One-shot agent tap: POST with an empty body buys the default Luna pack.
const first = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
  signal: AbortSignal.timeout(30_000),
});
if (first.status !== 402) throw new Error("Expected 402, received " + first.status);
const challenge = decode(first.headers.get("payment-required"));
const requirement = challenge.accepts?.[0];
console.log("challenge:", requirement.network, requirement.scheme, "amount atoms:", requirement.amount);

const account = privateKeyToAccount(wallet.privateKey);
const client = new x402Client().setSpendControls({
  allowedAssets: [{ network: requirement.network, asset: requirement.asset, maxAmountPerPayment: requirement.amount }],
});
registerExactEvmScheme(client, { signer: account, networks: [requirement.network] });
const payment = await client.createPaymentPayload(challenge);
delete payment.extensions?.quote;

const paid = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "payment-signature": Buffer.from(JSON.stringify(payment)).toString("base64"),
  },
  body: JSON.stringify({}),
  signal: AbortSignal.timeout(120_000),
});
const receipt = paid.headers.get("payment-response") ? decode(paid.headers.get("payment-response")) : undefined;
const body = await paid.json();
console.log(JSON.stringify({
  status: paid.status,
  settled: receipt?.success === true,
  transaction: receipt?.transaction ?? null,
  codePrefix: typeof body.code === "string" ? body.code.slice(0, 14) + "..." : null,
  model: body.model,
  tokens: body.tokens,
  statusUrl: body.status_url ?? null,
}));

// The tapped key must pass the free status endpoint immediately.
if (!body.code) process.exit(1);
const status = await fetch("https://mapleai.shop/v1/prepaid/status", {
  headers: { authorization: "Bearer " + body.code },
  signal: AbortSignal.timeout(30_000),
});
const statusBody = await status.json();
console.log(JSON.stringify({
  statusCheck: status.status,
  valid: statusBody.valid,
  allowedModels: statusBody.allowedModels,
  remaining: statusBody.tokens?.remaining,
}));
