import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { addShopSource, listShopSources, removeShopSource } from "@/lib/db/lavaPayments";
import { enabledSuppliers } from "@/lib/shop/suppliers";

/**
 * GET  /api/marketplace/shop/sources (management) — offer → supplier item mapping.
 * POST — add a source { offerId, supplier, supplierItemId, priority? }
 * DELETE — remove by { id }
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const suppliers = [];
  for (const s of enabledSuppliers()) {
    try {
      const bal = await s.getBalance();
      suppliers.push({ name: s.name, label: s.label, balanceUsd: bal.balanceUsd });
    } catch (e) {
      suppliers.push({ name: s.name, label: s.label, error: (e as Error).message });
    }
  }

  return Response.json({ sources: listShopSources(), suppliers });
}

const POST_SCHEMA = z.object({
  offerId: z.string().min(1),
  supplier: z.enum(["aethel", "canboso", "qcst", "robotic"]),
  supplierItemId: z.string().min(1),
  priority: z.number().int().min(0).max(9999).optional(),
});

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const body = POST_SCHEMA.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json(
      { error: { message: "Invalid body", issues: body.error.issues } },
      { status: 400 }
    );
  }
  addShopSource(body.data);
  return Response.json({ ok: true }, { status: 201 });
}

export async function DELETE(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = z.object({ id: z.number().int() }).parse(await request.json());
  if (!removeShopSource(id)) {
    return Response.json({ error: { message: "Not found" } }, { status: 404 });
  }
  return Response.json({ ok: true });
}
