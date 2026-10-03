import { appendFileSync } from "node:fs";

/**
 * Content logging for x402 paid calls — same philosophy as the free tier
 * (free-oss-data.jsonl / embedding-data.jsonl): records WHAT was requested,
 * with content capped per value and a total cap, never auth headers or
 * payment signatures. Revenue accounting stays in payment-events.jsonl
 * (which by design holds no prompt text either).
 */
const dataFile = process.env.X402_DATA_FILE ?? "./x402-data.jsonl";
const TOTAL_CAP = 16_384;
const STRING_VALUE_CAP = 2_048;

const SECRET_KEYS = new Set([
  "authorization", "payment-signature", "x-payment", "api_key", "apikey", "api-key",
  "secret", "client_secret", "access_token", "refresh_token", "id_token", "private_key",
  "payment_signature", "paymentsignature",
]);

function capValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > STRING_VALUE_CAP) {
      return value.slice(0, STRING_VALUE_CAP) + `…«truncated ${value.length - STRING_VALUE_CAP} chars»`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(capValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k.toLowerCase())) {
        out[k] = "«redacted»";
        continue;
      }
      out[k] = capValue(v);
    }
    return out;
  }
  return value;
}

export function capJson(value: unknown): unknown {
  const capped = capValue(value);
  let serialized = JSON.stringify(capped);
  if (serialized && serialized.length > TOTAL_CAP) {
    serialized = serialized.slice(0, TOTAL_CAP) + "…«truncated»";
    try {
      return { preview: serialized };
    } catch {
      return undefined;
    }
  }
  return capped;
}

export function recordX402Data(entry: Record<string, unknown>): void {
  try {
    appendFileSync(dataFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch (error) {
    console.error("[x402-data] write failed:", error instanceof Error ? error.message : "unknown");
  }
}
