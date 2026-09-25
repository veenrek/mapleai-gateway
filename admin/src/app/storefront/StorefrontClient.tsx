"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import PublicShell from "@/app/PublicShell";

interface Lot {
  id: string;
  publicModel: string;
  seller: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export default function StorefrontClient() {
  const [lots, setLots] = useState<Lot[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((d) => setAuthed(Boolean(d?.authenticated)))
      .catch(() => {});
  }, []);

  const loadCatalog = useCallback(() => {
    setCatalogError(null);
    setLots(null);
    fetch("/api/storefront")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => setLots(Array.isArray(d.lots) ? d.lots : []))
      .catch(() => setCatalogError("Catalog is temporarily unavailable. Try again later."));
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const handleWalletLogin = async () => {
    setWalletLoading(true);
    setWalletError(null);
    try {
      const eth = (
        window as unknown as {
          ethereum?: {
            request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
          };
        }
      ).ethereum;
      if (!eth)
        throw new Error(
          "No EVM wallet detected. Install one (MetaMask, Rabby, Coinbase…) and refresh."
        );

      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const wallet = accounts?.[0];
      if (!wallet) throw new Error("No account returned by wallet");

      const nonceRes = await fetch("/api/auth/wallet/nonce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      if (!nonceRes.ok) {
        const data = await nonceRes.json().catch(() => ({}));
        throw new Error(data?.error?.message || "Wallet login is not available");
      }
      const { nonce, issuedAt, message } = await nonceRes.json();

      const signature = (await eth.request({
        method: "personal_sign",
        params: [message, wallet],
      })) as string;

      const verifyRes = await fetch("/api/auth/wallet/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, signature, nonce, issuedAt }),
      });
      if (!verifyRes.ok) {
        const data = await verifyRes.json().catch(() => ({}));
        throw new Error(data?.error?.message || "Wallet verification failed");
      }

      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : "Wallet login failed");
    } finally {
      setWalletLoading(false);
    }
  };

  const headerActions = authed ? (
    <Link
      href="/dashboard"
      className="rounded-control bg-primary px-3 py-2 text-sm font-medium text-white transition hover:bg-primary-hover"
    >
      Dashboard
    </Link>
  ) : (
    <button
      onClick={handleWalletLogin}
      disabled={walletLoading}
      className="inline-flex items-center gap-2 rounded-control bg-primary px-3 py-2 text-sm font-medium text-white transition hover:bg-primary-hover disabled:opacity-60"
    >
      {walletLoading && (
        <svg
          className="h-3.5 w-3.5 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-90"
            fill="currentColor"
            d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
          />
        </svg>
      )}
      {walletLoading ? "Connecting…" : "Owner sign in"}
    </button>
  );

  return (
    <PublicShell actions={headerActions}>
      <div className="space-y-10">
        {/* Hero */}
        <section className="space-y-3">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            AI models, priced per token
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
            Pick a model, get a prepaid API key from the operator, and call it from any
            OpenAI-compatible client. Input and output are priced separately, per million tokens.
          </p>
        </section>

        {walletError && (
          <div className="rounded-card border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-300">
            {walletError}
          </div>
        )}

        {/* Catalog states */}
        {catalogError && (
          <div className="flex flex-col items-start gap-3 rounded-card border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-300">
            <span>{catalogError}</span>
            <button
              onClick={loadCatalog}
              className="rounded-control border border-red-500/40 px-3 py-1.5 text-xs font-medium transition hover:bg-red-500/10"
            >
              Retry
            </button>
          </div>
        )}

        {!catalogError && lots === null && (
          <div className="grid gap-4 md:grid-cols-2" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="animate-pulse rounded-card border border-border bg-surface p-5"
              >
                <div className="h-4 w-2/3 rounded bg-surface-2" />
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="h-16 rounded-control bg-surface-2" />
                  <div className="h-16 rounded-control bg-surface-2" />
                </div>
                <div className="mt-4 h-3 w-1/3 rounded bg-surface-2" />
              </div>
            ))}
          </div>
        )}

        {!catalogError && lots !== null && lots.length === 0 && (
          <div className="rounded-card border border-dashed border-border bg-surface p-10 text-center">
            <p className="text-sm font-medium text-text-main">No models listed yet</p>
            <p className="mt-1 text-sm text-text-muted">
              New offers appear here as soon as sellers publish them — check back soon.
            </p>
          </div>
        )}

        {/* Lots grid */}
        {!catalogError && lots !== null && lots.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2">
            {lots.map((lot) => (
              <article
                key={lot.id}
                className="rounded-card border border-border bg-surface p-5 transition-colors hover:border-text-muted/40"
              >
                <div className="flex items-start justify-between gap-3">
                  <code className="break-all font-mono text-sm font-semibold text-text-main">
                    {lot.publicModel}
                  </code>
                  <span className="shrink-0 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                    available
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-control bg-surface-2 p-3">
                    <div className="text-xs text-text-muted">Input</div>
                    <div className="mt-0.5 font-semibold">
                      ${lot.inputUsdPerMillionTokens.toFixed(2)}
                    </div>
                    <div className="text-[10px] text-text-muted">per 1M tokens</div>
                  </div>
                  <div className="rounded-control bg-surface-2 p-3">
                    <div className="text-xs text-text-muted">Output</div>
                    <div className="mt-0.5 font-semibold">
                      ${lot.outputUsdPerMillionTokens.toFixed(2)}
                    </div>
                    <div className="text-[10px] text-text-muted">per 1M tokens</div>
                  </div>
                </div>
                <div className="mt-4 text-xs text-text-muted">Seller: {lot.seller}</div>
              </article>
            ))}
          </div>
        )}

        {/* How to buy */}
        <section className="rounded-card border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold">How to buy</h2>
          <ol className="mt-3 space-y-2.5 text-sm text-text-muted">
            {[
              "Contact the operator to get a prepaid API key for your model.",
              "Point your OpenAI-compatible client at this deployment with the key.",
              "Track your remaining balance on the key checker at any time.",
            ].map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-text-main">
                  {i + 1}
                </span>
                <span className="leading-relaxed">
                  {i === 2 ? (
                    <>
                      Track your remaining balance on{" "}
                      <Link href="/check" className="text-primary hover:underline">
                        the key checker
                      </Link>{" "}
                      at any time.
                    </>
                  ) : (
                    step
                  )}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </PublicShell>
  );
}
