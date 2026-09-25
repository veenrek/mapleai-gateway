"use client";

import { useCallback, useEffect, useState } from "react";

type PlatformUsage = {
  connectionId: string;
  provider: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
  total: number;
  usdEstimate: number | null;
};

type PrepaidKey = {
  id: string;
  name: string;
  keyPrefix: string;
  apiKey?: string | null;
  status: string;
  allowedModels: string[];
  tokenBudgetTotal: number | null;
  tokensUsed: number;
  tokensReserved: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  usageStats?: {
    platforms: PlatformUsage[];
    usdEstimateTotal: number;
  };
};

function m(n: number): string {
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export default function PrepaidStatsClient() {
  const [keys, setKeys] = useState<PrepaidKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/marketplace/prepaid-keys", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { keys?: PrepaidKey[] };
      setKeys(Array.isArray(json.keys) ? json.keys : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const setStatus = useCallback(
    async (id: string, status: "active" | "paused" | "disabled") => {
      setBusyId(id);
      try {
        const res = await fetch(`/api/marketplace/prepaid-keys/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(`HTTP ${res.status}: ${t.slice(0, 120)}`);
        }
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
      <header>
        <h1 className="text-xl font-semibold">Prepaid Keys</h1>
        <p className="text-sm text-text-muted">
          Per-key token usage split by upstream platform with estimated upstream cost.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {error}
        </div>
      )}
      {loading && keys.length === 0 && <div className="text-sm text-text-muted">Loading…</div>}
      {!loading && keys.length === 0 && !error && (
        <div className="text-sm text-text-muted">No prepaid keys yet.</div>
      )}

      {keys.map((k) => {
        const total = k.tokenBudgetTotal ?? 0;
        const usedPct = total > 0 ? Math.min(100, (k.tokensUsed / total) * 100) : 0;
        const expired = k.expiresAt ? Date.parse(k.expiresAt) <= Date.now() : false;
        return (
          <div key={k.id} className="rounded-lg border border-border p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{k.name}</span>
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${
                  k.status !== "active" || expired
                    ? "bg-red-500/10 text-red-500"
                    : "bg-green-500/10 text-green-600 dark:text-green-400"
                }`}
              >
                {k.status !== "active" ? k.status : expired ? "expired" : "active"}
              </span>
              <span className="font-mono text-xs text-text-muted">
                {k.apiKey ? (
                  <span className="group cursor-pointer" title="Нажать чтобы скопировать" onClick={() => { void navigator.clipboard.writeText(k.apiKey ?? ""); }}>
                    {k.apiKey}
                  </span>
                ) : (
                  <span title="Ключ выбран без хранения — переизадайте чтобы показывалось">
                    {k.keyPrefix}… (no raw stored)
                  </span>
                )}{" · "}{k.allowedModels.join(", ")}
                {k.expiresAt ? ` · until ${k.expiresAt.slice(0, 10)}` : ""}
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              {k.status !== "paused" && (
                <button
                  type="button"
                  disabled={busyId === k.id}
                  onClick={() => void setStatus(k.id, "paused")}
                  className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600 dark:text-amber-400 transition hover:bg-amber-500/20 disabled:opacity-50"
                >
                  ⏸ Pause
                </button>
              )}
              {k.status !== "disabled" && (
                <button
                  type="button"
                  disabled={busyId === k.id}
                  onClick={() => void setStatus(k.id, "disabled")}
                  className="rounded border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs text-red-500 transition hover:bg-red-500/20 disabled:opacity-50"
                >
                  ⛔ Block
                </button>
              )}
              {k.status !== "active" && (
                <button
                  type="button"
                  disabled={busyId === k.id}
                  onClick={() => void setStatus(k.id, "active")}
                  className="rounded border border-green-500/40 bg-green-500/10 px-2.5 py-1 text-xs text-green-600 dark:text-green-400 transition hover:bg-green-500/20 disabled:opacity-50"
                >
                  ▶ Unlock
                </button>
              )}
            </div>

            <div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                <div className="h-full rounded-full bg-primary" style={{ width: `${usedPct}%` }} />
              </div>
              <div className="mt-1 font-mono text-xs text-text-muted">
                {m(k.tokensUsed)} / {m(total)} tokens used
                {k.tokensReserved > 0 ? ` (+${(k.tokensReserved / 1e6).toFixed(2)}M in flight)` : ""}
                {" · "}
                {m(Math.max(0, total - k.tokensUsed - k.tokensReserved))} remaining
              </div>
            </div>

            {k.usageStats && k.usageStats.platforms.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-text-muted">
                      <th className="py-1 pr-3 font-medium">Upstream platform</th>
                      <th className="py-1 pr-3 font-medium text-right">Requests</th>
                      <th className="py-1 pr-3 font-medium text-right">Input</th>
                      <th className="py-1 pr-3 font-medium text-right">Output</th>
                      <th className="py-1 pr-3 font-medium text-right">Cache read</th>
                      <th className="py-1 pr-3 font-medium text-right">Total tokens</th>
                      <th className="py-1 font-medium text-right">Est. $</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {k.usageStats.platforms.map((p) => (
                      <tr key={p.connectionId} className="border-b border-border/40">
                        <td className="py-1.5 pr-3">{p.provider}</td>
                        <td className="py-1.5 pr-3 text-right">{p.requests}</td>
                        <td className="py-1.5 pr-3 text-right">{m(p.input)}</td>
                        <td className="py-1.5 pr-3 text-right">{m(p.output)}</td>
                        <td className="py-1.5 pr-3 text-right">{m(p.cacheRead)}</td>
                        <td className="py-1.5 pr-3 text-right font-medium">{m(p.total)}</td>
                        <td className="py-1.5 text-right">
                          {p.usdEstimate != null ? `≈ $${p.usdEstimate.toFixed(4)}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-mono text-xs">
                      <td colSpan={6} className="pt-1.5 pr-3 text-right text-text-muted">
                        Estimated upstream cost (calibrated to measured billing)
                      </td>
                      <td className="pt-1.5 text-right font-medium">
                        ≈ ${k.usageStats.usdEstimateTotal.toFixed(4)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
