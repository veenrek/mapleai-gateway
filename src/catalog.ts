/**
 * The sellable model catalog: the intersection of what we price (MODEL_PRICES)
 * and what the upstream actually serves (MODEL_MAPPING).
 *
 * Everything public — /v1/models, the landing page, llms.txt, AI-AGENTS.md and
 * the OpenAPI spec — is rendered from this one function, so a model can never be
 * advertised at a price we do not charge, or offered when upstream cannot serve it.
 */
import { config } from "./config.js";
import { MODEL_METADATA } from "./model-metadata.js";
import { isTokenPriced, upstreamModelId, type TokenPricing } from "./models.js";

export interface CatalogModel {
  /** Public id clients send to us */
  id: string;
  /** Id we forward upstream */
  upstreamId: string;
  name: string;
  description: string;
  contextWindow: number;
  maxOutput: number;
  categories: string[];
  pricing: TokenPricing;
}

/** Display metadata fallback when model-metadata.ts has no entry. */
function derivedMetadata(id: string) {
  const tail = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  const pretty = tail
    .split("-")
    .map((part) => (/^[0-9]/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
  return {
    name: pretty,
    description: `${pretty} via the MapleAI x402 gateway`,
    contextWindow: 200000,
    maxOutput: 8192,
    categories: ["chat"],
  };
}

/** Models we actually sell: token-priced entries in MODEL_PRICES. */
export function catalog(): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const [id, pricing] of Object.entries(config.modelPrices)) {
    if (!isTokenPriced(pricing)) continue;
    const meta = MODEL_METADATA[id];
    const fallback = derivedMetadata(id);
    out.push({
      id,
      upstreamId: upstreamModelId(id),
      name: meta?.name ?? fallback.name,
      description: meta?.description ?? fallback.description,
      contextWindow: meta?.context_window ?? fallback.contextWindow,
      maxOutput: meta?.max_output ?? fallback.maxOutput,
      categories: meta?.categories ?? fallback.categories,
      // Pricing always comes from MODEL_PRICES — the value we actually charge.
      pricing,
    });
  }
  return out;
}

export function findCatalogModel(id: string | undefined): CatalogModel | undefined {
  if (!id) return undefined;
  return catalog().find((m) => m.id === id);
}

/** Cheapest advertised input rate ($/1M tokens). */
export function minInputPrice(): number {
  const models = catalog();
  if (models.length === 0) return 0;
  return Math.min(...models.map((m) => m.pricing.input));
}

/** Largest advertised context window. */
export function maxContextWindow(): number {
  const models = catalog();
  if (models.length === 0) return 0;
  return Math.max(...models.map((m) => m.contextWindow));
}

/** Format a $/1M-token rate without trailing zeros: 0.7 -> "0.70", 3.5 -> "3.50". */
export function money(usd: number): string {
  return usd.toFixed(2);
}

/** Compact token count: 1000000 -> "1M", 200000 -> "200K". */
export function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
