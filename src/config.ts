import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] missing required env var: ${name} (see .env.example)`);
    process.exit(1);
  }
  return value;
}

/**
 * MODEL_PRICES — JSON map "model id" -> pricing. Two shapes per model:
 *   "$0.01"                          flat price per request
 *   {"input": 0.15, "output": 0.6}   $ per 1M input / output tokens
 */
export type ModelPricing = string | { input: number; output: number };

function parseModelPrices(raw: string | undefined): Record<string, ModelPricing> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MODEL_PRICES must be a JSON object");
  }
  return parsed as Record<string, ModelPricing>;
}

function parseModelMapping(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MODEL_MAPPING must be a JSON object");
  }
  return parsed as Record<string, string>;
}

export const config = {
  port: Number(process.env.PORT ?? 4021),

  /** CAIP-2 network id:
   *  solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 = Solana devnet (testnet, public facilitator)
   *  solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp  = Solana mainnet-beta (needs a Solana mainnet facilitator)
   *  eip155:84532 = Base Sepolia, eip155:8453 = Base mainnet */
  network: (process.env.NETWORK ?? "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1") as `${string}:${string}`,

  /** Address that receives USDC payments (Solana base58 or EVM 0x…, must match NETWORK) */
  payTo: required("PAY_TO"),
  /** Required on Robinhood Chain until an official USDC address is confirmed. */
  paymentAssetAddress: process.env.PAYMENT_ASSET_ADDRESS,

  facilitatorUrl: process.env.FACILITATOR_URL ?? "https://x402.org/facilitator",
  facilitatorToken: process.env.FACILITATOR_TOKEN,
  facilitatorMode: process.env.FACILITATOR_MODE ?? "http",
  arcRpcUrl: process.env.ARC_RPC_URL ?? "https://rpc.mainnet.arc.io",

  /** OpenAI-compatible upstream you are reselling access to */
  upstreamBaseUrl: (process.env.UPSTREAM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
  upstreamApiKey: required("UPSTREAM_API_KEY"),
  /** Optional second credential for the same upstream, used after auth/quota failures. */
  backupUpstreamApiKey: process.env.BACKUP_UPSTREAM_API_KEY,
  /** Dedicated credential for future image routes once the upstream enables access. */
  imageUpstreamApiKey: process.env.IMAGE_UPSTREAM_API_KEY,
  /** Separate credential for the SystemOne-only Jev model. */
  jevUpstreamApiKey: process.env.JEV_UPSTREAM_API_KEY,
  nvidiaApiKey: process.env.NVIDIA_API_KEY,
  embeddingStatsFile: process.env.EMBEDDING_STATS_FILE ?? "./embedding-events.jsonl",
  embeddingDataFile: process.env.EMBEDDING_DATA_FILE ?? "./embedding-data.jsonl",
  jevDataFile: process.env.JEV_DATA_FILE ?? "./jev-data.jsonl",
  embeddingStatsToken: process.env.EMBEDDING_STATS_TOKEN,
  infuraProjectId: process.env.INFURA_PROJECT_ID,
  prepaidIssuerUrl: process.env.PREPAID_ISSUER_URL ?? "http://127.0.0.1:4031/api/internal/prepaid-codes",
  prepaidIssuerToken: process.env.PREPAID_ISSUER_TOKEN,

  /**
   * Per-model upstream override: models listed in COMBO_UPSTREAM_MODELS are
   * served through the admin combo router at COMBO_UPSTREAM_BASE_URL with a
   * dedicated internal prepaid key instead of the direct upstream —
   * the combo fans out across several provider credentials, so a single
   * upstream blackout (gpt-6-luna, 2026-09-29) no longer knocks the model out.
   */
  comboUpstreamBaseUrl: (process.env.COMBO_UPSTREAM_BASE_URL ?? "http://127.0.0.1:4031/api/v1").replace(/\/$/, ""),
  internalComboKey: process.env.X402_INTERNAL_LUNA_KEY,
  comboUpstreamModels: (process.env.COMBO_UPSTREAM_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0),

  modelPrices: parseModelPrices(process.env.MODEL_PRICES),
  modelMapping: parseModelMapping(process.env.MODEL_MAPPING),
  /** Fallback flat price per request for models not listed in MODEL_PRICES */
  defaultPrice: process.env.DEFAULT_PRICE ?? "$0.01",

  /** Output tokens assumed when the request does not set max_tokens */
  outputTokenEstimate: Number(process.env.OUTPUT_TOKEN_ESTIMATE ?? 8192),
  /** Hard cap applied to max_tokens in the price quote */
  outputTokenCap: Number(process.env.OUTPUT_TOKEN_CAP ?? 16384),
  /** Multiplier on token cost (your margin) */
  priceMarkup: Number(process.env.PRICE_MARKUP ?? 1.25),
  /** Fixed overhead for non-Arc token-priced calls; Arc uses a live gas estimate. */
  facilitatorFeeUsd: Number(process.env.FACILITATOR_FEE_USD ?? 0.001),
  /** Floor applied to every quote so dust-sized calls still cover settlement */
  minChargeUsd: Number(process.env.MIN_CHARGE_USD ?? 0.001),

  /** JSONL file where per-request usage records are appended */
  ledgerFile: process.env.LEDGER_FILE ?? "./ledger.jsonl",

  /**
   * x402scan ownership proofs (comma-separated): signatures over the origin,
   * produced by tools/sign-ownership-proof.mjs and published in openapi.json
   * so the catalog can mark the listing ownership-verified.
   */
  ownershipProofs: (process.env.X402_OWNERSHIP_PROOFS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0),

  /**
   * Models temporarily pulled from sale (outages at the upstream, e.g. the
   * gpt-6-luna channel blackout on 2026-09-29). They disappear from /v1/models
   * and every generated document, and a request for one returns an explicit
   * "temporarily unavailable" error after the paywall cancels the settlement.
   */
  disabledModels: (process.env.DISABLED_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0),

  /** Brand shown in every public document and API response */
  serviceName: process.env.SERVICE_NAME ?? "MapleAI",
  /** Support contact published in openapi.json / llms.txt / landing page */
  contactEmail: process.env.CONTACT_EMAIL ?? "contact@mapleai.shop",
  /**
   * Externally visible origin (e.g. https://sol.mapleai.shop). When empty the
   * origin is derived from each request's Host header, which is what we want
   * behind a reverse proxy; set it explicitly to pin canonical URLs.
   */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
};
