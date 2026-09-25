/**
 * Aethel Store Seller API — port of the tgshop bot adapter (src/supplier.js).
 * Auth: header `X-API-Key`. Idempotent purchases via `Idempotency-Key`.
 */
import type { SupplierClient, SupplierItem, SupplierPurchaseResult } from "./types";

const API = () =>
  (process.env.AETHEL_API_URL ?? "https://mail-api.hvmforum.space/api").replace(/\/+$/, "");
const KEY = () => process.env.AETHEL_API_KEY?.trim() || null;

const ERRORS: Record<number, string> = {
  400: "Aethel: неверный запрос",
  401: "Aethel: ключ отклонён",
  402: "Aethel: недостаточно средств на балансе",
  404: "Aethel: товар или покупка не найдены",
  409: "Aethel: нет остатка либо конфликт идемпотентности",
  429: "Aethel: слишком много запросов",
};

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
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const j = json as Record<string, unknown> | null;
    throw new Error(
      ERRORS[res.status] ?? String(j?.error ?? j?.message ?? `Aethel HTTP ${res.status}`)
    );
  }
  return json;
}

export const aethel: SupplierClient = {
  name: "aethel",
  label: "Aethel Store",
  enabled: () => Boolean(KEY()),

  async getBalance() {
    const b = (await req("/v1/balance")) as Record<string, unknown>;
    return { balanceUsd: Number(b?.balance_usd ?? b?.balance ?? 0) };
  },

  async getCatalog() {
    const catalog = await req("/v1/catalog");
    // Flatten any catalog shape: {items:[...]} or {categories:[{items:[...]}]}
    const out: SupplierItem[] = [];
    const visit = (node: unknown, catName = "", depth = 0): void => {
      if (node == null || depth > 4) return;
      if (Array.isArray(node)) return node.forEach((n) => visit(n, catName, depth));
      if (typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      const id = o.item_id ?? o.id ?? o.productId;
      const price = o.price_usd ?? o.priceUsd ?? o.price;
      const name = o.name ?? o.title;
      if (id != null && price != null && name) {
        out.push({
          id: String(id),
          name: String(name),
          priceUsd: Number(price),
          stock: (o.stock ?? o.quantity ?? o.available ?? o.available_quantity ?? null) as
            | number
            | null,
          description: (o.description ?? null) as string | null,
        });
        return;
      }
      const nextCat = String(o.category_name ?? o.name ?? o.title ?? catName);
      for (const k of ["categories", "items", "products", "goods", "children"]) {
        if (Array.isArray(o[k])) visit(o[k], k === "categories" ? catName : nextCat, depth + 1);
      }
    };
    visit(catalog);
    const seen = new Set<string>();
    return { items: out.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true))) };
  },

  async purchase({ itemId, idempotencyKey }) {
    const r = (await req(
      "/v1/purchases",
      { method: "POST", body: JSON.stringify({ item_id: Number(itemId), quantity: 1 }) },
      idempotencyKey
    )) as SupplierPurchaseResult;
    return r;
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
          "code",
          "codes",
          "data",
          "value",
          "credentials",
          "login",
          "password",
          "text",
          "content",
          "item",
          "line",
        ]) {
          if (o[k] != null) scan(o[k], depth + 1);
        }
        return;
      }
      const s = String(x).trim();
      if (s) parts.push(s);
    };
    const p = payload as Record<string, unknown> | null;
    scan(p?.delivery ?? (p?.result as Record<string, unknown> | undefined)?.delivery ?? p);
    return [...new Set(parts)].join("\n").slice(0, 2000) || null;
  },
};
