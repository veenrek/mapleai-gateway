import { NextResponse } from "next/server";
import { z } from "zod";
import { getRelayAccounts, createRelayAccount, getRelayPoolStats } from "@/lib/db/relayAccounts";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const providerTypeEnum = z.enum(["anthropic", "openai", "codex"]);

const createAccountSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  providerType: providerTypeEnum.optional(),
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
});

/** Public shape — secrets never leave the server. */
function publicAccount(account: ReturnType<typeof getRelayAccounts>[number]) {
  const { apiKey, codexRefreshToken, ...rest } = account;
  return {
    ...rest,
    hasApiKey: Boolean(apiKey),
    hasCodexRefreshToken: Boolean(codexRefreshToken),
    apiKeyPrefix: apiKey ? apiKey.slice(0, 8) : null,
  };
}

export async function GET() {
  const accounts = getRelayAccounts();
  return NextResponse.json({
    accounts: accounts.map(publicAccount),
    stats: getRelayPoolStats(),
  });
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.json();

    // Bulk import — accepts an anthropic-api-relay accounts.json export
    // (either the raw array or the wrapper object with an `accounts` field).
    if (
      rawBody &&
      typeof rawBody === "object" &&
      Array.isArray((rawBody as { accounts?: unknown }).accounts)
    ) {
      const { importRelayAccounts } = await import("@/lib/db/relayAccounts");
      const result = importRelayAccounts(
        (rawBody as { accounts: Array<Record<string, unknown>> }).accounts
      );
      return NextResponse.json(result);
    }
    if (Array.isArray(rawBody)) {
      const { importRelayAccounts } = await import("@/lib/db/relayAccounts");
      const result = importRelayAccounts(rawBody as Array<Record<string, unknown>>);
      return NextResponse.json(result);
    }

    const validation = validateBody(createAccountSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const account = createRelayAccount(validation.data);
    return NextResponse.json(publicAccount(account));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
