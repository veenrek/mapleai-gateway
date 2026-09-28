import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { recordEmbeddingData } from "./embedding-stats.js";

export const embeddingModel = "nvidia/nemotron-3-embed-1b";
export const embeddingsEnabled = Boolean(config.nvidiaApiKey);

/** Conversion marker: free embeddings are the entry point, chat is the next hop. */
export const embeddingNextEndpoint = "/v1/chat/completions";
export const embeddingNextHint =
  "Next step: POST /v1/chat/completions with your query plus the retrieved context; " +
  "x402 pay-per-request (about $0.001 minimum, exact quote in the 402 challenge).";

export const embeddingInputSchema = {
  oneOf: [
    { type: "string" },
    {
      type: "array",
      minItems: 1,
      maxItems: 128,
      items: { type: "string" },
    },
  ],
} as const;

export const embeddingRequestSchema = {
  type: "object",
  required: ["input"],
  properties: {
    model: { type: "string", description: "Optional compatibility field; its value is ignored." },
    input: embeddingInputSchema,
    input_type: { type: "string", enum: ["query", "passage"] },
    encoding_format: { type: "string", enum: ["float", "base64"] },
  },
} as const;

export const embeddingValidationErrorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["message", "type", "param", "code", "details"],
      properties: {
        message: { type: "string" },
        type: { const: "invalid_request" },
        param: { type: "string" },
        code: { type: "string" },
        details: {
          type: "object",
          required: ["expected", "schema"],
          properties: {
            expected: { type: "string" },
            schema: embeddingRequestSchema,
          },
        },
      },
    },
  },
} as const;

const INVALID_INPUT_MAX_LOG_CHARS = 16_384;

function validationFailure(body: unknown): { reason: string; param: string; message: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { reason: "invalid_body", param: "body", message: "Request body must be a JSON object." };
  }

  if (!("input" in body)) {
    return { reason: "missing_input", param: "input", message: "input is required." };
  }

  const input = (body as { input: unknown }).input;
  if (typeof input === "string") return null;
  if (!Array.isArray(input)) {
    return {
      reason: "invalid_input_type",
      param: "input",
      message: "input must be a string or an array of strings.",
    };
  }
  if (input.length === 0) {
    return { reason: "empty_input_array", param: "input", message: "input array must not be empty." };
  }
  if (input.length > 128) {
    return {
      reason: "too_many_inputs",
      param: "input",
      message: "input array must contain no more than 128 strings.",
    };
  }
  if (!input.every((item) => typeof item === "string")) {
    return {
      reason: "non_string_input_item",
      param: "input",
      message: "Every item in the input array must be a string.",
    };
  }
  return null;
}

function boundedInvalidInput(body: unknown): { input: unknown; inputTruncated: boolean } {
  const input = body && typeof body === "object" && !Array.isArray(body) && "input" in body
    ? (body as { input: unknown }).input
    : body;
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? "null";
  } catch {
    serialized = String(input);
  }
  if (serialized.length <= INVALID_INPUT_MAX_LOG_CHARS) {
    return { input, inputTruncated: false };
  }
  return {
    input: { preview: serialized.slice(0, INVALID_INPUT_MAX_LOG_CHARS) },
    inputTruncated: true,
  };
}

export function validateEmbedding(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;
  // Discovery probes keep posting an empty JSON object ({}). Instead of a 400
  // they get a valid empty embedding list plus a usage hint, so automated
  // crawlers pass their health check; real clients are unaffected.
  const probe =
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    !("input" in body) &&
    typeof (body as { model?: unknown }).model === "string";
  if (probe) {
    res.locals.embeddingFailure = {
      source: "validation",
      reason: "missing_input",
      param: "input",
      message: "input is required.",
    };
    recordEmbeddingData(body, "", 200, req.get("host") ?? "unknown", embeddingModel,
      res.locals.embeddingFailure as { source: string; reason: string; message: string });
    res.setHeader("x-mapleai-next", embeddingNextEndpoint);
    res.status(200).json({
      object: "list",
      data: [],
      model: embeddingModel,
      hint: "Send {\"input\": \"your text\"} or {\"input\": [\"up to 128 strings\"]}",
      hint_next: embeddingNextHint,
    });
    return;
  }
  const failure = validationFailure(body);
  if (failure) {
    res.locals.embeddingFailure = { source: "validation", ...failure };
    recordEmbeddingData(
      body,
      "",
      400,
      req.get("host") ?? "unknown",
      embeddingModel,
      res.locals.embeddingFailure as { source: string; reason: string; message: string }
    );
    res.setHeader("x-mapleai-next", embeddingNextEndpoint);
    res.status(400).json({
      error: {
        message: failure.message,
        type: "invalid_request",
        param: failure.param,
        code: "invalid_input",
        details: {
          expected: "input must be a string or an array of 1 to 128 strings",
          schema: embeddingRequestSchema,
        },
      },
      hint_next: embeddingNextHint,
    });
    return;
  }
  next();
}

export async function fetchEmbeddings(body: Record<string, unknown>): Promise<globalThis.Response> {
  if (!config.nvidiaApiKey) throw new Error("NVIDIA embeddings credential unavailable");
  return fetch("https://integrate.api.nvidia.com/v1/embeddings", { method: "POST", headers: { authorization: "Bearer " + config.nvidiaApiKey, "content-type": "application/json" }, body: JSON.stringify({ ...body, model: embeddingModel }), signal: AbortSignal.timeout(120_000) });
}
