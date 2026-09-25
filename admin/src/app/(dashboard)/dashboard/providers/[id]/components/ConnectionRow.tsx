"use client";

// Phase 1d extraction — Issue #3501
// ConnectionRow (and its local helpers CooldownTimer, inferErrorType,
// getStatusPresentation) moved out of ProviderDetailPageClient.tsx.

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Toggle } from "@/shared/components";
import { pickDisplayValue } from "@/shared/utils/maskEmail";
import useEmailPrivacyStore from "@/store/emailPrivacyStore";
import { isClaudeExtraUsageBlockEnabled } from "@/lib/providers/claudeExtraUsage";
import { shouldShowConnectionLastError } from "./connectionRowHelpers";
import {
  getCodexEffectiveServiceTier,
  type CodexGlobalServiceMode,
} from "@/lib/providers/codexFastTier";
import { normalizeCodexLimitPolicy, providerText, ERROR_TYPE_LABELS } from "../providerPageHelpers";

// ---------------------------------------------------------------------------
// Types (exported so the client can reference them without re-importing)
// ---------------------------------------------------------------------------

export interface ConnectionRowConnection {
  id?: string;
  name?: string;
  email?: string;
  displayName?: string;
  rateLimitedUntil?: string;
  rateLimitProtection?: boolean;
  testStatus?: string;
  isActive?: boolean;
  priority?: number;
  lastError?: string;
  lastErrorType?: string;
  lastErrorSource?: string;
  errorCode?: string | number;
  globalPriority?: number;
  providerSpecificData?: Record<string, unknown>;
  expiresAt?: string;
  tokenExpiresAt?: string;
  maxConcurrent?: number | null;
  authType?: string;
  proxyEnabled?: boolean;
  perKeyProxyEnabled?: boolean;
}

export interface ConnectionRowProps {
  providerId?: string;
  connection: ConnectionRowConnection;
  isOAuth: boolean;
  isClaude?: boolean;
  isCodex?: boolean;
  isGeminiCli?: boolean;
  codexGlobalServiceMode?: CodexGlobalServiceMode;
  isFirst: boolean;
  isLast: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleActive: (isActive?: boolean) => void | Promise<void>;
  onToggleRateLimit: (enabled?: boolean) => void;
  onToggleClaudeExtraUsage?: (enabled?: boolean) => void;
  onToggleCodex5h?: (enabled?: boolean) => void;
  onToggleCodexWeekly?: (enabled?: boolean) => void;
  isCcCompatible?: boolean;
  cliproxyapiEnabled?: boolean;
  onToggleCliproxyapiMode?: (enabled?: boolean) => void;
  onRetest: () => void;
  isRetesting?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onReauth?: () => void;
  onProxy?: () => void;
  hasProxy?: boolean;
  proxySource?: string;
  proxyHost?: string;
  proxyEnabled?: boolean;
  perKeyProxyEnabled?: boolean;
  onToggleProxyEnabled?: (enabled: boolean) => void;
  onTogglePerKeyProxyEnabled?: (enabled: boolean) => void;
  onRefreshToken?: () => void;
  isRefreshing?: boolean;
  onApplyCodexAuthLocal?: () => void;
  isApplyingCodexAuthLocal?: boolean;
  onExportCodexAuthFile?: () => void;
  isExportingCodexAuthFile?: boolean;
  onApplyClaudeAuthLocal?: () => void;
  isApplyingClaudeAuthLocal?: boolean;
  onExportClaudeAuthFile?: () => void;
  isExportingClaudeAuthFile?: boolean;
  onApplyGeminiAuthLocal?: () => void;
  isApplyingGeminiAuthLocal?: boolean;
  onExportGeminiAuthFile?: () => void;
  isExportingGeminiAuthFile?: boolean;
}

// ---------------------------------------------------------------------------
// CooldownTimerProps (local — only used below)
// ---------------------------------------------------------------------------

interface CooldownTimerProps {
  until: string | number | Date;
}

// ---------------------------------------------------------------------------
// CooldownTimer
// ---------------------------------------------------------------------------

function CooldownTimer({ until }: CooldownTimerProps) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    const updateRemaining = () => {
      const diff = new Date(until).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining("");
        return;
      }
      const secs = Math.floor(diff / 1000);
      if (secs < 60) {
        setRemaining(`${secs}s`);
      } else if (secs < 3600) {
        setRemaining(`${Math.floor(secs / 60)}m ${secs % 60}s`);
      } else {
        const hrs = Math.floor(secs / 3600);
        const mins = Math.floor((secs % 3600) / 60);
        setRemaining(`${hrs}h ${mins}m`);
      }
    };

    updateRemaining();
    const interval = setInterval(updateRemaining, 1000);
    return () => clearInterval(interval);
  }, [until]);

  if (!remaining) return null;

  return <span className="text-xs text-orange-500 font-mono">⏱ {remaining}</span>;
}

// ---------------------------------------------------------------------------
// inferErrorType
// ---------------------------------------------------------------------------

function inferErrorType(connection: ConnectionRowConnection, isCooldown: boolean): string | null {
  if (isCooldown) return "upstream_rate_limited";
  if (connection.testStatus === "banned") return "banned";
  if (connection.testStatus === "credits_exhausted") return "credits_exhausted";
  if (connection.lastErrorType) return connection.lastErrorType;

  const code = Number(connection.errorCode);
  if (code === 401 || code === 403) return "upstream_auth_error";
  if (code === 429) return "upstream_rate_limited";
  if (code >= 500) return "upstream_unavailable";

  const msg = (connection.lastError || "").toLowerCase();
  if (!msg) return null;
  if (
    msg.includes("runtime") ||
    msg.includes("not runnable") ||
    msg.includes("not installed") ||
    msg.includes("healthcheck")
  )
    return "runtime_error";
  if (msg.includes("refresh failed")) return "token_refresh_failed";
  if (msg.includes("token expired") || msg.includes("expired")) return "token_expired";
  if (
    msg.includes("invalid api key") ||
    msg.includes("token invalid") ||
    msg.includes("revoked") ||
    msg.includes("access denied") ||
    msg.includes("unauthorized")
  )
    return "upstream_auth_error";
  if (
    msg.includes("rate limit") ||
    msg.includes("quota") ||
    msg.includes("too many requests") ||
    msg.includes("429")
  )
    return "upstream_rate_limited";
  if (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("econn") ||
    msg.includes("enotfound")
  )
    return "network_error";
  if (msg.includes("not supported")) return "unsupported";
  return "upstream_error";
}

// ---------------------------------------------------------------------------
// getStatusPresentation
// ---------------------------------------------------------------------------

type TFn = (key: string, values?: Record<string, unknown>) => string;

function getStatusPresentation(
  connection: ConnectionRowConnection,
  effectiveStatus: string | undefined,
  isCooldown: boolean,
  t: TFn
) {
  if (connection.isActive === false) {
    return {
      statusVariant: "default",
      statusLabel: t("statusDisabled"),
      errorType: null,
      errorBadge: null,
      errorTextClass: "text-text-muted",
    };
  }

  if (effectiveStatus === "active" || effectiveStatus === "success") {
    return {
      statusVariant: "success",
      statusLabel: t("statusConnected"),
      errorType: null,
      errorBadge: null,
      errorTextClass: "text-text-muted",
    };
  }

  const errorType = inferErrorType(connection, isCooldown);
  const errorBadge = errorType ? ERROR_TYPE_LABELS[errorType] || null : null;

  if (errorType === "runtime_error") {
    return {
      statusVariant: "warning",
      statusLabel: t("statusRuntimeIssue"),
      errorType,
      errorBadge,
      errorTextClass: "text-yellow-600 dark:text-yellow-400",
    };
  }

  if (errorType === "account_deactivated") {
    return {
      statusVariant: "error",
      statusLabel: t("statusDeactivated", "Deactivated"),
      errorType,
      errorBadge,
      errorTextClass: "text-red-600 font-bold",
    };
  }

  if (
    errorType === "upstream_auth_error" ||
    errorType === "auth_missing" ||
    errorType === "token_refresh_failed" ||
    errorType === "token_expired"
  ) {
    return {
      statusVariant: "error",
      statusLabel: t("statusAuthFailed"),
      errorType,
      errorBadge,
      errorTextClass: "text-red-500",
    };
  }

  if (errorType === "upstream_rate_limited") {
    return {
      statusVariant: "warning",
      statusLabel: t("statusRateLimited"),
      errorType,
      errorBadge,
      errorTextClass: "text-yellow-600 dark:text-yellow-400",
    };
  }

  if (errorType === "network_error") {
    return {
      statusVariant: "warning",
      statusLabel: t("statusNetworkIssue"),
      errorType,
      errorBadge,
      errorTextClass: "text-yellow-600 dark:text-yellow-400",
    };
  }

  if (errorType === "unsupported") {
    return {
      statusVariant: "default",
      statusLabel: t("statusTestUnsupported"),
      errorType,
      errorBadge,
      errorTextClass: "text-text-muted",
    };
  }

  if (errorType === "banned") {
    return {
      statusVariant: "error",
      statusLabel: t("statusBanned", "Banned (403)"),
      errorType,
      errorBadge,
      errorTextClass: "text-red-600 font-bold",
    };
  }

  if (errorType === "credits_exhausted") {
    return {
      statusVariant: "warning",
      statusLabel: t("statusCreditsExhausted", "Out of Credits"),
      errorType,
      errorBadge,
      errorTextClass: "text-amber-500",
    };
  }

  const fallbackStatusMap: Record<string, string> = {
    unavailable: t("statusUnavailable"),
    failed: t("statusFailed"),
    error: t("statusError"),
  };

  return {
    statusVariant: "error",
    statusLabel: fallbackStatusMap[effectiveStatus ?? ""] || effectiveStatus || t("statusError"),
    errorType,
    errorBadge,
    errorTextClass: "text-red-500",
  };
}

// ---------------------------------------------------------------------------
// ConnectionRow
// ---------------------------------------------------------------------------

export default function ConnectionRow({
  connection,
  providerId,
  isOAuth,
  isClaude,
  isCodex,
  isGeminiCli,
  codexGlobalServiceMode,
  isCcCompatible,
  cliproxyapiEnabled,
  isFirst,
  isLast,
  isSelected,
  onToggleSelect,
  onMoveUp,
  onMoveDown,
  onToggleActive,
  onToggleRateLimit,
  onToggleClaudeExtraUsage,
  onToggleCodex5h,
  onToggleCodexWeekly,
  onToggleCliproxyapiMode,
  onRetest,
  isRetesting,
  onEdit,
  onDelete,
  onReauth,
  onProxy,
  hasProxy,
  proxySource,
  proxyHost,
  onRefreshToken,
  isRefreshing,
  onApplyCodexAuthLocal,
  isApplyingCodexAuthLocal,
  onExportCodexAuthFile,
  isExportingCodexAuthFile,
  onApplyClaudeAuthLocal,
  isApplyingClaudeAuthLocal,
  onExportClaudeAuthFile,
  isExportingClaudeAuthFile,
  onApplyGeminiAuthLocal,
  isApplyingGeminiAuthLocal,
  onExportGeminiAuthFile,
  isExportingGeminiAuthFile,
  perKeyProxyEnabled,
  onTogglePerKeyProxyEnabled,
  proxyEnabled,
  onToggleProxyEnabled,
}: ConnectionRowProps) {
  const t = useTranslations("providers");
  const emailsVisible = useEmailPrivacyStore((s) => s.emailsVisible);
  const displayName = isOAuth
    ? pickDisplayValue(
        [connection.name, connection.email, connection.displayName],
        emailsVisible,
        t("oauthAccount")
      )
    : connection.name;
  const applyCodexAuthLabel =
    typeof t.has === "function" && t.has("applyCodexAuthLocal")
      ? t("applyCodexAuthLocal")
      : "Apply auth";
  const exportCodexAuthLabel =
    typeof t.has === "function" && t.has("exportCodexAuthFile")
      ? t("exportCodexAuthFile")
      : "Export auth";
  const applyClaudeAuthLabel =
    typeof t.has === "function" && t.has("applyClaudeAuthLocal")
      ? t("applyClaudeAuthLocal")
      : "Apply auth";
  const exportClaudeAuthLabel =
    typeof t.has === "function" && t.has("exportClaudeAuthFile")
      ? t("exportClaudeAuthFile")
      : "Export auth";
  const applyGeminiAuthLabel =
    typeof t.has === "function" && t.has("applyGeminiAuthLocal")
      ? t("applyGeminiAuthLocal")
      : "Apply auth";
  const exportGeminiAuthLabel =
    typeof t.has === "function" && t.has("exportGeminiAuthFile")
      ? t("exportGeminiAuthFile")
      : "Export auth";

  // Use useState + useEffect for impure Date.now() to avoid calling during render
  const [isCooldown, setIsCooldown] = useState(false);
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [balanceData, setBalanceData] = useState<Record<string, unknown> | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  // Inline usage badge: cheap localOnly fetch on mount (no upstream call).
  const [inlineUsage, setInlineUsage] = useState<{
    tokensUsed?: number;
    tokensTotal?: number;
    capturedAt?: string;
  } | null>(null);
  // Per-connection latency aggregates (24h): upstream TTFT + total client time.
  const [inlineLatency, setInlineLatency] = useState<{
    upstreamTtftMs?: number;
    clientLatencyMs?: number;
  } | null>(null);

  useEffect(() => {
    if (!providerId || !connection.id) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/providers/${encodeURIComponent(providerId)}/balance?connection=${encodeURIComponent(connection.id ?? "")}&localOnly=1`,
          { credentials: "same-origin" }
        );
        if (!res.ok) return;
        const data = (await res.json()) as { connections?: Array<Record<string, unknown>> } | null;
        const c = data?.connections?.[0];
        if (!c || cancelled) return;
        const local = c.local as { tokensUsed?: number } | undefined;
        const cached = c.cachedProviderTotals as
          | { tokens_total?: number; capturedAt?: string }
          | undefined;
        setInlineUsage({
          tokensUsed: local?.tokensUsed,
          tokensTotal: cached?.tokens_total,
          capturedAt: cached?.capturedAt,
        });
      } catch {
        /* badge is best-effort */
      }
      try {
        const res = await fetch(
          `/api/providers/${encodeURIComponent(providerId)}/latency?connection=${encodeURIComponent(connection.id ?? "")}`,
          { credentials: "same-origin" }
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          requests?: number;
          upstreamTtftMs?: number;
          clientLatencyMs?: number;
        } | null;
        if (!data || cancelled) return;
        setInlineLatency(
          Number(data.requests) > 0
            ? { upstreamTtftMs: data.upstreamTtftMs, clientLatencyMs: data.clientLatencyMs }
            : null
        );
      } catch {
        /* badge is best-effort */
      }
    };
    load();
    // Refresh the badge in the background every minute — but only while the
    // page is open AND the tab is visible. On tab re-focus, refresh at once.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [providerId, connection.id]);
  // T12: token expiry status — lazy init avoids calling Date.now() during render;
  // updates every 30s via interval only (no sync setState in effect body).
  // Prefer tokenExpiresAt (updated on each refresh) over expiresAt (original grant date).
  const effectiveExpiresAt = connection.tokenExpiresAt || connection.expiresAt;
  const getTokenMinsLeft = () => {
    if (!isOAuth || !effectiveExpiresAt) return null;
    const expiresMs = new Date(effectiveExpiresAt).getTime();
    return Math.floor((expiresMs - Date.now()) / 60000);
  };
  const [tokenMinsLeft, setTokenMinsLeft] = useState<number | null>(getTokenMinsLeft);

  useEffect(() => {
    if (!isOAuth || !effectiveExpiresAt) return;
    const update = () => {
      const expiresMs = new Date(effectiveExpiresAt).getTime();
      setTokenMinsLeft(Math.floor((expiresMs - Date.now()) / 60000));
    };
    update();
    const iv = setInterval(update, 30000);
    return () => clearInterval(iv);
  }, [isOAuth, effectiveExpiresAt]);

  useEffect(() => {
    const checkCooldown = () => {
      const cooldown =
        connection.rateLimitedUntil && new Date(connection.rateLimitedUntil).getTime() > Date.now();
      setIsCooldown(!!cooldown);
    };

    checkCooldown();
    // Update every second while in cooldown
    const interval = connection.rateLimitedUntil ? setInterval(checkCooldown, 1000) : null;
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [connection.rateLimitedUntil]);

  // Determine effective status (override unavailable if cooldown expired)
  const effectiveStatus =
    connection.testStatus === "unavailable" && !isCooldown
      ? "active" // Cooldown expired → treat as active
      : connection.testStatus;

  const statusPresentation = getStatusPresentation(connection, effectiveStatus, isCooldown, t);
  const rateLimitEnabled = !!connection.rateLimitProtection;
  const codexPolicy =
    connection.providerSpecificData &&
    typeof connection.providerSpecificData === "object" &&
    connection.providerSpecificData.codexLimitPolicy &&
    typeof connection.providerSpecificData.codexLimitPolicy === "object"
      ? connection.providerSpecificData.codexLimitPolicy
      : {};
  const normalizedCodexPolicy = normalizeCodexLimitPolicy(codexPolicy);
  const codex5hEnabled = normalizedCodexPolicy.use5h;
  const codexWeeklyEnabled = normalizedCodexPolicy.useWeekly;
  const codexServiceTier = isCodex
    ? getCodexEffectiveServiceTier(
        connection.providerSpecificData,
        codexGlobalServiceMode ?? "none"
      )
    : "default";
  const codexServiceTierIsGlobal =
    isCodex && codexGlobalServiceMode !== undefined && codexGlobalServiceMode !== "none";
  const codexServiceTierBadge =
    codexServiceTier === "priority"
      ? {
          label: providerText(t, "codexTierFastLabel", "Fast"),
          icon: "bolt",
          className: "bg-sky-500/15 text-sky-500",
          title: codexServiceTierIsGlobal
            ? providerText(
                t,
                "providerDetailGlobalPriorityActive",
                "Global Codex priority service tier is active"
              )
            : providerText(
                t,
                "providerDetailConnectionPriorityActive",
                "Codex priority service tier is active for this connection"
              ),
        }
      : codexServiceTier === "flex"
        ? {
            label: providerText(t, "codexTierFlexLabel", "Flex"),
            icon: "speed",
            className: "bg-cyan-500/15 text-cyan-500",
            title: codexServiceTierIsGlobal
              ? providerText(
                  t,
                  "providerDetailGlobalFlexActive",
                  "Global Codex flex service tier is active"
                )
              : providerText(
                  t,
                  "providerDetailConnectionFlexActive",
                  "Codex flex service tier is active for this connection"
                ),
          }
        : null;
  const claudeBlockExtraUsageEnabled = isClaude
    ? isClaudeExtraUsageBlockEnabled("claude", connection.providerSpecificData)
    : false;
  const cliproxyapiDeepMode = !!cliproxyapiEnabled;

  return (
    <div
      className={`group flex items-center justify-between p-3 rounded-lg hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors ${connection.isActive === false ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            className="w-4 h-4 shrink-0 rounded border-border text-primary focus:ring-primary/30 cursor-pointer"
          />
        )}
        {/* Priority arrows */}
        <div className="flex flex-col">
          <button
            onClick={onMoveUp}
            disabled={isFirst}
            className={`p-0.5 rounded ${isFirst ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}
          >
            <span className="material-symbols-outlined text-sm">keyboard_arrow_up</span>
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast}
            className={`p-0.5 rounded ${isLast ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}
          >
            <span className="material-symbols-outlined text-sm">keyboard_arrow_down</span>
          </button>
        </div>
        <span className="material-symbols-outlined text-base text-text-muted">
          {isOAuth ? "lock" : "key"}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{displayName}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Badge variant={statusPresentation.statusVariant as any} size="sm" dot>
              {statusPresentation.statusLabel}
            </Badge>
            {/* T12: Token expiry status indicator (state-driven, no Date.now in render) */}
            {tokenMinsLeft !== null &&
              (tokenMinsLeft < 0 ? (
                <span
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium bg-red-500/15 text-red-500"
                  title={t("tokenExpiredTitle", { date: effectiveExpiresAt })}
                >
                  <span className="material-symbols-outlined text-[11px]">error</span>
                  {t("tokenExpiredBadge")}
                </span>
              ) : tokenMinsLeft < 30 ? (
                <span
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium bg-amber-500/15 text-amber-500"
                  title={t("tokenExpiresSoonTitle", { minutes: tokenMinsLeft })}
                >
                  <span className="material-symbols-outlined text-[11px]">warning</span>
                  {`~${tokenMinsLeft}m`}
                </span>
              ) : null)}
            {isCooldown && connection.isActive !== false && (
              <CooldownTimer until={connection.rateLimitedUntil!} />
            )}
            {statusPresentation.errorBadge && connection.isActive !== false && (
              <Badge variant={statusPresentation.errorBadge.variant} size="sm">
                {t(statusPresentation.errorBadge.labelKey)}
              </Badge>
            )}
            {shouldShowConnectionLastError(connection) && (
              <span
                className={`text-xs truncate max-w-[300px] ${statusPresentation.errorTextClass}`}
                title={connection.lastError}
              >
                {connection.lastError}
              </span>
            )}
            <span className="text-xs text-text-muted">#{connection.priority}</span>
            {inlineLatency && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-sky-500/10 text-sky-600 dark:text-sky-400 font-mono"
                title="Avg 24h: ↑ us→provider (TTFT) · ↓ us→client (total)"
              >
                <span className="material-symbols-outlined text-[12px] leading-none">speed</span>
                <span title="Us → provider (time to first token)">
                  ↑{((inlineLatency.upstreamTtftMs ?? 0) / 1000).toFixed(1)}s
                </span>
                <span title="Us → client (total request duration)">
                  ↓{((inlineLatency.clientLatencyMs ?? 0) / 1000).toFixed(1)}s
                </span>
              </span>
            )}
            {inlineUsage && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary"
                title={
                  inlineUsage.tokensTotal != null
                    ? `Local usage / key budget (cached ${String(inlineUsage.capturedAt ?? "").slice(0, 10)})`
                    : "Local token usage"
                }
              >
                <span className="material-symbols-outlined text-[12px]">toll</span>
                <span className="font-mono">
                  {(inlineUsage.tokensUsed ?? 0).toLocaleString("en-US")}
                  {inlineUsage.tokensTotal != null && (
                    <> / {inlineUsage.tokensTotal.toLocaleString("en-US")}</>
                  )}
                </span>
              </span>
            )}
            {connection.globalPriority && (
              <span className="text-xs text-text-muted">
                {t("autoPriority", { priority: connection.globalPriority })}
              </span>
            )}
            {connection.maxConcurrent != null && connection.maxConcurrent > 0 && (
              <span
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium bg-zinc-500/15 text-zinc-500 dark:bg-zinc-400/15 dark:text-zinc-400"
                title={t("accountConcurrencyCapLabel")}
              >
                <span className="material-symbols-outlined text-[11px]">dynamic_feed</span>
                {connection.maxConcurrent}
              </span>
            )}
            {/* Rate Limit Protection — inline toggle with label */}
            <span className="text-text-muted/30 select-none">|</span>
            <button
              onClick={() => onToggleRateLimit(!rateLimitEnabled)}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition-all cursor-pointer ${
                rateLimitEnabled
                  ? "bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25"
                  : "bg-black/[0.03] dark:bg-white/[0.03] text-text-muted/50 hover:text-text-muted hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
              }`}
              title={
                rateLimitEnabled ? t("disableRateLimitProtection") : t("enableRateLimitProtection")
              }
            >
              <span className="material-symbols-outlined text-[13px]">shield</span>
              {rateLimitEnabled ? t("rateLimitProtected") : t("rateLimitUnprotected")}
            </button>
            {providerId && (
              <>
                <span className="text-text-muted/30 select-none">|</span>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    const next = !balanceOpen;
                    setBalanceOpen(next);
                    if (!next || balanceData || balanceLoading) return;
                    setBalanceLoading(true);
                    try {
                      const res = await fetch(
                        `/api/providers/${encodeURIComponent(providerId)}/balance?connection=${encodeURIComponent(connection.id ?? "")}`,
                        { credentials: "same-origin" }
                      );
                      const data = (await res.json().catch(() => null)) as {
                        connections?: Array<Record<string, unknown>>;
                        error?: { message?: string };
                      } | null;
                      if (data?.error) {
                        setBalanceData({ error: data.error.message });
                      } else {
                        setBalanceData(data);
                      }
                    } catch {
                      setBalanceData({ error: "network error" });
                    } finally {
                      setBalanceLoading(false);
                    }
                  }}
                  title="Balance / reconciliation"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-black/[0.03] dark:bg-white/[0.03] text-text-muted/50 hover:text-text-muted hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-all cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[13px]">
                    account_balance_wallet
                  </span>
                  Balance
                </button>
              </>
            )}
            {isClaude && (
              <>
                <span className="text-text-muted/30 select-none">|</span>
                <button
                  onClick={() => onToggleClaudeExtraUsage?.(!claudeBlockExtraUsageEnabled)}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition-all cursor-pointer ${
                    !claudeBlockExtraUsageEnabled
                      ? "bg-amber-500/15 text-amber-500 hover:bg-amber-500/25"
                      : "bg-black/[0.03] dark:bg-white/[0.03] text-text-muted/50 hover:text-text-muted hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
                  }`}
                  title={t("claudeExtraUsageToggleTitle")}
                >
                  <span className="material-symbols-outlined text-[13px]">payments</span>
                  {t("claudeExtraUsageShort")}{" "}
                  {!claudeBlockExtraUsageEnabled ? t("toggleOnShort") : t("toggleOffShort")}
                </button>
              </>
            )}
            {isCcCompatible && (
              <>
                <span className="text-text-muted/30 select-none">|</span>
                <button
                  onClick={() => onToggleCliproxyapiMode?.(!cliproxyapiDeepMode)}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition-all cursor-pointer ${
                    cliproxyapiDeepMode
                      ? "bg-indigo-500/15 text-indigo-500 hover:bg-indigo-500/25"
                      : "bg-black/[0.03] dark:bg-white/[0.03] text-text-muted/50 hover:text-text-muted hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
                  }`}
                  title={cliproxyapiDeepMode ? t("cpaModeEnabledTitle") : t("cpaModeDisabledTitle")}
                >
                  <span className="material-symbols-outlined text-[13px]">swap_horiz</span>
                  CPA {cliproxyapiDeepMode ? t("toggleOnShort") : t("toggleOffShort")}
                </button>
              </>
            )}
            {isCodex && (
              <>
                <span className="text-text-muted/30 select-none">|</span>
                {codexServiceTierBadge && (
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${codexServiceTierBadge.className}`}
                    title={codexServiceTierBadge.title}
                  >
                    <span className="material-symbols-outlined text-[13px]">
                      {codexServiceTierBadge.icon}
                    </span>
                    {codexServiceTierBadge.label}
                  </span>
                )}
                <button
                  onClick={() => onToggleCodex5h?.(!codex5hEnabled)}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition-all cursor-pointer ${
                    codex5hEnabled
                      ? "bg-blue-500/15 text-blue-500 hover:bg-blue-500/25"
                      : "bg-black/[0.03] dark:bg-white/[0.03] text-text-muted/50 hover:text-text-muted hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
                  }`}
                  title={t("codex5hToggleTitle")}
                >
                  <span className="material-symbols-outlined text-[13px]">timer</span>
                  5h {codex5hEnabled ? t("toggleOnShort") : t("toggleOffShort")}
                </button>
                <button
                  onClick={() => onToggleCodexWeekly?.(!codexWeeklyEnabled)}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition-all cursor-pointer ${
                    codexWeeklyEnabled
                      ? "bg-violet-500/15 text-violet-500 hover:bg-violet-500/25"
                      : "bg-black/[0.03] dark:bg-white/[0.03] text-text-muted/50 hover:text-text-muted hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
                  }`}
                  title={t("codexWeeklyToggleTitle")}
                >
                  <span className="material-symbols-outlined text-[13px]">date_range</span>
                  {t("weeklyShort")} {codexWeeklyEnabled ? t("toggleOnShort") : t("toggleOffShort")}
                </button>
              </>
            )}
            {onToggleProxyEnabled && (
              <>
                <span className="text-text-muted/30 select-none">|</span>
                <button
                  onClick={() => onToggleProxyEnabled(!proxyEnabled)}
                  aria-label={proxyEnabled ? t("proxyEnabledTitle") : t("proxyDisabledTitle")}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition-all cursor-pointer ${
                    proxyEnabled
                      ? "bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25"
                      : "bg-black/[0.03] dark:bg-white/[0.03] text-text-muted/50 hover:text-text-muted hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
                  }`}
                  title={proxyEnabled ? t("proxyEnabledTitle") : t("proxyDisabledTitle")}
                >
                  <span className="material-symbols-outlined text-[13px]">vpn_lock</span>
                  {proxyEnabled ? <span className="sr-only">{t("proxyOn")}</span> : t("proxyOff")}
                </button>
              </>
            )}
            {onTogglePerKeyProxyEnabled && (
              <>
                <span className="text-text-muted/30 select-none">|</span>
                <button
                  onClick={() => onTogglePerKeyProxyEnabled(!perKeyProxyEnabled)}
                  aria-label={
                    perKeyProxyEnabled
                      ? t("perKeyProxyEnabledTitle")
                      : t("perKeyProxyDisabledTitle")
                  }
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition-all cursor-pointer ${
                    perKeyProxyEnabled
                      ? "bg-violet-500/15 text-violet-500 hover:bg-violet-500/25"
                      : "bg-black/[0.03] dark:bg-white/[0.03] text-text-muted/50 hover:text-text-muted hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
                  }`}
                  title={
                    perKeyProxyEnabled
                      ? t("perKeyProxyEnabledTitle")
                      : t("perKeyProxyDisabledTitle")
                  }
                >
                  <span className="material-symbols-outlined text-[13px]">key</span>
                  {perKeyProxyEnabled ? (
                    t("perKeyProxyOn")
                  ) : (
                    <span className="sr-only">{t("perKeyProxyOff")}</span>
                  )}
                </button>
              </>
            )}
            {hasProxy &&
              (() => {
                const colorClass =
                  proxySource === "global"
                    ? "bg-emerald-500/15 text-emerald-500"
                    : proxySource === "provider"
                      ? "bg-amber-500/15 text-amber-500"
                      : "bg-blue-500/15 text-blue-500";
                const label =
                  proxySource === "global"
                    ? t("proxySourceGlobal")
                    : proxySource === "provider"
                      ? t("proxySourceProvider")
                      : t("proxySourceKey");
                return (
                  <>
                    <span className="text-text-muted/30 select-none">|</span>
                    <span
                      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium ${colorClass}`}
                      title={t("proxyConfiguredBySource", {
                        source: label,
                        host: proxyHost || t("configured"),
                      })}
                    >
                      <span className="material-symbols-outlined text-[13px]">vpn_lock</span>
                      {proxyHost || t("proxy")}
                    </span>
                  </>
                );
              })()}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          loading={isRetesting}
          disabled={connection.isActive === false}
          onClick={onRetest}
          className="!h-7 !px-2 text-xs"
          title={t("retestAuthentication")}
        >
          {t("retest")}
        </Button>
        {/* T12: Manual token refresh for OAuth accounts */}
        {onRefreshToken && (
          <Button
            size="sm"
            variant="ghost"
            icon="token"
            loading={isRefreshing}
            disabled={connection.isActive === false || isRefreshing}
            onClick={onRefreshToken}
            className="!h-7 !px-2 text-xs text-amber-500 hover:text-amber-400"
            title={t("refreshOauthTokenTitle")}
          >
            {t("tokenShort")}
          </Button>
        )}
        {isCodex && onApplyCodexAuthLocal && (
          <Button
            size="sm"
            variant="ghost"
            icon="download_done"
            loading={isApplyingCodexAuthLocal}
            disabled={isApplyingCodexAuthLocal}
            onClick={onApplyCodexAuthLocal}
            className="!h-7 !px-2 text-xs text-emerald-500 hover:text-emerald-400"
            title={applyCodexAuthLabel}
          >
            {applyCodexAuthLabel}
          </Button>
        )}
        {isCodex && onExportCodexAuthFile && (
          <Button
            size="sm"
            variant="ghost"
            icon="download"
            loading={isExportingCodexAuthFile}
            disabled={isExportingCodexAuthFile}
            onClick={onExportCodexAuthFile}
            className="!h-7 !px-2 text-xs text-sky-500 hover:text-sky-400"
            title={exportCodexAuthLabel}
          >
            {exportCodexAuthLabel}
          </Button>
        )}
        {isClaude && onApplyClaudeAuthLocal && (
          <Button
            size="sm"
            variant="ghost"
            icon="install_desktop"
            loading={isApplyingClaudeAuthLocal}
            disabled={isApplyingClaudeAuthLocal}
            onClick={onApplyClaudeAuthLocal}
            className="!h-7 !px-2 text-xs text-emerald-500 hover:text-emerald-400"
            title={applyClaudeAuthLabel}
          >
            {applyClaudeAuthLabel}
          </Button>
        )}
        {isClaude && onExportClaudeAuthFile && (
          <Button
            size="sm"
            variant="ghost"
            icon="download"
            loading={isExportingClaudeAuthFile}
            disabled={isExportingClaudeAuthFile}
            onClick={onExportClaudeAuthFile}
            className="!h-7 !px-2 text-xs text-sky-500 hover:text-sky-400"
            title={exportClaudeAuthLabel}
          >
            {exportClaudeAuthLabel}
          </Button>
        )}
        {isGeminiCli && onApplyGeminiAuthLocal && (
          <Button
            size="sm"
            variant="ghost"
            icon="install_desktop"
            loading={isApplyingGeminiAuthLocal}
            disabled={isApplyingGeminiAuthLocal}
            onClick={onApplyGeminiAuthLocal}
            className="!h-7 !px-2 text-xs text-emerald-500 hover:text-emerald-400"
            title={applyGeminiAuthLabel}
          >
            {applyGeminiAuthLabel}
          </Button>
        )}
        {isGeminiCli && onExportGeminiAuthFile && (
          <Button
            size="sm"
            variant="ghost"
            icon="download"
            loading={isExportingGeminiAuthFile}
            disabled={isExportingGeminiAuthFile}
            onClick={onExportGeminiAuthFile}
            className="!h-7 !px-2 text-xs text-sky-500 hover:text-sky-400"
            title={exportGeminiAuthLabel}
          >
            {exportGeminiAuthLabel}
          </Button>
        )}
        <Toggle
          size="sm"
          checked={connection.isActive ?? true}
          onChange={onToggleActive}
          title={(connection.isActive ?? true) ? t("disableConnection") : t("enableConnection")}
        />
        <div className="flex gap-1 ml-1 transition-opacity">
          {onReauth && (
            <button
              onClick={onReauth}
              className="p-2 hover:bg-amber-500/10 rounded text-amber-600 hover:text-amber-500"
              title={t("reauthenticateConnection")}
            >
              <span className="material-symbols-outlined text-[18px]">passkey</span>
            </button>
          )}
          <button
            onClick={onEdit}
            className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary"
            title={t("edit")}
          >
            <span className="material-symbols-outlined text-[18px]">edit</span>
          </button>
          <button
            onClick={onProxy}
            className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary"
            title={t("proxyConfig")}
          >
            <span className="material-symbols-outlined text-[18px]">vpn_lock</span>
          </button>
          <button
            onClick={onDelete}
            className="p-2 hover:bg-red-500/10 rounded text-red-500"
            title={t("delete")}
          >
            <span className="material-symbols-outlined text-[18px]">delete</span>
          </button>
        </div>
      </div>
      {balanceOpen && (
        <div
          className="mt-2 rounded-lg border border-border bg-surface p-3 text-xs space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          {balanceLoading && <div className="text-text-muted">Loading balance…</div>}
          {!balanceLoading && typeof balanceData?.error === "string" && (
            <div className="text-red-500">{String(balanceData.error)}</div>
          )}
          {!balanceLoading &&
            balanceData &&
            !balanceData.error &&
            (() => {
              const conns = (balanceData.connections as Array<Record<string, unknown>>) ?? [];
              if (conns.length === 0)
                return <div className="text-text-muted">No data (connection inactive?)</div>;
              const c = conns[0];
              const prov = c.provider as
                | {
                    usd?: { limit?: number; used?: number; remaining?: number };
                    tokensEquivalent?: {
                      total?: number;
                      usedByCost?: number;
                      remaining?: number;
                    };
                    rawTokensReported?: number | null;
                    tokenPlan?: {
                      total: number;
                      used: number | null;
                      remaining: number | null;
                    };
                  }
                | undefined;
              const local = c.local as
                | {
                    tokensUsed?: number;
                    inputTokens?: number;
                    outputTokens?: number;
                    reasoningTokens?: number;
                    cacheReadTokens?: number;
                    requests?: number;
                  }
                | undefined;
              const rec = c.reconciliation as { deltaRawTokens?: number | null } | undefined;
              const fmt = (n?: number | null) =>
                typeof n === "number" ? n.toLocaleString("en-US") : "—";
              return (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{c.connection as string}</span>
                    {typeof c.expiresAt === "string" && (
                      <span className="text-text-muted">expires: {c.expiresAt.slice(0, 10)}</span>
                    )}
                  </div>
                  {/* Budget ground truth — money, not converted tokens */}
                  {prov?.usd ? (
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded bg-black/5 dark:bg-white/5 p-1.5">
                        <div className="text-[10px] text-text-muted">Limit $</div>
                        <div className="font-mono font-semibold">{prov.usd.limit ?? "—"}</div>
                      </div>
                      <div className="rounded bg-red-500/10 p-1.5">
                        <div className="text-[10px] text-text-muted">Spent $</div>
                        <div className="font-mono font-semibold text-red-500">
                          {typeof prov.usd.used === "number" ? prov.usd.used.toFixed(2) : "—"}
                        </div>
                      </div>
                      <div className="rounded bg-emerald-500/10 p-1.5">
                        <div className="text-[10px] text-text-muted">Remaining $</div>
                        <div className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                          {typeof prov.usd.remaining === "number"
                            ? prov.usd.remaining.toFixed(2)
                            : "—"}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-text-muted">No quota info from provider</div>
                  )}
                  {local && (
                    <div className="space-y-0.5 text-text-muted">
                      <div>
                        Local spend: {" "}
                        <span className="font-mono text-text-main">
                          {fmt(local.tokensUsed)}
                        </span>{" "}
                        tok ({fmt(local.requests)} req)
                      </div>
                      <div className="text-[11px]">
                        in {fmt(local.inputTokens)} · out {fmt(local.outputTokens)} · reasoning{" "}
                        {fmt(local.reasoningTokens ?? 0)}
                        {(local.cacheReadTokens ?? 0) > 0 && (
                          <span className="text-emerald-600 dark:text-emerald-400">
                            {" "}· of which cached input: {fmt(local.cacheReadTokens)} (near-free)
                          </span>
                        )}
                      </div>
                      {rec?.deltaRawTokens != null && (
                        <div
                          className={
                            Math.abs(rec.deltaRawTokens) / Math.max(1, local.tokensUsed ?? 1) >
                            0.05
                              ? "text-amber-500"
                              : "text-emerald-500"
                          }
                          title="Our raw count minus provider's raw counter (>5% off is highlighted)"
                        >
                          Δ raw vs provider: {rec.deltaRawTokens > 0 ? "+" : ""}
                          {fmt(rec.deltaRawTokens)} tok
                        </div>
                      )}
                    </div>
                  )}
                  {prov?.tokenPlan && (
                    <div className="text-[10px] text-text-muted/70">
                      Token package: {" "}
                      {prov.tokenPlan.used != null ? fmt(prov.tokenPlan.used) : "?"} used / {" "}
                      {fmt(prov.tokenPlan.total)} plan
                      {prov.tokenPlan.remaining != null &&
                        ` · left ${fmt(prov.tokenPlan.remaining)}`}
                    </div>
                  )}
                  {prov?.tokensEquivalent && (
                    <div className="text-[10px] text-text-muted/70">
                      Package “tokens” per relay’s own conversion: {" "}
                      {fmt(prov.tokensEquivalent.usedByCost)} used / {" "}
                      {fmt(prov.tokensEquivalent.total)} total
                    </div>
                  )}
                </div>
              );
            })()}
        </div>
      )}
    </div>
  );
}
