// Background scheduler for marketplace maintenance: crypto deposit watching and
// auth-nonce cleanup.
//
// Modeled on providerLimitsSyncScheduler: startup delay, single-flight guard,
// unref'd timers so it never keeps the process alive on its own. The deposit
// scan runs only when EVM chains / a deposit seed are configured; nonce cleanup
// always runs so the auth_nonces table cannot grow without bound.
import { getMarketplaceCryptoConfig } from "@/lib/marketplace/crypto/config";
import { runDepositWatcherCycle } from "@/lib/marketplace/crypto/watcher";
import { runSolvencyCheck } from "@/lib/marketplace/crypto/solvencyMonitor";
import { pruneMarketplaceAuthNonces } from "@/lib/db/marketplaceUsers";

const STARTUP_DELAY_MS = 8_000;
const DEFAULT_INTERVAL_MS = 60_000;

let schedulerTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let isRunning = false;
let lastSolvencyRunAt = 0;

function getIntervalMs(): number {
  const raw = Number(process.env.MARKETPLACE_DEPOSIT_POLL_MS);
  return Number.isFinite(raw) && raw >= 5_000 ? raw : DEFAULT_INTERVAL_MS;
}

function getSolventIntervalMs(): number {
  const raw = Number(process.env.MARKETPLACE_SOLVENCY_CHECK_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : 300_000;
}

async function runCycle(): Promise<void> {
  if (isRunning) {
    console.log("[MarketplaceWatcher] Skipping cycle — previous run still in progress");
    return;
  }
  isRunning = true;
  const start = Date.now();
  try {
    // Always prune expired/consumed nonces, regardless of crypto config.
    try {
      const pruned = pruneMarketplaceAuthNonces();
      if (pruned > 0) console.log(`[MarketplaceWatcher] Pruned ${pruned} expired auth nonce(s)`);
    } catch (error) {
      console.warn("[MarketplaceWatcher] Nonce prune failed:", (error as Error).message);
    }

    if (getMarketplaceCryptoConfig().enabled) {
      const results = await runDepositWatcherCycle();
      const recorded = results.reduce((sum, r) => sum + r.newDeposits, 0);
      const credited = results.reduce((sum, r) => sum + r.credited, 0);
      const reversed = results.reduce((sum, r) => sum + r.reversed, 0);
      if (recorded > 0 || credited > 0 || reversed > 0) {
        console.log(
          `[MarketplaceWatcher] Deposits: ${recorded} new, ${credited} credited, ${reversed} reversed across ${results.length} chain(s) in ${Date.now() - start}ms`
        );
      }

      // Solvency check on its own cadence (default every 5 min): the on-chain
      // treasury must cover the sum of all DB balances. Unhealthy → error log
      // + audit event inside runSolvencyCheck.
      if (Date.now() - lastSolvencyRunAt >= getSolventIntervalMs()) {
        lastSolvencyRunAt = Date.now();
        try {
          const report = await runSolvencyCheck();
          if (report.skippedReason) {
            console.log(`[Solvency] Skipped: ${report.skippedReason}`);
          }
        } catch (error) {
          console.warn("[Solvency] Check failed:", (error as Error).message);
        }
      }
    }
  } catch (error) {
    console.warn("[MarketplaceWatcher] Cycle failed:", (error as Error).message);
  } finally {
    isRunning = false;
  }
}

export function startMarketplaceDepositWatcher(): void {
  if (schedulerTimer || startupTimer) {
    console.log("[MarketplaceWatcher] Already running — skipping start");
    return;
  }

  const config = getMarketplaceCryptoConfig();
  const intervalMs = getIntervalMs();
  console.log(
    config.enabled
      ? `[MarketplaceWatcher] Started — ${config.chains.length} chain(s) + nonce cleanup, interval ${intervalMs}ms`
      : `[MarketplaceWatcher] Started — nonce cleanup only (set MARKETPLACE_EVM_CHAINS + MARKETPLACE_DEPOSIT_MNEMONIC to enable deposits)`
  );

  startupTimer = setTimeout(() => {
    startupTimer = null;
    void runCycle();
    schedulerTimer = setInterval(() => {
      void runCycle();
    }, intervalMs);
    schedulerTimer.unref?.();
  }, STARTUP_DELAY_MS);
  startupTimer.unref?.();
}

export function stopMarketplaceDepositWatcher(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log("[MarketplaceWatcher] Stopped");
  }
}
