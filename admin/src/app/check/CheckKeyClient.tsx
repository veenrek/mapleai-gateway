"use client";

import { useState } from "react";
import PublicShell from "@/app/PublicShell";

interface CheckResult {
  valid: boolean;
  reason?: string | null;
  name?: string;
  keyPrefix?: string;
  allowedModels?: string[];
  tokens?: { total: number; used: number; reserved: number; remaining: number } | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}

const REASON_TEXT: Record<string, string> = {
  not_found: "Key not found — check for typos",
  disabled: "Key has been disabled",
  expired: "Key has expired",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

export default function CheckKeyClient() {
  const [key, setKey] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    const trimmed = key.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/marketplace/check-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.message || `Check failed (HTTP ${res.status})`);
        return;
      }
      setResult((await res.json()) as CheckResult);
    } catch {
      setError("Network error — try again");
    } finally {
      setLoading(false);
    }
  };

  return (
    <PublicShell>
      <div className="mx-auto w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight">API Key Checker</h1>
          <p className="text-sm leading-relaxed text-text-muted">
            Paste your prepaid API key to see its status and remaining balance.
          </p>
        </div>

        <div className="space-y-3 rounded-card border border-border bg-surface p-4">
          <input
            type="password"
            className="w-full rounded-control border border-border bg-bg px-3 py-2 font-mono text-sm text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && check()}
            placeholder="oms_buy_..."
            autoComplete="off"
            autoFocus
          />
          <button
            onClick={check}
            disabled={loading || !key.trim()}
            className="w-full rounded-control bg-primary py-2 text-sm font-medium text-white transition hover:bg-primary-hover disabled:opacity-50"
          >
            {loading ? "Checking..." : "Check key"}
          </button>
        </div>

        {error && (
          <div className="rounded-card border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-300">
            {error}
          </div>
        )}

        {result && (
          <div
            className={`space-y-3 rounded-card border p-4 text-sm ${
              result.valid
                ? "border-green-500/30 bg-green-500/10"
                : "border-red-500/30 bg-red-500/10"
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  result.valid ? "bg-green-500" : "bg-red-500"
                }`}
              />
              <span className="font-semibold">
                {result.valid
                  ? "Key is active"
                  : (REASON_TEXT[result.reason ?? ""] ?? "Key is invalid")}
              </span>
            </div>

            {result.valid && (
              <div className="space-y-2 text-text-main">
                {result.name && (
                  <div className="text-text-muted">
                    Plan: <span className="font-medium text-text-main">{result.name}</span>
                  </div>
                )}
                {result.allowedModels && result.allowedModels.length > 0 && (
                  <div className="text-text-muted">
                    Models:{" "}
                    <span className="font-mono text-xs text-text-main">
                      {result.allowedModels.join(", ")}
                    </span>
                  </div>
                )}
                {result.tokens && (
                  <div>
                    <div className="mb-1 flex justify-between">
                      <span className="text-text-muted">Tokens used</span>
                      <span className="font-mono">
                        {formatTokens(result.tokens.used)} / {formatTokens(result.tokens.total)}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{
                          width: `${
                            result.tokens.total > 0
                              ? Math.min(
                                  100,
                                  ((result.tokens.used + result.tokens.reserved) /
                                    result.tokens.total) *
                                    100
                                )
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                    <div className="mt-1 text-right font-mono text-xs text-text-muted">
                      {formatTokens(result.tokens.remaining)} remaining
                    </div>
                  </div>
                )}
                {result.expiresAt && (
                  <div className="text-text-muted">
                    Valid until:{" "}
                    <span className="text-text-main">{result.expiresAt.slice(0, 10)}</span>
                  </div>
                )}
                {result.lastUsedAt && (
                  <div className="text-xs text-text-muted">
                    Last used: {result.lastUsedAt.slice(0, 19).replace("T", " ")} UTC
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <a
          href="/connect"
          className="flex items-center justify-between rounded-card border border-border bg-surface p-3 text-sm text-text-muted transition-colors hover:bg-surface-2"
        >
          <span>How to connect your key (Codex, OpenCode, VS Code, Hermes)</span>
          <span aria-hidden="true">→</span>
        </a>

        <p className="text-center text-xs leading-relaxed text-text-muted">
          The key is checked directly against the platform database and is never stored by this
          page.
        </p>
      </div>
    </PublicShell>
  );
}
