/**
 * RoboticVN API v2 (api.roboticvn.com) — port of the tgshop bot adapter.
 * Auth: header `x-api-key`. Currencies: USD / VND.
 */
import type { SupplierClient, SupplierItem, SupplierPurchaseResult } from "./types";

const API = () =>
  (process.env.ROBOTIC_API_URL ?? "https://api.roboticvn.com/api/v2").replace(/\/+$/, "");
const KEY = () => process.env.ROBOTIC_API_KEY?.trim() || null;

async function req(path: string, opts: { method?: string; body?: unknown } = {}) {
  if (!KEY()) throw new Error("ROBOTIC_API_KEY not set");
  const res = await fetch(`${API()}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "x-api-key": KEY()!,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const err = data?.error as { message?: string } | undefined;
    const msg = err?.message ?? (data?.message as string) ?? `RoboticVN HTTP ${res.status}`;
    throw new Error(String(msg).slice(0, 200));
  }
  return data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function collectDelivered(payload: unknown): Record<string, unknown>[] {
  const p = payload as Record<string, unknown> | null;
  const a = (p?.delivered_accounts ?? []) as Record<string, unknown>[];
  const b = (p?.deliveredAccount ?? []) as Record<string, unknown>[];
  return [...a, ...b].filter((x) => x && (x.account || x.additional_info || x.password));
}

export const robotic: SupplierClient = {
  name: "robotic",
  label: "RoboticVN",
  enabled: () => Boolean(KEY()),

  async getBalance() {
    const r = await req("/wallet/balance?locale=en");
    const d = (r?.data ?? r ?? {}) as Record<string, unknown>;
    let usd = 0;
    if (Array.isArray(d)) {
      const u = (d as Record<string, unknown>[]).find((b) =>
        /usd/i.test(String(b?.currency_code ?? b?.currency ?? ""))
      );
      usd = Number(u?.balance ?? u?.amount ?? u?.total ?? 0);
    } else {
      usd = Number(d.usd ?? 0);
    }
    return { balanceUsd: usd };
  },

  async getCatalog() {
    const summaries: Record<string, unknown>[] = [];
    for (let offset = 0; offset < 500; offset += 100) {
      const page = await req(`/products?limit=100&offset=${offset}`);
      const rows = (page?.data ?? []) as Record<string, unknown>[];
      summaries.push(...rows);
      if (rows.length < 100) break;
    }
    const items: SupplierItem[] = [];
    for (const s of summaries) {
      try {
        const d = await req(`/products/${s.id}`);
        const p = (d?.data ?? d ?? {}) as Record<string, unknown>;
        for (const v of (p.variants ?? []) as Record<string, unknown>[]) {
          const prices = (v.prices ?? {}) as Record<string, unknown>;
          items.push({
            id: String(v.id),
            name: `${p.title ?? s.title} — ${v.title}`.slice(0, 100),
            priceUsd: Number(prices.usd ?? prices.USD ?? 0) || null,
            stock: (v.available_quantity as number) ?? null,
            inStock: (v.in_stock as boolean) ?? true,
          });
        }
      } catch (e) {
        console.error(`RoboticVN product ${s.id}:`, (e as Error).message);
      }
    }
    return { items };
  },

  async purchase({ itemId }) {
    const r = await req("/orders", {
      method: "POST",
      body: {
        items: [{ variant_id: String(itemId), quantity: 1 }],
        currency_code: "usd",
        payment_method: "wallet",
      },
    });
    const order = (r?.data ?? r ?? {}) as Record<string, unknown>;
    const orderId = order.order_id ?? order.id;
    if (!orderId) throw new Error("RoboticVN не вернул order_id");

    // Digital goods are usually delivered instantly; poll briefly.
    for (let i = 0; i < 8; i++) {
      await sleep(1500);
      const d = (await req(`/orders/${orderId}/delivery?locale=en`).catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (collectDelivered(d).length) {
        return { id: orderId as string | number, delivery: collectDelivered(d), raw: d };
      }
    }
    throw new Error(`RoboticVN заказ ${String(orderId)}: списано, но выдача задерживается`);
  },

  extractDelivery(payload) {
    const p = payload as Record<string, unknown> | null;
    const rows = (p?.delivery as Record<string, unknown>[] | undefined) ?? collectDelivered(p);
    if (!rows.length) return null;
    return rows
      .map((r) => {
        const title = r.display_title ?? r.product_title ?? r.title;
        return [
          title,
          r.account,
          r.password ? `Пароль: ${String(r.password)}` : null,
          r.additional_info,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n")
      .slice(0, 2000);
  },
};
