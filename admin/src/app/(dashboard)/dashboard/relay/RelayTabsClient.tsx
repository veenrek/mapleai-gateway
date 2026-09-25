"use client";

import { useState } from "react";
import RelayProxyClient from "./RelayProxyClient";
import UpstreamPoolClient from "./UpstreamPoolClient";

type Tab = "pool" | "tokens";

export default function RelayTabsClient() {
  const [tab, setTab] = useState<Tab>("pool");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Relay</h1>
        <div className="flex gap-1 mt-3 border-b border-border">
          <button
            onClick={() => setTab("pool")}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === "pool"
                ? "border-primary text-primary"
                : "border-transparent text-text-muted hover:text-text"
            }`}
          >
            Upstream Pool
          </button>
          <button
            onClick={() => setTab("tokens")}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === "tokens"
                ? "border-primary text-primary"
                : "border-transparent text-text-muted hover:text-text"
            }`}
          >
            Access Tokens
          </button>
        </div>
      </div>

      {tab === "pool" ? <UpstreamPoolClient /> : <RelayProxyClient />}
    </div>
  );
}
