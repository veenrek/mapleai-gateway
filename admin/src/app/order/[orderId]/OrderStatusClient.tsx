"use client";

import { useEffect, useState } from "react";

interface OrderStatus {
  status: "pending" | "paid" | "failed" | "expired";
  fulfilled: boolean;
  delivery: string | null;
  supplier: string | null;
  paidAt: string | null;
}

export default function OrderStatusClient({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<OrderStatus | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/marketplace/shop/order/${encodeURIComponent(orderId)}`);
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        const data = (await res.json()) as OrderStatus;
        if (!stop) setOrder(data);
      } catch {
        /* retry on next tick */
      }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [orderId]);

  if (notFound) {
    return <p className="text-center text-text-muted">Order not found.</p>;
  }
  if (!order) {
    return <p className="text-center text-text-muted">Loading…</p>;
  }

  if (order.status === "paid" && order.fulfilled && order.delivery) {
    return (
      <div className="space-y-4 text-center">
        <div className="text-4xl">🎉</div>
        <h1 className="text-2xl font-semibold">Your order is ready!</h1>
        <p className="text-sm text-text-muted">
          Payment confirmed — here is your Gemini Pro activation:
        </p>
        <pre className="mx-auto max-w-2xl whitespace-pre-wrap break-words rounded-xl border border-border bg-bg p-4 text-left text-sm">
          {order.delivery}
        </pre>
        <p className="text-xs text-text-muted">
          Keep this page safe — the code above is your purchase.
        </p>
      </div>
    );
  }

  if (order.status === "paid") {
    return (
      <div className="space-y-3 text-center">
        <h1 className="text-2xl font-semibold">Payment received ✅</h1>
        <p className="text-sm text-text-muted">
          Preparing your item… this page refreshes automatically every few seconds.
        </p>
        <div className="mx-auto h-2 w-48 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full w-1/3 animate-pulse bg-primary" />
        </div>
      </div>
    );
  }

  if (order.status === "failed" || order.status === "expired") {
    return (
      <div className="space-y-3 text-center">
        <h1 className="text-2xl font-semibold">Payment not completed</h1>
        <p className="text-sm text-text-muted">
          The invoice was not paid in time. If funds were debited — contact support.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-center">
      <h1 className="text-2xl font-semibold">Waiting for payment…</h1>
      <p className="text-sm text-text-muted">
        Complete the payment on the Lava checkout page — this page updates automatically.
      </p>
    </div>
  );
}
