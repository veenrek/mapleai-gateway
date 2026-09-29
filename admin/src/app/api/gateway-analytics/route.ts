import { readFileSync, existsSync } from "node:fs";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { marketplaceJson } from "@/lib/marketplace/response";

type Gateway = { flag: string; dir: string };

const GATEWAYS: Gateway[] = [
  { flag: "sol", dir: process.env.GATEWAY_SOL_DIR ?? "/opt/claude-api-sol" },
  { flag: "base", dir: process.env.GATEWAY_BASE_DIR ?? "/opt/claude-api-base" },
  { flag: "polygon", dir: process.env.GATEWAY_POLYGON_DIR ?? "/opt/claude-api-polygon" },
  { flag: "arc", dir: process.env.GATEWAY_ARC_DIR ?? "/opt/claude-api-arc" },
];

const OUR_PAYER_HINTS = new Set(
  (process.env.GATEWAY_INTERNAL_PAYERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

interface JsonEvent { [key: string]: unknown }

function readJsonl(path: string): JsonEvent[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: JsonEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
  }
  return out;
}

function dayOf(ts: unknown): string {
  return typeof ts === "string" ? ts.slice(0, 10) : "unknown";
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  interface GatewaySection {
    payments: {
      total: number;
      settled: number;
      revenueUsdc: number;
      today: Record<string, { settled: number; usdc: number; challenges: number } | undefined>;
      recent: Array<Record<string, unknown>>;
    };
    embeddings: { all: number; today: number; todayOk: number; todayProbes: number };
    jev: { loggedCalls: number; today: number };
    freeOss: { total: number; today: number; ok: number; quotaExceeded: number; uniqueIps: number };
  }
  const result: Record<string, GatewaySection> = {};
  const payerAgg = new Map<string, { payer: string; count: number; usdc: number; external: boolean }>();
  const routeAgg = new Map<string, { route: string; count: number; usdc: number }>();
  const dayAgg = new Map<string, { day: string; settled: number; usdc: number; challenges: number }>();
  let totalRevenue = 0;
  let totalSettled = 0;

  for (const gw of GATEWAYS) {
    const payments = readJsonl(`${gw.dir}/payment-events.jsonl`);
    const embeddings = readJsonl(`${gw.dir}/embedding-events.jsonl`);
    const jev = readJsonl(`${gw.dir}/jev-data.jsonl`);
    const freeOss = readJsonl(`${gw.dir}/free-oss-data.jsonl`);

    const byDay = new Map<string, { settled: number; usdc: number; challenges: number }>();
    const gwPaid: Array<Record<string, unknown>> = [];
    let gwRevenue = 0;
    let gwSettled = 0;
    for (const ev of payments) {
      const day = dayOf(ev.ts);
      const daySlot = byDay.get(day) ?? { settled: 0, usdc: 0, challenges: 0 };
      if (ev.kind === "payment_challenge") daySlot.challenges += 1;
      if (ev.kind === "settled") {
        const usdc = Number(ev.amountUsdc ?? 0);
        daySlot.settled += 1;
        daySlot.usdc += usdc;
        gwRevenue += usdc;
        gwSettled += 1;

        const payer = typeof ev.payer === "string" ? ev.payer : "unknown";
        const p = payerAgg.get(payer) ?? { payer, count: 0, usdc: 0, external: !OUR_PAYER_HINTS.has(payer.toLowerCase()) };
        p.count += 1;
        p.usdc += usdc;
        payerAgg.set(payer, p);

        const route = typeof ev.route === "string" ? ev.route : "?";
        const r = routeAgg.get(route) ?? { route, count: 0, usdc: 0 };
        r.count += 1;
        r.usdc += usdc;
        routeAgg.set(route, r);
      }
      byDay.set(day, daySlot);
      gwPaid.push(ev);
    }
    byDay.forEach((slot, day) => {
      const g = dayAgg.get(day) ?? { day, settled: 0, usdc: 0, challenges: 0 };
      dayAgg.set(day, {
        day,
        settled: g.settled + slot.settled,
        usdc: g.usdc + slot.usdc,
        challenges: g.challenges + slot.challenges,
      });
    });
    totalRevenue += gwRevenue;
    totalSettled += gwSettled;

    const today = new Date().toISOString().slice(0, 10);
    const embToday = embeddings.filter((e) => dayOf(e.ts) === today);
    const embOk = embToday.filter((e) => e.status === 200).length;
    const embProbe = embToday.filter((e) => (e.failure as JsonEvent | undefined)?.reason === "missing_input").length;

    const freeIps = new Set(freeOss.map((e) => String(e.clientIp)));
    const freeToday = freeOss.filter((e) => dayOf(e.ts) === today);
    const freeOk = freeOss.filter((e) => e.status === 200).length;
    const freeQuota = freeOss.filter((e) => e.status === 429).length;

    result[gw.flag] = {
      payments: {
        total: payments.length,
        settled: gwSettled,
        revenueUsdc: Number(gwRevenue.toFixed(6)),
        today: Object.fromEntries(byDay.get(today) ? [[today, byDay.get(today)]] : []),
        recent: gwPaid.slice(-5).reverse(),
      },
      embeddings: {
        all: embeddings.length,
        today: embToday.length,
        todayOk: embOk,
        todayProbes: embProbe,
      },
      jev: {
        loggedCalls: jev.length,
        today: jev.filter((e) => dayOf(e.ts) === today).length,
      },
      freeOss: {
        total: freeOss.length,
        today: freeToday.length,
        ok: freeOk,
        quotaExceeded: freeQuota,
        uniqueIps: freeIps.size,
      },
    };
  }

  const days = [...dayAgg.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-14);
  const payers = [...payerAgg.values()].sort((a, b) => b.usdc - a.usdc);
  const routes = [...routeAgg.values()].sort((a, b) => b.usdc - a.usdc);

  return marketplaceJson({
    totals: {
      settled: totalSettled,
      revenueUsdc: Number(totalRevenue.toFixed(6)),
      uniquePayers: payerAgg.size,
      externalPayers: payers.filter((p) => p.external).length,
    },
    byDay: days,
    topPayers: payers.slice(0, 15),
    perRoute: routes,
    gateways: result,
  });
}
