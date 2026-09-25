import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getSellerRegistrationMode, setSellerRegistrationMode } from "@/lib/db/marketplace";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return marketplaceJson({
    sellerRegistrationMode: getSellerRegistrationMode(),
  });
}

const patchSchema = z.object({
  sellerRegistrationMode: z.enum(["closed", "open"]),
});

export async function PATCH(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }

  const parsed = patchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return marketplaceError(400, parsed.error.issues[0]?.message || "Invalid settings payload");
  }

  setSellerRegistrationMode(parsed.data.sellerRegistrationMode);
  return marketplaceJson({
    sellerRegistrationMode: getSellerRegistrationMode(),
  });
}
