import { get_encoding, type Tiktoken } from "tiktoken";
import { config } from "./config.js";
import { isTokenPriced, pricingForModel, type TokenPricing } from "./models.js";
import { paymentOverheadUsd } from "./gas.js";

let encoder: Tiktoken | undefined;

function getEncoder(): Tiktoken {
  encoder ??= get_encoding("o200k_base");
  return encoder;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

interface ChatRequestBody {
  model?: string;
  messages?: ChatMessage[];
  /** OpenAI Responses API input: a string or a list of message items. */
  input?: unknown;
  /** Responses API system prompt. */
  instructions?: string;
  max_tokens?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  tools?: unknown;
  [key: string]: unknown;
}

const TOKENS_PER_MESSAGE = 4;
const TOKENS_REPLY_PRIMING = 3;
const TOKENS_PER_IMAGE_PART = 500;

function textTokens(text: string): number {
  try {
    return getEncoder().encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function messageTokens(message: ChatMessage): number {
  let tokens = TOKENS_PER_MESSAGE;
  const content = message.content;
  if (typeof content === "string") {
    tokens += textTokens(content);
  } else if (Array.isArray(content)) {
    for (const part of content as Array<Record<string, unknown>>) {
      if (part?.type === "text" && typeof part.text === "string") {
        tokens += textTokens(part.text);
      } else {
        tokens += TOKENS_PER_IMAGE_PART;
      }
    }
  }
  return tokens;
}

export function estimateInputTokens(body: ChatRequestBody): number {
  const messages = Array.isArray(body.messages)
    ? body.messages
    : responsesInputToMessages(body.input);
  let tokens = TOKENS_REPLY_PRIMING;
  if (typeof body.instructions === "string") {
    tokens += textTokens(body.instructions);
  }
  for (const message of messages) {
    tokens += messageTokens(message);
  }
  if (body.tools) {
    tokens += textTokens(JSON.stringify(body.tools));
  }
  return tokens;
}

/**
 * Flatten a Responses API `input` field into chat-style messages so the same
 * token counter and quote path serve both request shapes.
 */
function responsesInputToMessages(input: unknown): ChatMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages: ChatMessage[] = [];
  for (const item of input as Array<Record<string, unknown>>) {
    if (!item || typeof item !== "object") continue;
    const role = typeof item.role === "string" ? item.role : "user";
    const content = item.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (Array.isArray(content)) {
      const parts = (content as Array<Record<string, unknown>>)
        .map((part) => {
          if (typeof part?.text === "string") return { type: "text", text: part.text };
          if (part?.type === "input_text" && typeof part.text === "string") {
            return { type: "text", text: part.text };
          }
          return undefined;
        })
        .filter((part): part is { type: string; text: string } => part !== undefined);
      if (parts.length > 0) messages.push({ role, content: parts });
    }
  }
  return messages;
}

export function estimateOutputTokens(body: ChatRequestBody): number {
  const requested = body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens;
  if (typeof requested === "number" && Number.isInteger(requested) && requested > 0) {
    return requested;
  }
  return Math.min(config.outputTokenEstimate, config.outputTokenCap);
}

function formatUsd(usd: number): string {
  return `$${Math.max(usd, 0.000001).toFixed(6)}`;
}

export interface QuoteBreakdown {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  price: string;
  paymentOverheadUsd: number;
  pricing: "per-token" | "per-request" | "default";
}

/**
 * Quote the exact price for one chat completion, before it runs:
 * counted input tokens + estimated output (max_tokens, else default estimate),
 * per-model $/1M-token rates, markup, plus settlement overhead.
 */
export async function quoteBreakdown(body: ChatRequestBody): Promise<QuoteBreakdown> {
  const pricing = pricingForModel(body.model);
  const overhead = await paymentOverheadUsd();

  if (!pricing) {
    return { model: body.model, price: floorPrice(parseUsd(config.defaultPrice) + (config.network === "eip155:5042" ? overhead : 0)), paymentOverheadUsd: overhead, pricing: "default" };
  }
  if (!isTokenPriced(pricing)) {
    return { model: body.model, price: floorPrice(parseUsd(pricing.per_request) + (config.network === "eip155:5042" ? overhead : 0)), paymentOverheadUsd: overhead, pricing: "per-request" };
  }

  const p: TokenPricing = pricing;
  const inputTokens = estimateInputTokens(body);
  const outputTokens = estimateOutputTokens(body);

  const usd =
    ((inputTokens * p.input + outputTokens * p.output) / 1_000_000) * config.priceMarkup +
    overhead;

  return {
    model: body.model,
    inputTokens,
    outputTokens,
    price: floorPrice(usd),
    paymentOverheadUsd: overhead,
    pricing: "per-token",
  };
}

/** Parse a "$0.01"-style price string into a number. */
function parseUsd(price: string): number {
  const value = Number(String(price).replace(/[^0-9.]/g, ""));
  return Number.isFinite(value) ? value : 0;
}

/** Apply the minimum charge so small calls still cover settlement costs. */
function floorPrice(usd: number): string {
  return formatUsd(Math.max(usd, config.minChargeUsd));
}

export async function quotePrice(body: ChatRequestBody): Promise<string> {
  return (await quoteBreakdown(body)).price;
}
