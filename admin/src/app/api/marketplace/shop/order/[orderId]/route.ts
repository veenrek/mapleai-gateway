import { z } from "zod";
import { getLavaPaymentByOrderId } from "@/lib/db/lavaPayments";
import { getLavaConfig } from "@/lib/marketplace/lava/config";
import { reconcileLavaPayment } from "@/lib/marketplace/lava/reconcile";

const Params = z.object({ orderId: z.string().min(8).max(100) });

/**
 * GET /api/marketplace/shop/order/{orderId} — PUBLIC order status for buyers.
 * The orderId is an unguessable UUID-style token (acts as the access secret).
 * Returns delivery text only when the payment is paid AND fulfilled.
 *
 * Lazily re-checks the Lava invoice on each poll, so a buyer landing here
 * after payment sees the code as soon as Lava confirms — no cron needed.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  const { orderId } = Params.parse(await ctx.params);
  let p = getLavaPaymentByOrderId(orderId);
  if (!p) {
    return Response.json({ error: { message: "Order not found" } }, { status: 404 });
  }

  // lazy reconcile: pull fresh state from Lava when still pending/without delivery
  if ((p.status === "pending" && p.invoiceId) || (p.status === "paid" && !p.deliveryText)) {
    const config = getLavaConfig();
    if (config.enabled) {
      try {
        await reconcileLavaPayment({ baseUrl: config.baseUrl, apiKey: config.apiKey! }, p);
        p = getLavaPaymentByOrderId(orderId) ?? p;
      } catch {
        /* keep last known state */
      }
    }
  }

  return Response.json({
    orderId: p.orderId,
    status: p.status, // pending | paid | failed | expired
    paidAt: p.paidAt,
    fulfilled: Boolean(p.deliveryText),
    delivery: p.status === "paid" && p.deliveryText ? p.deliveryText : null,
    supplier: p.supplierName,
  });
}
