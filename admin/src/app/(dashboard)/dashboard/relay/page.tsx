import type { Metadata } from "next";
import RelayTabsClient from "./RelayTabsClient";

export const metadata: Metadata = {
  title: "MapleAI — Relay",
  description: "Upstream account rotation pool and serverless relay proxy endpoints",
};

export default function RelayProxyPage() {
  return <RelayTabsClient />;
}
