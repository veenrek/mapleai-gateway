"use client";

import { useState } from "react";

const FEATURES = [
  "Gemini Pro AI — 18 months of premium access",
  "Antigravity agent coding included",
  "5 TB Google Drive storage",
  "Veo 3 video generation",
  "Nano Banana image model",
];

type Method = "CARD" | "PAYPAL" | "PIX";
type Currency = "USD" | "EUR" | "BRL";

/* Мини-логотипы платёжных систем (инлайн-SVG, без внешних запросов) */
const VisaLogo = () => (
  <svg viewBox="0 0 46 16" className="h-3.5" role="img" aria-label="Visa">
    <text
      x="0"
      y="13"
      fontFamily="Arial, sans-serif"
      fontSize="15"
      fontStyle="italic"
      fontWeight="bold"
      fill="#1A1F71"
    >
      VISA
    </text>
  </svg>
);

const McLogo = () => (
  <svg viewBox="0 0 32 20" className="h-4" role="img" aria-label="Mastercard">
    <circle cx="12" cy="10" r="9" fill="#EB001B" />
    <circle cx="20" cy="10" r="9" fill="#F79E1B" fillOpacity="0.85" />
  </svg>
);

const ApplePayLogo = () => (
  <svg viewBox="0 0 62 18" className="h-4" role="img" aria-label="Apple Pay">
    <text
      x="0"
      y="14"
      fontFamily="Arial, sans-serif"
      fontSize="13"
      fontWeight="600"
      fill="currentColor"
    >
      Apple Pay
    </text>
  </svg>
);

const GooglePayLogo = () => (
  <svg viewBox="0 0 46 18" className="h-4" role="img" aria-label="Google Pay">
    <text x="0" y="14" fontFamily="Arial, sans-serif" fontSize="13" fontWeight="600">
      <tspan fill="#4285F4">G</tspan>
      <tspan fill="currentColor"> Pay</tspan>
    </text>
  </svg>
);

const PayPalLogo = () => (
  <svg viewBox="0 0 56 18" className="h-4" role="img" aria-label="PayPal">
    <text
      x="0"
      y="14"
      fontFamily="Arial, sans-serif"
      fontSize="14"
      fontStyle="italic"
      fontWeight="bold"
    >
      <tspan fill="#003087">Pay</tspan>
      <tspan fill="#009CDE">Pal</tspan>
    </text>
  </svg>
);

const PixLogo = () => (
  <svg viewBox="0 0 20 20" className="h-4" role="img" aria-label="PIX">
    <path
      d="M10 1.5 18.5 10 10 18.5 1.5 10Z"
      fill="none"
      stroke="#32BCAD"
      strokeWidth="2.2"
      strokeLinejoin="round"
    />
    <circle cx="10" cy="10" r="2.2" fill="#32BCAD" />
  </svg>
);

/** Ряд логотипов для выбранного способа оплаты */
const PayLogos = ({ method }: { method: Method }) => (
  <span className="mt-1.5 flex items-center gap-2">
    {method === "CARD" && (
      <>
        <VisaLogo />
        <McLogo />
        <ApplePayLogo />
        <GooglePayLogo />
      </>
    )}
    {method === "PAYPAL" && <PayPalLogo />}
    {method === "PIX" && <PixLogo />}
  </span>
);

const METHODS: { id: Method; label: string; hint: string; currencies: Currency[] }[] = [
  {
    id: "CARD",
    label: "Card",
    hint: "Visa / Mastercard · Apple Pay · Google Pay at checkout",
    currencies: ["USD", "EUR"],
  },
  {
    id: "PAYPAL",
    label: "PayPal",
    hint: "PayPal balance or linked card",
    currencies: ["USD", "EUR"],
  },
  { id: "PIX", label: "PIX", hint: "Brazil — instant bank transfer (BRL)", currencies: ["BRL"] },
];

export default function BuyGeminiClient() {
  const [method, setMethod] = useState<Method>("CARD");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [amount, setAmount] = useState("29.99");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeMethod = METHODS.find((m) => m.id === method)!;
  const effectiveCurrency = activeMethod.currencies.includes(currency)
    ? currency
    : activeMethod.currencies[0];

  const pay = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/marketplace/payments/lava/product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: Number(amount),
          currency: effectiveCurrency,
          paymentMethod: method,
          ...(email ? { email } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message ?? `Error ${res.status}`);
        return;
      }
      if (data.paymentUrl) window.location.href = data.paymentUrl;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Hero */}
      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        <div
          className="flex h-52 items-center justify-center"
          style={{ background: "linear-gradient(135deg,#4285F4 0%,#9b72cb 50%,#d96570 100%)" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local static asset */}
          <img
            src="/gemini-pro-hero.png"
            alt="Gemini Pro AI"
            className="h-full w-full object-cover"
          />
        </div>
        <div className="space-y-4 p-6">
          <h1 className="text-3xl font-semibold tracking-tight">Gemini Pro AI — 18 Months</h1>
          <p className="text-sm text-text-muted">
            Full Gemini Pro subscription for 18 months. Instant digital delivery — the activation
            link is issued right after payment. Secure checkout by Lava.top.
          </p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-2 text-sm">
                <span className="text-green-500">✓</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Checkout */}
      <div className="space-y-5 rounded-2xl border border-border bg-surface p-6">
        <h2 className="text-lg font-medium">Payment method</h2>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {METHODS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMethod(m.id)}
              className={`rounded-xl border p-3 text-left transition ${
                method === m.id
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-text-muted"
              }`}
            >
              <div className="text-sm font-medium">{m.label}</div>
              <PayLogos method={m.id} />
              <div className="mt-0.5 text-[11px] text-text-muted">{m.hint}</div>
            </button>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-1">
            <span className="text-xs text-text-muted">Amount ({effectiveCurrency})</span>
            <input
              type="number"
              min={effectiveCurrency === "USD" ? 5 : 1}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-main outline-none focus:border-primary"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-text-muted">Currency</span>
            <select
              value={effectiveCurrency}
              onChange={(e) => setCurrency(e.target.value as Currency)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-main outline-none focus:border-primary"
            >
              {activeMethod.currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-text-muted">Email for receipt (optional)</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-main outline-none focus:border-primary"
            />
          </label>
        </div>

        {error ? (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        ) : null}

        <button
          onClick={pay}
          disabled={loading || !Number(amount) || Number(amount) <= 0}
          className="w-full rounded-xl bg-primary py-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {loading
            ? "Creating invoice…"
            : `Pay ${Number(amount) > 0 ? `${Number(amount)} ${effectiveCurrency}` : ""} · ${activeMethod.label}`}
        </button>

        <p className="text-center text-[11px] text-text-muted">
          Payments are processed by Lava.top. On the secure checkout page you can pay with a bank
          card, Apple Pay or Google Pay (Card), PayPal balance (PayPal) or PIX (Brazil).
        </p>
      </div>
    </div>
  );
}
