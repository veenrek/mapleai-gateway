import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  createMarketplaceBuyerKey,
  findPrepaidBuyerKeyByNameWithSecret,
} from "@/lib/db/marketplace";

/**
 * Internal issuer for the x402 gateway prepaid-code purchase endpoint.
 * Loopback-only in deployment; every call must carry the shared
 * PREPAID_ISSUER_TOKEN and an Idempotency-Key derived from the settled
 * payment, so a retried paid request returns the same key instead of
 * issuing a second one.
 */

const GATEWAY_TO_COMBO_MODEL = {
  "openai/gpt-5.6-sol": "gpt-5.6-sol",
  "openai/gpt-5.6-terra": "gpt-5.6-terra",
  "openai/gpt-6-luna": "gpt-6-luna",
  "openai/gpt-6-sol": "gpt-6-sol",
} as const;

const issueSchema = z.object({
  model: z.enum([
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-6-luna",
    "openai/gpt-6-sol",
  ]),
  tokens: z.number().int().min(100_000).max(1_000_000).multipleOf(100_000),
  network: z.string().trim().min(1).max(40),
});

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function authorized(request: Request): boolean {
  const expected = process.env.PREPAID_ISSUER_TOKEN;
  if (!expected) return false;
  const presented = request.headers.get("x-prepaid-issuer-token") ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return json(401, { error: { message: "Invalid issuer token", type: "unauthorized" } });
  }

  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) {
    return json(400, {
      error: { message: "Idempotency-Key must be a 64-char hex digest", type: "invalid_request" },
    });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json(400, { error: { message: "Invalid JSON body", type: "invalid_request" } });
  }
  const parsed = issueSchema.safeParse(rawBody);
  if (!parsed.success) {
    return json(400, {
      error: {
        message: parsed.error.issues[0]?.message || "Invalid prepaid code payload",
        type: "invalid_request",
      },
    });
  }

  const { model, tokens, network } = parsed.data;
  const comboModel = GATEWAY_TO_COMBO_MODEL[model];
  const keyName = `x402 ${network} ${comboModel} ${tokens / 1000}k ${idempotencyKey}`;

  const existing = findPrepaidBuyerKeyByNameWithSecret(keyName);
  if (existing) {
    if (!existing.apiKey) {
      return json(500, {
        error: { message: "Stored key cannot be recovered", type: "issuer_error" },
      });
    }
    return json(200, { id: existing.buyerKey.id, code: existing.apiKey, model, tokens });
  }

  const { buyerKey, apiKey } = createMarketplaceBuyerKey({
    name: keyName,
    allowedModels: [comboModel],
    tokenBudgetTotal: tokens,
    isUnlimited: false,
    expiresAt: null,
    userId: null,
    balanceMicroUsd: 0,
  });

  return json(201, { id: buyerKey.id, code: apiKey, model, tokens });
}
