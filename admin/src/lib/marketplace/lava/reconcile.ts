import { getLavaInvoice } from "./client";
import {
  listPendingLavaPaymentsWithInvoice,
  markLavaPaymentFailed,
  markLavaPaymentPaid,
  type LavaPayment,
} from "@/lib/db/lavaPayments";
import { topUpMarketplaceBuyerKey } from "@/lib/db/marketplace";
import { fulfillLavaProduct, type FulfillResult } from "@/lib/shop/suppliers";

/** Wrapper so a supplier outage never breaks the reconcile loop. */
async function fulfillLavaPaymentSafe(payment: LavaPayment): Promise<FulfillResult> {
  try {
    return await fulfillLavaProduct(payment);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface LavaReconcileResult {
  checked: number;
  paid: number;
  failed: number;
  stillPending: number;
}

/**
 * Poll Lava for a single pending payment and apply the transition.
 * Returns the outcome bucket.
 */
export async function reconcileLavaPayment(
  config: { baseUrl: string; apiKey: string },
  payment: LavaPayment
): Promise<"paid" | "failed" | "pending"> {
  const invoice = await getLavaInvoice(config.baseUrl, config.apiKey, payment.invoiceId!);
  if (!invoice) return "pending"; // transient gateway error — retry next round

  const status = String(invoice.status ?? "").toLowerCase();

  if (status === "completed" || status === "paid" || status === "success") {
    // markLavaPaymentPaid is atomic: only the first pending→paid transition
    // returns true, so crediting happens exactly once per invoice.
    if (markLavaPaymentPaid(payment.orderId)) {
      // buyerKeyId === null → product sale: auto-fulfill via suppliers
      if (!payment.buyerKeyId) {
        try {
          const r = await fulfillLavaPaymentSafe(payment);
          if (!r.ok) console.error(`[lava] fulfill failed for ${payment.orderId}:`, r.error);
        } catch (e) {
          console.error(`[lava] fulfill crashed for ${payment.orderId}:`, (e as Error).message);
        }
        return "paid";
      }
      try {
        topUpMarketplaceBuyerKey(payment.buyerKeyId!, payment.amountMicroUsd, {
          source: "lava",
          orderId: payment.orderId,
          invoiceId: payment.invoiceId,
          gatewayAmount: invoice.amount,
          gatewayStatus: invoice.status,
        });
      } catch (error) {
        console.error(`[lava] credit failed for order ${payment.orderId}:`, error);
        // Payment stays marked paid; logged for manual resolution rather than
        // risking a double-credit on the next poll.
      }
    }
    return "paid";
  }

  if (status === "cancelled" || status === "canceled" || status === "expired") {
    markLavaPaymentFailed(payment.orderId, status === "expired" ? "expired" : "failed");
    return "failed";
  }

  return "pending"; // "new" / awaiting payment
}

/** Reconcile all pending payments that already carry a lava invoice id. */
export async function reconcileAllPendingLavaPayments(config: {
  baseUrl: string;
  apiKey: string;
}): Promise<LavaReconcileResult> {
  const pending = listPendingLavaPaymentsWithInvoice(100);
  const result: LavaReconcileResult = {
    checked: pending.length,
    paid: 0,
    failed: 0,
    stillPending: 0,
  };

  for (const payment of pending) {
    const outcome = await reconcileLavaPayment(config, payment);
    if (outcome === "paid") result.paid += 1;
    else if (outcome === "failed") result.failed += 1;
    else result.stillPending += 1;
  }

  return result;
}
