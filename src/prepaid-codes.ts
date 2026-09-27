import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { paymentOverheadUsd } from "./gas.js";
import { isTokenPriced, pricingForModel } from "./models.js";

export const prepaidCodeModels = [
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-6-luna",
  "openai/gpt-6-sol",
] as const;

export const prepaidCodesEnabled = Boolean(config.prepaidIssuerToken);

if (prepaidCodesEnabled) {
  let issuer: URL;
  try {
    issuer = new URL(config.prepaidIssuerUrl);
  } catch {
    throw new Error("PREPAID_ISSUER_URL must be a valid URL");
  }
  if (
    issuer.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(issuer.hostname)
  ) {
    throw new Error("PREPAID_ISSUER_URL must use HTTP over loopback");
  }
}

export const prepaidCodeInputSchema = {
  type: "object",
  required: ["model", "tokens"],
  properties: {
    model: { type: "string", enum: prepaidCodeModels },
    tokens: { type: "integer", minimum: 100_000, maximum: 1_000_000, multipleOf: 100_000 },
  },
} as const;

export const prepaidCodeExample = {
  model: "openai/gpt-6-luna",
  tokens: 100_000,
};

export const prepaidCodeOutputExample = {
  object: "prepaid_code",
  code: "oms_buy_example",
  model: "openai/gpt-6-luna",
  tokens: { total: 100_000, remaining: 100_000 },
  api_base: "https://mapleai.shop/v1",
};

export function validatePrepaidCodePurchase(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({
      error: { message: "Request body must be a JSON object.", type: "invalid_request", code: "invalid_body" },
    });
    return;
  }
  if (!(prepaidCodeModels as readonly unknown[]).includes(body.model)) {
    res.status(400).json({
      error: {
        message: "model must be one of the four supported GPT models.",
        type: "invalid_request",
        param: "model",
        code: "invalid_model",
        details: { schema: prepaidCodeInputSchema },
      },
    });
    return;
  }
  if (
    !Number.isSafeInteger(body.tokens) ||
    body.tokens < 100_000 ||
    body.tokens > 1_000_000 ||
    body.tokens % 100_000 !== 0
  ) {
    res.status(400).json({
      error: {
        message: "tokens must be a multiple of 100000 from 100000 to 1000000.",
        type: "invalid_request",
        param: "tokens",
        code: "invalid_token_amount",
        details: { schema: prepaidCodeInputSchema },
      },
    });
    return;
  }
  next();
}

export async function quotePrepaidCode(body: { model: string; tokens: number }): Promise<string> {
  const pricing = pricingForModel(body?.model);
  const tokens = body?.tokens;
  if (
    !pricing ||
    !isTokenPriced(pricing) ||
    !Number.isSafeInteger(tokens) ||
    tokens < 100_000 ||
    tokens > 1_000_000 ||
    tokens % 100_000 !== 0
  ) {
    // Invalid purchases still get a minimal challenge; validation after the
    // paywall rejects them with 400 and the settlement is canceled.
    return `$${config.minChargeUsd.toFixed(6)}`;
  }
  const overhead = await paymentOverheadUsd();
  // Prepaid packs are sold at the model's input rate with no markup.
  const rawUsd = (tokens * pricing.input) / 1_000_000 + overhead;
  return `$${Math.max(config.minChargeUsd, rawUsd).toFixed(6)}`;
}

export async function issuePrepaidCode(
  body: { model: string; tokens: number },
  network: string,
  paymentSignature: string | undefined
): Promise<{ id: string; code: string; model: string; tokens: number }> {
  const issuerToken = config.prepaidIssuerToken;
  if (!prepaidCodesEnabled || !issuerToken) throw new Error("Prepaid code issuer is disabled");
  if (!paymentSignature) throw new Error("Missing x402 payment signature");

  const idempotencyKey = createHash("sha256")
    .update(network)
    .update("\0")
    .update(paymentSignature)
    .digest("hex");
  const response = await fetch(config.prepaidIssuerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-prepaid-issuer-token": issuerToken,
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ model: body.model, tokens: body.tokens, network }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Prepaid code issuer returned HTTP ${response.status}`);

  const issued = (await response.json()) as {
    id?: unknown;
    code?: unknown;
    model?: unknown;
    tokens?: unknown;
  };
  if (
    typeof issued.id !== "string" ||
    typeof issued.code !== "string" ||
    issued.model !== body.model ||
    issued.tokens !== body.tokens
  ) {
    throw new Error("Prepaid code issuer returned an invalid response");
  }
  return { id: issued.id, code: issued.code, model: body.model, tokens: body.tokens };
}
