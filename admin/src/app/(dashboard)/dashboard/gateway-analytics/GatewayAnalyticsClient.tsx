"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

type Totals = { settled: number; revenueUsdc: number; uniquePayers: number; externalPayers: number };
type DayRow = { day: string; settled: number; usdc: number; challenges: number };
type PayerRow = { payer: string; count: number; usdc: number; external: boolean };
type RouteRow = { route: string; count: number; usdc: number };
type GatewaySection = {
  payments: { total: number; settled: number; revenueUsdc: number; today: Record<string, { settled: number; usdc: number; challenges: number }>; recent: Array<Record<string, unknown>> };
  embeddings: { all: number; today: number; todayOk: number; todayProbes: number };
  jev: { loggedCalls: number; today: number };
  freeOss: { total: number; today: number; ok: number; quotaExceeded: number; uniqueIps: number };
};
type Payload = { totals: Totals; byDay: DayRow[]; topPayers: PayerRow[]; perRoute: RouteRow[]; gateways: Record<string, GatewaySection> };

function usd(n: number): string { return `$${n.toFixed(4)}`; }
function shortAddr(a: string): string { return a.length > 14 ? a.slice(0, 8) + "…" + a.slice(-4) : a; }

export default function GatewayAnalyticsClient() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway-analytics", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as Payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading && !data) return <p className="p-6 text-sm opacity-60">loading…</p>;
  if (error && !data) return <p className="p-6 text-sm text-red-400">{error}</p>;
  if (!data) return null;

  const { totals, byDay, topPayers, perRoute, gateways } = data;
  const today = new Date().toISOString().slice(0, 10);
  const todayRow = byDay.find((d) => d.day === today);

  return (
    <div className="p-6 space-y-8 max-w-6xl">
      <h1 className="text-xl font-semibold">Gateway analytics (x402)</h1>
      <p className="text-sm opacity-60">Reads payment-events / embeddings / jev / free-oss logs from the four VDS gateways. Auto-refresh 60s.</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card label="Revenue all-time" value={usd(totals.revenueUsdc)} />
        <Card label="Settled payments" value={String(totals.settled)} />
        <Card label="Unique payers" value={String(totals.uniquePayers)} />
        <Card label="External payers" value={String(totals.externalPayers)} />
        <Card label="Today settled" value={String(todayRow?.settled ?? 0)} />
        <Card label="Today revenue" value={usd(todayRow?.usdc ?? 0)} />
        <Card label="Today challenges" value={String(todayRow?.challenges ?? 0)} />
        <Card label="Jev logged (all)" value={String(Object.values(gateways).reduce((n, g) => n + g.jev.loggedCalls, 0))} />
      </div>

      <section>
        <h2 className="text-lg font-medium mb-2">Last 14 days</h2>
        <Table
          head={["day", "settled", "revenue", "challenges"]}
          rows={byDay.slice().reverse().map((d) => [d.day, String(d.settled), usd(d.usdc), String(d.challenges)])}
        />
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">Revenue by route</h2>
        <Table
          head={["route", "calls", "revenue"]}
          rows={perRoute.map((r) => [r.route, String(r.count), usd(r.usdc)])}
        />
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">Top payers</h2>
        <Table
          head={["payer", "type", "calls", "revenue"]}
          rows={topPayers.map((p) => [
            <code key={p.payer} className="text-xs" title={p.payer}>{shortAddr(p.payer)}</code>,
            p.external ? "external" : "internal",
            String(p.count),
            usd(p.usdc),
          ])}
        />
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">Per gateway (today)</h2>
        <Table
          head={["gw", "settled Σ", "revenue Σ", "emb today", "emb ok", "emb probes", "jev Σ", "oss today", "oss ok", "oss quota", "oss IPs"]}
          rows={Object.entries(gateways).map(([flag, g]) => [
            flag,
            String(g.payments.settled),
            usd(g.payments.revenueUsdc),
            String(g.embeddings.today),
            String(g.embeddings.todayOk),
            String(g.embeddings.todayProbes),
            String(g.jev.loggedCalls),
            String(g.freeOss.today),
            String(g.freeOss.ok),
            String(g.freeOss.quotaExceeded),
            String(g.freeOss.uniqueIps),
          ])}
        />
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">Recent payment events (last 5 per gateway)</h2>
        {Object.entries(gateways).map(([flag, g]) => (
          <details key={flag} className="mb-3">
            <summary className="cursor-pointer text-sm opacity-80">{flag} · settled {g.payments.settled} · {usd(g.payments.revenueUsdc)}</summary>
            <Table
              head={["ts", "kind", "route", "status", "payer", "usdc"]}
              rows={g.payments.recent.map((e) => [
                String(e.ts ?? "").slice(0, 19),
                String(e.kind ?? ""),
                String(e.route ?? ""),
                String(e.httpStatus ?? ""),
                <code key={String(e.id)} className="text-xs">{shortAddr(String(e.payer ?? ""))}</code>,
                usd(Number(e.amountUsdc ?? 0)),
              ])}
            />
          </details>
        ))}
      </section>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 p-3">
      <div className="text-xs opacity-60">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | ReactNode)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm border-collapse">
        <thead>
          <tr>{head.map((h) => <th key={h} className="text-left py-1 pr-4 font-medium opacity-70">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-white/5">
              {r.map((c, j) => <td key={j} className="py-1 pr-4 align-top">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
