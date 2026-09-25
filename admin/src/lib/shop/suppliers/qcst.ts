/**
 * QCST Partner API v1 (api.qcst.tech) — port of the tgshop bot adapter.
 * Auth: header `X-API-Key` (qcst_live_...). Amounts in VND, converted to USD
 * via QCST_VND_PER_USD (default 26500).
 */
import type { SupplierClient, SupplierItem, SupplierPurchaseResult } from "./types";

const API = () => (process.env.QCST_API_URL ?? "https://api.qcst.tech").replace(/\/+$/, "");
const KEY = () => process.env.QCST_API_KEY?.trim() || null;
const VND_PER_USD = () => {
  const n = Number(process.env.QCST_VND_PER_USD ?? 26500);
  return Number.isFinite(n) && n > 0 ? n : 26500;
};
const toUsd = (vnd: number) => vnd / VND_PER_USD();

const ERRORS: Record<number, string> = {
  400: "QCST: неверный запрос",
  401: "QCST: ключ отклонён",
  403: "QCST: доступ запрещён",
  404: "QCST: товар или заказ не найден",
  409: "QCST: нет остатка или дубликат id заказа",
  429: "QCST: слишком много запросов",
};

async function req(method: string, path: string, body: unknown = null) {
  const res = await fetch(`${API()}${path}`, {
    method,
    headers: {
      "X-API-Key": KEY() ?? "",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || json?.success === false) {
    const detail =
      typeof json?.detail === "string"
        ? json.detail
        : ((json?.error_code as string) ?? (json?.title as string) ?? `QCST HTTP ${res.status}`);
    throw new Error(ERRORS[res.status] ?? `QCST: ${detail}`);
  }
  return (json?.data ?? json) as Record<string, unknown> & Record<string, unknown>[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FAILED = new Set(["failed", "cancelled", "canceled", "expired"]);

export const qcst: SupplierClient = {
  name: "qcst",
  label: "QCST",
  enabled: () => Boolean(KEY()),

  async getBalance() {
    const d = (await req("GET", "/v1/balance")) as Record<string, unknown>;
    return { balanceUsd: toUsd(Number(d?.available ?? 0)) };
  },

  async getCatalog() {
    const list = (await req("GET", "/v1/products")) as unknown;
    const rows = (
      Array.isArray(list) ? list : ((list as Record<string, unknown>)?.data ?? [])
    ) as Record<string, unknown>[];
    const items: SupplierItem[] = [];
    for (const p of rows) {
      if (!p?.id) continue;
      items.push({
        id: String(p.id),
        name: String(p.name_en || p.name || p.id),
        priceUsd: toUsd(Number(p.price ?? 0)),
        stock:
          p.stock_quantity == null
            ? String(p.availability).toUpperCase() === "OUT_OF_STOCK"
              ? 0
              : null
            : Number(p.stock_quantity),
        description: (p.description_en ?? p.description ?? null) as string | null,
      });
    }
    return { items };
  },

  async purchase({ itemId, idempotencyKey }): Promise<SupplierPurchaseResult> {
    let order = (await req("POST", "/v1/orders", {
      client_order_id: String(idempotencyKey),
      product_id: String(itemId),
      quantity: 1,
      customer_inputs: [],
      locale: "en",
    })) as Record<string, unknown>;

    const failed = (o: Record<string, unknown>) => FAILED.has(String(o?.status).toLowerCase());
    const failMsg = (o: Record<string, unknown>) => {
      const err = o?.error as Record<string, unknown> | undefined;
      return `QCST заказ ${String(o.status)}: ${String(err?.detail ?? err?.code ?? "без деталей")}`;
    };
    if (failed(order)) throw new Error(failMsg(order));

    const deadline = Date.now() + 120_000;
    while (!order.delivery_available || order.delivery == null) {
      if (Date.now() > deadline) {
        throw new Error(
          `QCST не выдал заказ за 2 мин (id ${String(order?.id)}) — проверьте в кабинете QCST`
        );
      }
      await sleep(3000);
      order = (await req("GET", `/v1/orders/${encodeURIComponent(String(order.id))}`)) as Record<
        string,
        unknown
      >;
      if (failed(order)) throw new Error(failMsg(order));
    }
    return { id: order.id as string | number, ...order };
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
          "username",
          "email",
          "password",
          "link",
          "url",
          "key",
          "license",
          "text",
          "content",
          "account",
        ]) {
          if (o[k] != null) scan(o[k], depth + 1);
        }
        return;
      }
      const s = String(x).trim();
      if (s) parts.push(s);
    };
    scan((payload as Record<string, unknown> | null)?.delivery ?? null);
    return [...new Set(parts)].join("\n").slice(0, 2000) || null;
  },
};
