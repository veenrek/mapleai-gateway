/**
 * Supplier registry for the site shop + fulfillment after Lava payment.
 *
 * Sources for a sold offer are looked up in `shop_product_sources`
 * (offer_id → supplier item ids). After a product invoice is paid we buy
 * exactly one unit from the cheapest in-stock source, idempotently keyed by
 * the Lava order id, and store the delivered text back onto the payment row.
 */
import { aethel } from "./aethel";
import { canboso } from "./canboso";
import { qcst } from "./qcst";
import { robotic } from "./robotic";
import type { SupplierClient, SupplierItem } from "./types";
import { getShopSources, setLavaPaymentFulfillment, type LavaPayment } from "@/lib/db/lavaPayments";

const REGISTRY: Record<string, SupplierClient> = {
  aethel,
  canboso,
  qcst,
  robotic,
};

export function getSupplier(name: string): SupplierClient | null {
  const c = REGISTRY[name];
  return c?.enabled() ? c : null;
}

export function enabledSuppliers(): SupplierClient[] {
  return Object.values(REGISTRY).filter((c) => c.enabled());
}

/** In-memory catalog cache (suppliers are slow; bot uses 60s TTL too). */
const catalogCache = new Map<string, { items: SupplierItem[]; ts: number }>();
const CATALOG_TTL_MS = 60_000;

async function cachedCatalog(s: SupplierClient): Promise<SupplierItem[]> {
  const hit = catalogCache.get(s.name);
  if (hit && Date.now() - hit.ts < CATALOG_TTL_MS) return hit.items;
  const { items } = await s.getCatalog();
  catalogCache.set(s.name, { items, ts: Date.now() });
  return items;
}

export interface FulfillResult {
  ok: boolean;
  supplier?: string;
  priceUsd?: number;
  delivery?: string;
  error?: string;
}

/**
 * Fulfill a paid product sale: pick the cheapest in-stock source for the
 * offer, purchase one unit, persist the delivered text on the payment row.
 * Idempotent: if deliveryText is already set, returns it without re-buying.
 */
export async function fulfillLavaProduct(payment: LavaPayment): Promise<FulfillResult> {
  if (payment.deliveryText) {
    return {
      ok: true,
      supplier: payment.supplierName ?? undefined,
      delivery: payment.deliveryText,
    };
  }
  if (!payment.offerId) return { ok: false, error: "payment has no offerId" };

  const sources = getShopSources(payment.offerId);
  if (!sources.length) return { ok: false, error: "no supplier sources configured for this offer" };

  let lastError = "no source available";
  for (const src of sources) {
    const client = getSupplier(src.supplier);
    if (!client) {
      lastError = `${src.supplier}: отключён`;
      continue;
    }
    try {
      // цена + сток из кэша каталога
      const items = await cachedCatalog(client);
      const item = items.find((i) => String(i.id) === String(src.supplierItemId));
      if (!item) {
        lastError = `${client.label}: товар #${src.supplierItemId} не найден`;
        continue;
      }
      if (item.stock != null && item.stock <= 0) {
        lastError = `${client.label}: нет стока`;
        continue;
      }

      const payload = await client.purchase({
        itemId: String(src.supplierItemId),
        // idempotency: same lava order → same purchase, no double charge
        idempotencyKey: payment.orderId,
      });
      const text = client.extractDelivery(payload);
      if (!text) throw new Error(`${client.label}: в ответе нет данных выдачи`);

      setLavaPaymentFulfillment(payment.orderId, {
        supplierName: client.name,
        supplierItemId: String(src.supplierItemId),
        deliveryText: text,
      });
      return {
        ok: true,
        supplier: client.name,
        priceUsd: item.priceUsd ?? undefined,
        delivery: text,
      };
    } catch (e) {
      lastError = `${client.label}: ${(e as Error).message}`;
      console.error(`[shop] fulfill ${payment.orderId} via ${client.name}:`, (e as Error).message);
    }
  }
  return { ok: false, error: lastError };
}
