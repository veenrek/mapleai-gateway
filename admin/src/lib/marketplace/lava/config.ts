/**
 * Lava.top payment gateway configuration.
 *
 * Env vars (public API v1.22):
 *   LAVA_API_KEY      — secret API key (lava.top → settings → API keys)
 *   LAVA_OFFER_ID     — offer (product) UUID; the offer must be ONE_TIME and
 *                       should have dynamic pricing enabled so `amount` is honoured
 *   LAVA_PAYER_EMAIL  — email passed as the invoice payer (required by Lava)
 *   LAVA_BASE_URL     — optional API base override (default https://gate.lava.top)
 *
 * Payment confirmation is done by polling GET /api/v2/invoices/{id}
 * (same pattern as the tgshop bot) — no webhook configuration required.
 * The module degrades gracefully: getLavaConfig() returns { enabled: false }
 * until all required vars are set, and callers must branch on that.
 */

export interface LavaConfig {
  enabled: boolean;
  apiKey: string | null;
  offerId: string | null;
  payerEmail: string | null;
  baseUrl: string;
}

export function getLavaConfig(): LavaConfig {
  const apiKey = process.env.LAVA_API_KEY || null;
  const offerId = process.env.LAVA_OFFER_ID || null;
  const payerEmail = process.env.LAVA_PAYER_EMAIL || null;
  const baseUrl = (process.env.LAVA_BASE_URL || "https://gate.lava.top").replace(/\/+$/, "");
  const enabled = Boolean(apiKey && offerId && payerEmail);
  if (!enabled) {
    console.warn(
      "[lava] LAVA_API_KEY / LAVA_OFFER_ID / LAVA_PAYER_EMAIL not set — Lava.top payments disabled"
    );
  }
  return { enabled, apiKey, offerId, payerEmail, baseUrl };
}
