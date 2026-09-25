import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createMarketplaceBuyerKey, listPrepaidMarketplaceBuyerKeysWithStats } from "@/lib/db/marketplace";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { getUnifiedModelsResponse } from "@/app/api/v1/models/catalog";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return marketplaceJson({ keys: listPrepaidMarketplaceBuyerKeysWithStats() });
}

const issueSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120),
  /** Public marketplace models the key may call (exact ids, e.g. "gpt-5"). */
  models: z.array(z.string().trim().min(1)).min(1).optional(),
  /** Scope the key to every storefront model of this provider. */
  provider: z.string().trim().min(1).optional(),
  /** Scope the key to a combo model. */
  comboId: z.string().trim().min(1).optional(),
  /** Token budget, e.g. 50_000_000 for "50M tokens". */
  tokens: z.number().int().positive("tokens must be a positive integer"),
  /** Optional validity window. */
  expiresInDays: z.number().int().positive().max(3650).optional(),
});

/** Storefront catalog models owned by the given provider (or all combos). */
async function getCatalogModelsForScope(
  request: Request,
  scope: { provider?: string; comboId?: string }
): Promise<string[]> {
  // Reuse the exact catalog the storefront serves; forward credentials so
  // catalog auth (when enabled) passes on behalf of the admin session.
  const catalogRequest = new Request("http://localhost/v1/models", {
    headers: {
      cookie: request.headers.get("cookie") || "",
      authorization: request.headers.get("authorization") || "",
    },
  });
  const catalogResponse = await getUnifiedModelsResponse(catalogRequest);
  if (!catalogResponse.ok) return [];
  const data = (await catalogResponse.json()) as {
    data?: Array<{ id?: string; owned_by?: string }>;
  };
  const entries = Array.isArray(data.data) ? data.data : [];
  if (scope.comboId) {
    return entries
      .filter((m) => m.owned_by === "combo" && typeof m.id === "string" && m.id === scope.comboId)
      .map((m) => m.id as string);
  }
  return entries
    .filter((m) => m.owned_by === scope.provider && typeof m.id === "string")
    .map((m) => m.id as string);
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  const parsed = issueSchema.safeParse(rawBody);
  if (!parsed.success) {
    return marketplaceError(400, parsed.error.issues[0]?.message || "Invalid prepaid key payload");
  }

  const { name, models, provider, comboId, tokens, expiresInDays } = parsed.data;

  // Provider/combo scope: the allowed models come from the storefront catalog —
  // either the whole scope (no explicit models) or the owner-picked subset.
  let allowedModels = models;
  if (provider || comboId) {
    const scopeModels = await getCatalogModelsForScope(request, { provider, comboId });
    if (scopeModels.length === 0) {
      return marketplaceError(
        400,
        provider
          ? `No storefront models found for provider "${provider}"`
          : "No storefront model found for the selected combo"
      );
    }
    if (models && models.length > 0) {
      const scopeSet = new Set(scopeModels);
      const outOfScope = models.filter((m) => !scopeSet.has(m));
      if (outOfScope.length > 0) {
        return marketplaceError(
          400,
          `Models not available in the selected scope: ${outOfScope.join(", ")}`
        );
      }
      allowedModels = models;
    } else {
      allowedModels = scopeModels;
    }
  }
  if (!allowedModels || allowedModels.length === 0) {
    return marketplaceError(400, "Select a provider or combo, or provide a model list");
  }

  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  // Prepaid-token key: no USD balance, no owning user — usable by anyone
  // holding the raw key until the budget or the validity window runs out.
  const { buyerKey, apiKey } = createMarketplaceBuyerKey({
    name,
    allowedModels,
    tokenBudgetTotal: tokens,
    expiresAt,
    userId: null,
    balanceMicroUsd: 0,
  });

  // The raw key is returned exactly once, at issuance.
  return marketplaceJson(
    {
      id: buyerKey.id,
      name: buyerKey.name,
      apiKey,
      keyPrefix: buyerKey.keyPrefix,
      allowedModels: buyerKey.allowedModels,
      tokens: { total: buyerKey.tokenBudgetTotal, remaining: buyerKey.tokenBudgetTotal },
      expiresAt: buyerKey.expiresAt,
      shareUrl: `/check`,
    },
    { status: 201 }
  );
}
