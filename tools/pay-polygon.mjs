import { readFileSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const env = Object.fromEntries(readFileSync("/etc/arc-facilitator.env", "utf8")
  .split(String.fromCharCode(10)).filter((line) => line.includes("="))
  .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const account = privateKeyToAccount(env.FACILITATOR_PRIVATE_KEY);
const url = "https://polygon.mapleai.shop/api/v1/chat/completions";
const body = JSON.stringify({
  model: "openai/gpt-6-luna",
  messages: [{ role: "user", content: "Say hello in one word." }],
  max_tokens: 64,
});
const headers = { "content-type": "application/json" };
const first = await fetch(url, { method: "POST", headers, body });
if (first.status !== 402) throw new Error("Expected 402, got " + first.status);
const paymentRequired = JSON.parse(Buffer.from(first.headers.get("payment-required"), "base64").toString());
const requirement = paymentRequired.accepts?.[0];
if (paymentRequired.resource?.url !== url || requirement?.network !== "eip155:137" ||
    requirement.asset?.toLowerCase() !== "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" ||
    requirement.payTo?.toLowerCase() !== env.FACILITATOR_PAY_TO.toLowerCase() ||
    !/^[0-9]+$/.test(requirement.amount) || BigInt(requirement.amount) > 5000n) {
  throw new Error("Unexpected payment requirement");
}
console.log("quote_usdc=" + Number(requirement.amount) / 1_000_000);

const client = new x402Client().setSpendControls({
  allowedAssets: [{ network: "eip155:137", asset: requirement.asset, maxAmountPerPayment: "5000" }],
});
registerExactEvmScheme(client, { signer: account, networks: ["eip155:137"] });
const payload = await client.createPaymentPayload(paymentRequired);
delete payload.extensions?.quote;
const paid = await fetch(url, {
  method: "POST",
  headers: { ...headers, "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64") },
  body,
});
console.log("status=" + paid.status);
if (paid.status === 402) {
  const challenge = paid.headers.get("payment-required");
  if (challenge) {
    const refusal = JSON.parse(Buffer.from(challenge, "base64").toString());
    console.log("payment_error=" + refusal.error);
  }
}
const settlementHeader = paid.headers.get("payment-response");
if (settlementHeader) {
  const settled = JSON.parse(Buffer.from(settlementHeader, "base64").toString());
  console.log("settlement=" + JSON.stringify({ success: settled.success, transaction: settled.transaction, network: settled.network, errorReason: settled.errorReason }));
}
const response = await paid.text();
console.log("response=" + response.slice(0, 450));
