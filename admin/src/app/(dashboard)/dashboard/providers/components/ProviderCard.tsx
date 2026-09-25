"use client";

import type { MouseEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Badge, Card, Toggle } from "@/shared/components";
import ProviderTestSlideOver from "@/shared/components/ProviderTestSlideOver";
import ProviderIcon from "@/shared/components/ProviderIcon";
import {
  isAnthropicCompatibleProvider,
  isClaudeCodeCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";

import { CategoryDot } from "./CategoryDot";

interface ProviderStats {
  total?: number;
  connected?: number;
  error?: number;
  warning?: number;
  errorCode?: string | null;
  errorTime?: string | null;
  allDisabled?: boolean;
  expiryStatus?: "expired" | "expiring_soon" | string | null;
  codexServiceTier?: "default" | "priority" | "flex" | null;
}

const KIND_LABEL: Record<string, string> = {
  llm: "Chat",
  embedding: "Embed",
  image: "Image",
  imageToText: "I→T",
  tts: "TTS",
  stt: "STT",
  webSearch: "Search",
  webFetch: "Fetch",
  video: "Video",
  music: "Music",
};

interface ProviderCardProps {
  providerId: string;
  provider: {
    id?: string;
    name: string;
    color?: string;
    apiType?: string;
    deprecated?: boolean;
    deprecationReason?: string;
    hasFree?: boolean;
    freeNote?: string;
    subscriptionRisk?: boolean;
    /** Declared service kinds — "llm" enables the inline Test button */
    serviceKinds?: string[];
  };
  stats: ProviderStats;
  authType?: string;
  onToggle: (active: boolean) => void;
}

const DOT_COLORS: Record<string, string> = {
  free: "bg-green-500",
  "no-auth": "bg-stone-500",
  oauth: "bg-blue-500",
  apikey: "bg-amber-500",
  compatible: "bg-orange-500",
  "web-cookie": "bg-purple-500",
  search: "bg-teal-500",
  audio: "bg-rose-500",
  local: "bg-emerald-500",
  "upstream-proxy": "bg-indigo-500",
  "cloud-agent": "bg-violet-500",
};

type ProviderMessageTranslator = ((key: string, values?: Record<string, unknown>) => string) & {
  has?: (key: string) => boolean;
};

function providerText(
  t: ProviderMessageTranslator,
  key: string,
  fallback: string,
  values?: Record<string, unknown>
): string {
  if (typeof t.has === "function" && t.has(key)) {
    return t(key, values);
  }
  if (values) {
    return Object.entries(values).reduce(
      (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
      fallback
    );
  }
  return fallback;
}

function getStatusDisplay(
  connected: number,
  error: number,
  warning: number,
  errorCode: string | null | undefined,
  t: ReturnType<typeof useTranslations>,
  afterConnected?: ReactNode
) {
  const parts: ReactNode[] = [];
  if (connected > 0) {
    parts.push(
      <Badge key="connected" variant="success" size="sm" dot>
        {t("connected", { count: connected })}
      </Badge>
    );
    if (afterConnected) parts.push(afterConnected);
  }
  if (warning > 0) {
    parts.push(
      <Badge key="warning" variant="warning" size="sm" dot>
        {t("warningCount", { count: warning })}
      </Badge>
    );
  }
  if (error > 0) {
    const errText = errorCode
      ? t("errorCount", { count: error, code: errorCode })
      : t("errorCountNoCode", { count: error });
    parts.push(
      <Badge key="error" variant="error" size="sm" dot>
        {errText}
      </Badge>
    );
  }
  if (parts.length === 0) {
    return <span className="text-text-muted">{t("noConnections")}</span>;
  }
  return parts;
}

export default function ProviderCard({
  providerId,
  provider,
  stats,
  authType = "apikey",
  onToggle,
}: ProviderCardProps) {
  const t = useTranslations("providers");
  const tc = useTranslations("common");
  const tp = useTranslations("miniPlayground");
  const [testExpanded, setTestExpanded] = useState<boolean>(false);
  const [balanceOpen, setBalanceOpen] = useState<boolean>(false);
  const [balanceData, setBalanceData] = useState<{
    connections?: Array<Record<string, unknown>>;
  } | null>(null);
  const [balanceLoading, setBalanceLoading] = useState<boolean>(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  // Latency aggregates (24h): upstream TTFT + total client latency.
  const [latency, setLatency] = useState<{
    requests?: number;
    upstreamTtftMs?: number;
    clientLatencyMs?: number;
    successRate?: number | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/latency`, {
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data && Number(data.requests) > 0) setLatency(data);
      } catch {
        /* metrics are best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const fetchBalance = async (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setBalanceOpen((v) => !v);
    if (balanceData || balanceLoading) return;
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const res = await fetch(
        `/api/providers/${encodeURIComponent(providerId)}/balance`,
        { credentials: "same-origin" }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setBalanceError(data?.error?.message ?? `HTTP ${res.status}`);
      } else {
        setBalanceData(data);
      }
    } catch {
      setBalanceError("network error");
    } finally {
      setBalanceLoading(false);
    }
  };

  // Show the Test button for LLM providers (when serviceKinds includes "llm"
  // OR when the provider has no explicit serviceKinds but is a regular LLM provider
  // i.e. not a search/audio/cloud-agent type).
  const serviceKinds = provider.serviceKinds ?? [];
  const isLlmProvider =
    serviceKinds.includes("llm") ||
    (serviceKinds.length === 0 &&
      authType !== "search" &&
      authType !== "audio" &&
      authType !== "cloud-agent" &&
      authType !== "upstream-proxy" &&
      authType !== "no-auth");

  const handleTestClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setTestExpanded((v) => !v);
  };
  const connected = Number(stats.connected || 0);
  const error = Number(stats.error || 0);
  const allDisabled = Boolean(stats.allDisabled);
  const isCompatible = isOpenAICompatibleProvider(providerId);
  const isCcCompatible = isClaudeCodeCompatibleProvider(providerId);
  const isAnthropicCompatible = isAnthropicCompatibleProvider(providerId) && !isCcCompatible;
  const codexServiceTierLabel =
    stats.codexServiceTier === "flex"
      ? providerText(t, "codexTierFlexLabel", "Flex")
      : providerText(t, "codexTierFastLabel", "Fast");
  const codexServiceTierChip =
    providerId === "codex" && stats.codexServiceTier && stats.codexServiceTier !== "default" ? (
      <span
        key="codex-service-tier"
        className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide ${
          stats.codexServiceTier === "flex"
            ? "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400"
            : "bg-sky-500/10 text-sky-600 dark:text-sky-400"
        }`}
        title={providerText(t, "codexServiceTierActive", "Codex {tier} service tier is active", {
          tier: codexServiceTierLabel,
        })}
      >
        <span className="material-symbols-outlined text-[10px] leading-none">
          {stats.codexServiceTier === "flex" ? "speed" : "bolt"}
        </span>
        {codexServiceTierLabel}
      </span>
    ) : null;

  const dotLabels: Record<string, string> = {
    free: tc("free"),
    "no-auth": t("noAuthLabel"),
    oauth: t("oauthLabel"),
    apikey: t("apiKeyLabel"),
    compatible: t("compatibleLabel"),
    "web-cookie": t("webCookieProviders"),
    search: t("searchProvidersHeading"),
    audio: t("audioProvidersHeading"),
    local: t("localProviders"),
    "upstream-proxy": t("upstreamProxyProviders"),
    "cloud-agent": t("cloudAgentProviders"),
  };

  const staticIconPath = (() => {
    if (isCompatible) {
      return provider.apiType === "responses" ? "/providers/oai-r.png" : "/providers/oai-cc.png";
    }
    if (isAnthropicCompatible || isCcCompatible) return "/providers/anthropic-m.png";
    return null;
  })();

  const handleToggle = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onToggle(allDisabled);
  };

  return (
    <div className="flex flex-col h-full">
      <Link href={`/dashboard/providers/${providerId}`} className="group flex-1 flex flex-col">
        <Card
          padding="xs"
          className={`h-full flex flex-col hover:bg-black/5 dark:hover:bg-white/5 hover:border-primary/40 transition-colors cursor-pointer ${allDisabled ? "opacity-50" : ""} ${provider.deprecated ? "opacity-60" : ""}`}
        >
          <div className="flex flex-col gap-2 h-full">
            {/* Row 1 — Identity: icon + full name + risk/category indicators */}
            <div className="flex items-start gap-3 min-w-0">
              <div
                className="size-9 rounded-lg flex items-center justify-center shrink-0"
                style={{ backgroundColor: `${provider.color || "#64748b"}15` }}
              >
                {staticIconPath ? (
                  <Image
                    src={staticIconPath}
                    alt={provider.name}
                    width={26}
                    height={26}
                    className="object-contain rounded-lg max-w-[26px] max-h-[26px]"
                    sizes="26px"
                  />
                ) : (
                  <ProviderIcon providerId={provider.id || providerId} size={24} type="color" />
                )}
              </div>
              <h3 className="text-sm font-semibold leading-snug flex-1 min-w-0">
                <span
                  className={`block break-words ${provider.deprecated ? "line-through opacity-60" : ""}`}
                  title={provider.name}
                >
                  {provider.name}
                </span>
              </h3>
              <div className="flex items-center gap-1 shrink-0 pt-0.5">
                {provider.deprecated && (
                  <span
                    className="material-symbols-outlined text-[16px] leading-none text-text-muted"
                    title={provider.deprecationReason || t("deprecatedProvider")}
                    aria-label={t("deprecated")}
                  >
                    block
                  </span>
                )}
                {provider.subscriptionRisk === true && (
                  <span
                    className="material-symbols-outlined text-[16px] leading-none text-amber-500"
                    title={t("riskNotice.tooltip")}
                    aria-label={t("riskNotice.tooltip")}
                  >
                    info
                  </span>
                )}
                <CategoryDot
                  color={DOT_COLORS[authType] || DOT_COLORS.apikey}
                  hasFree={provider.hasFree === true}
                  label={dotLabels[authType] || t("apiKeyLabel")}
                  freeLabel={t("hasFreeTooltip")}
                />
              </div>
            </div>

            {/* Row 2 — Capabilities: service-kind chips + compatibility badges (deprecated shown as block icon in Row 1 header). Rendered only when content exists. */}
            {((provider.serviceKinds && provider.serviceKinds.length > 0) ||
              isCompatible ||
              isCcCompatible ||
              isAnthropicCompatible) && (
              <div className="flex flex-wrap items-center gap-1">
                {provider.serviceKinds?.map((k) => (
                  <span
                    key={k}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-bg-subtle border border-border text-text-muted leading-none"
                  >
                    {KIND_LABEL[k] ?? k}
                  </span>
                ))}
                {isCompatible && (
                  <Badge variant="default" size="sm">
                    {provider.apiType === "responses" ? t("responses") : t("chat")}
                  </Badge>
                )}
                {isCcCompatible && (
                  <Badge variant="default" size="sm">
                    CC
                  </Badge>
                )}
                {isAnthropicCompatible && (
                  <Badge variant="default" size="sm">
                    {t("messages")}
                  </Badge>
                )}
              </div>
            )}

            {/* Row 3 — Footer: connection status + controls (toggle, test) */}
            <div className="flex items-center justify-between gap-2 mt-auto pt-1.5 border-t border-border/40">
              {latency && (
                <div
                  className="flex items-center gap-2 text-[10px] text-text-muted font-mono"
                  title="Avg over last 24h: upstream time-to-first-token / total client latency"
                >
                  <span className="material-symbols-outlined text-[11px] leading-none">speed</span>
                  <span title="Us → provider (time to first token)">
                    ↑{latency.upstreamTtftMs != null ? (latency.upstreamTtftMs / 1000).toFixed(1) : "—"}s
                  </span>
                  <span title="Us → client (total request duration)">
                    ↓{latency.clientLatencyMs != null ? (latency.clientLatencyMs / 1000).toFixed(1) : "—"}s
                  </span>
                  <span className="text-text-muted/60">24h</span>
                </div>
              )}
              <div className="flex items-center gap-1.5 text-xs flex-nowrap min-w-0 overflow-hidden">
                {allDisabled ? (
                  <Badge variant="default" size="sm">
                    <span className="flex items-center gap-1">
                      <span className="material-symbols-outlined text-[12px]">pause_circle</span>
                      {t("disabled")}
                    </span>
                  </Badge>
                ) : (
                  <>
                    {getStatusDisplay(
                      connected,
                      error,
                      Number(stats.warning || 0),
                      stats.errorCode,
                      t,
                      codexServiceTierChip
                    )}
                    {stats.expiryStatus === "expired" && (
                      <Badge variant="error" size="sm" dot>
                        {t("expiredBadge")}
                      </Badge>
                    )}
                    {stats.expiryStatus === "expiring_soon" && (
                      <Badge variant="warning" size="sm" dot>
                        {t("expiringSoonBadge")}
                      </Badge>
                    )}
                    {stats.errorTime && (
                      <span className="text-text-muted truncate min-w-0">* {stats.errorTime}</span>
                    )}
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {Number(stats.total || 0) > 0 && (
                  <div onClick={handleToggle}>
                    <Toggle
                      size="xs"
                      checked={!allDisabled}
                      onChange={() => {}}
                      title={allDisabled ? t("enableProvider") : t("disableProvider")}
                    />
                  </div>
                )}
                {isLlmProvider && (
                  <button
                    type="button"
                    onClick={handleTestClick}
                    title={tp("expandTest")}
                    className="inline-flex items-center gap-0.5 rounded-md border border-border bg-bg-subtle px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary hover:border-primary/30 transition-colors"
                  >
                    <span className="material-symbols-outlined text-[11px] leading-none">
                      play_arrow
                    </span>
                    {tp("testLabel")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={fetchBalance}
                  title="Balance / reconciliation"
                  className="inline-flex items-center gap-0.5 rounded-md border border-border bg-bg-subtle px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary hover:border-primary/30 transition-colors"
                >
                  <span className="material-symbols-outlined text-[11px] leading-none">
                    account_balance_wallet
                  </span>
                  Balance
                </button>
                {!isLlmProvider && (
                  <span className="material-symbols-outlined text-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
                    chevron_right
                  </span>
                )}
              </div>
            </div>
          </div>
        </Card>
      </Link>
      {balanceOpen && (
        <div
          className="mt-1 rounded-lg border border-border bg-surface p-3 text-xs space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          {balanceLoading && <div className="text-text-muted">Loading balance…</div>}
          {balanceError && <div className="text-red-500">{balanceError}</div>}
          {!balanceLoading &&
            !balanceError &&
            (balanceData?.connections ?? []).map((c, i) => {
              const conn = String(c.connection ?? `#${i}`);
              const err = typeof c.error === "string" ? c.error : null;
              const prov = c.provider as
                | {
                    usd?: { limit?: number; used?: number; remaining?: number };
                    tokensEquivalent?: {
                      total?: number;
                      usedByCost?: number;
                      remaining?: number;
                    };
                    rawTokensReported?: number | null;
                  }
                | undefined;
              const local = c.local as { tokensUsed?: number; requests?: number } | undefined;
              const rec = c.reconciliation as { deltaTokens?: number | null } | undefined;
              const fmt = (n?: number | null) =>
                typeof n === "number" ? n.toLocaleString("en-US") : "—";
              return (
                <div key={conn} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{conn}</span>
                    {c.valid != null && (
                      <span
                        className={
                          c.valid
                            ? "text-green-600 dark:text-green-400"
                            : "text-red-500"
                        }
                      >
                        {c.valid ? "active" : "inactive"}
                      </span>
                    )}
                  </div>
                  {err && <div className="text-red-500">{err}</div>}
                  {prov?.tokensEquivalent && (
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded bg-black/5 dark:bg-white/5 p-1.5">
                        <div className="text-[10px] text-text-muted">Total</div>
                        <div className="font-mono">{fmt(prov.tokensEquivalent.total)}</div>
                      </div>
                      <div className="rounded bg-black/5 dark:bg-white/5 p-1.5">
                        <div className="text-[10px] text-text-muted">Used</div>
                        <div className="font-mono">{fmt(prov.tokensEquivalent.usedByCost)}</div>
                      </div>
                      <div className="rounded bg-black/5 dark:bg-white/5 p-1.5">
                        <div className="text-[10px] text-text-muted">Remaining</div>
                        <div className="font-mono">{fmt(prov.tokensEquivalent.remaining)}</div>
                      </div>
                    </div>
                  )}
                  {local && (
                    <div className="text-text-muted">
                      Local: {fmt(local.tokensUsed)} tokens / {fmt(local.requests)} req
                      {rec?.deltaTokens != null && (
                        <span className={rec.deltaTokens < 0 ? " text-amber-500" : ""}>
                          {" "}· Δ {rec.deltaTokens > 0 ? "+" : ""}
                          {fmt(rec.deltaTokens)}
                        </span>
                      )}
                    </div>
                  )}
                  {typeof c.expiresAt === "string" && (
                    <div className="text-text-muted">Expires: {c.expiresAt.slice(0, 10)}</div>
                  )}
                </div>
              );
            })}
          {!balanceLoading &&
            !balanceError &&
            (balanceData?.connections ?? []).length === 0 && (
              <div className="text-text-muted">No active connections</div>
            )}
        </div>
      )}
      {isLlmProvider && (
        <ProviderTestSlideOver
          isOpen={testExpanded}
          onClose={() => setTestExpanded(false)}
          providerId={providerId}
          provider={provider}
          staticIconPath={staticIconPath}
        />
      )}

    </div>
  );
}
