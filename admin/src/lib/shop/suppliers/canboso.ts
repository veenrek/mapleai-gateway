/**
 * Canboso Telegram Buyer API (canboso.com) — port of the tgshop bot adapter.
 * Auth: header `X-API-Key` (tgb_...). Currency: USD.
 * Only instant ("account") products are exposed.
 */
import type { SupplierClient, SupplierItem, SupplierPurchaseResult } from "./types";

const API = () =>
  (process.env.CANBOSO_API_URL ?? "https://canboso.com/api/v2/telegram-buyer").replace(/\/+$/, "");
const KEY = () => process.env.CANBOSO_API_TOKEN?.trim() || null;

async function req(path: string, opts: RequestInit = {}, idempotencyKey: string | null = null) {
  const res = await fetch(`${API()}${path}`, {
    ...opts,
    headers: {
      "X-API-Key": KEY() ?? "",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || json?.success === false) {
    const msg = (json?.message as string) ?? `Canboso HTTP ${res.status}`;
    throw new Error(/insufficient/i.test(msg) ? "Canboso: недостаточно средств" : msg);
  }
  return json;
}

export const canboso: SupplierClient = {
  name: "canboso",
  label: "Canboso",
  enabled: () => Boolean(KEY()),

  async getBalance() {
    const b = (await req("/balance")) as Record<string, unknown>;
    return { balanceUsd: Number(b?.balanceUsd ?? b?.balance ?? 0) };
  },

  async getCatalog() {
    const data = (await req("/products")) as Record<string, unknown>;
    const products = (Array.isArray(data?.products) ? data.products : []).filter(
      (p: Record<string, unknown>) => p.productType === "account"
    );
    const items: SupplierItem[] = products.map((p: Record<string, unknown>) => ({
      id: String(p.productId),
      name: String(p.name ?? "Товар Canboso"),
      priceUsd: Number((p.price as Record<string, unknown>)?.amount ?? 0) || null,
      stock: ((p.availability as Record<string, unknown>)?.available as number) ?? null,
    }));
    return { items };
  },

  async purchase({ itemId, idempotencyKey }) {
    return (await req(
      "/purchase",
      {
        method: "POST",
        body: JSON.stringify({ product_id: String(itemId), quantity: 1 }),
      },
      idempotencyKey
    )) as SupplierPurchaseResult;
  },

  extractDelivery(payload) {
    const parts: string[] = [];
    const scan = (x: unknown, depth = 0): void => {
      if (x == null || depth > 4) return;
      if (Array.isArray(x)) return x.forEach((i) => scan(i, depth));
      if (typeof x === "object") {
        const o = x as Record<string, unknown>;
        for (const k of [
          "items",
          "positions",
          "lines",
          "credentials",
          "user",
          "login",
          "email",
          "account",
          "password",
          "pass",
          "code",
          "codes",
          "data",
          "value",
          "text",
          "content",
          "item",
          "line",
          "link",
          "url",
          "key",
        ]) {
          if (o[k] != null) scan(o[k], depth + 1);
        }
        return;
      }
      const s = String(x).trim();
      if (s) parts.push(s);
    };
    const p = payload as Record<string, unknown> | null;
    const src = Array.isArray(p?.items)
      ? p.items
      : p?.order && typeof p.order === "object"
        ? p.order
        : p;
    scan(src);
    return [...new Set(parts)].join("\n").slice(0, 2000) || null;
  },
};
