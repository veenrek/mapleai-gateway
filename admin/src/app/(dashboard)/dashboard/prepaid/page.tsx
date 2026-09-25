import type { Metadata } from "next";
import PrepaidStatsClient from "./PrepaidStatsClient";

export const metadata: Metadata = {
  title: "MapleAI — Prepaid Keys",
  description: "Prepaid key usage split by upstream platform and estimated upstream cost",
};

export default function PrepaidPage() {
  return <PrepaidStatsClient />;
}
