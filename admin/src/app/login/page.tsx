"use client";

import { useState, useEffect } from "react";
import { Button } from "@/shared/components";
import { useRouter } from "next/navigation";

/**
 * Wallet-only login. The management password has been removed from the UI:
 * the platform owner signs a SIWE message with a wallet listed in
 * ADMIN_WALLET_ADDRESSES and receives the same admin session cookie the
 * legacy password flow issued. (The /api/auth/login endpoint still exists as
 * break-glass access but is not reachable from this page.)
 */

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function getEthereum(): Eip1193 | null {
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  return eth ?? null;
}

export default function LoginPage() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [walletLoading, setWalletLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    // Already authenticated → straight to dashboard.
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((d) => {
        if (d?.authenticated) router.replace("/dashboard");
      })
      .catch(() => {});
  }, [router]);

  const handleWalletLogin = async () => {
    setWalletLoading(true);
    setError("");
    try {
      const eth = getEthereum();
      if (!eth) throw new Error("No EVM wallet found. Install MetaMask or a compatible wallet.");

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

      sessionStorage.setItem("omniroute_login_time", String(Date.now()));
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet login failed");
    } finally {
      setWalletLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-text-main">MapleAI</h1>
          <p className="text-sm text-text-muted">
            Sign in with the owner wallet to manage the platform.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-6 space-y-4">
          <Button
            variant="primary"
            className="w-full h-11 text-sm font-medium"
            loading={loading}
            onClick={handleWalletLogin}
            disabled={loading}
          >
            Sign in with wallet
          </Button>

          {error && (
            <p className="text-sm text-red-500 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-base">error</span>
              {error}
            </p>
          )}

          <p className="text-xs text-text-muted/60 leading-relaxed">
            Requires a wallet on the server&apos;s{" "}
            <code className="font-mono">ADMIN_WALLET_ADDRESSES</code> allowlist (set in .env). The
            signed message is free — no transaction, no gas.
          </p>
        </div>
      </div>
    </div>
  );
}
