import { existsSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { toClientSvmSigner } from "@x402/svm";

if (existsSync(".env")) process.loadEnvFile(".env");

const networks = {
  base: {
    origin: "https://base.mapleai.shop",
    id: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  solana: {
    origin: "https://sol.mapleai.shop",
    id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
} as const;

type NetworkName = keyof typeof networks;
const networkName = (process.env.MAPLEAI_NETWORK ?? "base") as NetworkName;
const network = networks[networkName];
if (!network) throw new Error("MAPLEAI_NETWORK must be base or solana");

const model = process.env.MAPLEAI_MODEL ?? "openai/gpt-6-luna";
const maxPaymentUsdc = process.env.MAPLEAI_MAX_PAYMENT_USDC ?? "0.01";
const maxPaymentAtomic = toUsdcAtomic(maxPaymentUsdc);
const question = process.argv.slice(2).filter((arg) => arg !== "--quote-only").join(" ").trim()
  || "How do I use embeddings with MapleAI?";
const quoteOnly = process.argv.includes("--quote-only");
const notes = [
  { title: "Embeddings", text: "MapleAI provides free NVIDIA Nemotron embeddings at POST /v1/embeddings. Send input as a string or an array of strings; the endpoint always uses nvidia/nemotron-3-embed-1b." },
  { title: "Chat", text: "MapleAI chat completions use POST /v1/chat/completions. The caller receives an x402 challenge, signs the USDC payment, and retries the request." },
  { title: "Networks", text: "MapleAI accepts x402 payments on Base and Solana. Use base.mapleai.shop with Base USDC or sol.mapleai.shop with Solana USDC." },
];

const [queryEmbedding, notesEmbedding] = await Promise.all([
  embed([question], "query"),
  embed(notes.map((note) => note.text), "passage"),
]);
const queryVector = queryEmbedding[0];
if (!queryVector) throw new Error("Embedding response did not include a query vector");
const rankedNotes = notes.map((note, index) => {
  const vector = notesEmbedding[index];
  if (!vector) throw new Error("Embedding response did not include all note vectors");
  return { ...note, score: cosineSimilarity(queryVector, vector) };
}).sort((a, b) => b.score - a.score).slice(0, 2);

console.log("Retrieved context:");
for (const note of rankedNotes) console.log(`- ${note.title} (${note.score.toFixed(3)})`);

const url = `${network.origin}/v1/chat/completions`;
const requestBody = JSON.stringify({
  model,
  messages: [
    { role: "system", content: "Answer using the supplied context. If the context does not contain the answer, say so." },
    { role: "user", content: `Question: ${question}\n\nContext:\n${rankedNotes.map((note) => `${note.title}: ${note.text}`).join("\n")}` },
  ],
  max_tokens: 160,
});
const headers = { "content-type": "application/json" };
const firstResponse = await fetch(url, { method: "POST", headers, body: requestBody });
if (firstResponse.status !== 402) {
  throw new Error(`Expected x402 challenge, got ${firstResponse.status}: ${await firstResponse.text()}`);
}

const challenge = decodeHeader(firstResponse.headers.get("payment-required")) as {
  resource?: { url?: string };
  accepts?: Array<{ network?: string; asset?: string; payTo?: string; amount?: string }>;
};
const requirement = challenge.accepts?.find((accept) => accept.network === network.id && accept.asset?.toLowerCase() === network.asset.toLowerCase());
if (challenge.resource?.url !== url || !requirement?.amount || BigInt(requirement.amount) > BigInt(maxPaymentAtomic)) {
  throw new Error("The payment challenge did not match the selected network or spend limit");
}
console.log(`Quote: ${formatUsdc(requirement.amount)} USDC on ${networkName}`);

if (quoteOnly) {
  console.log("Quote only; no payment was signed or sent.");
} else {
  const client = new x402Client().setSpendControls({
    allowedAssets: [{ network: network.id, asset: network.asset, maxAmountPerPayment: maxPaymentAtomic }],
  });
  if (networkName === "base") {
    const privateKey = process.env.EVM_PRIVATE_KEY;
    if (!privateKey) throw new Error("Set EVM_PRIVATE_KEY in .env for Base payments");
    registerExactEvmScheme(client, {
      signer: privateKeyToAccount(privateKey as `0x${string}`),
      networks: [network.id],
    });
  } else {
    const privateKey = process.env.SVM_PRIVATE_KEY;
    if (!privateKey) throw new Error("Set SVM_PRIVATE_KEY in .env for Solana payments");
    const signer = await createKeyPairSignerFromBytes(base58.decode(privateKey));
    registerExactSvmScheme(client, { signer: toClientSvmSigner(signer), networks: [network.id] });
  }

  const payment = await client.createPaymentPayload(challenge as never);
  delete payment.extensions?.quote;
  const paidResponse = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "payment-signature": Buffer.from(JSON.stringify(payment)).toString("base64"),
    },
    body: requestBody,
  });
  const paidBody = await paidResponse.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!paidResponse.ok) throw new Error(`Chat failed (${paidResponse.status}): ${paidBody.error?.message ?? "unknown error"}`);
  console.log("\nMapleAI answer:\n" + (paidBody.choices?.[0]?.message?.content ?? "(empty response)"));
  const receiptHeader = paidResponse.headers.get("payment-response");
  if (receiptHeader) {
    const receipt = decodeHeader(receiptHeader) as { success?: boolean; transaction?: string };
    console.log(`\nSettlement: ${receipt.success ? "confirmed" : "not confirmed"}${receipt.transaction ? ` (${receipt.transaction})` : ""}`);
  }
}

function decodeHeader(value: string | null): unknown {
  if (!value) throw new Error("Missing x402 response header");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

async function embed(input: string[], inputType: "query" | "passage"): Promise<number[][]> {
  const response = await fetch(`${network.origin}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, input_type: inputType, encoding_format: "float" }),
  });
  const result = await response.json() as {
    data?: Array<{ embedding?: number[] }>;
    error?: { message?: string };
  };
  if (!response.ok || !result.data || result.data.length !== input.length) {
    throw new Error(`Embeddings failed (${response.status}): ${result.error?.message ?? "unexpected response"}`);
  }
  const vectors = result.data.map((item) => item.embedding);
  if (vectors.some((vector) => !vector)) throw new Error("Embedding response is missing vectors");
  return vectors as number[][];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Embedding dimensions do not match");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function toUsdcAtomic(value: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error("USDC amounts must have at most 6 decimal places");
  const [whole, fraction = ""] = value.split(".");
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))).toString();
}

function formatUsdc(value: string): string {
  const amount = BigInt(value);
  return `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, "0")}`;
}
