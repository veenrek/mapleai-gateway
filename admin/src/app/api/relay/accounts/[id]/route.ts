import { NextResponse } from "next/server";
import { z } from "zod";
import { getRelayAccount, updateRelayAccount, deleteRelayAccount } from "@/lib/db/relayAccounts";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const updateAccountSchema = z.object({
  name: z.string().trim().min(1).optional(),
  providerType: z.enum(["anthropic", "openai", "codex"]).optional(),
  baseUrl: z.string().trim().optional().nullable(),
  apiKey: z.string().optional().nullable(),
  authHeader: z.string().trim().optional(),
  model: z.string().trim().optional().nullable(),
  modelsCache: z.array(z.string()).optional().nullable(),
  proxyUrl: z.string().trim().optional().nullable(),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
  maxMessages: z.number().int().nonnegative().optional(),
  maxTokens: z.number().int().nonnegative().optional(),
  clearCooldown: z.boolean().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

function publicAccount(account: ReturnType<typeof getRelayAccount>) {
  if (!account) return null;
  const { apiKey, codexRefreshToken, ...rest } = account;
  return {
    ...rest,
    hasApiKey: Boolean(apiKey),
    hasCodexRefreshToken: Boolean(codexRefreshToken),
    apiKeyPrefix: apiKey ? apiKey.slice(0, 8) : null,
  };
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  return NextResponse.json(publicAccount(getRelayAccount(id)));
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const validation = validateBody(updateAccountSchema, await request.json());
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const updated = updateRelayAccount(id, validation.data);
    if (!updated) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    return NextResponse.json(publicAccount(updated));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const deleted = deleteRelayAccount(id);
  if (!deleted) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
