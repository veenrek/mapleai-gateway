import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { setMarketplaceBuyerKeyStatus } from "@/lib/db/marketplace";
import { marketplaceError, marketplaceJson } from "@/lib/marketplace/response";
import { handleCorsOptions } from "@/shared/utils/cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

const patchSchema = z.object({
  // active | paused | disabled
  status: z.enum(["active", "paused", "disabled"]),
});

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return marketplaceError(400, "Invalid JSON body", "invalid_request");
  }
  const parsed = patchSchema.safeParse(rawBody);
  if (!parsed.success) return marketplaceError(400, "Invalid status payload");

  const { id } = await ctx.params;
  try {
    const key = setMarketplaceBuyerKeyStatus(id, parsed.data.status);
    return marketplaceJson({ key });
  } catch (err) {
    if (err && typeof err === "object" && "status" in err) {
      const e = err as { status: number; message: string };
      return marketplaceError(e.status, e.message);
    }
    throw err;
  }
}
