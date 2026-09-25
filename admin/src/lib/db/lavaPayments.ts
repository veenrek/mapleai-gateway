/**
 * Lava.top payment records — one row per created invoice.
 * The webhook handler marks rows paid idempotently (UNIQUE order_id +
 * status transition guard). Buyer-key crediting happens exactly once per
 * paid invoice at the transition moment.
 */
import { getDbInstance, rowToCamel } from "./core";

export interface LavaPayment {
  id: number;
  orderId: string;
  invoiceId: string | null;
  buyerKeyId: string | null;
  amountMicroUsd: number;
  currency: string | null;
  status: "pending" | "paid" | "failed" | "expired";
  createdAt: string;
  paidAt: string | null;
  // Product-sale fulfillment (null for buyer-key top-ups)
  offerId: string | null;
  supplierName: string | null;
  supplierItemId: string | null;
  deliveryText: string | null;
  fulfilledAt: string | null;
}

export interface ShopProductSource {
  id: number;
  offerId: string;
  supplier: string;
  supplierItemId: string;
  priority: number;
  active: boolean;
}

export function createLavaPayment(input: {
  orderId: string;
  invoiceId?: string | null;
  /** null = direct product sale (no buyer key to credit). */
  buyerKeyId: string | null;
  amountMicroUsd: number;
  currency?: string | null;
  /** Lava offer id for product sales (used at fulfillment). */
  offerId?: string | null;
}): LavaPayment {
  const db = getDbInstance();
  db.prepare(
    `INSERT INTO lava_payments (order_id, invoice_id, buyer_key_id, amount_micro_usd, currency, offer_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    input.orderId,
    input.invoiceId ?? null,
    input.buyerKeyId,
    Math.round(input.amountMicroUsd),
    input.currency ?? null,
    input.offerId ?? null
  );
  return getLavaPaymentByOrderId(input.orderId)!;
}

export function getLavaPaymentByOrderId(orderId: string): LavaPayment | null {
  const row = getDbInstance()
    .prepare("SELECT * FROM lava_payments WHERE order_id = ?")
    .get(orderId);
  return row ? (rowToCamel(row) as unknown as LavaPayment) : null;
}

export function getLavaPaymentByInvoiceId(invoiceId: string): LavaPayment | null {
  const row = getDbInstance()
    .prepare("SELECT * FROM lava_payments WHERE invoice_id = ?")
    .get(invoiceId);
  return row ? (rowToCamel(row) as unknown as LavaPayment) : null;
}

/** Pending payments that already have a lava invoice id (candidates for polling). */
export function listPendingLavaPaymentsWithInvoice(limit = 100): LavaPayment[] {
  const rows = getDbInstance()
    .prepare(
      "SELECT * FROM lava_payments WHERE status = 'pending' AND invoice_id IS NOT NULL ORDER BY id ASC LIMIT ?"
    )
    .all(Math.max(1, Math.min(limit, 1000))) as Record<string, unknown>[];
  return rows.map((r) => rowToCamel(r) as unknown as LavaPayment);
}

export function attachInvoiceId(orderId: string, invoiceId: string): void {
  getDbInstance()
    .prepare("UPDATE lava_payments SET invoice_id = ? WHERE order_id = ?")
    .run(invoiceId, orderId);
}

/**
 * Transition a payment to `paid`. Returns true only when THIS call performed
 * the transition (first successful webhook) — callers must credit the buyer
 * key exactly when this returns true, keeping crediting idempotent even if
 * the webhook is delivered more than once.
 */
export function markLavaPaymentPaid(orderId: string): boolean {
  const res = getDbInstance()
    .prepare(
      "UPDATE lava_payments SET status = 'paid', paid_at = datetime('now') WHERE order_id = ? AND status = 'pending'"
    )
    .run(orderId);
  return res.changes === 1;
}

export function markLavaPaymentFailed(orderId: string, failed: "failed" | "expired"): void {
  getDbInstance()
    .prepare("UPDATE lava_payments SET status = ? WHERE order_id = ? AND status = 'pending'")
    .run(failed, orderId);
}

export function listLavaPayments(limit = 100): LavaPayment[] {
  const rows = getDbInstance()
    .prepare("SELECT * FROM lava_payments ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.min(limit, 1000))) as Record<string, unknown>[];
  return rows.map((r) => rowToCamel(r) as unknown as LavaPayment);
}

/** Persist fulfillment result for a product sale. */
export function setLavaPaymentFulfillment(
  orderId: string,
  f: { supplierName: string; supplierItemId: string; deliveryText: string }
): void {
  getDbInstance()
    .prepare(
      `UPDATE lava_payments
       SET supplier_name = ?, supplier_item_id = ?, delivery_text = ?, fulfilled_at = datetime('now')
       WHERE order_id = ?`
    )
    .run(f.supplierName, f.supplierItemId, f.deliveryText, orderId);
}

/* ─── Shop product sources ─── */

export function getShopSources(offerId: string): ShopProductSource[] {
  const rows = getDbInstance()
    .prepare(
      `SELECT * FROM shop_product_sources WHERE offer_id = ? AND active = 1 ORDER BY priority ASC`
    )
    .all(offerId) as Record<string, unknown>[];
  return rows.map((r) => rowToCamel(r) as unknown as ShopProductSource);
}

export function listShopSources(): ShopProductSource[] {
  const rows = getDbInstance()
    .prepare(`SELECT * FROM shop_product_sources ORDER BY offer_id, priority ASC`)
    .all() as Record<string, unknown>[];
  return rows.map((r) => rowToCamel(r) as unknown as ShopProductSource);
}

export function addShopSource(input: {
  offerId: string;
  supplier: string;
  supplierItemId: string;
  priority?: number;
}): void {
  getDbInstance()
    .prepare(
      `INSERT INTO shop_product_sources (offer_id, supplier, supplier_item_id, priority)
       VALUES (?, ?, ?, ?)`
    )
    .run(input.offerId, input.supplier, input.supplierItemId, input.priority ?? 100);
}

export function removeShopSource(id: number): boolean {
  const res = getDbInstance().prepare(`DELETE FROM shop_product_sources WHERE id = ?`).run(id);
  return res.changes === 1;
}
