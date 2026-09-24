import { config } from "./config.js";

/** $ per 1M tokens */
export interface TokenPricing {
  input: number;
  output: number;
}

export interface ModelEntry {
  id: string;
  pricing: TokenPricing | { per_request: string };
}

export function pricingForModel(model: string | undefined): TokenPricing | { per_request: string } | undefined {
  if (!model) return undefined;
  // Accept either the canonical catalog id or the bare upstream id.
  const pricing = config.modelPrices[canonicalModelId(model) ?? model];
  if (pricing === undefined) return undefined;
  return isTokenPriced(pricing) ? pricing : { per_request: pricing as string };
}

export function isTokenPriced(p: unknown): p is TokenPricing {
  return (
    typeof p === "object" &&
    p !== null &&
    typeof (p as TokenPricing).input === "number" &&
    typeof (p as TokenPricing).output === "number"
  );
}

export function listModels(): ModelEntry[] {
  return Object.entries(config.modelPrices).map(([id, pricing]) => ({
    id,
    pricing: isTokenPriced(pricing) ? pricing : { per_request: pricing as string },
  }));
}

/**
 * Catalog ids are the prefixed form (e.g. anthropic/claude-opus-5). Clients
 * may also send the bare upstream id (claude-opus-5); both resolve to the
 * canonical catalog entry.
 */
export function canonicalModelId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (id in config.modelPrices) return id;
  for (const [canonical, upstream] of Object.entries(config.modelMapping)) {
    if (upstream === id && canonical in config.modelPrices) return canonical;
  }
  return undefined;
}

/** Model id to send to the upstream provider for a canonical catalog id. */
export function upstreamModelId(id: string): string {
  const canonical = canonicalModelId(id) ?? id;
  return config.modelMapping[canonical] ?? canonical;
}

/** True when the catalog knows this id (canonical or bare upstream form). */
export function isKnownModel(id: string | undefined): boolean {
  return canonicalModelId(id) !== undefined;
}
