// Shared broadcast-and-finalize step for marketplace withdrawals (both the
// user-wallet and seller payout routes). Centralizing this keeps the critical
// double-pay invariant in ONE place: a refund is only ever safe BEFORE the
// transfer is broadcast. Once the treasury tx has a hash the funds may move
// on-chain, so any later failure must NOT refund — the deposit watcher's
// settleWithdrawals reconciles the on-chain outcome instead.
import {
  markWithdrawalFailed,
  markWithdrawalSubmitted,
  type MarketplaceWithdrawal,
} from "@/lib/db/marketplaceUsers";
import { sendErc20Transfer } from "@/lib/marketplace/crypto/txSigner";

export interface BroadcastParams {
  rpcUrl: string;
  chainId: number;
  tokenAddress: string;
  toAddress: string;
  amountBaseUnits: string;
}

/** Injectable seams so the double-pay invariant can be unit-tested deterministically. */
export interface WithdrawalExecutorDeps {
  sendTransfer: (params: BroadcastParams) => Promise<{ txHash: string }>;
  markSubmitted: (id: string, txHash: string) => MarketplaceWithdrawal;
  markFailed: (id: string, reason: string) => unknown;
}

const defaultDeps: WithdrawalExecutorDeps = {
  sendTransfer: sendErc20Transfer,
  markSubmitted: markWithdrawalSubmitted,
  markFailed: markWithdrawalFailed,
};

export type FinalizeResult =
  | {
      outcome: "submitted";
      /** True when the row was persisted as 'submitted'; false when the DB write
       *  failed post-broadcast (funds in flight, row left 'pending'). */
      persisted: boolean;
      withdrawalId: string;
      txHash: string;
    }
  | {
      outcome: "broadcast_failed";
      withdrawalId: string;
      reason: string;
    };

/**
 * Broadcast the transfer for an already-debited, 'pending' withdrawal and resolve
 * its state.
 *
 *  - Broadcast throws  → no tx on-chain → refund the debit, return broadcast_failed.
 *  - Broadcast succeeds → NEVER refund. Persist the tx hash; if that DB write
 *    fails, leave the row 'pending' (manual reconciliation) but still report
 *    submitted, because the funds are already in flight.
 */
export async function broadcastAndFinalizeWithdrawal(
  withdrawalId: string,
  broadcast: BroadcastParams,
  deps: WithdrawalExecutorDeps = defaultDeps
): Promise<FinalizeResult> {
  let txHash: string;
  try {
    ({ txHash } = await deps.sendTransfer(broadcast));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Withdrawal broadcast failed";
    try {
      deps.markFailed(withdrawalId, reason);
    } catch {
      // best-effort; the pending row will be aged-out/reconciled otherwise
    }
    return { outcome: "broadcast_failed", withdrawalId, reason };
  }

  try {
    deps.markSubmitted(withdrawalId, txHash);
    return { outcome: "submitted", persisted: true, withdrawalId, txHash };
  } catch (error) {
    // CRITICAL: do NOT refund here — the funds are already in flight on-chain,
    // so refunding would double-pay. The row stays 'pending' without its tx hash
    // (the watcher only reconciles 'submitted' rows, so this needs manual
    // reconciliation). A vanishingly rare local-SQLite failure right after a
    // successful broadcast; reporting success is the safe choice.
    console.error(
      `[Marketplace] Withdrawal ${withdrawalId} broadcast as ${txHash} but failed to mark submitted:`,
      error instanceof Error ? error.message : String(error)
    );
    return { outcome: "submitted", persisted: false, withdrawalId, txHash };
  }
}
