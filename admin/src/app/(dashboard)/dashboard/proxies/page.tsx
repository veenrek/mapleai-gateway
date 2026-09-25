"use client";

import { Suspense } from "react";
import ProxyTab from "../settings/components/ProxyTab";

/**
 * Proxies management — standalone tab page backed by the upstream ProxyTab
 * component (registry, pool, free pool, subscriptions, documentation).
 */
export default function ProxiesPage() {
  return (
    <Suspense fallback={null}>
      <ProxyTab />
    </Suspense>
  );
}
