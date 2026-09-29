import type { Metadata } from "next";
import GatewayAnalyticsClient from "./GatewayAnalyticsClient";

export const metadata: Metadata = {
  title: "MapleAI — Gateway Analytics",
  description: "x402 payments, embeddings, Jev and free tier stats across all gateway domains",
};

export default function GatewayAnalyticsPage() {
  return <GatewayAnalyticsClient />;
}
