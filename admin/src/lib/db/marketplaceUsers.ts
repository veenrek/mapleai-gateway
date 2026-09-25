// Unified marketplace user identity (wallet-based) + crypto deposit accounting.
//
// A marketplace user can both sell and buy. Their wallet balance lives on
// `marketplace_users.balance_micro_usd`. On-chain deposits are recorded
// idempotently per (chain_id, tx_hash, log_index) and credited exactly once.
// SIWE auth nonces are single-use and time-bounded.
//
// This module mirrors the conventions in `./marketplace.ts` (DbLike, explicit
// transactions, `*FromRow` mappers, MarketplaceDbError) and never holds raw SQL
// outside of it. Re-exported through `src/lib/localDb.ts`.
import { randomBytes, randomUUID } from "crypto";
import { getDbInstance } from "./core";
import { MarketplaceDbError, debitMarketplaceSellerBalance } from "./marketplace";

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
  transaction: <T>(fn: () => T) => () => T;
}

type MarketplaceUserStatus = "active" | "suspended" | "disabled";
type DepositStatus = "seen" | "confirmed" | "credited" | "reversed";

interface UserRow {
  id: string;
  wallet_address: string;
  display_name: string | null;
  status: MarketplaceUserStatus;
  balance_micro_usd: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

interface DepositAddressRow {
  id: string;
  user_id: string;
  chain_id: number;
  token_address: string;
  deposit_address: string;
  derivation_index: number;
  encrypted_private_key: string | null;
  created_at: string;
}

interface DepositRow {
  id: string;
  user_id: string;
  chain_id: number;
  tx_hash: string;
  log_index: number;
  block_number: number;
  token_address: string;
  from_address: string | null;
  to_address: string;
  amount_token: string;
  amount_micro_usd: number;
  confirmations: number;
  status: DepositStatus;
  credited_at: string | null;
  created_at: string;
  updated_at: string;
}

interface NonceRow {
  nonce: string;
  wallet_address: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface MarketplaceUser {
  id: string;
  walletAddress: string;
  displayName: string | null;
  status: MarketplaceUserStatus;
  balanceMicroUsd: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface MarketplaceDepositAddress {
  id: string;
  userId: string;
  chainId: number;
  tokenAddress: string;
  depositAddress: string;
  derivationIndex: number;
  createdAt: string;
}

export interface MarketplaceDeposit {
  id: string;
  userId: string;
  chainId: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  tokenAddress: string;
  fromAddress: string | null;
  toAddress: string;
  amountToken: string;
  amountMicroUsd: number;
  confirmations: number;
  status: DepositStatus;
  creditedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordDepositInput {
  userId: string;
  chainId: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  tokenAddress: string;
  fromAddress?: string | null;
  toAddress: string;
  amountToken: string;
  amountMicroUsd: number;
  confirmations?: number;
}

export interface CreateDepositAddressInput {
  userId: string;
  chainId: number;
  tokenAddress: string;
  depositAddress: string;
  derivationIndex: number;
  encryptedPrivateKey?: string | null;
}

const NONCE_TTL_MS = 10 * 60 * 1000;

function getDb(): DbLike {
  return getDbInstance() as unknown as DbLike;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Normalize an EVM address to its lowercase form for storage and comparison.
 * Wallet identity is case-insensitive; we never rely on checksum casing in the DB.
 */
export function normalizeWalletAddress(address: string): string {
  return address.trim().toLowerCase();
}

function normalizeAmount(value: number | undefined | null): number {
  if (!Number.isFinite(value) || !value || value < 0) return 0;
  return Math.round(value);
}

function userFromRow(row: UserRow): MarketplaceUser {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    displayName: row.display_name,
    status: row.status,
    balanceMicroUsd: row.balance_micro_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

function depositAddressFromRow(row: DepositAddressRow): MarketplaceDepositAddress {
  return {
    id: row.id,
    userId: row.user_id,
    chainId: row.chain_id,
    tokenAddress: row.token_address,
    depositAddress: row.deposit_address,
    derivationIndex: row.derivation_index,
    createdAt: row.created_at,
  };
}

function depositFromRow(row: DepositRow): MarketplaceDeposit {
  return {
    id: row.id,
    userId: row.user_id,
    chainId: row.chain_id,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    blockNumber: row.block_number,
    tokenAddress: row.token_address,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    amountToken: row.amount_token,
    amountMicroUsd: row.amount_micro_usd,
    confirmations: row.confirmations,
    status: row.status,
    creditedAt: row.credited_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Write a ledger entry against the unified user account. Mirrors the column
 * layout of `insertLedgerEntry` in `./marketplace.ts` but scoped to a user.
 */
function insertUserLedgerEntry(
  db: DbLike,
  input: {
    userId: string;
    kind: string;
    amountMicroUsd: number;
    balanceAfterMicroUsd: number;
    metadata?: unknown;
  }
): void {
  db.prepare(
    `INSERT INTO marketplace_ledger_entries (
      id, buyer_key_id, seller_id, listing_id, usage_event_id, user_id, kind,
      amount_micro_usd, seller_amount_micro_usd, platform_fee_micro_usd,
      balance_after_micro_usd, metadata_json, created_at
    ) VALUES (?, NULL, NULL, NULL, NULL, ?, ?, ?, 0, 0, ?, ?, ?)`
  ).run(
    randomUUID(),
    input.userId,
    input.kind,
    input.amountMicroUsd,
    input.balanceAfterMicroUsd,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
    nowIso()
  );
}

export function getMarketplaceUserById(id: string): MarketplaceUser | null {
  const row = getDb()
    .prepare<UserRow>("SELECT * FROM marketplace_users WHERE id = ?")
    .get(id);
  return row ? userFromRow(row) : null;
}

export function getMarketplaceUserByWallet(
  walletAddress: string | null | undefined
): MarketplaceUser | null {
  if (!walletAddress) return null;
  const row = getDb()
    .prepare<UserRow>("SELECT * FROM marketplace_users WHERE wallet_address = ?")
    .get(normalizeWalletAddress(walletAddress));
  return row ? userFromRow(row) : null;
}

/**
 * Idempotently fetch or create the user for a wallet address. Created users
 * start active with a zero balance.
 */
export function getOrCreateMarketplaceUserByWallet(walletAddress: string): MarketplaceUser {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) throw new MarketplaceDbError(400, "Wallet address is required");

  const db = getDb();
  const tx = db.transaction(() => {
    const existing = db
      .prepare<UserRow>("SELECT * FROM marketplace_users WHERE wallet_address = ?")
      .get(wallet);
    if (existing) return existing;

    const id = randomUUID();
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO marketplace_users (
        id, wallet_address, display_name, status, balance_micro_usd,
        created_at, updated_at, last_login_at
      ) VALUES (?, ?, NULL, 'active', 0, ?, ?, NULL)`
    ).run(id, wallet, createdAt, createdAt);
    return db.prepare<UserRow>("SELECT * FROM marketplace_users WHERE id = ?").get(id);
  });

  const row = tx();
  if (!row) throw new MarketplaceDbError(500, "Marketplace user was not created");
  return userFromRow(row);
}

export function touchMarketplaceUserLogin(userId: string): void {
  const at = nowIso();
  getDb()
    .prepare("UPDATE marketplace_users SET last_login_at = ?, updated_at = ? WHERE id = ?")
    .run(at, at, userId);
}

/**
 * Credit the user's wallet balance and write a ledger entry. Returns the new
 * balance. Runs inside the caller's transaction when one is supplied.
 */
export function creditMarketplaceUserBalance(
  userId: string,
  amountMicroUsd: number,
  kind: string,
  metadata?: unknown
): MarketplaceUser {
  const amount = normalizeAmount(amountMicroUsd);
  if (amount <= 0) throw new MarketplaceDbError(400, "Credit amount must be positive");

  const db = getDb();
  const tx = db.transaction(() => {
    const row = db
      .prepare<UserRow>("SELECT * FROM marketplace_users WHERE id = ?")
      .get(userId);
    if (!row) throw new MarketplaceDbError(404, "Marketplace user not found");

    const updatedAt = nowIso();
    const balanceAfter = row.balance_micro_usd + amount;
    db.prepare(
      "UPDATE marketplace_users SET balance_micro_usd = ?, updated_at = ? WHERE id = ?"
    ).run(balanceAfter, updatedAt, userId);
    insertUserLedgerEntry(db, {
      userId,
      kind,
      amountMicroUsd: amount,
      balanceAfterMicroUsd: balanceAfter,
      metadata,
    });
    return db.prepare<UserRow>("SELECT * FROM marketplace_users WHERE id = ?").get(userId);
  });

  const updated = tx();
  if (!updated) throw new MarketplaceDbError(500, "Balance credit failed");
  return userFromRow(updated);
}

/**
 * Debit the user's wallet balance (e.g. when funding a buyer key). Throws 402
 * when the balance is insufficient.
 */
export function debitMarketplaceUserBalance(
  userId: string,
  amountMicroUsd: number,
  kind: string,
  metadata?: unknown
): MarketplaceUser {
  const amount = normalizeAmount(amountMicroUsd);
  if (amount <= 0) throw new MarketplaceDbError(400, "Debit amount must be positive");

  const db = getDb();
  const tx = db.transaction(() => {
    const row = db
      .prepare<UserRow>("SELECT * FROM marketplace_users WHERE id = ?")
      .get(userId);
    if (!row) throw new MarketplaceDbError(404, "Marketplace user not found");
    if (row.balance_micro_usd < amount) {
      throw new MarketplaceDbError(402, "Insufficient marketplace wallet balance");
    }

    const updatedAt = nowIso();
    const balanceAfter = row.balance_micro_usd - amount;
    db.prepare(
      "UPDATE marketplace_users SET balance_micro_usd = ?, updated_at = ? WHERE id = ?"
    ).run(balanceAfter, updatedAt, userId);
    insertUserLedgerEntry(db, {
      userId,
      kind,
      amountMicroUsd: -amount,
      balanceAfterMicroUsd: balanceAfter,
      metadata,
    });
    return db.prepare<UserRow>("SELECT * FROM marketplace_users WHERE id = ?").get(userId);
  });

  const updated = tx();
  if (!updated) throw new MarketplaceDbError(500, "Balance debit failed");
  return userFromRow(updated);
}

export function listMarketplaceDepositAddresses(userId: string): MarketplaceDepositAddress[] {
  return getDb()
    .prepare<DepositAddressRow>(
      "SELECT * FROM marketplace_deposit_addresses WHERE user_id = ? ORDER BY created_at ASC"
    )
    .all(userId)
    .map(depositAddressFromRow);
}

export function getMarketplaceDepositAddress(
  userId: string,
  chainId: number,
  tokenAddress: string
): MarketplaceDepositAddress | null {
  const row = getDb()
    .prepare<DepositAddressRow>(
      `SELECT * FROM marketplace_deposit_addresses
       WHERE user_id = ? AND chain_id = ? AND token_address = ?`
    )
    .get(userId, chainId, normalizeWalletAddress(tokenAddress));
  return row ? depositAddressFromRow(row) : null;
}

/**
 * All deposit addresses across users for a chain — used by the watcher to build
 * the `eth_getLogs` recipient filter.
 */
export function listAllDepositAddressesForChain(chainId: number): MarketplaceDepositAddress[] {
  return getDb()
    .prepare<DepositAddressRow>(
      "SELECT * FROM marketplace_deposit_addresses WHERE chain_id = ?"
    )
    .all(chainId)
    .map(depositAddressFromRow);
}

export function getNextDepositDerivationIndex(): number {
  const row = getDb()
    .prepare<{ max_index: number | null }>(
      "SELECT MAX(derivation_index) AS max_index FROM marketplace_deposit_addresses"
    )
    .get();
  return Number(row?.max_index ?? -1) + 1;
}

export function createMarketplaceDepositAddress(
  input: CreateDepositAddressInput
): MarketplaceDepositAddress {
  const db = getDb();
  const id = randomUUID();
  const createdAt = nowIso();
  try {
    db.prepare(
      `INSERT INTO marketplace_deposit_addresses (
        id, user_id, chain_id, token_address, deposit_address, derivation_index,
        encrypted_private_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.userId,
      input.chainId,
      normalizeWalletAddress(input.tokenAddress),
      normalizeWalletAddress(input.depositAddress),
      input.derivationIndex,
      input.encryptedPrivateKey ?? null,
      createdAt
    );
  } catch (error) {
    throw new MarketplaceDbError(
      409,
      `Deposit address could not be created: ${(error as Error).message}`
    );
  }
  const row = db
    .prepare<DepositAddressRow>("SELECT * FROM marketplace_deposit_addresses WHERE id = ?")
    .get(id);
  if (!row) throw new MarketplaceDbError(500, "Deposit address was not created");
  return depositAddressFromRow(row);
}

export function listMarketplaceDeposits(userId: string, limit = 100): MarketplaceDeposit[] {
  return getDb()
    .prepare<DepositRow>(
      "SELECT * FROM marketplace_deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(userId, limit)
    .map(depositFromRow);
}

export function listPendingMarketplaceDeposits(): MarketplaceDeposit[] {
  return getDb()
    .prepare<DepositRow>(
      "SELECT * FROM marketplace_deposits WHERE status IN ('seen', 'confirmed') ORDER BY created_at ASC"
    )
    .all()
    .map(depositFromRow);
}

/**
 * Credited deposits on a chain that are still within the reorg re-check window
 * (i.e. mined within `maxBlockAge` blocks of the current head). Used by the
 * watcher to detect a reorg that dropped an already-credited tx.
 */
export function listRecentlyCreditedDeposits(
  chainId: number,
  minBlockNumber: number
): MarketplaceDeposit[] {
  return getDb()
    .prepare<DepositRow>(
      `SELECT * FROM marketplace_deposits
       WHERE chain_id = ? AND status = 'credited' AND block_number >= ?
       ORDER BY block_number ASC`
    )
    .all(chainId, minBlockNumber)
    .map(depositFromRow);
}

/**
 * Record a newly observed on-chain deposit. Idempotent: if a row already exists
 * for (chain_id, tx_hash, log_index) the existing row is returned with its
 * confirmation count refreshed (never downgrading a credited deposit).
 */
export function recordMarketplaceDeposit(input: RecordDepositInput): MarketplaceDeposit {
  const db = getDb();
  const tx = db.transaction(() => {
    const existing = db
      .prepare<DepositRow>(
        "SELECT * FROM marketplace_deposits WHERE chain_id = ? AND tx_hash = ? AND log_index = ?"
      )
      .get(input.chainId, input.txHash, input.logIndex);

    if (existing) {
      if (existing.status !== "credited") {
        db.prepare(
          "UPDATE marketplace_deposits SET confirmations = ?, updated_at = ? WHERE id = ?"
        ).run(normalizeAmount(input.confirmations), nowIso(), existing.id);
      }
      return db
        .prepare<DepositRow>("SELECT * FROM marketplace_deposits WHERE id = ?")
        .get(existing.id);
    }

    const id = randomUUID();
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO marketplace_deposits (
        id, user_id, chain_id, tx_hash, log_index, block_number, token_address,
        from_address, to_address, amount_token, amount_micro_usd, confirmations,
        status, credited_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seen', NULL, ?, ?)`
    ).run(
      id,
      input.userId,
      input.chainId,
      input.txHash,
      input.logIndex,
      input.blockNumber,
      normalizeWalletAddress(input.tokenAddress),
      input.fromAddress ? normalizeWalletAddress(input.fromAddress) : null,
      normalizeWalletAddress(input.toAddress),
      input.amountToken,
      normalizeAmount(input.amountMicroUsd),
      normalizeAmount(input.confirmations),
      createdAt,
      createdAt
    );
    return db.prepare<DepositRow>("SELECT * FROM marketplace_deposits WHERE id = ?").get(id);
  });

  const row = tx();
  if (!row) throw new MarketplaceDbError(500, "Deposit was not recorded");
  return depositFromRow(row);
}

/**
 * Credit a deposit to the user's wallet balance exactly once. Safe to call
 * repeatedly — only a non-credited deposit transitions to `credited` and moves
 * the balance. Returns true when the credit was applied on this call.
 */
export function creditMarketplaceDeposit(depositId: string): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    const deposit = db
      .prepare<DepositRow>("SELECT * FROM marketplace_deposits WHERE id = ?")
      .get(depositId);
    if (!deposit) throw new MarketplaceDbError(404, "Deposit not found");
    if (deposit.status === "credited") return false;

    const user = db
      .prepare<UserRow>("SELECT * FROM marketplace_users WHERE id = ?")
      .get(deposit.user_id);
    if (!user) throw new MarketplaceDbError(404, "Marketplace user not found");

    const completedAt = nowIso();
    const balanceAfter = user.balance_micro_usd + deposit.amount_micro_usd;
    db.prepare(
      "UPDATE marketplace_users SET balance_micro_usd = ?, updated_at = ? WHERE id = ?"
    ).run(balanceAfter, completedAt, user.id);
    db.prepare(
      "UPDATE marketplace_deposits SET status = 'credited', credited_at = ?, updated_at = ? WHERE id = ?"
    ).run(completedAt, completedAt, deposit.id);
    insertUserLedgerEntry(db, {
      userId: user.id,
      kind: "crypto_deposit",
      amountMicroUsd: deposit.amount_micro_usd,
      balanceAfterMicroUsd: balanceAfter,
      metadata: {
        chainId: deposit.chain_id,
        txHash: deposit.tx_hash,
        logIndex: deposit.log_index,
        tokenAddress: deposit.token_address,
        amountToken: deposit.amount_token,
      },
    });
    return true;
  });

  return tx();
}

export interface ReverseDepositResult {
  reversed: boolean;
  /** micro-USD that could not be clawed back because the balance was already spent. */
  shortfallMicroUsd: number;
}

/**
 * Reverse a previously credited deposit after a chain reorg dropped its tx.
 * Debits the user's balance by the credited amount; if the balance is now lower
 * than the credit (funds already spent), it is floored at zero and the
 * unrecoverable remainder is reported as `shortfallMicroUsd` for operator
 * follow-up. Idempotent: a non-credited deposit is a no-op.
 */
export function reverseMarketplaceDeposit(depositId: string): ReverseDepositResult {
  const db = getDb();
  const tx = db.transaction((): ReverseDepositResult => {
    const deposit = db
      .prepare<DepositRow>("SELECT * FROM marketplace_deposits WHERE id = ?")
      .get(depositId);
    if (!deposit) throw new MarketplaceDbError(404, "Deposit not found");
    if (deposit.status !== "credited") return { reversed: false, shortfallMicroUsd: 0 };

    const user = db
      .prepare<UserRow>("SELECT * FROM marketplace_users WHERE id = ?")
      .get(deposit.user_id);
    if (!user) throw new MarketplaceDbError(404, "Marketplace user not found");

    const at = nowIso();
    const clawback = Math.min(user.balance_micro_usd, deposit.amount_micro_usd);
    const shortfall = deposit.amount_micro_usd - clawback;
    const balanceAfter = user.balance_micro_usd - clawback;

    db.prepare(
      "UPDATE marketplace_users SET balance_micro_usd = ?, updated_at = ? WHERE id = ?"
    ).run(balanceAfter, at, user.id);
    db.prepare(
      "UPDATE marketplace_deposits SET status = 'reversed', updated_at = ? WHERE id = ?"
    ).run(at, deposit.id);
    insertUserLedgerEntry(db, {
      userId: user.id,
      kind: "crypto_deposit_reversal",
      amountMicroUsd: -clawback,
      balanceAfterMicroUsd: balanceAfter,
      metadata: {
        chainId: deposit.chain_id,
        txHash: deposit.tx_hash,
        logIndex: deposit.log_index,
        reason: "reorg",
        shortfallMicroUsd: shortfall,
      },
    });
    return { reversed: true, shortfallMicroUsd: shortfall };
  });

  return tx();
}

/**
 * Mark a deposit as confirmed (enough confirmations) without crediting it.
 * The watcher promotes seen → confirmed, then confirmed → credited.
 */
export function markDepositConfirmed(depositId: string, confirmations: number): void {
  getDb()
    .prepare(
      `UPDATE marketplace_deposits SET status = 'confirmed', confirmations = ?, updated_at = ?
       WHERE id = ? AND status = 'seen'`
    )
    .run(normalizeAmount(confirmations), nowIso(), depositId);
}

/**
 * Set the USD value of a not-yet-credited deposit (priced at credit time from a
 * live oracle). No-op on a credited/reversed deposit so a reorg cannot change a
 * settled amount.
 */
export function updateDepositAmountMicroUsd(depositId: string, amountMicroUsd: number): void {
  getDb()
    .prepare(
      `UPDATE marketplace_deposits SET amount_micro_usd = ?, updated_at = ?
       WHERE id = ? AND status IN ('seen', 'confirmed')`
    )
    .run(normalizeAmount(amountMicroUsd), nowIso(), depositId);
}

interface BuyerKeyBalanceRow {
  id: string;
  user_id: string | null;
  balance_micro_usd: number;
}

/**
 * Move funds from the user's wallet balance into one of their buyer keys, in a
 * single transaction. Verifies the buyer key belongs to the user. Writes ledger
 * entries on both sides. Returns the new balances.
 */
export function fundBuyerKeyFromUserBalance(
  userId: string,
  buyerKeyId: string,
  amountMicroUsd: number
): { userBalanceMicroUsd: number; buyerKeyBalanceMicroUsd: number } {
  const amount = normalizeAmount(amountMicroUsd);
  if (amount <= 0) throw new MarketplaceDbError(400, "Funding amount must be positive");

  const db = getDb();
  const tx = db.transaction(() => {
    const user = db
      .prepare<UserRow>("SELECT * FROM marketplace_users WHERE id = ?")
      .get(userId);
    if (!user) throw new MarketplaceDbError(404, "Marketplace user not found");

    const buyerKey = db
      .prepare<BuyerKeyBalanceRow>(
        "SELECT id, user_id, balance_micro_usd FROM marketplace_buyer_keys WHERE id = ?"
      )
      .get(buyerKeyId);
    if (!buyerKey) throw new MarketplaceDbError(404, "Buyer key not found");
    if (buyerKey.user_id && buyerKey.user_id !== userId) {
      throw new MarketplaceDbError(403, "Buyer key does not belong to this user");
    }
    if (user.balance_micro_usd < amount) {
      throw new MarketplaceDbError(402, "Insufficient marketplace wallet balance");
    }

    const at = nowIso();
    const userBalanceAfter = user.balance_micro_usd - amount;
    const buyerBalanceAfter = buyerKey.balance_micro_usd + amount;

    db.prepare(
      "UPDATE marketplace_users SET balance_micro_usd = ?, updated_at = ? WHERE id = ?"
    ).run(userBalanceAfter, at, userId);
    db.prepare(
      "UPDATE marketplace_buyer_keys SET balance_micro_usd = ?, updated_at = ? WHERE id = ?"
    ).run(buyerBalanceAfter, at, buyerKeyId);

    insertUserLedgerEntry(db, {
      userId,
      kind: "buyer_key_fund",
      amountMicroUsd: -amount,
      balanceAfterMicroUsd: userBalanceAfter,
      metadata: { buyerKeyId },
    });
    // Buyer-key-scoped entry: deliberately NO user_id so that the sum of
    // user-scoped ledger amounts equals the user wallet balance (reconciliation
    // invariant). The matching user-side debit is the `buyer_key_fund` entry above.
    db.prepare(
      `INSERT INTO marketplace_ledger_entries (
        id, buyer_key_id, seller_id, listing_id, usage_event_id, user_id, kind,
        amount_micro_usd, seller_amount_micro_usd, platform_fee_micro_usd,
        balance_after_micro_usd, metadata_json, created_at
      ) VALUES (?, ?, NULL, NULL, NULL, NULL, 'buyer_topup', ?, 0, 0, ?, ?, ?)`
    ).run(
      randomUUID(),
      buyerKeyId,
      amount,
      buyerBalanceAfter,
      JSON.stringify({ source: "wallet_balance", fundedByUserId: userId }),
      at
    );

    return { userBalanceMicroUsd: userBalanceAfter, buyerKeyBalanceMicroUsd: buyerBalanceAfter };
  });

  return tx();
}

/**
 * Issue a single-use SIWE nonce for a wallet. Returns the nonce string to embed
 * in the sign-in message.
 */
export function issueMarketplaceAuthNonce(walletAddress: string): string {
  const wallet = normalizeWalletAddress(walletAddress);
  if (!wallet) throw new MarketplaceDbError(400, "Wallet address is required");
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = Date.now();
  getDb()
    .prepare(
      `INSERT INTO marketplace_auth_nonces (nonce, wallet_address, issued_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(
      nonce,
      wallet,
      new Date(issuedAt).toISOString(),
      new Date(issuedAt + NONCE_TTL_MS).toISOString()
    );
  return nonce;
}

/**
 * Atomically consume a nonce for a wallet. Returns true only if the nonce
 * exists, matches the wallet, is unconsumed, and is unexpired. Replays and
 * cross-wallet reuse return false.
 */
export function consumeMarketplaceAuthNonce(nonce: string, walletAddress: string): boolean {
  const wallet = normalizeWalletAddress(walletAddress);
  const db = getDb();
  const tx = db.transaction(() => {
    const row = db
      .prepare<NonceRow>("SELECT * FROM marketplace_auth_nonces WHERE nonce = ?")
      .get(nonce);
    if (!row) return false;
    if (row.consumed_at) return false;
    if (row.wallet_address !== wallet) return false;
    if (Date.parse(row.expires_at) <= Date.now()) return false;
    db.prepare("UPDATE marketplace_auth_nonces SET consumed_at = ? WHERE nonce = ?").run(
      nowIso(),
      nonce
    );
    return true;
  });
  return tx();
}

/**
 * Delete expired/consumed nonces. Call opportunistically; not on a hot path.
 */
export function pruneMarketplaceAuthNonces(): number {
  const result = getDb()
    .prepare(
      "DELETE FROM marketplace_auth_nonces WHERE expires_at <= ? OR consumed_at IS NOT NULL"
    )
    .run(nowIso());
  return Number(result.changes || 0);
}

export interface BalanceDrift {
  userId: string;
  walletAddress: string;
  storedBalanceMicroUsd: number;
  ledgerSumMicroUsd: number;
  driftMicroUsd: number;
}

/**
 * Reconcile each user's stored wallet balance against the signed sum of their
 * user-scoped ledger entries. A healthy system has zero drift everywhere: every
 * balance mutation writes a matching ledger row with the same delta. Returns
 * only the users whose stored balance disagrees with their ledger — an empty
 * array means the books balance.
 *
 * Note: buyer-key balance changes are intentionally NOT user-scoped in the
 * ledger (see fundBuyerKeyFromUserBalance), so they do not enter this sum.
 */
export function reconcileMarketplaceUserBalances(): BalanceDrift[] {
  const rows = getDb()
    .prepare<{
      id: string;
      wallet_address: string;
      balance_micro_usd: number;
      ledger_sum: number | null;
    }>(
      `SELECT u.id, u.wallet_address, u.balance_micro_usd,
              COALESCE(SUM(l.amount_micro_usd), 0) AS ledger_sum
       FROM marketplace_users u
       LEFT JOIN marketplace_ledger_entries l ON l.user_id = u.id
       GROUP BY u.id`
    )
    .all();

  const drifts: BalanceDrift[] = [];
  for (const row of rows) {
    const ledgerSum = Number(row.ledger_sum || 0);
    const drift = row.balance_micro_usd - ledgerSum;
    if (drift !== 0) {
      drifts.push({
        userId: row.id,
        walletAddress: row.wallet_address,
        storedBalanceMicroUsd: row.balance_micro_usd,
        ledgerSumMicroUsd: ledgerSum,
        driftMicroUsd: drift,
      });
    }
  }
  return drifts;
}

// ── Crypto withdrawals ──────────────────────────────────────────────────────

type WithdrawalStatus = "pending" | "submitted" | "confirmed" | "failed";

interface WithdrawalRow {
  id: string;
  user_id: string | null;
  seller_id: string | null;
  chain_id: number;
  token_address: string;
  to_address: string;
  amount_micro_usd: number;
  amount_token: string;
  tx_hash: string | null;
  status: WithdrawalStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceWithdrawal {
  id: string;
  userId: string | null;
  sellerId: string | null;
  chainId: number;
  tokenAddress: string;
  toAddress: string;
  amountMicroUsd: number;
  amountToken: string;
  txHash: string | null;
  status: WithdrawalStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function withdrawalFromRow(row: WithdrawalRow): MarketplaceWithdrawal {
  return {
    id: row.id,
    userId: row.user_id,
    sellerId: row.seller_id,
    chainId: row.chain_id,
    tokenAddress: row.token_address,
    toAddress: row.to_address,
    amountMicroUsd: row.amount_micro_usd,
    amountToken: row.amount_token,
    txHash: row.tx_hash,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Debit the user's wallet balance and record a pending withdrawal. Runs
 * atomically: if the debit fails (insufficient balance), the withdrawal row is
 * not created. The actual on-chain broadcast happens by a separate call
 * (submitWithdrawalTx) so the API response never blocks on chain confirmation.
 */
export function recordUserWithdrawal(params: {
  userId: string;
  chainId: number;
  tokenAddress: string;
  toAddress: string;
  amountMicroUsd: number;
  amountToken: string;
}): MarketplaceWithdrawal {
  const amount = normalizeAmount(params.amountMicroUsd);
  if (amount <= 0) throw new MarketplaceDbError(400, "Withdrawal amount must be positive");

  const db = getDb();
  const tx = db.transaction(() => {
    const user = db
      .prepare<UserRow>("SELECT * FROM marketplace_users WHERE id = ?")
      .get(params.userId);
    if (!user) throw new MarketplaceDbError(404, "Marketplace user not found");
    if (user.balance_micro_usd < amount) {
      throw new MarketplaceDbError(402, "Insufficient marketplace wallet balance");
    }

    const createdAt = nowIso();
    const balanceAfter = user.balance_micro_usd - amount;
    db.prepare(
      "UPDATE marketplace_users SET balance_micro_usd = ?, updated_at = ? WHERE id = ?"
    ).run(balanceAfter, createdAt, params.userId);
    insertUserLedgerEntry(db, {
      userId: params.userId,
      kind: "crypto_withdrawal",
      amountMicroUsd: -amount,
      balanceAfterMicroUsd: balanceAfter,
      metadata: {
        chainId: params.chainId,
        tokenAddress: params.tokenAddress,
        toAddress: params.toAddress,
      },
    });

    const id = randomUUID();
    db.prepare(
      `INSERT INTO marketplace_withdrawals (
        id, user_id, seller_id, chain_id, token_address, to_address,
        amount_micro_usd, amount_token, tx_hash, status, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?)`
    ).run(
      id,
      params.userId,
      params.chainId,
      normalizeWalletAddress(params.tokenAddress),
      normalizeWalletAddress(params.toAddress),
      amount,
      params.amountToken,
      createdAt,
      createdAt
    );
    return db
      .prepare<WithdrawalRow>("SELECT * FROM marketplace_withdrawals WHERE id = ?")
      .get(id);
  });

  const row = tx();
  if (!row) throw new MarketplaceDbError(500, "Withdrawal was not recorded");
  return withdrawalFromRow(row);
}

/** Mark a pending withdrawal as submitted (tx broadcast to chain). */
export function markWithdrawalSubmitted(id: string, txHash: string): MarketplaceWithdrawal {
  const db = getDb();
  const at = nowIso();
  db.prepare(
    "UPDATE marketplace_withdrawals SET status = 'submitted', tx_hash = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
  ).run(txHash, at, id);
  const row = db
    .prepare<WithdrawalRow>("SELECT * FROM marketplace_withdrawals WHERE id = ?")
    .get(id);
  if (!row) throw new MarketplaceDbError(404, "Withdrawal not found");
  return withdrawalFromRow(row);
}

/** Mark a submitted withdrawal as confirmed on-chain. */
export function markWithdrawalConfirmed(id: string): MarketplaceWithdrawal {
  const db = getDb();
  db.prepare(
    "UPDATE marketplace_withdrawals SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'submitted'"
  ).run(nowIso(), id);
  const row = db
    .prepare<WithdrawalRow>("SELECT * FROM marketplace_withdrawals WHERE id = ?")
    .get(id);
  if (!row) throw new MarketplaceDbError(404, "Withdrawal not found");
  return withdrawalFromRow(row);
}

/**
 * Mark a withdrawal as failed and refund the debited balance. Atomically:
 * credit the user/seller balance + write a ledger reversal entry. Refunds both
 * `pending` (broadcast never succeeded) and `submitted` (tx reverted/dropped)
 * withdrawals. Idempotent: already-failed/confirmed withdrawals are a no-op.
 */
export function markWithdrawalFailed(id: string, error: string): MarketplaceWithdrawal {
  const db = getDb();
  const tx = db.transaction(() => {
    const w = db
      .prepare<WithdrawalRow>("SELECT * FROM marketplace_withdrawals WHERE id = ?")
      .get(id);
    if (!w) throw new MarketplaceDbError(404, "Withdrawal not found");
    if (w.status !== "submitted" && w.status !== "pending") return w;

    const at = nowIso();
    db.prepare(
      "UPDATE marketplace_withdrawals SET status = 'failed', error = ?, updated_at = ? WHERE id = ?"
    ).run(error.slice(0, 500), at, id);

    if (w.user_id) {
      const user = db
        .prepare<UserRow>("SELECT * FROM marketplace_users WHERE id = ?")
        .get(w.user_id);
      if (user) {
        const balanceAfter = user.balance_micro_usd + w.amount_micro_usd;
        db.prepare(
          "UPDATE marketplace_users SET balance_micro_usd = ?, updated_at = ? WHERE id = ?"
        ).run(balanceAfter, at, w.user_id);
        insertUserLedgerEntry(db, {
          userId: w.user_id,
          kind: "crypto_withdrawal_reversal",
          amountMicroUsd: w.amount_micro_usd,
          balanceAfterMicroUsd: balanceAfter,
          metadata: { withdrawalId: w.id, reason: error.slice(0, 200) },
        });
      }
    }
    if (w.seller_id) {
      const seller = db
        .prepare<{ balance_micro_usd: number }>(
          "SELECT balance_micro_usd FROM marketplace_sellers WHERE id = ?"
        )
        .get(w.seller_id);
      if (seller) {
        const balanceAfter = seller.balance_micro_usd + w.amount_micro_usd;
        db.prepare(
          "UPDATE marketplace_sellers SET balance_micro_usd = ?, updated_at = ? WHERE id = ?"
        ).run(balanceAfter, at, w.seller_id);
        // Seller-scoped ledger reversal (mirrors the seller_withdrawal debit).
        db.prepare(
          `INSERT INTO marketplace_ledger_entries (
            id, buyer_key_id, seller_id, listing_id, usage_event_id, user_id, kind,
            amount_micro_usd, seller_amount_micro_usd, platform_fee_micro_usd,
            balance_after_micro_usd, metadata_json, created_at
          ) VALUES (?, NULL, ?, NULL, NULL, NULL, 'seller_withdrawal_reversal', 0, ?, 0, ?, ?, ?)`
        ).run(
          randomUUID(),
          w.seller_id,
          w.amount_micro_usd,
          balanceAfter,
          JSON.stringify({ withdrawalId: w.id, reason: error.slice(0, 200) }),
          at
        );
      }
    }
    return db
      .prepare<WithdrawalRow>("SELECT * FROM marketplace_withdrawals WHERE id = ?")
      .get(id);
  });

  const row = tx();
  if (!row) throw new MarketplaceDbError(500, "Withdrawal reversal failed");
  return withdrawalFromRow(row);
}

/** List submitted withdrawals across all chains for the watcher confirmer. */
export function listSubmittedWithdrawals(): MarketplaceWithdrawal[] {
  return getDb()
    .prepare<WithdrawalRow>(
      "SELECT * FROM marketplace_withdrawals WHERE status = 'submitted' ORDER BY created_at ASC"
    )
    .all()
    .map(withdrawalFromRow);
}

/** List withdrawals for a user, newest first. */
export function listUserWithdrawals(userId: string, limit = 50): MarketplaceWithdrawal[] {
  return getDb()
    .prepare<WithdrawalRow>(
      "SELECT * FROM marketplace_withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(userId, limit)
    .map(withdrawalFromRow);
}

/** List withdrawals for a seller, newest first. */
export function listSellerWithdrawals(sellerId: string, limit = 50): MarketplaceWithdrawal[] {
  return getDb()
    .prepare<WithdrawalRow>(
      "SELECT * FROM marketplace_withdrawals WHERE seller_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(sellerId, limit)
    .map(withdrawalFromRow);
}

/**
 * Debit a seller's balance and record a pending withdrawal to their login
 * wallet. Uses debitMarketplaceSellerBalance (which writes a seller-scoped
 * ledger entry) and then creates the withdrawal row atomically.
 */
export function recordSellerWithdrawal(params: {
  sellerId: string;
  toAddress: string;
  chainId: number;
  tokenAddress: string;
  amountMicroUsd: number;
  amountToken: string;
}): MarketplaceWithdrawal {
  const amount = normalizeAmount(params.amountMicroUsd);
  if (amount <= 0) throw new MarketplaceDbError(400, "Withdrawal amount must be positive");

  const db = getDb();
  const tx = db.transaction(() => {
    // Debit the seller balance (throws 402 if insufficient).
    debitMarketplaceSellerBalance({
      sellerId: params.sellerId,
      amountMicroUsd: amount,
      kind: "seller_withdrawal",
      metadata: { chainId: params.chainId, tokenAddress: params.tokenAddress },
    });

    const createdAt = nowIso();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO marketplace_withdrawals (
        id, user_id, seller_id, chain_id, token_address, to_address,
        amount_micro_usd, amount_token, tx_hash, status, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?)`
    ).run(
      id,
      params.sellerId,
      params.chainId,
      normalizeWalletAddress(params.tokenAddress),
      normalizeWalletAddress(params.toAddress),
      amount,
      params.amountToken,
      createdAt,
      createdAt
    );
    return db
      .prepare<WithdrawalRow>("SELECT * FROM marketplace_withdrawals WHERE id = ?")
      .get(id);
  });

  const row = tx();
  if (!row) throw new MarketplaceDbError(500, "Seller withdrawal was not recorded");
  return withdrawalFromRow(row);
}
