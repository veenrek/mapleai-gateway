/**
 * Lava.top API client (public API v1.22 — matches the tgshop bot integration).
 *
 * Create invoice:
 *   POST {baseUrl}/api/v3/invoice  (X-Api-Key: <apiKey>)
 *
 * Auth header is `X-Api-Key` — verified against the live gateway:
 * `Authorization: <key>` is rejected with 401 on this API.
 *   body: { email, offerId, currency, amount?, period? }
 *   response: { status: "ok", data: { id, paymentUrl?, status, ... } }
 *
 * Check status (bot-style polling, no webhooks required):
 *   GET {baseUrl}/api/v2/invoices/{id}  → invoice with .status
 *   ("new" | "completed" | "cancelled" | ...)
 *
 * Notes:
 *  - `amount` is honoured only when the offer has dynamic pricing enabled;
 *    otherwise the offer price is used.
 *  - `email` is required by Lava — payments are credited to the payer account.
 *  - `paymentUrl` may be null when the offer has a subscription period —
 *    the bot creates offers with `periodicity: "ONE_TIME"`.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

export interface LavaCreateInvoiceParams {
  email: string;
  offerId: string;
  currency: string;
  amount?: number;
  /** Spec field names (CreateInvoiceV3Request): paymentProvider / paymentMethod. */
  paymentProvider?: "SMART_GLOCAL" | "UNLIMINT" | "PAYPAL" | "PAY2ME";
  paymentMethod?: "CARD" | "SBP" | "PAYPAL" | "PIX";
  /** Redirect URL after successful payment (CreateInvoiceV3Request). */
  successfulReturnUrl?: string;
}

export interface LavaInvoiceData {
  id: string;
  status: string;
  paymentUrl: string | null;
  [key: string]: unknown;
}

function extractPaymentUrl(body: unknown): { id: string | null; paymentUrl: string | null } {
  if (!body || typeof body !== "object") return { id: null, paymentUrl: null };
  const data = (body as { data?: { id?: unknown; paymentUrl?: unknown } }).data;
  if (!data || typeof data !== "object") return { id: null, paymentUrl: null };
  return {
    id: typeof data.id === "string" ? data.id : null,
    paymentUrl: typeof data.paymentUrl === "string" ? data.paymentUrl : null,
  };
}

/** Create an invoice and return { id, paymentUrl }. Throws with a human-readable message. */
export async function createLavaInvoice(
  baseUrl: string,
  apiKey: string,
  params: LavaCreateInvoiceParams
): Promise<{ id: string; paymentUrl: string | null }> {
  const res = await fetch(`${baseUrl}/api/v3/invoice`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      email: params.email,
      offerId: params.offerId,
      currency: params.currency,
      ...(typeof params.amount === "number" && params.amount > 0 ? { amount: params.amount } : {}),
      ...(params.paymentProvider ? { paymentProvider: params.paymentProvider } : {}),
      ...(params.paymentMethod ? { paymentMethod: params.paymentMethod } : {}),
      ...(params.successfulReturnUrl ? { successful_return_url: params.successfulReturnUrl } : {}),
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
    details?: unknown;
  } | null;

  if (!res.ok) {
    const msg =
      (body && (body.error as { message?: string } | string | undefined)) || res.statusText;
    const msgStr = typeof msg === "string" ? msg : ((msg as { message?: string })?.message ?? "");
    const suffix = body?.details ? ` (${String(body.details)})` : "";
    throw new Error(`Lava invoice failed: ${res.status} ${msgStr}${suffix}`);
  }

  const { id, paymentUrl } = extractPaymentUrl(body);
  if (!id) throw new Error("Lava invoice created but no id returned");
  return { id, paymentUrl };
}

/** Fetch invoice status by id (bot-style polling). Returns null on failure. */
export async function getLavaInvoice(
  baseUrl: string,
  apiKey: string,
  invoiceId: string
): Promise<LavaInvoiceData | null> {
  try {
    const res = await fetch(`${baseUrl}/api/v2/invoices/${invoiceId}`, {
      headers: { accept: "application/json", "X-Api-Key": apiKey },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      data?: LavaInvoiceData;
    } | null;
    return body?.data ?? null;
  } catch {
    return null;
  }
}
