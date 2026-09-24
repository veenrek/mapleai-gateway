import { createPublicClient, http } from "viem";
import { config } from "./config.js";

const ARC_GAS_UNITS = 125_000n;
const ARC_GAS_PRICE_BUFFER_PERCENT = 15n;
const CACHE_MS = 3_000;
const arcClient = createPublicClient({ transport: http(config.arcRpcUrl, { timeout: 5_000 }) });
let cached: { value: number; until: number } | undefined;
let pending: Promise<number> | undefined;

export async function paymentOverheadUsd(): Promise<number> {
  if (config.network !== "eip155:5042") return config.facilitatorFeeUsd;
  if (cached && Date.now() < cached.until) return cached.value;
  pending ??= arcClient.getGasPrice().then((gasPrice) => {
    if (gasPrice <= 0n) throw new Error("Arc gas price unavailable");
    const bufferedGasPrice = (gasPrice * (100n + ARC_GAS_PRICE_BUFFER_PERCENT) + 99n) / 100n;
    const value = Number(bufferedGasPrice * ARC_GAS_UNITS) / 1e18;
    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid Arc gas estimate");
    cached = { value, until: Date.now() + CACHE_MS };
    return value;
  }).finally(() => { pending = undefined; });
  return pending;
}
