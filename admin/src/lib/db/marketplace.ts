import { createHash, randomBytes, randomUUID } from "crypto";
import { getDbInstance } from "./core";
import { decrypt, encrypt } from "./encryption";

type MarketplaceStatus = "active" | "paused" | "disabled";
type UsageStatus = "reserved" | "succeeded" | "failed";

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
  transaction: <T>(fn: () => T) => () => T;
}

interface SellerRow {
  id: string;
  name: string;
  email: string | null;
  status: MarketplaceStatus;
  api_key_prefix: string;
  balance_micro_usd: number;
  payout_details_json: string | null;
  created_at: string;
  updated_at: string;
}

interface SellerConnectionRow {
  seller_id: string;
  connection_id: string;
  provider: string;
  display_name: string | null;
  account_group: string;
  cooldown_until: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_at: string | null;
  created_at: string;
}

interface ListingRow {
  id: string;
  seller_id: string;
  connection_id: string;
  provider: string;
  upstream_model: string;
  public_model: string;
  status: MarketplaceStatus;
  input_price_micro_usd_per_million_tokens: number;
  output_price_micro_usd_per_million_tokens: number;
  platform_fee_bps: number;
  max_requests_per_minute: number | null;
  max_daily_tokens: number | null;
  tokens_sold: number;
  revenue_micro_usd: number;
  combo_id: string | null;
  cooldown_until: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

interface BuyerKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  status: MarketplaceStatus;
  balance_micro_usd: number;
  allowed_models_json: string;
  user_id: string | null;
  token_budget_total: number | null;
  is_unlimited: number;
  tokens_used: number;
  tokens_reserved: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

interface UsageEventRow {
  id: string;
  request_id: string;
  buyer_key_id: string;
  listing_id: string;
  seller_id: string;
  connection_id: string;
  public_model: string;
  upstream_model: string;
  reserved_prompt_tokens: number;
  reserved_completion_tokens: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  reserved_micro_usd: number;
  charged_micro_usd: number;
  seller_amount_micro_usd: number;
  platform_fee_micro_usd: number;
  status: UsageStatus;
  upstream_status: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

interface ProviderConnectionRow {
  id: string;
  provider: string;
  name: string | null;
  display_name: string | null;
}

interface UsageSummaryRow {
  request_count: number;
  total_tokens: number | null;
  charged_micro_usd: number | null;
  seller_amount_micro_usd: number | null;
  platform_fee_micro_usd: number | null;
  reserved_micro_usd: number | null;
}

export interface MarketplaceSeller {
  id: string;
  name: string;
  email: string | null;
  status: MarketplaceStatus;
  apiKeyPrefix: string;
  balanceMicroUsd: number;
  payoutDetails: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceSellerConnection {
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
}

export interface MarketplaceConnectionCooldownInput {
  sellerId: string;
  connectionId: string;
  cooldownUntil: string;
  errorCode: string;
  errorMessage: string;
}

export interface MarketplaceListing {
  id: string;
  sellerId: string;
  connectionId: string;
  provider: string;
  upstreamModel: string;
  publicModel: string;
  status: MarketplaceStatus;
  inputPriceMicroUsdPerMillionTokens: number;
  outputPriceMicroUsdPerMillionTokens: number;
  platformFeeBps: number;
  maxRequestsPerMinute: number | null;
  maxDailyTokens: number | null;
  tokensSold: number;
  revenueMicroUsd: number;
  /** When set, buyer requests route through this omniroute combo. */
  comboId: string | null;
  cooldownUntil: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceCooldownInput {
  listingId: string;
  cooldownUntil: string;
  errorCode: string;
  errorMessage: string;
}

export interface MarketplaceBuyerKey {
  id: string;
  name: string;
  keyPrefix: string;
  status: MarketplaceStatus;
  balanceMicroUsd: number;
  allowedModels: string[];
  userId: string | null;
  tokenBudgetTotal: number | null;
  isUnlimited: boolean;
  tokensUsed: number;
  tokensReserved: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface MarketplaceUsageEvent {
  id: string;
  requestId: string;
  buyerKeyId: string;
  listingId: string;
  sellerId: string;
  connectionId: string;
  publicModel: string;
  upstreamModel: string;
  reservedPromptTokens: number;
  reservedCompletionTokens: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reservedMicroUsd: number;
  chargedMicroUsd: number;
  sellerAmountMicroUsd: number;
  platformFeeMicroUsd: number;
  status: UsageStatus;
  upstreamStatus: number | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface MarketplaceUsageSummary {
  requestCount: number;
  totalTokens: number;
  chargedMicroUsd: number;
  sellerAmountMicroUsd: number;
  platformFeeMicroUsd: number;
  reservedMicroUsd: number;
}

export interface CreateMarketplaceSellerInput {
  name: string;
  email?: string | null;
  payoutDetails?: unknown;
  userId?: string | null;
}

export interface CreateMarketplaceBuyerKeyInput {
  name: string;
  balanceMicroUsd?: number;
  allowedModels?: string[];
  userId?: string | null;
  /** Prepaid-token mode: usage debits tokens instead of the USD balance. */
  tokenBudgetTotal?: number | null;
  isUnlimited?: boolean;
  /** Optional ISO timestamp after which the key is rejected. */
  expiresAt?: string | null;
}

export interface CreateMarketplaceListingInput {
  sellerId: string;
  connectionId: string;
  upstreamModel: string;
  publicModel?: string | null;
  inputPriceMicroUsdPerMillionTokens: number;
  outputPriceMicroUsdPerMillionTokens: number;
  platformFeeBps?: number;
  maxRequestsPerMinute?: number | null;
  maxDailyTokens?: number | null;
  /** Route buyer requests through an omniroute combo (combo engine owns fallback). */
  comboId?: string | null;
}

export interface UpdateMarketplaceSellerConnectionInput {
  sellerId: string;
  connectionId: string;
  accountGroup: string;
}

export interface MarketplaceFailoverTarget {
  listing: MarketplaceListing;
  connection: MarketplaceSellerConnection;
}

export interface ReserveMarketplaceUsageInput {
  buyerKeyId: string;
  publicModel: string;
  requestId: string;
  reservedPromptTokens: number;
  reservedCompletionTokens: number;
  reservedMicroUsd: number;
  connectionId?: string;
  skipListingLimits?: boolean;
}

export interface FinalizeMarketplaceUsageInput {
  usageEventId: string;
  status: Exclude<UsageStatus, "reserved">;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  chargedMicroUsd: number;
  upstreamStatus?: number | null;
  errorMessage?: string | null;
}

export class MarketplaceDbError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MarketplaceDbError";
    this.status = status;
  }
}

function getDb(): DbLike {
  return getDbInstance() as unknown as DbLike;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseStringArray(raw: string | null): string[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function hashMarketplaceKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateMarketplaceKey(kind: "seller" | "buyer"): string {
  const prefix = kind === "seller" ? "oms_seller" : "oms_buy";
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function normalizeAmount(value: number | undefined | null): number {
  if (!Number.isFinite(value) || !value || value < 0) return 0;
  return Math.round(value);
}

function normalizePlatformFeeBps(value: number | undefined | null): number {
  if (!Number.isFinite(value)) return 1500;
  return Math.min(10000, Math.max(0, Math.round(value || 0)));
}

function normalizePublicModel(value: string): string {
  return value.trim().replace(/\s+/g, "-");
}

function buildDefaultPublicModel(
  sellerId: string,
  provider: string,
  upstreamModel: string
): string {
  const safeModel = upstreamModel.trim().replace(/[^a-zA-Z0-9._/-]+/g, "-");
  return `market/${sellerId.slice(0, 8)}/${provider}/${safeModel}`;
}

function sellerFromRow(row: SellerRow): MarketplaceSeller {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status,
    apiKeyPrefix: row.api_key_prefix,
    balanceMicroUsd: row.balance_micro_usd,
    payoutDetails: parseJson(row.payout_details_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sellerConnectionFromRow(row: SellerConnectionRow): MarketplaceSellerConnection {
  return {
    sellerId: row.seller_id,
    connectionId: row.connection_id,
    provider: row.provider,
    displayName: row.display_name,
    accountGroup: row.account_group || "default",
    cooldownUntil: row.cooldown_until,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastErrorAt: row.last_error_at,
    createdAt: row.created_at,
  };
}

function listingFromRow(row: ListingRow): MarketplaceListing {
  return {
    id: row.id,
    sellerId: row.seller_id,
    connectionId: row.connection_id,
    provider: row.provider,
    upstreamModel: row.upstream_model,
    publicModel: row.public_model,
    status: row.status,
    inputPriceMicroUsdPerMillionTokens: row.input_price_micro_usd_per_million_tokens,
    outputPriceMicroUsdPerMillionTokens: row.output_price_micro_usd_per_million_tokens,
    platformFeeBps: row.platform_fee_bps,
    maxRequestsPerMinute: row.max_requests_per_minute,
    maxDailyTokens: row.max_daily_tokens,
    tokensSold: row.tokens_sold,
    revenueMicroUsd: row.revenue_micro_usd,
    comboId: row.combo_id ?? null,
    cooldownUntil: row.cooldown_until,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastErrorAt: row.last_error_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buyerKeyFromRow(row: BuyerKeyRow): MarketplaceBuyerKey {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    status: row.status,
    balanceMicroUsd: row.balance_micro_usd,
    allowedModels: parseStringArray(row.allowed_models_json),
    userId: row.user_id ?? null,
    tokenBudgetTotal: row.token_budget_total ?? null,
    isUnlimited: row.is_unlimited === 1,
    tokensUsed: row.tokens_used ?? 0,
    tokensReserved: row.tokens_reserved ?? 0,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function usageEventFromRow(row: UsageEventRow): MarketplaceUsageEvent {
  return {
    id: row.id,
    requestId: row.request_id,
    buyerKeyId: row.buyer_key_id,
    listingId: row.listing_id,
    sellerId: row.seller_id,
    connectionId: row.connection_id,
    publicModel: row.public_model,
    upstreamModel: row.upstream_model,
    reservedPromptTokens: row.reserved_prompt_tokens,
    reservedCompletionTokens: row.reserved_completion_tokens,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    reservedMicroUsd: row.reserved_micro_usd,
    chargedMicroUsd: row.charged_micro_usd,
    sellerAmountMicroUsd: row.seller_amount_micro_usd,
    platformFeeMicroUsd: row.platform_fee_micro_usd,
    status: row.status,
    upstreamStatus: row.upstream_status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function usageSummaryFromRow(row: UsageSummaryRow | undefined): MarketplaceUsageSummary {
  return {
    requestCount: Number(row?.request_count || 0),
    totalTokens: Number(row?.total_tokens || 0),
    chargedMicroUsd: Number(row?.charged_micro_usd || 0),
    sellerAmountMicroUsd: Number(row?.seller_amount_micro_usd || 0),
    platformFeeMicroUsd: Number(row?.platform_fee_micro_usd || 0),
    reservedMicroUsd: Number(row?.reserved_micro_usd || 0),
  };
}

function getListingRowByPublicModel(db: DbLike, publicModel: string): ListingRow | null {
  return (
    db
      .prepare<ListingRow>(
        `SELECT l.* FROM marketplace_listings l
         JOIN marketplace_sellers s ON s.id = l.seller_id
         WHERE l.public_model = ?
           AND l.status = 'active'
           AND s.status = 'active'
           AND (l.cooldown_until IS NULL OR l.cooldown_until <= ?)`
      )
      .get(publicModel, nowIso()) || null
  );
}

function getUsageEventRow(db: DbLike, id: string): UsageEventRow | null {
  return (
    db.prepare<UsageEventRow>("SELECT * FROM marketplace_usage_events WHERE id = ?").get(id) || null
  );
}

function getUtcDayStartIso(referenceIso: string): string {
  const date = new Date(referenceIso);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function assertListingLimits(
  db: DbLike,
  listing: ListingRow,
  reservationTokens: number,
  createdAt: string
): void {
  if (typeof listing.max_requests_per_minute === "number" && listing.max_requests_per_minute > 0) {
    const minuteStart = new Date(Date.parse(createdAt) - 60_000).toISOString();
    const row = db
      .prepare<{ request_count: number }>(
        `SELECT COUNT(*) AS request_count
         FROM marketplace_usage_events
         WHERE listing_id = ? AND created_at >= ?`
      )
      .get(listing.id, minuteStart);
    if (Number(row?.request_count || 0) >= listing.max_requests_per_minute) {
      throw new MarketplaceDbError(429, "Marketplace listing request rate limit exceeded");
    }
  }

  if (typeof listing.max_daily_tokens === "number" && listing.max_daily_tokens > 0) {
    const dayStart = getUtcDayStartIso(createdAt);
    const row = db
      .prepare<{ tokens_used: number | null }>(
        `SELECT COALESCE(SUM(
           CASE
             WHEN status = 'reserved' THEN reserved_prompt_tokens + reserved_completion_tokens
             WHEN status = 'succeeded' THEN COALESCE(total_tokens, reserved_prompt_tokens + reserved_completion_tokens)
             ELSE 0
           END
         ), 0) AS tokens_used
         FROM marketplace_usage_events
         WHERE listing_id = ? AND created_at >= ?`
      )
      .get(listing.id, dayStart);
    const tokensUsed = Number(row?.tokens_used || 0);
    if (tokensUsed + reservationTokens > listing.max_daily_tokens) {
      throw new MarketplaceDbError(429, "Marketplace listing daily token limit exceeded");
    }
  }
}

function insertLedgerEntry(
  db: DbLike,
  input: {
    buyerKeyId?: string | null;
    sellerId?: string | null;
    listingId?: string | null;
    usageEventId?: string | null;
    kind: string;
    amountMicroUsd?: number;
    sellerAmountMicroUsd?: number;
    platformFeeMicroUsd?: number;
    balanceAfterMicroUsd?: number | null;
    metadata?: unknown;
  }
): void {
  db.prepare(
    `INSERT INTO marketplace_ledger_entries (
      id, buyer_key_id, seller_id, listing_id, usage_event_id, kind, amount_micro_usd,
      seller_amount_micro_usd, platform_fee_micro_usd, balance_after_micro_usd, metadata_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    input.buyerKeyId || null,
    input.sellerId || null,
    input.listingId || null,
    input.usageEventId || null,
    input.kind,
    input.amountMicroUsd || 0,
    input.sellerAmountMicroUsd || 0,
    input.platformFeeMicroUsd || 0,
    input.balanceAfterMicroUsd ?? null,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
    nowIso()
  );
}

export function createMarketplaceSeller(input: CreateMarketplaceSellerInput): {
  seller: MarketplaceSeller;
  apiKey: string;
} {
  const db = getDb();
  const id = randomUUID();
  const apiKey = generateMarketplaceKey("seller");
  const createdAt = nowIso();

  db.prepare(
    `INSERT INTO marketplace_sellers (
      id, name, email, status, api_key_hash, api_key_prefix, balance_micro_usd,
      payout_details_json, user_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?, 0, ?, ?, ?, ?)`
  ).run(
    id,
    input.name.trim(),
    input.email?.trim() || null,
    hashMarketplaceKey(apiKey),
    apiKey.slice(0, 18),
    input.payoutDetails === undefined ? null : JSON.stringify(input.payoutDetails),
    input.userId || null,
    createdAt,
    createdAt
  );

  const seller = getMarketplaceSellerById(id);
  if (!seller) throw new MarketplaceDbError(500, "Seller was not created");
  return { seller, apiKey };
}

/**
 * Return the user's seller identity, creating one on first use. Lets a unified
 * user attach connections / publish listings without a separate seller signup.
 */
export function getOrCreateSellerForUser(input: {
  userId: string;
  name: string;
  email?: string | null;
}): { seller: MarketplaceSeller; apiKey: string | null } {
  const existing = getMarketplaceSellerByUserId(input.userId);
  if (existing) return { seller: existing, apiKey: null };
  const created = createMarketplaceSeller({
    name: input.name,
    email: input.email ?? null,
    userId: input.userId,
  });
  return { seller: created.seller, apiKey: created.apiKey };
}

export function listMarketplaceSellers(): MarketplaceSeller[] {
  return getDb()
    .prepare<SellerRow>("SELECT * FROM marketplace_sellers ORDER BY created_at DESC")
    .all()
    .map(sellerFromRow);
}

export function getMarketplaceSellerById(id: string): MarketplaceSeller | null {
  const row = getDb().prepare<SellerRow>("SELECT * FROM marketplace_sellers WHERE id = ?").get(id);
  return row ? sellerFromRow(row) : null;
}

/**
 * The first active seller owned by a unified user, if any. Used to reuse a
 * user's seller identity instead of creating duplicates per request.
 */
export function getMarketplaceSellerByUserId(userId: string): MarketplaceSeller | null {
  const row = getDb()
    .prepare<SellerRow>(
      "SELECT * FROM marketplace_sellers WHERE user_id = ? AND status = 'active' ORDER BY created_at ASC"
    )
    .get(userId);
  return row ? sellerFromRow(row) : null;
}

/**
 * Debit a seller's balance and write a ledger entry. Used by the withdrawal
 * subsystem: when a seller withdraws their earnings, the balance is held until
 * the on-chain tx confirms. Returns the updated seller row. Throws 402 when
 * the balance is insufficient.
 */
export function debitMarketplaceSellerBalance(params: {
  sellerId: string;
  amountMicroUsd: number;
  kind: string;
  metadata?: unknown;
}): MarketplaceSeller {
  const amount = normalizeAmount(params.amountMicroUsd);
  if (amount <= 0) throw new MarketplaceDbError(400, "Debit amount must be positive");

  const db = getDb();
  const tx = db.transaction(() => {
    const row = db
      .prepare<SellerRow>("SELECT * FROM marketplace_sellers WHERE id = ?")
      .get(params.sellerId);
    if (!row) throw new MarketplaceDbError(404, "Marketplace seller not found");
    if (row.balance_micro_usd < amount) {
      throw new MarketplaceDbError(402, "Insufficient seller balance");
    }

    const at = nowIso();
    const balanceAfter = row.balance_micro_usd - amount;
    db.prepare(
      "UPDATE marketplace_sellers SET balance_micro_usd = ?, updated_at = ? WHERE id = ?"
    ).run(balanceAfter, at, params.sellerId);
    insertLedgerEntry(db, {
      sellerId: params.sellerId,
      kind: params.kind,
      sellerAmountMicroUsd: -amount,
      platformFeeMicroUsd: 0,
      balanceAfterMicroUsd: balanceAfter,
      metadata: params.metadata,
    });
    return db
      .prepare<SellerRow>("SELECT * FROM marketplace_sellers WHERE id = ?")
      .get(params.sellerId);
  });

  const updated = tx();
  if (!updated) throw new MarketplaceDbError(500, "Seller balance debit failed");
  return sellerFromRow(updated);
}

export function listMarketplaceBuyerKeysByUserId(userId: string): MarketplaceBuyerKey[] {
  return getDb()
    .prepare<BuyerKeyRow>(
      "SELECT * FROM marketplace_buyer_keys WHERE user_id = ? ORDER BY created_at DESC"
    )
    .all(userId)
    .map(buyerKeyFromRow);
}

export function getMarketplaceSellerByApiKey(
  apiKey: string | null | undefined
): MarketplaceSeller | null {
  if (!apiKey) return null;
  const row = getDb()
    .prepare<SellerRow>(
      "SELECT * FROM marketplace_sellers WHERE api_key_hash = ? AND status = 'active'"
    )
    .get(hashMarketplaceKey(apiKey));
  return row ? sellerFromRow(row) : null;
}

export function attachMarketplaceSellerConnection(
  sellerId: string,
  connectionId: string
): MarketplaceSellerConnection {
  const db = getDb();
  const tx = db.transaction(() => {
    const owner = db
      .prepare<{
        seller_id: string;
      }>("SELECT seller_id FROM marketplace_seller_connections WHERE connection_id = ?")
      .get(connectionId);

    if (owner && owner.seller_id !== sellerId) {
      throw new MarketplaceDbError(409, "Provider connection already belongs to another seller");
    }

    const connection = db
      .prepare<ProviderConnectionRow>(
        "SELECT id, provider, name, display_name FROM provider_connections WHERE id = ?"
      )
      .get(connectionId);
    if (!connection) throw new MarketplaceDbError(404, "Provider connection not found");

    db.prepare(
      `INSERT OR IGNORE INTO marketplace_seller_connections (
        seller_id, connection_id, provider, display_name, account_group, cooldown_until,
        last_error_code, last_error_message, last_error_at, created_at
      ) VALUES (?, ?, ?, ?, 'default', NULL, NULL, NULL, NULL, ?)`
    ).run(
      sellerId,
      connection.id,
      connection.provider,
      connection.display_name || connection.name || null,
      nowIso()
    );

    return db
      .prepare<SellerConnectionRow>(
        "SELECT * FROM marketplace_seller_connections WHERE connection_id = ?"
      )
      .get(connectionId);
  });

  const row = tx();
  if (!row) throw new MarketplaceDbError(500, "Seller connection was not attached");
  return sellerConnectionFromRow(row);
}

export function listMarketplaceSellerConnections(sellerId: string): MarketplaceSellerConnection[] {
  return getDb()
    .prepare<SellerConnectionRow>(
      "SELECT * FROM marketplace_seller_connections WHERE seller_id = ? ORDER BY created_at DESC"
    )
    .all(sellerId)
    .map(sellerConnectionFromRow);
}

export function getMarketplaceSellerConnection(
  sellerId: string,
  connectionId: string
): MarketplaceSellerConnection | null {
  const row = getDb()
    .prepare<SellerConnectionRow>(
      "SELECT * FROM marketplace_seller_connections WHERE seller_id = ? AND connection_id = ?"
    )
    .get(sellerId, connectionId);
  return row ? sellerConnectionFromRow(row) : null;
}

export function updateMarketplaceSellerConnection(
  input: UpdateMarketplaceSellerConnectionInput
): MarketplaceSellerConnection {
  const accountGroup = input.accountGroup.trim() || "default";
  const result = getDb()
    .prepare(
      `UPDATE marketplace_seller_connections
       SET account_group = ?
       WHERE seller_id = ? AND connection_id = ?`
    )
    .run(accountGroup, input.sellerId, input.connectionId);
  if (!result.changes) throw new MarketplaceDbError(404, "Seller connection not found");
  const updated = getMarketplaceSellerConnection(input.sellerId, input.connectionId);
  if (!updated) throw new MarketplaceDbError(500, "Seller connection update failed");
  return updated;
}

export function createMarketplaceListing(input: CreateMarketplaceListingInput): MarketplaceListing {
  const db = getDb();
  const id = randomUUID();
  const createdAt = nowIso();
  const tx = db.transaction(() => {
    const sellerConnection = db
      .prepare<SellerConnectionRow>(
        "SELECT * FROM marketplace_seller_connections WHERE seller_id = ? AND connection_id = ?"
      )
      .get(input.sellerId, input.connectionId);
    if (!sellerConnection) {
      throw new MarketplaceDbError(403, "Connection does not belong to this seller");
    }

    const publicModel = normalizePublicModel(
      input.publicModel ||
        buildDefaultPublicModel(input.sellerId, sellerConnection.provider, input.upstreamModel)
    );
    const existing = db
      .prepare<{ id: string }>("SELECT id FROM marketplace_listings WHERE public_model = ?")
      .get(publicModel);
    if (existing) throw new MarketplaceDbError(409, "Public model already exists");

    // Combo-backed listing: the combo must exist; its name becomes the routing
    // target (upstreamModel falls back to it for display).
    let comboName: string | null = null;
    if (input.comboId) {
      const comboRow = db
        .prepare<{ name: string }>("SELECT name FROM combos WHERE id = ?")
        .get(input.comboId);
      if (!comboRow) throw new MarketplaceDbError(400, "Combo not found");
      comboName = comboRow.name;
    }
    const upstreamModel = (input.upstreamModel || comboName || "").trim();

    db.prepare(
      `INSERT INTO marketplace_listings (
        id, seller_id, connection_id, provider, upstream_model, public_model, status,
        input_price_micro_usd_per_million_tokens,
        output_price_micro_usd_per_million_tokens, platform_fee_bps,
        max_requests_per_minute, max_daily_tokens, tokens_sold, revenue_micro_usd,
        combo_id, cooldown_until, last_error_code, last_error_message, last_error_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, 0, ?, NULL, NULL, NULL, NULL, ?, ?)`
    ).run(
      id,
      input.sellerId,
      input.connectionId,
      sellerConnection.provider,
      upstreamModel,
      publicModel,
      normalizeAmount(input.inputPriceMicroUsdPerMillionTokens),
      normalizeAmount(input.outputPriceMicroUsdPerMillionTokens),
      normalizePlatformFeeBps(input.platformFeeBps),
      input.maxRequestsPerMinute ?? null,
      input.maxDailyTokens ?? null,
      input.comboId || null,
      createdAt,
      createdAt
    );

    return db.prepare<ListingRow>("SELECT * FROM marketplace_listings WHERE id = ?").get(id);
  });

  const row = tx();
  if (!row) throw new MarketplaceDbError(500, "Listing was not created");
  return listingFromRow(row);
}

export function listMarketplaceListings(): MarketplaceListing[] {
  return getDb()
    .prepare<ListingRow>("SELECT * FROM marketplace_listings ORDER BY created_at DESC")
    .all()
    .map(listingFromRow);
}

export function listActiveMarketplaceListings(): MarketplaceListing[] {
  return getDb()
    .prepare<ListingRow>(
      `SELECT l.* FROM marketplace_listings l
       JOIN marketplace_sellers s ON s.id = l.seller_id
       WHERE l.status = 'active' AND s.status = 'active'
         AND (l.cooldown_until IS NULL OR l.cooldown_until <= ?)
       ORDER BY l.created_at DESC`
    )
    .all(nowIso())
    .map(listingFromRow);
}

export function listMarketplaceSellerListings(sellerId: string): MarketplaceListing[] {
  return getDb()
    .prepare<ListingRow>(
      "SELECT * FROM marketplace_listings WHERE seller_id = ? ORDER BY created_at DESC"
    )
    .all(sellerId)
    .map(listingFromRow);
}

export function getActiveMarketplaceListingByPublicModel(
  publicModel: string
): MarketplaceListing | null {
  const row = getListingRowByPublicModel(getDb(), publicModel);
  return row ? listingFromRow(row) : null;
}

export function markMarketplaceListingCoolingDown(input: MarketplaceCooldownInput): void {
  const updatedAt = nowIso();
  getDb()
    .prepare(
      `UPDATE marketplace_listings
       SET cooldown_until = ?, last_error_code = ?, last_error_message = ?, last_error_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      input.cooldownUntil,
      input.errorCode,
      input.errorMessage.slice(0, 500),
      updatedAt,
      updatedAt,
      input.listingId
    );
}

export function markMarketplaceSellerConnectionCoolingDown(
  input: MarketplaceConnectionCooldownInput
): void {
  const updatedAt = nowIso();
  getDb()
    .prepare(
      `UPDATE marketplace_seller_connections
       SET cooldown_until = ?, last_error_code = ?, last_error_message = ?, last_error_at = ?
       WHERE seller_id = ? AND connection_id = ?`
    )
    .run(
      input.cooldownUntil,
      input.errorCode,
      input.errorMessage.slice(0, 500),
      updatedAt,
      input.sellerId,
      input.connectionId
    );
}

export function resolveMarketplaceFailoverTargets(
  listingId: string,
  excludedConnectionIds: string[] = []
): MarketplaceFailoverTarget[] {
  const db = getDb();
  const listingRow = db
    .prepare<ListingRow>("SELECT * FROM marketplace_listings WHERE id = ?")
    .get(listingId);
  if (!listingRow) return [];

  const primary = db
    .prepare<SellerConnectionRow>(
      "SELECT * FROM marketplace_seller_connections WHERE seller_id = ? AND connection_id = ?"
    )
    .get(listingRow.seller_id, listingRow.connection_id);
  if (!primary) return [];

  // Combo-backed listing: the combo engine owns target selection and fallback,
  // so the marketplace-level account-group failover must not duplicate it.
  if (listingRow.combo_id) {
    return [
      {
        listing: listingFromRow(listingRow),
        connection: sellerConnectionFromRow(primary),
      },
    ];
  }

  const excluded = new Set(excludedConnectionIds);
  const rows = db
    .prepare<SellerConnectionRow>(
      `SELECT * FROM marketplace_seller_connections
       WHERE seller_id = ? AND provider = ? AND account_group = ?
         AND (cooldown_until IS NULL OR cooldown_until <= ?)
       ORDER BY CASE WHEN connection_id = ? THEN 0 ELSE 1 END, created_at ASC`
    )
    .all(
      listingRow.seller_id,
      listingRow.provider,
      primary.account_group || "default",
      nowIso(),
      listingRow.connection_id
    )
    .filter((row) => !excluded.has(row.connection_id));

  return rows.map((row) => ({
    listing: listingFromRow({ ...listingRow, connection_id: row.connection_id }),
    connection: sellerConnectionFromRow(row),
  }));
}

export function createMarketplaceBuyerKey(input: CreateMarketplaceBuyerKeyInput): {
  buyerKey: MarketplaceBuyerKey;
  apiKey: string;
} {
  const db = getDb();
  const id = randomUUID();
  const apiKey = generateMarketplaceKey("buyer");
  const createdAt = nowIso();
  const allowedModels = input.allowedModels || [];
  const tokenBudgetTotal = input.isUnlimited
    ? null
    : input.tokenBudgetTotal != null
      ? Math.max(0, Math.floor(input.tokenBudgetTotal))
      : null;

  db.prepare(
    `INSERT INTO marketplace_buyer_keys (
      id, name, key_hash, key_prefix, key_enc, status, balance_micro_usd, allowed_models_json,
      user_id, token_budget_total, is_unlimited, tokens_used, tokens_reserved, expires_at,
      created_at, updated_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, NULL)`
  ).run(
    id,
    input.name.trim(),
    hashMarketplaceKey(apiKey),
    apiKey.slice(0, 16),
    encrypt(apiKey) ?? null,
    normalizeAmount(input.balanceMicroUsd),
    JSON.stringify(allowedModels),
    input.userId || null,
    tokenBudgetTotal,
    input.isUnlimited ? 1 : 0,
    input.expiresAt || null,
    createdAt,
    createdAt
  );

  const buyerKey = getMarketplaceBuyerKeyById(id);
  if (!buyerKey) throw new MarketplaceDbError(500, "Buyer key was not created");
  return { buyerKey, apiKey };
}

export function listMarketplaceBuyerKeys(): MarketplaceBuyerKey[] {
  return getDb()
    .prepare<BuyerKeyRow>("SELECT * FROM marketplace_buyer_keys ORDER BY created_at DESC")
    .all()
    .map(buyerKeyFromRow);
}

export function getMarketplaceBuyerKeyById(id: string): MarketplaceBuyerKey | null {
  const row = getDb()
    .prepare<BuyerKeyRow>("SELECT * FROM marketplace_buyer_keys WHERE id = ?")
    .get(id);
  return row ? buyerKeyFromRow(row) : null;
}

export function getMarketplaceBuyerKeyByApiKey(
  apiKey: string | null | undefined
): MarketplaceBuyerKey | null {
  if (!apiKey) return null;
  const row = getDb()
    .prepare<BuyerKeyRow>(
      "SELECT * FROM marketplace_buyer_keys WHERE key_hash = ? AND status = 'active'"
    )
    .get(hashMarketplaceKey(apiKey));
  return row ? buyerKeyFromRow(row) : null;
}

/** Set buyer key status: 'active' | 'paused' | 'disabled'. Anything but 'active' blocks auth. */
export function setMarketplaceBuyerKeyStatus(
  buyerKeyId: string,
  status: "active" | "paused" | "disabled"
): MarketplaceBuyerKey {
  const db = getDb();
  const exists = db
    .prepare<BuyerKeyRow>("SELECT id FROM marketplace_buyer_keys WHERE id = ?")
    .get(buyerKeyId);
  if (!exists) throw new MarketplaceDbError(404, "Buyer key not found");
  db.prepare("UPDATE marketplace_buyer_keys SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    nowIso(),
    buyerKeyId
  );
  const row = getMarketplaceBuyerKeyById(buyerKeyId);
  if (!row) throw new MarketplaceDbError(500, "Buyer key update failed");
  return row;
}

export function topUpMarketplaceBuyerKey(
  buyerKeyId: string,
  amountMicroUsd: number,
  metadata?: unknown
): MarketplaceBuyerKey {
  const db = getDb();
  const amount = normalizeAmount(amountMicroUsd);
  if (amount <= 0) throw new MarketplaceDbError(400, "Top-up amount must be positive");

  const tx = db.transaction(() => {
    const row = db
      .prepare<BuyerKeyRow>("SELECT * FROM marketplace_buyer_keys WHERE id = ?")
      .get(buyerKeyId);
    if (!row) throw new MarketplaceDbError(404, "Buyer key not found");

    const updatedAt = nowIso();
    const balanceAfter = row.balance_micro_usd + amount;
    db.prepare(
      "UPDATE marketplace_buyer_keys SET balance_micro_usd = ?, updated_at = ? WHERE id = ?"
    ).run(balanceAfter, updatedAt, buyerKeyId);
    insertLedgerEntry(db, {
      buyerKeyId,
      kind: "buyer_topup",
      amountMicroUsd: amount,
      balanceAfterMicroUsd: balanceAfter,
      metadata,
    });

    return db
      .prepare<BuyerKeyRow>("SELECT * FROM marketplace_buyer_keys WHERE id = ?")
      .get(buyerKeyId);
  });

  const updated = tx();
  if (!updated) throw new MarketplaceDbError(500, "Buyer key top-up failed");
  return buyerKeyFromRow(updated);
}

export function reserveMarketplaceUsage(input: ReserveMarketplaceUsageInput): {
  buyerKey: MarketplaceBuyerKey;
  listing: MarketplaceListing;
  usageEvent: MarketplaceUsageEvent;
} {
  const db = getDb();
  const tx = db.transaction(() => {
    const buyer = db
      .prepare<BuyerKeyRow>(
        "SELECT * FROM marketplace_buyer_keys WHERE id = ? AND status = 'active'"
      )
      .get(input.buyerKeyId);
    if (!buyer) throw new MarketplaceDbError(401, "Invalid marketplace buyer key");

    const createdAt = nowIso();
    const listing = getListingRowByPublicModel(db, input.publicModel);
    if (!listing) throw new MarketplaceDbError(404, "Marketplace model not found");

    const allowedModels = parseStringArray(buyer.allowed_models_json);
    if (allowedModels.length > 0 && !allowedModels.includes(input.publicModel)) {
      throw new MarketplaceDbError(403, "Buyer key is not allowed to use this marketplace model");
    }

    if (buyer.expires_at && Date.parse(buyer.expires_at) <= Date.now()) {
      throw new MarketplaceDbError(401, "Marketplace buyer key has expired");
    }

    // Prepaid-token keys debit tokens instead of the USD balance: the operator
    // collected payment out-of-band when issuing the key, so no USD movement
    // is reserved or charged (reservedMicroUsd is forced to 0 below).
    const prepaidTokenMode = buyer.token_budget_total != null || buyer.is_unlimited === 1;
    let reservedMicroUsd = normalizeAmount(input.reservedMicroUsd);
    const reservedTokens =
      normalizeAmount(input.reservedPromptTokens) + normalizeAmount(input.reservedCompletionTokens);

    if (prepaidTokenMode) {
      reservedMicroUsd = 0;
      // Дальше удержания до фактического достижения бюджета
      const tokensUsed = buyer.tokens_used ?? 0;
      if (buyer.is_unlimited !== 1 && tokensUsed >= (buyer.token_budget_total ?? 0)) {
        throw new MarketplaceDbError(
          402,
          `Prepaid key budget exhausted: ${tokensUsed} used of ${buyer.token_budget_total}`
        );
      }
    } else if (buyer.balance_micro_usd < reservedMicroUsd) {
      throw new MarketplaceDbError(402, "Insufficient marketplace balance");
    }

    if (input.skipListingLimits !== true) {
      assertListingLimits(db, listing, reservedTokens, createdAt);
    }

    const executionConnectionId = input.connectionId || listing.connection_id;

    const usageEventId = randomUUID();
    const balanceAfter = buyer.balance_micro_usd - reservedMicroUsd;
    db.prepare(
      `UPDATE marketplace_buyer_keys
       SET balance_micro_usd = ?, last_used_at = ?, updated_at = ?,
           tokens_reserved = COALESCE(tokens_reserved, 0) + ?
       WHERE id = ?`
    ).run(balanceAfter, createdAt, createdAt, prepaidTokenMode ? reservedTokens : 0, buyer.id);

    db.prepare(
      `INSERT INTO marketplace_usage_events (
        id, request_id, buyer_key_id, listing_id, seller_id, connection_id, public_model,
        upstream_model, reserved_prompt_tokens, reserved_completion_tokens, prompt_tokens,
        completion_tokens, total_tokens, reserved_micro_usd, charged_micro_usd,
        seller_amount_micro_usd, platform_fee_micro_usd, status, upstream_status,
        error_message, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0, 0, 0, 'reserved', NULL, NULL, ?, NULL)`
    ).run(
      usageEventId,
      input.requestId,
      buyer.id,
      listing.id,
      listing.seller_id,
      executionConnectionId,
      listing.public_model,
      listing.upstream_model,
      normalizeAmount(input.reservedPromptTokens),
      normalizeAmount(input.reservedCompletionTokens),
      reservedMicroUsd,
      createdAt
    );

    insertLedgerEntry(db, {
      buyerKeyId: buyer.id,
      sellerId: listing.seller_id,
      listingId: listing.id,
      usageEventId,
      kind: "buyer_reservation",
      amountMicroUsd: -reservedMicroUsd,
      balanceAfterMicroUsd: balanceAfter,
      metadata: {
        publicModel: listing.public_model,
        reservedPromptTokens: input.reservedPromptTokens,
        reservedCompletionTokens: input.reservedCompletionTokens,
      },
    });

    const updatedBuyer = db
      .prepare<BuyerKeyRow>("SELECT * FROM marketplace_buyer_keys WHERE id = ?")
      .get(buyer.id);
    const usageEvent = getUsageEventRow(db, usageEventId);
    if (!updatedBuyer || !usageEvent) throw new MarketplaceDbError(500, "Usage reservation failed");

    return { buyerKey: updatedBuyer, listing, usageEvent };
  });

  const result = tx();
  return {
    buyerKey: buyerKeyFromRow(result.buyerKey),
    listing: listingFromRow(result.listing),
    usageEvent: usageEventFromRow(result.usageEvent),
  };
}

export function finalizeMarketplaceUsage(
  input: FinalizeMarketplaceUsageInput
): MarketplaceUsageEvent {
  const db = getDb();
  const tx = db.transaction(() => {
    const event = getUsageEventRow(db, input.usageEventId);
    if (!event) throw new MarketplaceDbError(404, "Marketplace usage event not found");
    if (event.status !== "reserved") return event;

    const charge =
      input.status === "succeeded"
        ? Math.min(normalizeAmount(input.chargedMicroUsd), event.reserved_micro_usd)
        : 0;
    const sellerAmount =
      input.status === "succeeded"
        ? Math.floor((charge * (10000 - eventPlatformFeeBps(db, event.listing_id))) / 10000)
        : 0;
    const platformFee = charge - sellerAmount;
    const completedAt = nowIso();
    const balanceDelta = event.reserved_micro_usd - charge;

    const buyer = db
      .prepare<BuyerKeyRow>("SELECT * FROM marketplace_buyer_keys WHERE id = ?")
      .get(event.buyer_key_id);
    if (!buyer) throw new MarketplaceDbError(404, "Marketplace buyer key not found");

    // Prepaid-token settlement: consumed tokens move from reserved to used on
    // success; on failure the reservation is released in full. Mirrors the
    // USD refund path above.
    const reservedEventTokens =
      normalizeAmount(event.reserved_prompt_tokens) +
      normalizeAmount(event.reserved_completion_tokens);
    const actualTotalTokens = input.totalTokens == null ? 0 : normalizeAmount(input.totalTokens);
    if (buyer.token_budget_total != null || buyer.is_unlimited === 1) {
      const tokensUsedAfter =
        (buyer.tokens_used ?? 0) + (input.status === "succeeded" ? actualTotalTokens : 0);
      const tokensReservedAfter = Math.max(0, (buyer.tokens_reserved ?? 0) - reservedEventTokens);
      if (tokensUsedAfter !== buyer.tokens_used || tokensReservedAfter !== buyer.tokens_reserved) {
        db.prepare(
          `UPDATE marketplace_buyer_keys SET tokens_used = ?, tokens_reserved = ?, updated_at = ? WHERE id = ?`
        ).run(tokensUsedAfter, tokensReservedAfter, completedAt, buyer.id);
      }
    }

    const buyerBalanceAfter = buyer.balance_micro_usd + balanceDelta;
    if (balanceDelta !== 0) {
      db.prepare(
        "UPDATE marketplace_buyer_keys SET balance_micro_usd = ?, updated_at = ? WHERE id = ?"
      ).run(buyerBalanceAfter, completedAt, buyer.id);
      insertLedgerEntry(db, {
        buyerKeyId: buyer.id,
        sellerId: event.seller_id,
        listingId: event.listing_id,
        usageEventId: event.id,
        kind: balanceDelta > 0 ? "buyer_refund" : "buyer_overage",
        amountMicroUsd: balanceDelta,
        balanceAfterMicroUsd: buyerBalanceAfter,
      });
    }

    if (sellerAmount > 0) {
      db.prepare(
        "UPDATE marketplace_sellers SET balance_micro_usd = balance_micro_usd + ?, updated_at = ? WHERE id = ?"
      ).run(sellerAmount, completedAt, event.seller_id);
      insertLedgerEntry(db, {
        sellerId: event.seller_id,
        listingId: event.listing_id,
        usageEventId: event.id,
        kind: "seller_earning",
        sellerAmountMicroUsd: sellerAmount,
        platformFeeMicroUsd: platformFee,
      });
    }

    if (input.status === "succeeded") {
      db.prepare(
        `UPDATE marketplace_listings
         SET tokens_sold = tokens_sold + ?, revenue_micro_usd = revenue_micro_usd + ?, updated_at = ?
         WHERE id = ?`
      ).run(normalizeAmount(input.totalTokens), charge, completedAt, event.listing_id);
    }

    db.prepare(
      `UPDATE marketplace_usage_events
       SET prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, charged_micro_usd = ?,
           seller_amount_micro_usd = ?, platform_fee_micro_usd = ?, status = ?, upstream_status = ?,
           error_message = ?, completed_at = ?
       WHERE id = ?`
    ).run(
      input.promptTokens,
      input.completionTokens,
      input.totalTokens,
      charge,
      sellerAmount,
      platformFee,
      input.status,
      input.upstreamStatus ?? null,
      input.errorMessage?.slice(0, 500) || null,
      completedAt,
      event.id
    );

    const updated = getUsageEventRow(db, event.id);
    if (!updated) throw new MarketplaceDbError(500, "Usage finalization failed");
    return updated;
  });

  return usageEventFromRow(tx());
}

function eventPlatformFeeBps(db: DbLike, listingId: string): number {
  const row = db
    .prepare<{
      platform_fee_bps: number;
    }>("SELECT platform_fee_bps FROM marketplace_listings WHERE id = ?")
    .get(listingId);
  return normalizePlatformFeeBps(row?.platform_fee_bps);
}

export function listMarketplaceUsageEvents(limit = 100): MarketplaceUsageEvent[] {
  return getDb()
    .prepare<UsageEventRow>(
      "SELECT * FROM marketplace_usage_events ORDER BY created_at DESC LIMIT ?"
    )
    .all(Math.min(Math.max(Math.round(limit), 1), 1000))
    .map(usageEventFromRow);
}

export function listMarketplaceBuyerUsageEvents(
  buyerKeyId: string,
  limit = 100
): MarketplaceUsageEvent[] {
  return getDb()
    .prepare<UsageEventRow>(
      `SELECT * FROM marketplace_usage_events
       WHERE buyer_key_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(buyerKeyId, Math.min(Math.max(Math.round(limit), 1), 1000))
    .map(usageEventFromRow);
}

export function listMarketplaceSellerUsageEvents(
  sellerId: string,
  limit = 100
): MarketplaceUsageEvent[] {
  return getDb()
    .prepare<UsageEventRow>(
      `SELECT * FROM marketplace_usage_events
       WHERE seller_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(sellerId, Math.min(Math.max(Math.round(limit), 1), 1000))
    .map(usageEventFromRow);
}

export function getMarketplaceBuyerUsageSummary(buyerKeyId: string): MarketplaceUsageSummary {
  const row = getDb()
    .prepare<UsageSummaryRow>(
      `SELECT COUNT(*) AS request_count,
              COALESCE(SUM(COALESCE(total_tokens, 0)), 0) AS total_tokens,
              COALESCE(SUM(charged_micro_usd), 0) AS charged_micro_usd,
              COALESCE(SUM(seller_amount_micro_usd), 0) AS seller_amount_micro_usd,
              COALESCE(SUM(platform_fee_micro_usd), 0) AS platform_fee_micro_usd,
              COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_micro_usd ELSE 0 END), 0) AS reserved_micro_usd
       FROM marketplace_usage_events
       WHERE buyer_key_id = ?`
    )
    .get(buyerKeyId);
  return usageSummaryFromRow(row);
}

export function getMarketplaceSellerUsageSummary(sellerId: string): MarketplaceUsageSummary {
  const row = getDb()
    .prepare<UsageSummaryRow>(
      `SELECT COUNT(*) AS request_count,
              COALESCE(SUM(COALESCE(total_tokens, 0)), 0) AS total_tokens,
              COALESCE(SUM(charged_micro_usd), 0) AS charged_micro_usd,
              COALESCE(SUM(seller_amount_micro_usd), 0) AS seller_amount_micro_usd,
              COALESCE(SUM(platform_fee_micro_usd), 0) AS platform_fee_micro_usd,
              COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_micro_usd ELSE 0 END), 0) AS reserved_micro_usd
       FROM marketplace_usage_events
       WHERE seller_id = ?`
    )
    .get(sellerId);
  return usageSummaryFromRow(row);
}

// ─── Seller registration mode (single-seller platform gate) ─────────────────

export type MarketplaceSellerRegistrationMode = "closed" | "open";

const SELLER_REGISTRATION_KEY = "sellerRegistrationMode";

/**
 * Whether NEW sellers may self-provision via a wallet session. Defaults to
 * "closed": the platform runs in single-seller mode where the operator creates
 * the one seller through the management API. Existing sellers are unaffected.
 */
export function getSellerRegistrationMode(): MarketplaceSellerRegistrationMode {
  const row = getDb()
    .prepare<{
      value: string;
    }>("SELECT value FROM key_value WHERE namespace = 'marketplace' AND key = ?")
    .get(SELLER_REGISTRATION_KEY);
  return row?.value === "open" ? "open" : "closed";
}

export function setSellerRegistrationMode(mode: MarketplaceSellerRegistrationMode): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('marketplace', ?, ?)"
    )
    .run(SELLER_REGISTRATION_KEY, mode);
}

// ─── Prepaid keys (token-budgeted, anonymous) ────────────────────────────────

export interface MarketplacePrepaidKeyStatus {
  /** False when the key is unknown, disabled, or expired. */
  valid: boolean;
  /** Machine-readable reason when invalid: "not_found" | "disabled" | "expired". */
  reason: "not_found" | "disabled" | "expired" | null;
  name: string;
  keyPrefix: string;
  allowedModels: string[];
  unlimited: boolean;
  /** Null when the key is not prepaid-token (USD-funded instead). */
  tokens: {
    total: number;
    used: number;
    reserved: number;
    remaining: number;
  } | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface PrepaidPlatformUsage {
  connectionId: string;
  provider: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
  total: number;
  usdEstimate: number | null;
}

export interface PrepaidUsageStats {
  platforms: PrepaidPlatformUsage[];
  usdEstimateTotal: number;
}

// Declared price card for byesu ($/1M): input, cached-read, output.
// Measured reality (control runs 2026-08-26): billing lands ~2x the declared
// card on both sterile prompts (x2.08) and live 50M agent traffic (x1.99).
const BYESU_PRICES = { input: 0.05, cacheRead: 0.005, output: 0.3 };
const BYESU_CALIBRATION_FACTOR = 2.0;
const BYESU_PROVIDER_ID = "openai-compatible-responses-ccdecd52-e061-4522-93bd-8e2582d49825";

/** Per-upstream usage breakdown for a prepaid key (from usage_history). Admin-facing. */
export function getPrepaidKeyUsageStats(buyerKeyId: string): PrepaidUsageStats {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT uh.connection_id, COALESCE(pc.provider, 'unknown') AS node_id,
              COUNT(*) AS requests,
              COALESCE(SUM(uh.tokens_input), 0) AS input,
              COALESCE(SUM(uh.tokens_output), 0) AS output,
              COALESCE(SUM(uh.tokens_cache_read), 0) AS cache_read,
              COALESCE(SUM(uh.tokens_reasoning), 0) AS reasoning
         FROM usage_history uh
         LEFT JOIN provider_connections pc ON pc.id = uh.connection_id
        WHERE uh.api_key_id = ?
        GROUP BY uh.connection_id`
    )
    .all(buyerKeyId) as Array<{
    connection_id: string | null;
    node_id: string;
    requests: number;
    input: number;
    output: number;
    cache_read: number;
    reasoning: number;
  }>;

  // Node id → human name from provider_nodes when available
  const platforms = rows.map((r) => {
    let providerName = r.node_id;
    try {
      if (r.node_id !== "unknown") {
        const node = db
          .prepare("SELECT name FROM provider_nodes WHERE id = ?")
          .get(r.node_id) as { name?: string } | undefined;
        if (node?.name) providerName = node.name;
      }
    } catch {
      /* fall back to id */
    }
    const total = r.input + r.output + r.reasoning;
    const usdEstimate =
      r.node_id === BYESU_PROVIDER_ID
        ? (((r.input - r.cache_read) * BYESU_PRICES.input +
            r.cache_read * BYESU_PRICES.cacheRead +
            r.output * BYESU_PRICES.output) /
            1e6) *
          BYESU_CALIBRATION_FACTOR
        : null;
    return {
      connectionId: r.connection_id ?? "unknown",
      provider: providerName,
      requests: r.requests,
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      reasoning: r.reasoning,
      total,
      usdEstimate: usdEstimate != null ? Math.round(usdEstimate * 1e6) / 1e6 : null,
    };
  });

  return {
    platforms,
    usdEstimateTotal:
      Math.round(
        platforms.reduce((s, p) => s + (p.usdEstimate ?? 0), 0) * 1e6
      ) / 1e6,
  };
}

/**
 * Public prepaid-key checker lookup. Resolves the raw key to a safe status
 * snapshot — never exposes the key hash or the USD balance internals.
 */
export function getMarketplacePrepaidKeyStatus(
  rawKey: string | null | undefined
): MarketplacePrepaidKeyStatus | null {
  if (!rawKey) return null;
  const row = getDb()
    .prepare<
      BuyerKeyRow & { key_hash: string }
    >("SELECT * FROM marketplace_buyer_keys WHERE key_hash = ?")
    .get(hashMarketplaceKey(rawKey.trim()));
  if (!row) return null;

  const now = Date.now();
  const expired = row.expires_at != null && Date.parse(row.expires_at) <= now;
  const valid = row.status === "active" && !expired;
  const total = row.token_budget_total ?? 0;
  const used = row.tokens_used ?? 0;
  const reserved = row.tokens_reserved ?? 0;

  return {
    valid,
    reason: valid ? null : row.status !== "active" ? "disabled" : expired ? "expired" : null,
    name: row.name,
    keyPrefix: row.key_prefix,
    allowedModels: parseStringArray(row.allowed_models_json),
    unlimited: row.is_unlimited === 1,
    tokens:
      row.token_budget_total != null
        ? {
            total,
            used,
            reserved,
            remaining: Math.max(0, total - used - reserved),
          }
        : null,
    expiresAt: row.expires_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
  };
}

/** All prepaid-token buyer keys with per-upstream usage stats (management view). */
export function listPrepaidMarketplaceBuyerKeysWithStats() {
  const rows = getDb()
    .prepare<BuyerKeyRow & { key_enc?: string | null }>(
      "SELECT * FROM marketplace_buyer_keys WHERE token_budget_total IS NOT NULL OR is_unlimited = 1 ORDER BY created_at DESC"
    )
    .all();
  return rows.map((row) => {
    const key = buyerKeyFromRow(row);
    let apiKey: string | null = null;
    if (row.key_enc) {
      try {
        apiKey = decrypt(row.key_enc) ?? null;
      } catch {
        apiKey = null;
      }
    }
    return { ...key, apiKey, usageStats: getPrepaidKeyUsageStats(key.id) };
  });
}

/** All prepaid-token buyer keys, newest first (management view). */
export function listPrepaidMarketplaceBuyerKeys(): MarketplaceBuyerKey[] {
  return getDb()
    .prepare<BuyerKeyRow>(
      "SELECT * FROM marketplace_buyer_keys WHERE token_budget_total IS NOT NULL OR is_unlimited = 1 ORDER BY created_at DESC"
    )
    .all()
    .map(buyerKeyFromRow);
}

// ---------------------------------------------------------------------------
// Prepaid-key direct billing (no marketplace listing involved).
// Admin issues keys out-of-band; buyer traffic reserves tokens against the
// key's budget and settles actual usage after the upstream call completes.
// ---------------------------------------------------------------------------

/** Reserve `tokens` against a prepaid key's budget. Throws 402 on insufficient. */
export function reservePrepaidTokens(buyerKeyId: string, tokens: number): void {
  const db = getDb();
  const amount = normalizeAmount(tokens);
  const tx = db.transaction(() => {
    const buyer = db
      .prepare<BuyerKeyRow>("SELECT * FROM marketplace_buyer_keys WHERE id = ? AND status = 'active'")
      .get(buyerKeyId);
    if (!buyer) throw new MarketplaceDbError(401, "Invalid marketplace buyer key");
    if (buyer.expires_at && Date.parse(buyer.expires_at) <= Date.now()) {
      throw new MarketplaceDbError(401, "Marketplace buyer key has expired");
    }
    if (buyer.token_budget_total == null && buyer.is_unlimited !== 1) {
      throw new MarketplaceDbError(400, "Buyer key is not a prepaid key");
    }
    const usedSoFar = buyer.tokens_used ?? 0;
    // Пользовательский запрос: ключ действует пока фактическое использование
    // не достигло бюджета (не блокируем «до отметки»). Резерв сверху остатка
    // допустим — финальная сверка и авто-отключение происходят на settle.
    if (buyer.is_unlimited !== 1 && usedSoFar >= buyer.token_budget_total!) {
      throw new MarketplaceDbError(
        402,
        `Prepaid key budget exhausted: ${usedSoFar} used of ${buyer.token_budget_total}`
      );
    }
    const now = nowIso();
    db.prepare(
      `UPDATE marketplace_buyer_keys
       SET tokens_reserved = COALESCE(tokens_reserved, 0) + ?, last_used_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(amount, now, now, buyer.id);
  });
  tx();
}

/**
 * Settle a prepaid reservation: on success charge the actual total, on failure
 * release the reservation untouched. `actualTokens` may be null when upstream
 * usage was absent — then we charge the full reservation (conservative).
 */
export function settlePrepaidTokens(
  buyerKeyId: string,
  reservedTokens: number,
  actualTotalTokens: number | null,
  succeeded: boolean
): void {
  const db = getDb();
  const reserved = normalizeAmount(reservedTokens);
  const charged =
    succeeded && actualTotalTokens != null ? normalizeAmount(actualTotalTokens) : succeeded ? reserved : 0;
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE marketplace_buyer_keys
       SET tokens_used = COALESCE(tokens_used, 0) + ?,
           tokens_reserved = MAX(0, COALESCE(tokens_reserved, 0) - ?),
           updated_at = ?
       WHERE id = ?`
    ).run(charged, reserved, now, buyerKeyId);

    // Auto-close: once the budget is fully consumed (possibly slight overrun
    // from in-flight reservations), disable the key immediately instead of
    // leaving a tiny unusable residue that keeps showing as "active".
    if (charged > 0) {
      db.prepare(
        `UPDATE marketplace_buyer_keys
         SET status = 'disabled', updated_at = ?
         WHERE id = ? AND status = 'active'
           AND token_budget_total IS NOT NULL
           AND is_unlimited = 0
           AND COALESCE(tokens_used, 0) >= token_budget_total`
      ).run(now, buyerKeyId);
    }
  });
  tx();
}

/** Find a prepaid buyer key by its exact name and decrypt the raw key (idempotent re-issue). */
export function findPrepaidBuyerKeyByNameWithSecret(
  name: string
): { buyerKey: MarketplaceBuyerKey; apiKey: string | null } | null {
  const row = getDb()
    .prepare<BuyerKeyRow & { key_enc?: string | null }>(
      `SELECT * FROM marketplace_buyer_keys
       WHERE name = ? AND (token_budget_total IS NOT NULL OR is_unlimited = 1)
       ORDER BY created_at DESC`
    )
    .get(name);
  if (!row) return null;
  let apiKey: string | null = null;
  if (row.key_enc) {
    try {
      apiKey = decrypt(row.key_enc) ?? null;
    } catch {
      apiKey = null;
    }
  }
  return { buyerKey: buyerKeyFromRow(row), apiKey };
}
