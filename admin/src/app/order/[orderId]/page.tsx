import type { Metadata } from "next";
import PublicShell from "@/app/PublicShell";
import OrderStatusClient from "./OrderStatusClient";

export const metadata: Metadata = {
  title: "Order status",
  robots: { index: false, follow: false }, // personal purchase page — never indexed
};

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return (
    <PublicShell>
      <div className="mx-auto max-w-3xl py-8">
        <OrderStatusClient orderId={orderId} />
      </div>
    </PublicShell>
  );
}
