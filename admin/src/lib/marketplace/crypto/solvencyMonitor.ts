/**
 * Solvency monitor — the on-chain treasury must always cover the sum of all
 * DB-recorded balances (users + sellers + USD-funded buyer keys). The DB is
 * the ledger; the chain is the vault backing it. A shortfall means either a
 * drained/underfunded treasury (drain, stuck withdrawal backlog) or an
 * accounting bug — both must be loud, immediately.
 *
 * Runs on a timer inside the marketplace scheduler and on demand via
 * GET /api/marketplace/solvency (management auth).
 */

import {
  getMarketplaceCryptoConfig,
  tokenBaseUnitsToMicroUsd,
  type MarketplaceChainConfig,
} from "./config";
import { ethCall } from "./erc20";
import { resolveTokenUsdPrice } from "./priceOracle";
import { getDbInstance } from "@/lib/db/core";
import { logAuditEvent } from "@/lib/compliance/index";

type JsonRecord = Record<string, unknown>;

const BALANCE_OF_SELECTOR = "0x70a08231";
const SOLVENCY_KEY = "solvencyLastReport";

export interface ChainTreasuryAsset {
  chainId: number;
  treasuryAddress: string;
  /** Raw base-unit token balance as returned by balanceOf. */
  rawBalance: string;
  microUsd: number;
  priceSource: string | null;
  error: string | null;
}

export interface SolvencyReport {
  checkedAt: string;
  healthy: boolean;
  /** max(0, liabilities − assets) in micro-USD. */
  shortfallMicroUsd: number;
  liabilities: {
    users: number;
    sellers: number;
    buyerKeys: number;
    total: number;
  };
  assets: {
    chains: ChainTreasuryAsset[];
    totalMicroUsd: number;
  };
  /** Present when the check itself could not run (no chains configured etc.). */
  skippedReason?: string;
}

function scalar(db: () => unknown): number {
  const value = db();
  return typeof value === "number" ? value : Number(value) || 0;
}

/** Sum of every USD liability the platform owes its users. */
export function sumMarketplaceLiabilities(): SolvencyReport["liabilities"] {
  const db = getDbInstance();
  const users = scalar(
    () =>
      (
        db
          .prepare("SELECT COALESCE(SUM(balance_micro_usd), 0) AS t FROM marketplace_users")
          .get() as { t: number } | undefined
      )?.t
  );
  const sellers = scalar(
    () =>
      (
        db
          .prepare("SELECT COALESCE(SUM(balance_micro_usd), 0) AS t FROM marketplace_sellers")
          .get() as { t: number } | undefined
      )?.t
  );
  const buyerKeys = scalar(
    () =>
      (
        db
          .prepare("SELECT COALESCE(SUM(balance_micro_usd), 0) AS t FROM marketplace_buyer_keys")
          .get() as { t: number } | undefined
      )?.t
  );
  return {
    users,
    sellers,
    buyerKeys,
    total: users + sellers + buyerKeys,
  };
}

async function fetchChainTreasuryAsset(chain: MarketplaceChainConfig): Promise<ChainTreasuryAsset> {
  const base: ChainTreasuryAsset = {
    chainId: chain.chainId,
    treasuryAddress: chain.treasuryAddress || "",
    rawBalance: "0",
    microUsd: 0,
    priceSource: null,
    error: null,
  };
  if (!chain.treasuryAddress) return { ...base, error: "no treasury address" };

  try {
    const paddedAddress = chain.treasuryAddress.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const rawHex = await ethCall(
      chain.rpcUrl,
      chain.tokenAddress,
      `${BALANCE_OF_SELECTOR}${paddedAddress}`
    );
    const rawBalance = BigInt(rawHex).toString(); // base units, decimal string
    const price = await resolveTokenUsdPrice(chain);
    if (!price) {
      return { ...base, rawBalance, error: "token price unavailable" };
    }
    const microUsd = tokenBaseUnitsToMicroUsd(rawBalance, chain.tokenDecimals, price.usdPerToken);
    return {
      ...base,
      rawBalance,
      microUsd,
      priceSource: price.source,
    };
  } catch (error) {
    return { ...base, error: String((error as Error)?.message || error).slice(0, 300) };
  }
}

/** Full check: DB liabilities vs on-chain treasury assets across all chains. */
export async function runSolvencyCheck(): Promise<SolvencyReport> {
  const config = getMarketplaceCryptoConfig();
  const checkedAt = new Date().toISOString();

  if (!config.enabled || config.chains.length === 0) {
    const report: SolvencyReport = {
      checkedAt,
      healthy: true,
      shortfallMicroUsd: 0,
      liabilities: sumMarketplaceLiabilities(),
      assets: { chains: [], totalMicroUsd: 0 },
      skippedReason: "marketplace crypto not configured",
    };
    persistReport(report);
    return report;
  }

  const chains = await Promise.all(config.chains.map(fetchChainTreasuryAsset));
  const assetsTotalMicroUsd = chains.reduce((sum, c) => sum + c.microUsd, 0);
  const liabilities = sumMarketplaceLiabilities();
  // Chains whose price/balance read failed must not silently pass the check:
  // treat their asset contribution as 0 but flag the report unhealthy.
  const hasReadErrors = chains.some((c) => c.error);
  const shortfall = Math.max(0, liabilities.total - assetsTotalMicroUsd);
  const healthy = !hasReadErrors && shortfall === 0;

  const report: SolvencyReport = {
    checkedAt,
    healthy,
    shortfallMicroUsd: shortfall,
    liabilities,
    assets: { chains, totalMicroUsd: assetsTotalMicroUsd },
  };

  persistReport(report);

  if (!healthy) {
    console.error(
      `[Solvency] UNHEALTHY: liabilities=${(liabilities.total / 1_000_000).toFixed(2)} USD, ` +
        `assets=${(assetsTotalMicroUsd / 1_000_000).toFixed(2)} USD, ` +
        `shortfall=${(shortfall / 1_000_000).toFixed(2)} USD` +
        (hasReadErrors ? " (some chain reads failed)" : "")
    );
    logAuditEvent({
      action: "marketplace.solvency.shortfall",
      actor: "system",
      target: "marketplace-treasury",
      resourceType: "solvency",
      status: "failed",
      metadata: report as unknown as JsonRecord,
    });
  }

  return report;
}

function persistReport(report: SolvencyReport): void {
  try {
    const db = getDbInstance() as unknown as {
      prepare: (sql: string) => { run: (...params: unknown[]) => unknown };
    };
    db.prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('marketplace', ?, ?)"
    ).run(SOLVENCY_KEY, JSON.stringify(report));
  } catch (error) {
    console.warn("[Solvency] Failed to persist report:", (error as Error).message);
  }
}

export function getLastSolvencyReport(): SolvencyReport | null {
  try {
    const db = getDbInstance() as unknown as {
      prepare: (sql: string) => { get: (...params: unknown[]) => { value?: string } | undefined };
    };
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'marketplace' AND key = ?")
      .get(SOLVENCY_KEY);
    if (!row?.value) return null;
    return JSON.parse(row.value) as SolvencyReport;
  } catch {
    return null;
  }
}
