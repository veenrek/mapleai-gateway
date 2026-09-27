"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Card } from "@/shared/components";
import {
  DEFAULT_ENABLED_PROVIDERS,
  isAnthropicCompatibleProvider,
  isClaudeCodeCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";

type Seller = {
  id: string;
  name: string;
  email: string | null;
  status: string;
  balanceMicroUsd: number;
  apiKeyPrefix: string;
};

type SellerConnection = {
  sellerId: string;
  connectionId: string;
  provider: string;
  displayName: string | null;
  accountGroup: string;
  cooldownUntil: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  createdAt: string;
};

type Listing = {
  id: string;
  sellerId: string;
  connectionId: string;
  provider: string;
  upstreamModel: string;
  publicModel: string;
  status: string;
  inputPriceMicroUsdPerMillionTokens: number;
  outputPriceMicroUsdPerMillionTokens: number;
  platformFeeBps: number;
  maxRequestsPerMinute: number | null;
  maxDailyTokens: number | null;
  tokensSold: number;
  revenueMicroUsd: number;
  cooldownUntil: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
};

type UsageSummary = {
  requestCount: number;
  totalTokens: number;
  chargedMicroUsd: number;
  sellerAmountMicroUsd: number;
  platformFeeMicroUsd: number;
  reservedMicroUsd: number;
};

type SellerSummary = {
  seller: Seller;
  usage: UsageSummary;
  connections: SellerConnection[];
  listings: Listing[];
};

type AdminSellerResponse = { seller: Seller; apiKey: string };
type SellerRegistrationMode = "closed" | "open";
type AdminBuyerResponse = {
  buyerKey: { id: string; name: string; keyPrefix: string };
  apiKey: string;
};

const SELLER_KEY_STORAGE = "omniroute-marketplace-seller-key";

function formatUsdFromMicro(value: number | null | undefined): string {
  return `$${((Number(value || 0) || 0) / 1_000_000).toFixed(4)}`;
}

function priceFromMicroPerMillion(value: number): string {
  return `$${((Number(value || 0) || 0) / 1_000_000).toFixed(4)}/1M`;
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof data?.error?.message === "string"
        ? data.error.message
        : typeof data?.error === "string"
          ? data.error
          : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

function TextInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  required = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        className="w-full rounded-control border border-border bg-bg px-3 py-2 text-sm text-text-main outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
    </label>
  );
}

function SecretBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
          Save this key now
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <code className="block break-all rounded bg-black/5 p-2 text-xs text-text-main dark:bg-white/10">
        {value}
      </code>
    </div>
  );
}

export default function MarketplacePageClient() {
  const [sellerKey, setSellerKey] = useState("");
  const [summary, setSummary] = useState<SellerSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [adminSellerName, setAdminSellerName] = useState("");
  const [adminSellerEmail, setAdminSellerEmail] = useState("");
  const [sellerRegistrationMode, setSellerRegistrationMode] =
    useState<SellerRegistrationMode | null>(null);

  const [prepaidName, setPrepaidName] = useState("");
  // "provider:<providerId>" or "combo:<comboId>" — chosen from a dropdown.
  const [prepaidScope, setPrepaidScope] = useState("");
  const [prepaidModelOptions, setPrepaidModelOptions] = useState<string[]>([]);
  const [prepaidModels, setPrepaidModels] = useState<string[]>([]);
  const [prepaidTokensMillions, setPrepaidTokensMillions] = useState("50");
  const [prepaidUnlimited, setPrepaidUnlimited] = useState(false);
  const [prepaidExpiryDays, setPrepaidExpiryDays] = useState("");
  const [issuedPrepaidKey, setIssuedPrepaidKey] = useState<{ apiKey: string; name: string } | null>(
    null
  );
  // (список отдельных препэйде ключей рендерится на /dashboard/prepaid)

  const [createdSellerKey, setCreatedSellerKey] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [buyerBalanceUsd, setBuyerBalanceUsd] = useState("10");
  const [createdBuyerKey, setCreatedBuyerKey] = useState("");

  const [accountGroup, setAccountGroup] = useState("default");
  const [existingConnectionId, setExistingConnectionId] = useState("");
  const [providerConnections, setProviderConnections] = useState<
    Array<{
      id: string;
      provider: string;
      displayName?: string | null;
      name?: string | null;
      isActive?: boolean;
      testStatus?: string | null;
    }>
  >([]);
  const [enabledProviderIds, setEnabledProviderIds] = useState<string[]>(DEFAULT_ENABLED_PROVIDERS);

  const [listingConnectionId, setListingConnectionId] = useState("");
  const [upstreamModel, setUpstreamModel] = useState("");
  const [publicModel, setPublicModel] = useState("");
  const [listingComboId, setListingComboId] = useState("");
  const [comboOptions, setComboOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [inputPrice, setInputPrice] = useState("1");
  const [outputPrice, setOutputPrice] = useState("2");
  const [platformFeeBps, setPlatformFeeBps] = useState("1500");
  const [maxRpm, setMaxRpm] = useState("");
  const [maxDailyTokens, setMaxDailyTokens] = useState("");

  useEffect(() => {
    const stored = window.localStorage.getItem(SELLER_KEY_STORAGE);
    if (stored) setSellerKey(stored);
  }, []);

  const showMessage = (value: string) => {
    setMessage(value);
    setError(null);
  };

  const showError = (value: unknown) => {
    setError(value instanceof Error ? value.message : String(value));
    setMessage(null);
  };

  const sellerHeaders = () => ({
    Authorization: `Bearer ${sellerKey}`,
    "Content-Type": "application/json",
  });

  const loadSummary = async (key = sellerKey) => {
    if (!key.trim()) {
      setSummary(null);
      return;
    }
    setLoadingSummary(true);
    try {
      const data = await readJson<SellerSummary>(
        await fetch("/api/marketplace/seller/summary", {
          headers: { Authorization: `Bearer ${key.trim()}` },
          cache: "no-store",
        })
      );
      setSummary(data);
      setListingConnectionId((current) => current || data.connections[0]?.connectionId || "");
      showMessage("Seller workspace loaded");
    } catch (err) {
      setSummary(null);
      showError(err);
    } finally {
      setLoadingSummary(false);
    }
  };

  const saveSellerKey = async () => {
    const key = sellerKey.trim();
    if (!key) return;
    window.localStorage.setItem(SELLER_KEY_STORAGE, key);
    await loadSummary(key);
  };

  const loadRegistrationMode = async () => {
    try {
      const data = await readJson<{ sellerRegistrationMode: SellerRegistrationMode }>(
        await fetch("/api/marketplace/settings", { cache: "no-store" })
      );
      setSellerRegistrationMode(data.sellerRegistrationMode);
    } catch {
      // management auth required — leave the toggle in its unknown state
    }
  };

  const toggleRegistrationMode = async () => {
    const next: SellerRegistrationMode = sellerRegistrationMode === "open" ? "closed" : "open";
    try {
      const data = await readJson<{ sellerRegistrationMode: SellerRegistrationMode }>(
        await fetch("/api/marketplace/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sellerRegistrationMode: next }),
        })
      );
      setSellerRegistrationMode(data.sellerRegistrationMode);
      showMessage(
        data.sellerRegistrationMode === "open"
          ? "Seller registration open — wallet users can become sellers"
          : "Seller registration closed — single-seller mode"
      );
    } catch (err) {
      showError(err);
    }
  };

  useEffect(() => {
    void loadRegistrationMode();
    void loadPrepaidKeys();
    void loadComboOptions();
    void loadProviderConnections();
    void loadEnabledProviders();
  }, []);

  // Semantic cache metrics (hits/misses/tokens saved) — refresh every 60s.
  const [cacheMetrics, setCacheMetrics] = useState<{
    hits: number;
    misses: number;
    tokensSaved: number;
    hitRate: number | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/cache/semantic-metrics", { credentials: "same-origin" });
        if (!res.ok) return;
        const d = (await res.json()) as {
          hits: number;
          misses: number;
          tokensSaved: number;
          hitRate: number | null;
        };
        if (!cancelled) setCacheMetrics(d);
      } catch {
        /* best-effort */
      }
    };
    load();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // When a scope is picked, offer its storefront catalog models for selection.
  useEffect(() => {
    setPrepaidModels([]);
    if (!prepaidScope) {
      setPrepaidModelOptions([]);
      return;
    }
    const [scopeKind, ...rest] = prepaidScope.split(":");
    const scopeValue = rest.join(":");
    if (!scopeValue) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await readJson<{ data?: Array<{ id?: string; owned_by?: string }> }>(
          await fetch("/api/v1/models", { cache: "no-store" })
        );
        const entries = Array.isArray(data.data) ? data.data : [];
        const comboNames = new Set(comboOptions.map((combo) => combo.name));
        const models =
          scopeKind === "combo"
            ? entries
                .filter(
                  (m) =>
                    m.owned_by === "combo" &&
                    (scopeValue === "__all__" ? comboNames.has(m.id ?? "") : m.id === scopeValue)
                )
                .map((m) => m.id as string)
            : entries
                .filter((m) => m.owned_by === scopeValue && typeof m.id === "string")
                .map((m) => m.id as string);
        if (!cancelled) setPrepaidModelOptions(models);
      } catch {
        if (!cancelled) setPrepaidModelOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prepaidScope, comboOptions]);

  const loadProviderConnections = async () => {
    try {
      const data = await readJson<{
        connections: Array<{
          id: string;
          provider: string;
          displayName?: string | null;
          name?: string | null;
          isActive?: boolean;
          testStatus?: string | null;
        }>;
      }>(await fetch("/api/providers", { cache: "no-store" }));
      setProviderConnections(Array.isArray(data.connections) ? data.connections : []);
    } catch {
      // management auth required — dropdown stays empty
    }
  };

  const loadEnabledProviders = async () => {
    try {
      const data = await readJson<{ enabledProviders?: string[] }>(
        await fetch("/api/settings", { cache: "no-store" })
      );
      if (Array.isArray(data.enabledProviders)) setEnabledProviderIds(data.enabledProviders);
    } catch {
      // keep defaults
    }
  };

  // Prepaid scopes are limited to enabled providers that actually have an
  // active (tested, not disabled) connection; owner-created compatible nodes
  // are always eligible and show their display name instead of the node id.
  const prepaidProviderOptions = (() => {
    const enabledSet = new Set(enabledProviderIds);
    const options = new Map<string, string>();
    for (const connection of providerConnections) {
      if (options.has(connection.provider)) continue;
      const isActiveConnection =
        connection.isActive !== false &&
        (connection.testStatus === "active" || connection.testStatus === "success");
      if (!isActiveConnection) continue;
      const isCompatibleNode =
        isOpenAICompatibleProvider(connection.provider) ||
        isAnthropicCompatibleProvider(connection.provider) ||
        isClaudeCodeCompatibleProvider(connection.provider);
      if (!isCompatibleNode && !enabledSet.has(connection.provider)) continue;
      options.set(
        connection.provider,
        isCompatibleNode
          ? connection.displayName || connection.name || connection.provider
          : connection.provider
      );
    }
    return [...options.entries()];
  })();

  const loadComboOptions = async () => {
    try {
      const data = await readJson<{ combos: Array<{ id: string; name: string }> }>(
        await fetch("/api/combos", { cache: "no-store" })
      );
      setComboOptions(Array.isArray(data.combos) ? data.combos : []);
    } catch {
      // ignore — dropdown stays empty
    }
  };

  const loadPrepaidKeys = async () => {
    // Содержимое рендерится на /dashboard/prepaid.
    try {
      await fetch("/api/marketplace/prepaid-keys", { cache: "no-store" });
    } catch {
      // ignore
    }
  };

  const issuePrepaidKey = async () => {
    const tokens = Math.round(Number(prepaidTokensMillions) * 1_000_000);
    if (
      !prepaidName.trim() ||
      !prepaidScope ||
      prepaidModels.length === 0 ||
      (!prepaidUnlimited && (!Number.isFinite(tokens) || tokens <= 0))
    )
      return;
    const [scopeKind, ...rest] = prepaidScope.split(":");
    const scopeValue = rest.join(":");
    if (!scopeValue) return;
    try {
      const data = await readJson<{ apiKey: string; name: string }>(
        await fetch("/api/marketplace/prepaid-keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: prepaidName.trim(),
            ...(scopeKind === "combo" ? { comboId: scopeValue } : { provider: scopeValue }),
            models: prepaidModels,
            ...(prepaidUnlimited ? { unlimited: true } : { tokens }),
            expiresInDays: prepaidExpiryDays ? Number(prepaidExpiryDays) : undefined,
          }),
        })
      );
      setIssuedPrepaidKey({ apiKey: data.apiKey, name: data.name });
      setPrepaidName("");
      setPrepaidScope("");
      setPrepaidModels([]);
      setPrepaidUnlimited(false);
      showMessage(`Prepaid key issued: ${data.name}`);
      await loadPrepaidKeys();
    } catch (err) {
      showError(err);
    }
  };

  const createSeller = async () => {
    try {
      const data = await readJson<AdminSellerResponse>(
        await fetch("/api/marketplace/sellers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: adminSellerName,
            email: adminSellerEmail || null,
          }),
        })
      );
      setCreatedSellerKey(data.apiKey);
      setSellerKey(data.apiKey);
      window.localStorage.setItem(SELLER_KEY_STORAGE, data.apiKey);
      showMessage(`Seller created: ${data.seller.name}`);
      await loadSummary(data.apiKey);
    } catch (err) {
      showError(err);
    }
  };

  const createBuyer = async () => {
    try {
      const data = await readJson<AdminBuyerResponse>(
        await fetch("/api/marketplace/buyer-keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: buyerName,
            balanceUsd: Number(buyerBalanceUsd || 0),
          }),
        })
      );
      setCreatedBuyerKey(data.apiKey);
      showMessage(`Buyer key created: ${data.buyerKey.name}`);
    } catch (err) {
      showError(err);
    }
  };

  const attachExistingConnection = async () => {
    try {
      await readJson(
        await fetch("/api/marketplace/seller/connections", {
          method: "POST",
          headers: sellerHeaders(),
          body: JSON.stringify({ connectionId: existingConnectionId, accountGroup }),
        })
      );
      setExistingConnectionId("");
      showMessage("Connection attached");
      await loadSummary();
    } catch (err) {
      showError(err);
    }
  };

  const createListing = async () => {
    try {
      await readJson(
        await fetch("/api/marketplace/seller/listings", {
          method: "POST",
          headers: sellerHeaders(),
          body: JSON.stringify({
            connectionId: listingConnectionId,
            ...(listingComboId ? { comboId: listingComboId } : { upstreamModel }),
            publicModel: publicModel || undefined,
            inputPriceUsdPerMillionTokens: Number(inputPrice || 0),
            outputPriceUsdPerMillionTokens: Number(outputPrice || 0),
            platformFeeBps: platformFeeBps ? Number(platformFeeBps) : undefined,
            maxRequestsPerMinute: maxRpm ? Number(maxRpm) : null,
            maxDailyTokens: maxDailyTokens ? Number(maxDailyTokens) : null,
          }),
        })
      );
      setUpstreamModel("");
      setPublicModel("");
      setListingComboId("");
      showMessage("Listing published");
      await loadSummary();
    } catch (err) {
      showError(err);
    }
  };

  const seller = summary?.seller;
  const usage = summary?.usage;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="overflow-hidden rounded-[2rem] border border-border bg-[radial-gradient(circle_at_top_left,rgba(99,102,241,0.24),transparent_36%),linear-gradient(135deg,rgba(15,23,42,0.96),rgba(30,41,59,0.9))] p-6 text-white shadow-xl sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <Badge variant="primary" className="mb-4 bg-white/10 text-white">
              MapleAI
            </Badge>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Seller console for reselling tokens from connected AI accounts
            </h1>
            <p className="mt-3 max-w-2xl text-sm text-white/75 sm:text-base">
              Attach provider connections, publish priced models, watch revenue, and hand buyers an
              OpenAI-compatible marketplace endpoint.
            </p>
          </div>
          <div className="grid min-w-[260px] grid-cols-2 gap-3 rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur">
            <div>
              <p className="text-xs text-white/60">Seller balance</p>
              <p className="text-2xl font-bold">{formatUsdFromMicro(seller?.balanceMicroUsd)}</p>
            </div>
            <div>
              <p className="text-xs text-white/60">Tokens sold</p>
              <p className="text-2xl font-bold">{usage?.totalTokens?.toLocaleString() || "0"}</p>
            </div>
            <div>
              <p className="text-xs text-white/60">Cache hit rate</p>
              <p className="text-2xl font-bold">
                {cacheMetrics?.hitRate != null ? `${cacheMetrics.hitRate}%` : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-white/60">Tokens saved by cache</p>
              <p className="text-2xl font-bold">
                {cacheMetrics ? cacheMetrics.tokensSaved.toLocaleString("en-US") : "0"}
              </p>
              {cacheMetrics && (
                <p className="text-[10px] text-white/50">
                  {cacheMetrics.hits} hits / {cacheMetrics.misses} misses
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {(message || error) && (
        <div
          className={`rounded-xl border p-3 text-sm ${
            error
              ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300"
              : "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
          }`}
        >
          {error || message}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-6">
          <Card
            title="Admin bootstrap"
            subtitle="Create sellers and buyer keys"
            icon="admin_panel_settings"
          >
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <TextInput
                  label="Seller name"
                  value={adminSellerName}
                  onChange={setAdminSellerName}
                />
                <TextInput
                  label="Seller email"
                  value={adminSellerEmail}
                  onChange={setAdminSellerEmail}
                  type="email"
                />
              </div>
              <Button onClick={createSeller} disabled={!adminSellerName.trim()} icon="person_add">
                Create seller
              </Button>
              <div className="border-t border-border pt-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Seller registration</div>
                  <div className="text-xs text-text-muted mt-0.5">
                    {sellerRegistrationMode === "open"
                      ? "Open — wallet users can self-provision as sellers"
                      : "Closed — single-seller mode (only sellers you create)"}
                  </div>
                </div>
                <Button
                  variant={sellerRegistrationMode === "open" ? "secondary" : "primary"}
                  onClick={toggleRegistrationMode}
                  disabled={sellerRegistrationMode === null}
                >
                  {sellerRegistrationMode === null
                    ? "…"
                    : sellerRegistrationMode === "open"
                      ? "Close registration"
                      : "Open registration"}
                </Button>
              </div>
              <SecretBox value={createdSellerKey} />
              <div className="border-t border-border pt-4 space-y-3">
                <div>
                  <div className="text-sm font-medium">Prepaid API keys</div>
                  <div className="text-xs text-text-muted mt-0.5">
                    Token-budgeted keys for users without an account — share the raw key and the
                    public checker at <code className="font-mono">/check</code>.
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextInput
                    label="Key name"
                    value={prepaidName}
                    onChange={setPrepaidName}
                    placeholder="GPT 50M — client X"
                  />
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
                      Provider or combo
                    </span>
                    <select
                      value={prepaidScope}
                      onChange={(event) => {
                        setPrepaidScope(event.target.value);
                        if (!event.target.value.startsWith("combo:")) setPrepaidUnlimited(false);
                      }}
                      className="w-full rounded-control border border-border bg-bg px-3 py-2 text-sm text-text-main outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                    >
                      <option value="">Select provider or combo</option>
                      <optgroup label="Providers">
                        {prepaidProviderOptions.map(([providerId, label]) => (
                          <option key={providerId} value={`provider:${providerId}`}>
                            {label}
                          </option>
                        ))}
                      </optgroup>
                      {comboOptions.length > 0 && (
                        <optgroup label="Combos">
                          <option value="combo:__all__">All active combos</option>
                          {comboOptions.map((combo) => (
                            <option key={combo.id} value={`combo:${combo.name}`}>
                              combo: {combo.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    <span className="block text-xs text-text-muted">
                      Pick one or more storefront models the key may call.
                    </span>
                    {prepaidScope &&
                      (prepaidModelOptions.length > 0 ? (
                        <>
                          <div className="max-h-40 space-y-1 overflow-auto rounded-control border border-border bg-bg p-2">
                            {prepaidModelOptions.map((model) => (
                              <label
                                key={model}
                                className="flex items-center gap-2 text-sm text-text-main"
                              >
                                <input
                                  type="checkbox"
                                  className="accent-primary"
                                  checked={prepaidModels.includes(model)}
                                  onChange={(event) =>
                                    setPrepaidModels((prev) =>
                                      event.target.checked
                                        ? [...prev, model]
                                        : prev.filter((m) => m !== model)
                                    )
                                  }
                                />
                                <span className="truncate" title={model}>
                                  {model}
                                </span>
                              </label>
                            ))}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-text-muted">
                            <button
                              type="button"
                              className="hover:text-text-main"
                              onClick={() => setPrepaidModels([...prepaidModelOptions])}
                            >
                              Select all
                            </button>
                            <button
                              type="button"
                              className="hover:text-text-main"
                              onClick={() => setPrepaidModels([])}
                            >
                              Clear
                            </button>
                            <span className="ml-auto">{prepaidModels.length} selected</span>
                          </div>
                        </>
                      ) : (
                        <span className="block text-xs text-text-muted">
                          No storefront models available for this scope.
                        </span>
                      ))}
                  </label>
                  <TextInput
                    label="Token budget, millions"
                    value={prepaidTokensMillions}
                    onChange={setPrepaidTokensMillions}
                    type="number"
                    disabled={prepaidUnlimited}
                  />
                  <label className="flex items-center gap-2 text-sm text-text-main">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={prepaidUnlimited}
                      disabled={!prepaidScope.startsWith("combo:")}
                      onChange={(event) => setPrepaidUnlimited(event.target.checked)}
                    />
                    Unlimited token budget
                  </label>
                  <TextInput
                    label="Expires in days (optional)"
                    value={prepaidExpiryDays}
                    onChange={setPrepaidExpiryDays}
                    type="number"
                    placeholder="365"
                  />
                </div>
                <Button
                  onClick={issuePrepaidKey}
                  disabled={
                    !prepaidName.trim() ||
                    !prepaidScope ||
                    prepaidModels.length === 0 ||
                    (!prepaidUnlimited &&
                      (!Number.isFinite(Number(prepaidTokensMillions)) || Number(prepaidTokensMillions) <= 0))
                  }
                  icon="vpn_key"
                >
                  Issue prepaid key
                </Button>
                <SecretBox value={issuedPrepaidKey?.apiKey ?? ""} />
                {/* Ударный список ключей — на странице /dashboard/prepaid */}
              </div>
              <div className="border-t border-border pt-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextInput label="Buyer name" value={buyerName} onChange={setBuyerName} />
                  <TextInput
                    label="Initial balance, USD"
                    value={buyerBalanceUsd}
                    onChange={setBuyerBalanceUsd}
                    type="number"
                  />
                </div>
                <Button
                  className="mt-3"
                  variant="secondary"
                  onClick={createBuyer}
                  disabled={!buyerName.trim()}
                  icon="vpn_key"
                >
                  Create buyer key
                </Button>
              </div>
              <SecretBox value={createdBuyerKey} />
            </div>
          </Card>

          <Card title="Seller login" subtitle="Stored only in this browser" icon="key">
            <div className="space-y-3">
              <TextInput
                label="Seller API key"
                value={sellerKey}
                onChange={setSellerKey}
                placeholder="oms_seller_..."
                type="password"
              />
              <div className="flex flex-wrap gap-2">
                <Button onClick={saveSellerKey} loading={loadingSummary} icon="login">
                  Load seller workspace
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSellerKey("");
                    setSummary(null);
                    window.localStorage.removeItem(SELLER_KEY_STORAGE);
                    showMessage("Seller key cleared");
                  }}
                >
                  Clear
                </Button>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card
            title={seller ? seller.name : "Seller workspace"}
            subtitle={seller ? `Seller ID ${seller.id}` : "Load a seller key to manage accounts"}
            icon="storefront"
            action={seller ? <Badge variant="success">{seller.status}</Badge> : null}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-border bg-bg p-4">
                <p className="text-xs text-text-muted">Requests</p>
                <p className="text-2xl font-semibold text-text-main">
                  {usage?.requestCount?.toLocaleString() || "0"}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-bg p-4">
                <p className="text-xs text-text-muted">Gross charged</p>
                <p className="text-2xl font-semibold text-text-main">
                  {formatUsdFromMicro(usage?.chargedMicroUsd)}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-bg p-4">
                <p className="text-xs text-text-muted">Platform fees</p>
                <p className="text-2xl font-semibold text-text-main">
                  {formatUsdFromMicro(usage?.platformFeeMicroUsd)}
                </p>
              </div>
            </div>
          </Card>

          <Card
            title="Add AI account"
            subtitle="Attach seller-owned provider connections"
            icon="add_link"
          >
            <div className="space-y-3 rounded-xl border border-border bg-bg p-4">
              <h3 className="font-semibold text-text-main">Attach existing connection</h3>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  Provider connection
                </span>
                <select
                  value={existingConnectionId}
                  onChange={(event) => setExistingConnectionId(event.target.value)}
                  className="w-full rounded-control border border-border bg-bg px-3 py-2 text-sm text-text-main outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">Select connection</option>
                  {providerConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.displayName || connection.name || connection.provider} (
                      {connection.provider})
                    </option>
                  ))}
                </select>
              </label>
              <TextInput label="Account group" value={accountGroup} onChange={setAccountGroup} />
              <Button
                variant="secondary"
                onClick={attachExistingConnection}
                disabled={!sellerKey || !existingConnectionId.trim()}
                icon="link"
              >
                Attach connection
              </Button>
            </div>
          </Card>

          <Card title="Publish listing" subtitle="Expose a priced marketplace model" icon="sell">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  Seller connection
                </span>
                <select
                  value={listingConnectionId}
                  onChange={(event) => setListingConnectionId(event.target.value)}
                  className="w-full rounded-control border border-border bg-bg px-3 py-2 text-sm text-text-main outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">Select connection</option>
                  {(summary?.connections || []).map((connection) => (
                    <option key={connection.connectionId} value={connection.connectionId}>
                      {connection.displayName || connection.provider} (
                      {connection.connectionId.slice(0, 8)})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-text-main">Route via combo</span>
                <select
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                  value={listingComboId}
                  onChange={(e) => setListingComboId(e.target.value)}
                >
                  <option value="">— none (single model) —</option>
                  {comboOptions.map((combo) => (
                    <option key={combo.id} value={combo.id}>
                      combo: {combo.name}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-text-muted">
                  When a combo is selected, buyer requests are routed by the omniroute combo engine
                  (strategy + fallback across its targets). Otherwise the single upstream model
                  below is used.
                </span>
              </label>
              {!listingComboId && (
                <TextInput
                  label="Upstream model"
                  value={upstreamModel}
                  onChange={setUpstreamModel}
                />
              )}
              <TextInput
                label="Public model"
                value={publicModel}
                onChange={setPublicModel}
                placeholder="market/seller/model"
              />
              <TextInput
                label="Input USD / 1M tokens"
                value={inputPrice}
                onChange={setInputPrice}
                type="number"
              />
              <TextInput
                label="Output USD / 1M tokens"
                value={outputPrice}
                onChange={setOutputPrice}
                type="number"
              />
              <TextInput
                label="Platform fee bps"
                value={platformFeeBps}
                onChange={setPlatformFeeBps}
                type="number"
              />
              <TextInput label="Max RPM" value={maxRpm} onChange={setMaxRpm} type="number" />
              <TextInput
                label="Max daily tokens"
                value={maxDailyTokens}
                onChange={setMaxDailyTokens}
                type="number"
              />
            </div>
            <Button
              className="mt-4"
              onClick={createListing}
              disabled={
                !sellerKey || !listingConnectionId || (!listingComboId && !upstreamModel.trim())
              }
              icon="publish"
            >
              Publish listing
            </Button>
          </Card>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Seller accounts" subtitle="Accounts available for resale" icon="dns">
          <div className="space-y-2">
            {(summary?.connections || []).length === 0 ? (
              <p className="text-sm text-text-muted">No seller accounts yet.</p>
            ) : (
              summary!.connections.map((connection) => (
                <div
                  key={connection.connectionId}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg p-3"
                >
                  <div>
                    <p className="font-medium text-text-main">
                      {connection.displayName || connection.provider}
                    </p>
                    <p className="text-xs text-text-muted">{connection.connectionId}</p>
                    <p className="text-xs text-text-muted">Group: {connection.accountGroup}</p>
                    {connection.lastErrorMessage && (
                      <p className="mt-1 text-xs text-yellow-700 dark:text-yellow-300">
                        {connection.lastErrorCode || "last_error"}: {connection.lastErrorMessage}
                        {connection.cooldownUntil ? ` until ${connection.cooldownUntil}` : ""}
                      </p>
                    )}
                  </div>
                  <Badge>{connection.provider}</Badge>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card title="Published listings" subtitle="Models buyers can call" icon="store">
          <div className="space-y-2">
            {(summary?.listings || []).length === 0 ? (
              <p className="text-sm text-text-muted">No listings yet.</p>
            ) : (
              summary!.listings.map((listing) => (
                <div key={listing.id} className="rounded-xl border border-border bg-bg p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-text-main">{listing.publicModel}</p>
                      <p className="text-xs text-text-muted">
                        {listing.provider}/{listing.upstreamModel}
                      </p>
                    </div>
                    <Badge variant={listing.status === "active" ? "success" : "default"}>
                      {listing.cooldownUntil &&
                      new Date(listing.cooldownUntil).getTime() > Date.now()
                        ? "cooldown"
                        : listing.status}
                    </Badge>
                  </div>
                  {listing.lastErrorMessage && (
                    <div className="mt-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-300">
                      <span className="font-semibold">{listing.lastErrorCode || "last_error"}</span>
                      {": "}
                      {listing.lastErrorMessage}
                      {listing.cooldownUntil ? ` Cooling down until ${listing.cooldownUntil}.` : ""}
                    </div>
                  )}
                  <div className="mt-3 grid gap-2 text-xs text-text-muted sm:grid-cols-4">
                    <span>
                      In {priceFromMicroPerMillion(listing.inputPriceMicroUsdPerMillionTokens)}
                    </span>
                    <span>
                      Out {priceFromMicroPerMillion(listing.outputPriceMicroUsdPerMillionTokens)}
                    </span>
                    <span>{listing.tokensSold.toLocaleString()} tokens</span>
                    <span>{formatUsdFromMicro(listing.revenueMicroUsd)} gross</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
