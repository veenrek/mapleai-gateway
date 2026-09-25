"use client";

import { useState } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";

const FEATURES = [
  "Gemini Pro AI — 18 months of premium access",
  "Antigravity agent coding included",
  "5 TB Google Drive storage",
  "Veo 3 video generation",
  "Nano Banana image model",
];

export default function BuyGeminiClient() {
  const [amount, setAmount] = useState("12.00");
  const [currency, setCurrency] = useState<"USD" | "RUB">("USD");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pay = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/marketplace/payments/lava/product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountUsd: Number(amount),
          currency,
          ...(email ? { email } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message ?? `Error ${res.status}`);
        return;
      }
      if (data.paymentUrl) window.open(data.paymentUrl, "_blank", "noopener");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-6 space-y-6">
      {/* Product hero */}
      <Card className="overflow-hidden">
        <div
          className="flex h-48 items-center justify-center"
          style={{
            background: "linear-gradient(135deg, #4285F4 0%, #9b72cb 50%, #d96570 100%)",
          }}
        >
          {/* Gemini-style mark: 4-point star */}
          <svg
            width="96"
            height="96"
            viewBox="0 0 96 96"
            fill="none"
            role="img"
            aria-label="Gemini Pro AI"
          >
            <path
              d="M48 4c3 18 12 27 30 30 1 .3 1 1.7 0 2C60 39 51 48 48 66c-.3 1-1.7 1-2 0-3-18-12-27-30-30-1-.3-1-1.7 0-2C34 31 43 22 46 4c.3-1 1.7-1 2 0Z"
              fill="white"
            />
            <circle cx="76" cy="20" r="6" fill="white" opacity="0.9" />
          </svg>
        </div>
        <div className="p-6 space-y-4">
          <h1 className="text-2xl font-semibold">Gemini Pro AI — 18 Months</h1>
          <p className="text-sm opacity-80">
            Full Gemini Pro subscription for 18 months. Instant digital delivery — an activation
            link is issued right after payment. Payment is processed by Lava.top secure checkout.
          </p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-2 text-sm">
                <span className="material-symbols-outlined text-green-500" style={{ fontSize: 18 }}>
                  check_circle
                </span>
                {f}
              </li>
            ))}
          </ul>
        </div>
      </Card>

      {/* Payment */}
      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-medium flex items-center gap-2">
          <span className="material-symbols-outlined">payments</span>
          Pay by Card
        </h2>
        <p className="text-xs opacity-70">
          Secure checkout by Lava.top. On the payment page you can choose Card, Apple Pay or Google
          Pay (availability depends on the currency and region).
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-1">
            <span className="text-xs opacity-70">Amount</span>
            <input
              type="number"
              min={5}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-md border border-border bg-sidebar px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs opacity-70">Currency</span>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as "USD" | "RUB")}
              className="w-full rounded-md border border-border bg-sidebar px-3 py-2 text-sm"
            >
              <option value="USD">USD (min $5)</option>
              <option value="RUB">RUB (min 50 ₽)</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs opacity-70">Email for receipt (optional)</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-md border border-border bg-sidebar px-3 py-2 text-sm"
            />
          </label>
        </div>
        {error ? (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        ) : null}
        <Button
          onClick={pay}
          disabled={loading || !Number(amount) || Number(amount) < 5}
          className="w-full sm:w-auto"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
            credit_card
          </span>
          {loading
            ? "Creating invoice…"
            : `Pay ${Number(amount) > 0 ? `${Number(amount).toFixed(2)} ${currency}` : ""} by Card`}
        </Button>
      </Card>
    </div>
  );
}
