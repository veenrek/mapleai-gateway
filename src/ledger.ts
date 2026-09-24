import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { isTokenPriced, pricingForModel } from "./models.js";

export interface UsageRecord {
  ts: string;
  model?: string;
  payer?: string;
  upstreamStatus: number;
  quotedUsd?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** What the request actually cost at our per-token rates (revenue calibration) */
  actualCostUsd?: number;
}

/** Best-effort payer extraction from the x402 payment header (EVM exact only). */
export function extractPayer(paymentHeader: string | undefined): string | undefined {
  if (!paymentHeader) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
    return (
      payload?.payload?.authorization?.from ??
      payload?.payload?.from ??
      undefined
    );
  } catch {
    return undefined;
  }
}

/** Parse OpenAI-style usage from an upstream chat completion body. */
export function parseUsage(body: Buffer): UsageRecord["usage"] | undefined {
  try {
    const json = JSON.parse(body.toString("utf8"));
    const u = json?.usage;
    if (!u) return undefined;
    return {
      promptTokens: u.prompt_tokens,
      completionTokens: u.completion_tokens,
      totalTokens: u.total_tokens,
    };
  } catch {
    return undefined; // streaming / non-JSON upstream response
  }
}

/**
 * Parse usage from an SSE stream tail. The provider emits a final
 * `data: {...}` chunk carrying `usage` before `data: [DONE]` when the client
 * sets `stream_options.include_usage`. The captured tail may start mid-JSON,
 * so scan backwards and keep the last line that parses.
 */
export function parseUsageFromSse(text: string): UsageRecord["usage"] | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const u = JSON.parse(payload)?.usage;
      if (u) {
        return {
          promptTokens: u.prompt_tokens,
          completionTokens: u.completion_tokens,
          totalTokens: u.total_tokens,
        };
      }
    } catch {
      // partial JSON at the start of the tail window
    }
  }
  return undefined;
}

export function actualCostUsd(model: string | undefined, usage: UsageRecord["usage"]): number | undefined {
  if (!usage || model === undefined) return undefined;
  const pricing = pricingForModel(model);
  if (!pricing || !isTokenPriced(pricing)) return undefined;
  const input = usage.promptTokens ?? 0;
  const output = usage.completionTokens ?? 0;
  return (input * pricing.input + output * pricing.output) / 1_000_000;
}

export function recordUsage(record: UsageRecord): void {
  try {
    const file = config.ledgerFile;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n");
  } catch (error) {
    console.error("[ledger] failed to write:", error);
  }
}
