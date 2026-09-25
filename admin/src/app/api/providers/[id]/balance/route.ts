import { NextResponse } from "next/server";
import { getDbInstance } from "@/lib/db/core";
import { decrypt } from "@/lib/db/encryption";
import {
  saveQuotaSnapshot,
  getQuotaSnapshots,
} from "@/lib/db/quotaSnapshots";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { handleCorsOptions } from "@/shared/utils/cors";

export const dynamic = "force-dynamic";

/**
 * Provider balance probe + reconciliation.
 *
 * Queries the upstream provider's Sub2API-style usage endpoint
 * (`{baseUrl}/usage`, Bearer auth) for every active api-key connection of the
 * provider and compares the provider-side numbers with our local token
 * accounting (usage_history).
 *
 * Conversion follows the provider's own convention: 1 USD = 4,000,000 tokens.
 */

const TOKENS_PER_USD = 4_000_000;

/**
 * Operator-declared real token package size for quota_limited relays whose
 * APIs report only USD quota (e.g. TTM sells a 100M-token package at $500).
 * Stored in key_value/settings as `tokenPlan:<providerId>` => {"total": N}.
 * When present, the balance panel shows plan-relative token accounting
 * (provider-reported raw consumption vs plan) instead of the synthetic
 * $→token marketing conversion.
 */
function getTokenPlanTotal(providerId: string): number | null {
  try {
    const row = getDbInstance()
      .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?")
      .get(`tokenPlan:${providerId}`) as { value?: string } | undefined;
    if (!row?.value) return null;
    const n = Number(JSON.parse(row.value)?.total);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } catch {
    return null;
  }
}

interface UpstreamUsage {
  mode?: string;
  status?: string;
  remaining?: number;
  expires_at?: string | null;
  quota?: { limit?: number; used?: number; remaining?: number } | null;
  subscription?: { monthly_limit_usd?: number; monthly_usage_usd?: number } | null;
  balance?: number;
  usage?: { total?: { total_tokens?: number; input_tokens?: number; output_tokens?: number } } | null;
}

function extractUpstream(data: UpstreamUsage): {
  totalUsd: number;
  usedUsd: number;
  remainUsd: number;
} {
  if (data.mode === "quota_limited" && data.quota) {
    return {
      totalUsd: data.quota.limit || 0,
      usedUsd: data.quota.used || 0,
      remainUsd: data.quota.remaining ?? 0,
    };
  }
  if (data.mode === "unrestricted") {
    if (data.subscription) {
      return {
        totalUsd: data.subscription.monthly_limit_usd || 0,
        usedUsd: data.subscription.monthly_usage_usd || 0,
        remainUsd: data.remaining ?? 0,
      };
    }
    return { totalUsd: data.balance || 0, usedUsd: 0, remainUsd: data.remaining ?? 0 };
  }
  // New API / One API legacy billing (fallback when /usage is missing):
  const lb = (data as { legacy_billing?: { hardLimitUsd?: number | null; usedUsd?: number | null; remainingUsd?: number | null } }).legacy_billing;
  if (lb) {
    return {
      totalUsd: lb.hardLimitUsd ?? 0,
      usedUsd: lb.usedUsd ?? 0,
      remainUsd: lb.remainingUsd ?? 0,
    };
  }
  return { totalUsd: 0, usedUsd: 0, remainUsd: 0 };
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id: rawId } = await ctx.params;
  const providerId = decodeURIComponent(rawId);
  const url = new URL(request.url);
  const connectionFilter = url.searchParams.get("connection");
  // localOnly: skip the upstream /usage probe — return our token accounting
  // plus the last cached provider totals (quota snapshot). Cheap enough to
  // call per connection row on dashboard render.
  const localOnly = url.searchParams.get("localOnly") === "1";

  const db = getDbInstance() as unknown as {
    prepare: (sql: string) => { all: (...a: unknown[]) => Record<string, unknown>[] };
  };

  // Resolve node base URL straight from the provider_nodes table.
  let baseUrl: string | null = null;
  const row = db
    .prepare("SELECT base_url FROM provider_nodes WHERE id = ?")
    .all(providerId)[0] as { base_url?: string } | undefined;
  baseUrl = row?.base_url ?? null;
  if (!baseUrl) {
    return NextResponse.json(
      { error: { message: "Unknown provider or no base URL", type: "invalid_request" } },
      { status: 404 }
    );
  }

  const connections = (
    db
      .prepare(
        "SELECT id, name, api_key FROM provider_connections WHERE provider = ? AND is_active = 1"
      )
      .all(providerId) as Array<Record<string, unknown>>
  ).filter((c) => !connectionFilter || String(c.id) === connectionFilter);

  const results: Array<Record<string, unknown>> = [];
  const nowIso = new Date().toISOString();

  // Last cached provider totals (quota snapshot) — used in localOnly mode and
  // attached to full-probe results so the UI can render instantly.
  let lastSnapshot: Record<string, unknown> | null = null;
  try {
    const snaps = getQuotaSnapshots({
      provider: providerId,
      connectionId: connectionFilter ?? undefined,
      since: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    });
    const latest = snaps[snaps.length - 1];
    const raw =
      (latest as unknown as Record<string, unknown> | undefined)?.rawData ??
      latest?.raw_data;
    if (latest && raw) {
      lastSnapshot = {
        ...(typeof raw === "string" ? JSON.parse(raw) : raw),
        capturedAt:
          (latest as unknown as Record<string, unknown>).createdAt ?? latest.created_at,
      };
    }
  } catch {
    lastSnapshot = null;
  }

  if (localOnly) {
    for (const conn of connections) {
      const key = typeof conn.api_key === "string" ? decrypt(conn.api_key) : null;
      void key; // existence check only — no upstream call in this mode
      const connName = typeof conn.name === "string" ? conn.name : String(conn.id);
      const connId = String(conn.id);
      const localRow = db
        .prepare(
          `SELECT COALESCE(SUM(tokens_input + tokens_output + tokens_reasoning), 0) AS total,
                  COALESCE(SUM(tokens_cache_read), 0) AS cacheReadT,
                  COUNT(*) AS requests
           FROM usage_history WHERE connection_id = ?`
        )
        .all(connId)[0] as
        | { total: number; cacheReadT: number; requests: number }
        | undefined;
      results.push({
        connection: connName,
        local: {
          tokensUsed: localRow?.total ?? 0,
          cacheReadTokens: localRow?.cacheReadT ?? 0,
          requests: localRow?.requests ?? 0,
        },
        cachedProviderTotals: lastSnapshot,
      });
    }
    return NextResponse.json({
      provider: providerId,
      checkedAt: nowIso,
      localOnly: true,
      connections: results,
    });
  }

  for (const conn of connections) {
    // NOTE: raw row is snake_case; decryptConnectionFields expects camelCase,
    // so decrypt the credential field directly.
    const key = typeof conn.api_key === "string" ? decrypt(conn.api_key) : null;
    const connName = typeof conn.name === "string" ? conn.name : String(conn.id);
    const connId = String(conn.id);
    if (!key) {
      results.push({ connection: connName, error: "no api key" });
      continue;
    }

    // --- upstream side ---
    let upstream: UpstreamUsage | null = null;
    let upstreamError: string | null = null;
    try {
      const url = `${baseUrl.replace(/\/+$/, "")}/usage`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 || res.status === 403) {
        upstreamError = "key rejected by provider";
      } else if (res.status === 404) {
        // New API / One API style relays (e.g. byesu.com) have no /usage but
        // keep the legacy OpenAI billing endpoints: /dashboard/billing/*.
        try {
          const base = baseUrl.replace(/\/+$/, "");
          const [subRes, usageRes] = await Promise.all([
            fetch(`${base}/dashboard/billing/subscription`, {
              headers: { Authorization: `Bearer ${key}` },
              signal: AbortSignal.timeout(15_000),
            }),
            fetch(`${base}/dashboard/billing/usage`, {
              headers: { Authorization: `Bearer ${key}` },
              signal: AbortSignal.timeout(15_000),
            }).catch(() => null),
          ]);
          if (subRes.ok) {
            const sub = (await subRes.json()) as {
              hard_limit_usd?: number;
              soft_limit_usd?: number;
            };
            let usedUsd: number | null = null;
            if (usageRes && usageRes.ok) {
              const u = (await usageRes.json()) as { total_usage?: number };
              if (typeof u.total_usage === "number") usedUsd = u.total_usage / 100;
            }
            const limit = typeof sub.hard_limit_usd === "number" ? sub.hard_limit_usd : null;
            upstream = {
              status: "active",
              legacy_billing: {
                hardLimitUsd: limit,
                softLimitUsd: sub.soft_limit_usd ?? null,
                usedUsd,
                remainingUsd:
                  limit != null && usedUsd != null ? Math.max(0, limit - usedUsd) : null,
              },
            } as unknown as UpstreamUsage;
          } else {
            upstreamError = `HTTP ${res.status}`;
          }
        } catch {
          upstreamError = `HTTP ${res.status}`;
        }
      } else if (!res.ok) {
        upstreamError = `HTTP ${res.status}`;
      } else {
        upstream = (await res.json()) as UpstreamUsage;
      }
    } catch (err) {
      upstreamError = err instanceof Error ? err.message.slice(0, 120) : "network error";
    }

    // --- local side (our token accounting for this connection) ---
    // NOTE: tokens_reasoning is part of real spend (effort=max burns it) and
    // tokens_cache_read is prompt-cached input — billed near-zero upstream but
    // still part of our raw accounting. Shown separately in the UI.
    const localRow = db
      .prepare(
        `SELECT COALESCE(SUM(tokens_input + tokens_output + tokens_reasoning), 0) AS total,
                COALESCE(SUM(tokens_input), 0) AS inputT,
                COALESCE(SUM(tokens_output), 0) AS outputT,
                COALESCE(SUM(tokens_reasoning), 0) AS reasoningT,
                COALESCE(SUM(tokens_cache_read), 0) AS cacheReadT,
                COUNT(*) AS requests
         FROM usage_history WHERE connection_id = ?`
      )
      .all(connId)[0] as
      | {
          total: number;
          inputT: number;
          outputT: number;
          reasoningT: number;
          cacheReadT: number;
          requests: number;
        }
      | undefined;

    const localTokens = localRow?.total ?? 0;

    if (!upstream) {
      results.push({
        connection: connName,
        error: upstreamError ?? "unknown error",
        local: {
          tokensUsed: localTokens,
          inputTokens: localRow?.inputT ?? 0,
          outputTokens: localRow?.outputT ?? 0,
          reasoningTokens: localRow?.reasoningT ?? 0,
          cacheReadTokens: localRow?.cacheReadT ?? 0,
          requests: localRow?.requests ?? 0,
        },
      });
      continue;
    }

    // Cache provider totals so dashboard rows can render inline balance
    // without hitting upstream on every render.
    const tokenPlanTotal = getTokenPlanTotal(providerId);
    try {
      const { totalUsd, usedUsd, remainUsd } = extractUpstream(upstream);
      const providerRawTokensSnap = upstream.usage?.total?.total_tokens ?? null;
      // When a real operator-declared token plan is configured, persist IT
      // (not the marketing $→token conversion) into the snapshot the UI reads.
      saveQuotaSnapshot({
        provider: providerId,
        connection_id: connId,
        window_key: "total",
        remaining_percentage:
          totalUsd > 0 ? Math.max(0, Math.min(100, (remainUsd / totalUsd) * 100)) : null,
        is_exhausted: remainUsd <= 0 ? 1 : 0,
        next_reset_at: upstream.expires_at ?? null,
        window_duration_ms: null,
        raw_data: JSON.stringify({
          limit_usd: totalUsd,
          used_usd: usedUsd,
          remaining_usd: remainUsd,
          tokens_total: tokenPlanTotal ?? Math.round(totalUsd * TOKENS_PER_USD),
          tokens_used:
            providerRawTokensSnap ?? (usedUsd > 0 ? Math.round(usedUsd * TOKENS_PER_USD) : null),
          tokens_remaining:
            tokenPlanTotal != null && providerRawTokensSnap != null
              ? Math.max(0, tokenPlanTotal - providerRawTokensSnap)
              : Math.round(remainUsd * TOKENS_PER_USD),
          plan_is_real: tokenPlanTotal != null,
          expires_at: upstream.expires_at ?? null,
        }),
      });
    } catch {
      // snapshot persistence is best-effort
    }

    const { totalUsd, usedUsd, remainUsd } = extractUpstream(upstream);
    // The tokensEquivalent “1 USD = 4M tokens” conversion is meaningful only for
    // sub2api-style relays (TTM) whose packages ARE measured in such tokens.
    // For legacy-billing relays (New API / One API, e.g. byesu) token capacity
    // is unknown — showing it misleads. Pass null deltas instead.
    const isLegacyBilling = Boolean((upstream as { legacy_billing?: unknown }).legacy_billing);
    const providerTokensTotal = Math.round(totalUsd * TOKENS_PER_USD);
    const providerTokensUsedByCost =
      usedUsd > 0 ? Math.round(usedUsd * TOKENS_PER_USD) : null;
    const providerTokensRemain = Math.round(remainUsd * TOKENS_PER_USD);
    // Provider also counts raw tokens per request:
    const providerRawTokens =
      upstream.usage?.total?.total_tokens ?? null;
    // Real operator-declared token package (if configured) beats the synthetic
    // $→token conversion; the marketing conversion is hidden in that case.
    const tokenPlan =
      tokenPlanTotal != null
        ? {
            total: tokenPlanTotal,
            used: providerRawTokens,
            remaining:
              providerRawTokens != null
                ? Math.max(0, tokenPlanTotal - providerRawTokens)
                : null,
          }
        : undefined;

    results.push({
      connection: connName,
      valid: String(upstream.status || "").toLowerCase() === "active",
      expiresAt: upstream.expires_at ?? null,
      daysUntilExpiry: null,
      provider: {
        mode: upstream.mode ?? null,
        usd: { limit: totalUsd, used: usedUsd, remaining: remainUsd },
        tokenPlan,
        tokensEquivalent: isLegacyBilling || tokenPlanTotal != null
          ? null
          : {
              total: providerTokensTotal,
              usedByCost: providerTokensUsedByCost,
              remaining: providerTokensRemain,
            },
        rawTokensReported: providerRawTokens,
        rawInputTokens: upstream.usage?.total?.input_tokens ?? null,
        rawOutputTokens: upstream.usage?.total?.output_tokens ?? null,
      },
      local: {
        tokensUsed: localTokens,
        inputTokens: localRow?.inputT ?? 0,
        outputTokens: localRow?.outputT ?? 0,
        reasoningTokens: localRow?.reasoningT ?? 0,
        // Prompt-cached input — billed near-zero by OpenAI-style backends.
        cacheReadTokens: localRow?.cacheReadT ?? 0,
        requests: localRow?.requests ?? 0,
      },
      reconciliation: {
        // Ground truth for spend is MONEY (usd.used). The ×4M "tokens" figure
        // is the relay's marketing conversion of dollars, NOT raw model tokens —
        // so we reconcile against the provider's RAW counters instead.
        deltaRawTokens:
          providerRawTokens != null ? localTokens - providerRawTokens : null,
        note:
          "deltaRawTokens: наш сырой подсчёт минус сырой счётчик провайдера. Деньги (usd) — истина по бюджету; «токены» пакета TTM — их внутренняя конвертация долларов",
      },
    });
  }

  return NextResponse.json({ provider: providerId, checkedAt: nowIso, connections: results });
}
