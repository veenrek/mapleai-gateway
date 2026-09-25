// Deposit watcher core — pure-ish logic, RPC functions injectable for testing.
//
// One cycle per chain: read the chain head, scan ERC-20 Transfer logs to known
// deposit addresses since the last processed block, record each as a deposit,
// then credit any deposit that has reached the chain's confirmation threshold.
// All crediting is idempotent (see creditMarketplaceDeposit).
import { getDbInstance } from "@/lib/db/core";
import {
  creditMarketplaceDeposit,
  getMarketplaceDepositAddress,
  getOrCreateMarketplaceUserByWallet,
  listAllDepositAddressesForChain,
  listPendingMarketplaceDeposits,
  listRecentlyCreditedDeposits,
  listSubmittedWithdrawals,
  markDepositConfirmed,
  markWithdrawalConfirmed,
  markWithdrawalFailed,
  normalizeWalletAddress,
  recordMarketplaceDeposit,
  reverseMarketplaceDeposit,
  updateDepositAmountMicroUsd,
} from "@/lib/db/marketplaceUsers";
import {
  getMarketplaceChain,
  getMarketplaceCryptoConfig,
  tokenBaseUnitsToMicroUsd,
  type MarketplaceChainConfig,
} from "./config";
import {
  getBlockNumber,
  getDepositTransferLogs,
  getTransactionReceipt,
  isTransactionKnown,
  type TransferLog,
} from "./erc20";
import { resolveTokenUsdPrice, type OracleDeps } from "./priceOracle";

const CURSOR_NAMESPACE = "marketplaceDepositWatcher";
const LOCK_KEY = "__cycle_lock__";
/** Lock lease: a cycle holding the lock past this is considered dead. */
const LOCK_TTL_MS = 5 * 60 * 1000;

/** Re-org safety margin: re-scan this many blocks behind the last processed. */
const REORG_LOOKBACK = 6;
/** Cap blocks scanned per cycle so a cold start doesn't issue a huge getLogs. */
const MAX_BLOCK_SPAN = 5_000;

export interface RpcAdapter {
  getBlockNumber: (rpcUrl: string) => Promise<number>;
  getDepositTransferLogs: typeof getDepositTransferLogs;
  getTransactionReceipt: typeof getTransactionReceipt;
  isTransactionKnown: typeof isTransactionKnown;
}

const defaultRpc: RpcAdapter = {
  getBlockNumber,
  getDepositTransferLogs,
  getTransactionReceipt,
  isTransactionKnown,
};

interface KvDb {
  prepare: (sql: string) => {
    get: (...p: unknown[]) => { value: string } | undefined;
    run: (...p: unknown[]) => unknown;
  };
}

function readCursor(chainId: number): number | null {
  const db = getDbInstance() as unknown as KvDb;
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(CURSOR_NAMESPACE, String(chainId));
  if (!row?.value) return null;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) ? n : null;
}

function writeCursor(chainId: number, blockNumber: number): void {
  const db = getDbInstance() as unknown as KvDb;
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)"
  ).run(CURSOR_NAMESPACE, String(chainId), String(blockNumber));
}

/**
 * Acquire a cross-process cycle lock via the key_value table so two server
 * instances sharing one database never scan/credit concurrently. The lock is a
 * timestamp lease: a stale lease (older than LOCK_TTL_MS, e.g. from a crashed
 * instance) is reclaimed. Returns true if the lock was acquired.
 *
 * The lease value is `expiry:token`; the random token identifies the holder so
 * releaseCycleLock only clears a lock we still own (an expired lease may have
 * been reclaimed by another instance whose lock we must not delete). `parseInt`
 * still reads the expiry from the `expiry:` prefix, so old single-number leases
 * remain readable.
 */
let heldLockToken: string | null = null;
let lockSeq = 0;

export function acquireCycleLock(nowMs: number): boolean {
  const db = getDbInstance() as unknown as KvDb;
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(CURSOR_NAMESPACE, LOCK_KEY);
  const heldUntil = row?.value ? parseInt(row.value, 10) : 0;
  if (Number.isFinite(heldUntil) && heldUntil > nowMs) return false;
  // Token: unique per acquisition. randomUUID is unavailable in workflow-style
  // contexts but fine here; nowMs + a counter keeps it unique without it.
  const token = `${nowMs}-${(lockSeq = (lockSeq + 1) % Number.MAX_SAFE_INTEGER)}`;
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)"
  ).run(CURSOR_NAMESPACE, LOCK_KEY, `${nowMs + LOCK_TTL_MS}:${token}`);
  heldLockToken = token;
  return true;
}

export function releaseCycleLock(): void {
  if (heldLockToken === null) return;
  const db = getDbInstance() as unknown as KvDb;
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(CURSOR_NAMESPACE, LOCK_KEY);
  // Only delete the lock if it still carries our token — otherwise our lease
  // expired and another instance reclaimed it; deleting would drop their lock.
  const currentToken = row?.value ? row.value.split(":").slice(1).join(":") : "";
  if (currentToken === heldLockToken) {
    db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?").run(
      CURSOR_NAMESPACE,
      LOCK_KEY
    );
  }
  heldLockToken = null;
}

export interface CycleResult {
  chainId: number;
  scannedFrom: number;
  scannedTo: number;
  newDeposits: number;
  credited: number;
  reversed: number;
}

/**
 * Run one scan cycle for a single chain. Returns counts for logging/tests.
 */
export async function runChainCycle(
  chain: MarketplaceChainConfig,
  rpc: RpcAdapter = defaultRpc,
  oracleDeps?: OracleDeps
): Promise<CycleResult> {
  const head = await rpc.getBlockNumber(chain.rpcUrl);

  // Treasury mode: scan Transfer logs to the single treasury address and
  // attribute each deposit by its sender (log.from). Legacy mode: scan logs to
  // the set of per-user derived deposit addresses and attribute by log.to.
  const treasury = chain.treasuryAddress;
  const toAddresses = treasury
    ? [treasury]
    : listAllDepositAddressesForChain(chain.chainId).map((a) => a.depositAddress);

  let newDeposits = 0;
  if (toAddresses.length > 0) {
    const cursor = readCursor(chain.chainId);
    const fromBlock = Math.max(
      0,
      cursor === null ? head - MAX_BLOCK_SPAN : cursor - REORG_LOOKBACK + 1
    );
    const toBlock = head;

    if (toBlock >= fromBlock) {
      const logs = await rpc.getDepositTransferLogs({
        rpcUrl: chain.rpcUrl,
        tokenAddress: chain.tokenAddress,
        toAddresses,
        fromBlock,
        toBlock,
      });
      newDeposits = ingestLogs(chain, logs, head);
      writeCursor(chain.chainId, toBlock);
    }
  }

  const credited = await settlePendingDeposits(chain, head, oracleDeps);
  const reversed = await recheckReorgs(chain, head, rpc);
  return {
    chainId: chain.chainId,
    scannedFrom: readCursor(chain.chainId) ?? head,
    scannedTo: head,
    newDeposits,
    credited,
    reversed,
  };
}

/**
 * Re-check recently-credited deposits against the chain. If a credited tx's
 * receipt has disappeared (dropped by a reorg) or moved off its recorded block,
 * reverse the credit. Deposits deeper than `reorgRecheckBlocks` are treated as
 * final and skipped.
 */
async function recheckReorgs(
  chain: MarketplaceChainConfig,
  head: number,
  rpc: RpcAdapter
): Promise<number> {
  const recheckWindow =
    Number.isInteger(chain.reorgRecheckBlocks) && chain.reorgRecheckBlocks > 0
      ? chain.reorgRecheckBlocks
      : Math.max(chain.minConfirmations * 4, 64);
  const minBlock = Math.max(0, head - recheckWindow);
  const candidates = listRecentlyCreditedDeposits(chain.chainId, minBlock);
  let reversed = 0;
  for (const deposit of candidates) {
    let receipt;
    try {
      receipt = await rpc.getTransactionReceipt(chain.rpcUrl, deposit.txHash);
    } catch (error) {
      // Transient RPC error — leave the deposit credited and retry next cycle.
      console.warn(
        `[MarketplaceWatcher] receipt re-check failed for ${deposit.txHash}:`,
        (error as Error).message
      );
      continue;
    }
    // A reverted tx (status 0) or one re-mined on a different block is a
    // definitive reorg outcome → reverse. A *missing* receipt (null block) is
    // ambiguous: it could be a real reorg drop, or just a transient RPC gap on
    // a tx that is still mined/in-mempool. Reversing on a transient gap wrongly
    // claws back a valid credit (and the shortfall is unrecoverable once spent),
    // so for the missing-receipt case only reverse when the node ALSO has no
    // knowledge of the tx (not mined, not in any mempool).
    const reverted = receipt.status === 0;
    const movedBlock =
      receipt.blockNumber !== null && receipt.blockNumber !== deposit.blockNumber;
    let shouldReverse = reverted || movedBlock;
    if (receipt.blockNumber === null && !reverted) {
      let known = true; // a probe failure must not trigger a reversal
      try {
        known = await rpc.isTransactionKnown(chain.rpcUrl, deposit.txHash);
      } catch (error) {
        console.warn(
          `[MarketplaceWatcher] tx-known probe failed for ${deposit.txHash}:`,
          (error as Error).message
        );
      }
      if (!known) shouldReverse = true;
    }
    if (shouldReverse) {
      const result = reverseMarketplaceDeposit(deposit.id);
      if (result.reversed) {
        reversed += 1;
        console.warn(
          `[MarketplaceWatcher] Reversed deposit ${deposit.txHash} (chain ${chain.chainId}) after reorg` +
            (result.shortfallMicroUsd > 0
              ? ` — UNRECOVERABLE shortfall ${result.shortfallMicroUsd} micro-USD (funds already spent)`
              : "")
        );
      }
    }
  }
  return reversed;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Record each Transfer log as a deposit attributed to the owning user. Logs to
 * unknown addresses are ignored. Returns the count of freshly recorded deposits.
 */
function ingestLogs(chain: MarketplaceChainConfig, logs: TransferLog[], head: number): number {
  const treasuryMode = Boolean(chain.treasuryAddress);
  let recorded = 0;
  for (const log of logs) {
    if (!log.txHash) continue;
    // Treasury mode: attribute by sender (log.from), auto-creating the user.
    // Mint/burn transfers from the zero address have no real sender — skip them.
    // Legacy mode: attribute by recipient (log.to) to a known deposit address.
    let owner: { userId: string } | null;
    if (treasuryMode) {
      if (normalizeWalletAddress(log.from) === ZERO_ADDRESS) continue;
      owner = resolveTreasuryDepositOwner(log.from);
    } else {
      owner = resolveDepositOwner(chain.chainId, log.to);
    }
    if (!owner) continue;
    const confirmations = Math.max(0, head - log.blockNumber + 1);
    // USD value is resolved at credit time from a live oracle, not here — a
    // price recorded at ingest could be stale by the time the deposit settles.
    const before = log;
    const deposit = recordMarketplaceDeposit({
      userId: owner.userId,
      chainId: chain.chainId,
      txHash: before.txHash,
      logIndex: before.logIndex,
      blockNumber: before.blockNumber,
      tokenAddress: chain.tokenAddress,
      fromAddress: before.from,
      toAddress: before.to,
      amountToken: before.amount,
      amountMicroUsd: 0,
      confirmations,
    });
    if (deposit.createdAt === deposit.updatedAt) recorded += 1;
  }
  return recorded;
}

function resolveDepositOwner(chainId: number, toAddress: string): { userId: string } | null {
  const addresses = listAllDepositAddressesForChain(chainId);
  const match = addresses.find((a) => a.depositAddress === toAddress.toLowerCase());
  return match ? { userId: match.userId } : null;
}

/**
 * Treasury-mode owner resolution: the depositor's wallet (log.from) IS the user
 * identity. Auto-create the user on first deposit so funds sent before the
 * wallet's first sign-in are never lost — they appear once the user logs in.
 */
function resolveTreasuryDepositOwner(fromAddress: string): { userId: string } | null {
  const wallet = normalizeWalletAddress(fromAddress);
  if (!wallet) return null;
  const user = getOrCreateMarketplaceUserByWallet(wallet);
  return { userId: user.id };
}

/**
 * Promote pending deposits to confirmed/credited once they have enough
 * confirmations relative to the current head. The USD amount is priced here,
 * at credit time, from a live oracle: if no fresh price is available the deposit
 * stays `confirmed` and is retried next cycle (never credited at a wrong price).
 */
async function settlePendingDeposits(
  chain: MarketplaceChainConfig,
  head: number,
  oracleDeps?: OracleDeps
): Promise<number> {
  let credited = 0;
  // Resolve the token price once per cycle (cheap + the CEX fallback is cached).
  let price: Awaited<ReturnType<typeof resolveTokenUsdPrice>> | undefined;

  for (const deposit of listPendingMarketplaceDeposits()) {
    if (deposit.chainId !== chain.chainId) continue;
    const confirmations = Math.max(0, head - deposit.blockNumber + 1);

    if (confirmations < chain.minConfirmations) {
      if (deposit.status === "seen") markDepositConfirmed(deposit.id, confirmations);
      continue;
    }

    if (deposit.status === "seen") markDepositConfirmed(deposit.id, confirmations);

    // Lazily resolve price only when we actually have something to credit.
    if (price === undefined) {
      price = await resolveTokenUsdPrice(chain, oracleDeps);
    }
    if (!price) {
      // Oracle unavailable — leave as confirmed and retry next cycle.
      continue;
    }

    const amountMicroUsd = tokenBaseUnitsToMicroUsd(
      deposit.amountToken,
      chain.tokenDecimals,
      price.usdPerToken
    );
    updateDepositAmountMicroUsd(deposit.id, amountMicroUsd);
    if (creditMarketplaceDeposit(deposit.id)) credited += 1;
  }
  return credited;
}

/**
 * Run one cycle across all configured chains. Errors on one chain do not abort
 * the others.
 */
export async function runDepositWatcherCycle(rpc: RpcAdapter = defaultRpc): Promise<CycleResult[]> {
  const config = getMarketplaceCryptoConfig();
  // Cross-process lock: skip the cycle if another instance holds a fresh lease.
  if (!acquireCycleLock(Date.now())) {
    console.log("[MarketplaceWatcher] Another instance holds the cycle lock — skipping");
    return [];
  }
  const results: CycleResult[] = [];
  try {
    for (const chain of config.chains) {
      try {
        results.push(await runChainCycle(chain, rpc));
      } catch (error) {
        console.warn(
          `[MarketplaceWatcher] chain ${chain.chainId} cycle failed:`,
          (error as Error).message
        );
      }
    }
    // Settle submitted withdrawals: confirm on-chain or refund on failure.
    if (config.withdrawalsEnabled) {
      try {
        await settleWithdrawals(rpc, Date.now());
      } catch (error) {
        console.warn("[MarketplaceWatcher] Withdrawal settlement failed:", (error as Error).message);
      }
    }
  } finally {
    releaseCycleLock();
  }
  return results;
}

/**
 * A submitted withdrawal whose tx is neither mined nor in any mempool is only
 * treated as dropped (and refunded) after it has been waiting at least this
 * long. This guards against transient RPC mempool gaps that would otherwise
 * refund a tx that is about to confirm.
 */
const WITHDRAWAL_DROP_GRACE_MS = 10 * 60 * 1000;

/**
 * Check submitted withdrawals against the chain and resolve their final state.
 *
 * Safety invariant: a withdrawal is refunded ONLY when we are certain the funds
 * did not (and will not) move on-chain — i.e. the tx was mined-and-reverted, or
 * it is absent from both the chain and the mempool for longer than the grace
 * window. A tx that is merely not-mined-yet is never refunded, so we can never
 * both refund the balance and have the transfer confirm (double-pay).
 */
async function settleWithdrawals(rpc: RpcAdapter, nowMs: number): Promise<void> {
  const withdrawals = listSubmittedWithdrawals();
  for (const w of withdrawals) {
    if (!w.txHash) continue;
    const chain = getMarketplaceChain(w.chainId);
    if (!chain) continue;
    try {
      const receipt = await rpc.getTransactionReceipt(chain.rpcUrl, w.txHash);

      if (receipt.blockNumber !== null && receipt.status === 1) {
        markWithdrawalConfirmed(w.id);
        continue;
      }
      if (receipt.blockNumber !== null && receipt.status === 0) {
        // Mined but reverted on-chain → funds did not move → safe to refund.
        markWithdrawalFailed(w.id, "Transaction reverted on-chain");
        continue;
      }

      // No receipt → not mined. Distinguish "still pending in the mempool" from
      // "dropped/never propagated". Only the latter, and only after a grace
      // window, is safe to refund.
      const known = await rpc.isTransactionKnown(chain.rpcUrl, w.txHash);
      if (known) continue; // still in mempool — wait
      const submittedAtMs = Date.parse(w.updatedAt);
      const agedOut =
        Number.isFinite(submittedAtMs) && nowMs - submittedAtMs >= WITHDRAWAL_DROP_GRACE_MS;
      if (agedOut) {
        markWithdrawalFailed(w.id, "Transaction dropped from mempool");
      }
      // Not yet aged out — leave 'submitted' for a later cycle.
    } catch (error) {
      // A failure settling one withdrawal must not abort the rest.
      console.warn(
        `[MarketplaceWatcher] Failed to settle withdrawal ${w.id}:`,
        (error as Error).message
      );
    }
  }
}

// Re-exported for unit tests that need to assert owner resolution directly.
export const __watcherInternals = {
  resolveDepositOwner,
  resolveTreasuryDepositOwner,
  getMarketplaceDepositAddress,
  settleWithdrawals,
  WITHDRAWAL_DROP_GRACE_MS,
};
