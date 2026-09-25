/**
 * Relay Pool — upstream account store (ported from anthropic-api-relay).
 *
 * Each account is one upstream endpoint (anthropic | openai | codex) with its
 * own credentials, optional proxy, model affinity, cooldown state, and usage
 * counters. The `relay-pool` executor rotates through these accounts per
 * request. Secrets are encrypted at rest via the shared encryption helpers.
 *
 * Rotation state machine (cooldown / disabled / recent errors) lives in the
 * executor (`open-sse/executors/relayPool.ts`); this module is persistence only.
 */

import { randomUUID } from "node:crypto";
import { getDbInstance } from "./core";
import { rowToCamel } from "./core";
import { encrypt, decrypt } from "./encryption";

type JsonRecord = Record<string, unknown>;

export type RelayProviderType = "anthropic" | "openai" | "codex";

export interface RelayAccount {
  id: string;
  name: string;
  providerType: RelayProviderType;
  baseUrl: string | null;
  apiKey: string | null;
  authHeader: string;
  model: string | null;
  modelsCache: string[] | null;
  proxyUrl: string | null;
  enabled: boolean;
  active: boolean;
  maxMessages: number;
  maxTokens: number;
  cooldownUntil: string | null;
  disabledUntil: string | null;
  lastError: string | null;
  lastStatus: number | null;
  successCount: number;
  errorCount: number;
  tokensIn: number;
  tokensOut: number;
  codexRefreshToken: string | null;
  codexExpiresAt: string | null;
  codexAccountId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateRelayAccountInput {
  name: string;
  providerType?: RelayProviderType;
  baseUrl?: string | null;
  apiKey?: string | null;
  authHeader?: string;
  model?: string | null;
  modelsCache?: string[] | null;
  proxyUrl?: string | null;
  enabled?: boolean;
  active?: boolean;
  maxMessages?: number;
  maxTokens?: number;
  codexRefreshToken?: string | null;
  codexExpiresAt?: string | null;
  codexAccountId?: string | null;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function parseModelsCache(value: unknown): string[] | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

function mapRow(row: unknown): RelayAccount {
  const r = rowToCamel(toRecord(row));
  const num = (v: unknown, d = 0) => (typeof v === "number" ? v : Number(v) || d);
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    id: str(r.id) ?? "",
    name: str(r.name) ?? "",
    providerType: (str(r.providerType) ?? "anthropic") as RelayProviderType,
    baseUrl: str(r.baseUrl),
    apiKey: decrypt(str(r.apiKey)),
    authHeader: str(r.authHeader) ?? "x-api-key",
    model: str(r.model),
    modelsCache: parseModelsCache(r.modelsCache),
    proxyUrl: str(r.proxyUrl),
    enabled: r.enabled === 1 || r.enabled === true,
    active: r.active === 1 || r.active === true,
    maxMessages: num(r.maxMessages),
    maxTokens: num(r.maxTokens),
    cooldownUntil: str(r.cooldownUntil),
    disabledUntil: str(r.disabledUntil),
    lastError: str(r.lastError),
    lastStatus: r.lastStatus == null ? null : num(r.lastStatus),
    successCount: num(r.successCount),
    errorCount: num(r.errorCount),
    tokensIn: num(r.tokensIn),
    tokensOut: num(r.tokensOut),
    codexRefreshToken: decrypt(str(r.codexRefreshToken)),
    codexExpiresAt: str(r.codexExpiresAt),
    codexAccountId: str(r.codexAccountId),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  };
}

export function getRelayAccounts(): RelayAccount[] {
  const db = getDbInstance();
  const rows = db.prepare("SELECT * FROM relay_accounts ORDER BY created_at ASC").all();
  return rows.map(mapRow);
}

export function getEnabledRelayAccounts(): RelayAccount[] {
  const db = getDbInstance();
  const rows = db
    .prepare("SELECT * FROM relay_accounts WHERE enabled = 1 ORDER BY created_at ASC")
    .all();
  return rows.map(mapRow);
}

export function getRelayAccount(id: string): RelayAccount | null {
  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM relay_accounts WHERE id = ?").get(id);
  return row ? mapRow(row) : null;
}

function normalizeProviderType(value: unknown): RelayProviderType {
  return value === "openai" || value === "codex" ? value : "anthropic";
}

export function createRelayAccount(input: CreateRelayAccountInput): RelayAccount {
  const db = getDbInstance();
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO relay_accounts (
      id, name, provider_type, base_url, api_key, auth_header, model, models_cache,
      proxy_url, enabled, active, max_messages, max_tokens,
      codex_refresh_token, codex_expires_at, codex_account_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    normalizeProviderType(input.providerType),
    input.baseUrl ?? null,
    encrypt(input.apiKey ?? null) ?? null,
    input.authHeader ?? "x-api-key",
    input.model ?? null,
    input.modelsCache && input.modelsCache.length ? JSON.stringify(input.modelsCache) : null,
    input.proxyUrl ?? null,
    input.enabled === false ? 0 : 1,
    input.active === true ? 1 : 0,
    input.maxMessages ?? 0,
    input.maxTokens ?? 0,
    encrypt(input.codexRefreshToken ?? null) ?? null,
    input.codexExpiresAt ?? null,
    input.codexAccountId ?? null,
    now,
    now
  );
  return getRelayAccount(id)!;
}

export function updateRelayAccount(
  id: string,
  patch: Partial<CreateRelayAccountInput> & {
    enabled?: boolean;
    active?: boolean;
    clearCooldown?: boolean;
  }
): RelayAccount | null {
  const existing = getRelayAccount(id);
  if (!existing) return null;
  const db = getDbInstance();

  const next = {
    name: patch.name ?? existing.name,
    providerType: normalizeProviderType(patch.providerType ?? existing.providerType),
    baseUrl: patch.baseUrl === undefined ? existing.baseUrl : patch.baseUrl,
    apiKey:
      patch.apiKey === undefined ? existing.apiKey : patch.apiKey === null ? null : patch.apiKey,
    authHeader: patch.authHeader ?? existing.authHeader,
    model: patch.model === undefined ? existing.model : patch.model,
    modelsCache: patch.modelsCache === undefined ? existing.modelsCache : patch.modelsCache,
    proxyUrl: patch.proxyUrl === undefined ? existing.proxyUrl : patch.proxyUrl,
    enabled: patch.enabled === undefined ? existing.enabled : patch.enabled,
    active: patch.active === undefined ? existing.active : patch.active,
    maxMessages: patch.maxMessages ?? existing.maxMessages,
    maxTokens: patch.maxTokens ?? existing.maxTokens,
    codexRefreshToken:
      patch.codexRefreshToken === undefined ? existing.codexRefreshToken : patch.codexRefreshToken,
    codexExpiresAt:
      patch.codexExpiresAt === undefined ? existing.codexExpiresAt : patch.codexExpiresAt,
    codexAccountId:
      patch.codexAccountId === undefined ? existing.codexAccountId : patch.codexAccountId,
  };

  // Cooldown clearing is explicit — the executor owns the rotation state machine.
  let cooldownClause = "";
  const cooldownParams: Record<string, unknown> = {};
  if (patch.clearCooldown) {
    cooldownClause = ", cooldown_until = @cooldownUntil, disabled_until = @disabledUntil";
    cooldownParams.cooldownUntil = null;
    cooldownParams.disabledUntil = null;
  }

  db.prepare(
    `UPDATE relay_accounts SET
      name = @name, provider_type = @providerType, base_url = @baseUrl, api_key = @apiKey,
      auth_header = @authHeader, model = @model, models_cache = @modelsCache,
      proxy_url = @proxyUrl, enabled = @enabled, active = @active,
      max_messages = @maxMessages, max_tokens = @maxTokens,
      codex_refresh_token = @codexRefreshToken, codex_expires_at = @codexExpiresAt,
      codex_account_id = @codexAccountId, updated_at = @updatedAt${cooldownClause}
    WHERE id = @id`
  ).run({
    ...next,
    apiKey: encrypt(next.apiKey) ?? null,
    codexRefreshToken: encrypt(next.codexRefreshToken) ?? null,
    modelsCache:
      next.modelsCache && next.modelsCache.length ? JSON.stringify(next.modelsCache) : null,
    // SQLite binds booleans as undefined — persist as 0/1.
    enabled: next.enabled ? 1 : 0,
    active: next.active ? 1 : 0,
    updatedAt: Date.now(),
    id,
    ...cooldownParams,
  });
  return getRelayAccount(id);
}

export function deleteRelayAccount(id: string): boolean {
  const db = getDbInstance();
  const result = db.prepare("DELETE FROM relay_accounts WHERE id = ?").run(id);
  return result.changes > 0;
}

/** Record a successful request: clears cooldown/recent-error state, bumps counters. */
export function markRelayAccountSuccess(
  id: string,
  usage?: { tokensIn?: number; tokensOut?: number }
) {
  const db = getDbInstance();
  db.prepare(
    `UPDATE relay_accounts SET
      success_count = success_count + 1,
      last_error = NULL, last_status = NULL,
      cooldown_until = NULL,
      tokens_in = tokens_in + @tokensIn,
      tokens_out = tokens_out + @tokensOut,
      updated_at = @updatedAt
    WHERE id = @id`
  ).run({
    tokensIn: Math.max(0, Math.floor(usage?.tokensIn ?? 0)),
    tokensOut: Math.max(0, Math.floor(usage?.tokensOut ?? 0)),
    updatedAt: Date.now(),
    id,
  });
}

/**
 * Record a failed request with a cooldown.
 * `cooldownMs = 0` marks the error without blocking the account (transient
 * aborts/timeouts rotate to the next account but must not poison rotation).
 */
export function markRelayAccountError(
  id: string,
  status: number,
  error: string,
  cooldownMs: number
) {
  const db = getDbInstance();
  const cooldownUntil = cooldownMs > 0 ? new Date(Date.now() + cooldownMs).toISOString() : null;
  db.prepare(
    `UPDATE relay_accounts SET
      error_count = error_count + 1,
      last_error = @lastError, last_status = @lastStatus,
      cooldown_until = COALESCE(@cooldownUntil, cooldown_until),
      updated_at = @updatedAt
    WHERE id = @id`
  ).run({
    lastError: error.slice(0, 2000),
    lastStatus: status,
    cooldownUntil,
    updatedAt: Date.now(),
    id,
  });
}

/** Add token usage without touching success/error counters. */
export function addRelayTokenUsage(id: string, tokensIn: number, tokensOut: number) {
  const db = getDbInstance();
  db.prepare(
    `UPDATE relay_accounts SET
      tokens_in = tokens_in + @tokensIn, tokens_out = tokens_out + @tokensOut,
      updated_at = @updatedAt
    WHERE id = @id`
  ).run({
    tokensIn: Math.max(0, Math.floor(tokensIn)),
    tokensOut: Math.max(0, Math.floor(tokensOut)),
    updatedAt: Date.now(),
    id,
  });
}

/** Set the sticky ("active") account — used by anthropic-sticky phase selection. */
export function setRelayAccountActive(id: string | null) {
  const db = getDbInstance();
  db.transaction(() => {
    db.prepare("UPDATE relay_accounts SET active = 0").run();
    if (id)
      db.prepare(
        "UPDATE relay_accounts SET active = 1, updated_at = @updatedAt WHERE id = @id"
      ).run({ updatedAt: Date.now(), id });
  })();
}

export interface RelayPoolStats {
  total: number;
  enabled: number;
  byProviderType: Array<{ providerType: string; count: number }>;
  totalSuccess: number;
  totalErrors: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

export function getRelayPoolStats(): RelayPoolStats {
  const db = getDbInstance();
  const totals = toRecord(
    db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(enabled), 0) AS enabled,
                COALESCE(SUM(success_count), 0) AS totalSuccess,
                COALESCE(SUM(error_count), 0) AS totalErrors,
                COALESCE(SUM(tokens_in), 0) AS totalTokensIn,
                COALESCE(SUM(tokens_out), 0) AS totalTokensOut
         FROM relay_accounts`
      )
      .get()
  );
  const byTypeRows = db
    .prepare(
      `SELECT provider_type AS providerType, COUNT(*) AS count
       FROM relay_accounts GROUP BY provider_type ORDER BY count DESC`
    )
    .all() as Array<JsonRecord>;
  return {
    total: Number(totals.total) || 0,
    enabled: Number(totals.enabled) || 0,
    byProviderType: byTypeRows.map((r) => ({
      providerType: String(r.providerType ?? ""),
      count: Number(r.count) || 0,
    })),
    totalSuccess: Number(totals.totalSuccess) || 0,
    totalErrors: Number(totals.totalErrors) || 0,
    totalTokensIn: Number(totals.totalTokensIn) || 0,
    totalTokensOut: Number(totals.totalTokensOut) || 0,
  };
}

/**
 * Import accounts from an anthropic-api-relay `accounts.json` export.
 * Returns { imported, skipped } — duplicates (same name + baseUrl + providerType)
 * are skipped so the import is idempotent.
 */
export function importRelayAccounts(accounts: Array<JsonRecord>): {
  imported: number;
  skipped: number;
} {
  const existing = getRelayAccounts();
  const seen = new Set(existing.map((a) => `${a.name}|${a.baseUrl}|${a.providerType}`));
  let imported = 0;
  let skipped = 0;
  for (const raw of accounts) {
    const name = typeof raw.name === "string" ? raw.name : "";
    const baseUrl = typeof raw.baseUrl === "string" && raw.baseUrl ? raw.baseUrl : null;
    const providerType = normalizeProviderType(raw.providerType);
    const key = `${name}|${baseUrl}|${providerType}`;
    if (!name || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    createRelayAccount({
      name,
      providerType,
      baseUrl,
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey : null,
      authHeader: typeof raw.authHeader === "string" ? raw.authHeader : "x-api-key",
      model: typeof raw.model === "string" && raw.model ? raw.model : null,
      modelsCache: Array.isArray(raw.modelsCache) ? raw.modelsCache.map(String) : null,
      proxyUrl: typeof raw.proxyUrl === "string" && raw.proxyUrl ? raw.proxyUrl : null,
      enabled: raw.enabled !== false,
      active: raw.active === true,
      maxMessages: typeof raw.maxMessages === "number" ? raw.maxMessages : 0,
      maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : 0,
      codexRefreshToken: typeof raw.codexRefreshToken === "string" ? raw.codexRefreshToken : null,
      codexExpiresAt: typeof raw.codexExpiresAt === "string" ? raw.codexExpiresAt : null,
      codexAccountId: typeof raw.codexAccountId === "string" ? raw.codexAccountId : null,
    });
    imported += 1;
  }
  return { imported, skipped };
}
