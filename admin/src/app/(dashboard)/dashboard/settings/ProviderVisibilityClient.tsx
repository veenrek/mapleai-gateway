"use client";

import { useEffect, useMemo, useState } from "react";
import {
  STATIC_PROVIDER_CATALOG_GROUPS,
  STATIC_PROVIDER_CATALOG_RESOLUTION_ORDER,
  type StaticProviderCatalogCategory,
} from "@/lib/providers/catalog";
import { DEFAULT_ENABLED_PROVIDERS } from "@/shared/constants/providers";

const CATEGORY_LABELS: Record<StaticProviderCatalogCategory, string> = {
  oauth: "OAuth providers",
  apikey: "API key providers",
  "no-auth": "No-auth providers",
  "web-cookie": "Web session providers",
  local: "Local providers",
  search: "Search providers",
  audio: "Audio providers",
  "upstream-proxy": "Upstream proxy providers",
  "cloud-agent": "Cloud agent providers",
};

type CatalogProvider = { id: string; name: string };

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-primary" : "bg-border"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          on ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

export default function ProviderVisibilityClient() {
  const [enabledProviders, setEnabledProviders] = useState<string[] | null>(null);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
        const data = await res.json();
        setEnabledProviders(
          Array.isArray(data.enabledProviders) ? data.enabledProviders : DEFAULT_ENABLED_PROVIDERS
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setEnabledProviders(DEFAULT_ENABLED_PROVIDERS);
      }
    })();
  }, []);

  const save = async (next: string[]) => {
    const previous = enabledProviders;
    setEnabledProviders(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledProviders: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Failed to save settings (${res.status})`);
      }
    } catch (err) {
      setEnabledProviders(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (providerId: string) => {
    if (!enabledProviders) return;
    const next = enabledProviders.includes(providerId)
      ? enabledProviders.filter((id) => id !== providerId)
      : [...enabledProviders, providerId];
    void save(next);
  };

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    return STATIC_PROVIDER_CATALOG_RESOLUTION_ORDER.map((category) => {
      const providers = Object.values(STATIC_PROVIDER_CATALOG_GROUPS[category].providers).filter(
        (provider) =>
          !query ||
          provider.name.toLowerCase().includes(query) ||
          provider.id.toLowerCase().includes(query)
      );
      return { category, providers: providers as CatalogProvider[] };
    }).filter((group) => group.providers.length > 0);
  }, [search]);

  const totalCount = useMemo(
    () =>
      STATIC_PROVIDER_CATALOG_RESOLUTION_ORDER.reduce(
        (sum, category) =>
          sum + Object.keys(STATIC_PROVIDER_CATALOG_GROUPS[category].providers).length,
        0
      ),
    []
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-main">Settings</h1>
        <p className="mt-1 text-sm text-text-muted">Owner settings for the MapleAI.</p>
      </div>

      <section className="rounded-card border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text-main">Provider visibility</h2>
            <p className="mt-1 text-sm text-text-muted">
              Only enabled providers appear on the Providers tab. “Add OpenAI Compatible” and “Add
              Anthropic Compatible” are always available.
            </p>
          </div>
          <span className="rounded-full border border-border bg-bg px-3 py-1 text-xs text-text-muted">
            {enabledProviders ? `${enabledProviders.length} / ${totalCount} enabled` : "Loading…"}
            {saving ? " · saving…" : ""}
          </span>
        </div>

        {error && (
          <div className="mt-3 rounded-control border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search providers…"
          className="mt-4 w-full rounded-control border border-border bg-bg px-3 py-2 text-sm text-text-main outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 sm:max-w-xs"
        />

        {!enabledProviders ? (
          <p className="mt-4 text-sm text-text-muted">Loading providers…</p>
        ) : (
          <div className="mt-4 space-y-6">
            {groups.map(({ category, providers }) => (
              <div key={category}>
                <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  {CATEGORY_LABELS[category]}
                </h3>
                <ul className="mt-2 divide-y divide-border rounded-control border border-border bg-bg">
                  {providers.map((provider) => {
                    const on = enabledProviders.includes(provider.id);
                    return (
                      <li
                        key={provider.id}
                        className="flex items-center justify-between gap-3 px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-text-main">
                            {provider.name}
                          </p>
                          <p className="truncate text-xs text-text-muted">{provider.id}</p>
                        </div>
                        <Toggle on={on} onToggle={() => toggle(provider.id)} />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {groups.length === 0 && (
              <p className="text-sm text-text-muted">No providers match “{search}”.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
