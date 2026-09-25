import type { MarketplaceListing } from "@/lib/db/marketplace";

export const MICRO_USD_PER_USD = 1_000_000;
export const TOKENS_PER_MILLION = 1_000_000;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function normalizeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

export function usdToMicroUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * MICRO_USD_PER_USD);
}

export function microUsdToUsd(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value / MICRO_USD_PER_USD;
}

export function priceUsdPerMillionToMicroUsd(value: number): number {
  return usdToMicroUsd(value);
}

export function calculateMarketplaceChargeMicroUsd(
  listing: Pick<
    MarketplaceListing,
    "inputPriceMicroUsdPerMillionTokens" | "outputPriceMicroUsdPerMillionTokens"
  >,
  usage: Pick<TokenUsage, "promptTokens" | "completionTokens">
): number {
  const promptTokens = normalizeTokenCount(usage.promptTokens);
  const completionTokens = normalizeTokenCount(usage.completionTokens);
  const inputCost =
    (promptTokens * listing.inputPriceMicroUsdPerMillionTokens) / TOKENS_PER_MILLION;
  const outputCost =
    (completionTokens * listing.outputPriceMicroUsdPerMillionTokens) / TOKENS_PER_MILLION;
  return Math.ceil(inputCost + outputCost);
}

export function estimatePromptTokens(body: unknown): number {
  const text = JSON.stringify(body ?? "");
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateCompletionReserveTokens(body: unknown): number {
  if (!body || typeof body !== "object") return 1024;
  const record = body as Record<string, unknown>;
  const maxTokens = record.max_tokens ?? record.max_completion_tokens;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
    return Math.ceil(maxTokens);
  }
  return 1024;
}

export function extractUsageFromResponseBody(body: unknown): TokenUsage | null {
  if (!body || typeof body !== "object") return null;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const promptTokens = normalizeTokenCount(
    record.prompt_tokens ?? record.input_tokens ?? record.inputTokens
  );
  const completionTokens = normalizeTokenCount(
    record.completion_tokens ?? record.output_tokens ?? record.outputTokens
  );
  const totalTokens = normalizeTokenCount(record.total_tokens ?? record.totalTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens || promptTokens + completionTokens,
  };
}

export function extractUsageFromSseText(text: string): TokenUsage | null {
  let latest: TokenUsage | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      latest = extractUsageFromResponseBody(parsed) || latest;
    } catch {
      // Ignore non-JSON SSE payloads from non-OpenAI providers.
    }
  }
  return latest;
}

export function fallbackUsageFromReservation(
  reservedPromptTokens: number,
  reservedCompletionTokens: number
): TokenUsage {
  const promptTokens = normalizeTokenCount(reservedPromptTokens);
  const completionTokens = normalizeTokenCount(reservedCompletionTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}
