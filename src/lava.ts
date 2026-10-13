/**
 * Lava.top merchant API client (https://gate.lava.top, OpenAPI v1.22.x).
 *
 * Used only by the card-pack checkout on the mapleai.shop shop front:
 * create a USD invoice for a prepaid token pack, then watch it complete
 * (webhook + invoice polling reconciliation).
 *
 * Verified live against the merchant account:
 *  - `POST /api/v3/invoice` with `X-API-KEY`, USD offers settle through the
 *    UNLIMINT provider with the CARD payment method;
 *  - per-invoice amount limits for USD are $5..$10000 (201 for $5, 400 below);
 *  - the account owner's email is rejected as the buyer email — checkout must
 *    pass a real customer address;
 *  - invoice statuses: NEW -> IN_PROGRESS -> COMPLETED | FAILED.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export const lavaCheckoutEnabled = Boolean(config.lavaApiKey && config.lavaOfferId);

export interface LavaInvoice {
  id: string;
  status: string;
  amountTotal: { amount: number; currency: string };
  paymentUrl?: string;
  contractId?: string;
}

export interface CreateLavaInvoiceInput {
  email: string;
  amountUsd: number;
  /** Success/failure/cancel return URLs (Lava appends nothing — pass query in). */
  successfulUrl: string;
  failureUrl: string;
  buyerLanguage?: string;
}

interface CreateInvoiceV3Response {
  id?: unknown;
  status?: unknown;
  amountTotal?: { amount?: unknown; currency?: unknown };
  paymentUrl?: unknown;
  contractId?: unknown;
}

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    "x-api-key": config.lavaApiKey,
  };
}

/** Create a one-time USD invoice for a prepaid pack. Returns id + paymentUrl. */
export async function createLavaInvoice(input: CreateLavaInvoiceInput): Promise<LavaInvoice> {
  if (!lavaCheckoutEnabled) throw new Error("Lava checkout is disabled (LAVA_API_KEY / LAVA_OFFER_ID)");
  const response = await fetch(`${config.lavaGateUrl}/api/v3/invoice`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      email: input.email,
      offerId: config.lavaOfferId,
      amount: input.amountUsd,
      currency: config.lavaCurrency,
      paymentProvider: config.lavaPaymentProvider,
      paymentMethod: config.lavaPaymentMethod,
      periodicity: "ONE_TIME",
      buyerLanguage: input.buyerLanguage ?? "ru",
      successful_return_url: input.successfulUrl,
      failure_return_url: input.failureUrl,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Lava invoice creation failed: HTTP ${response.status}${text ? ` ${text.slice(0, 300)}` : ""}`);
  }
  const raw = (await response.json()) as CreateInvoiceV3Response;
  if (typeof raw.id !== "string" || typeof raw.paymentUrl !== "string") {
    throw new Error("Lava invoice response is missing id/paymentUrl");
  }
  return {
    id: raw.id,
    status: typeof raw.status === "string" ? raw.status : "NEW",
    paymentUrl: raw.paymentUrl,
    contractId: typeof raw.contractId === "string" ? raw.contractId : undefined,
    amountTotal: {
      amount: typeof raw.amountTotal?.amount === "number" ? raw.amountTotal.amount : input.amountUsd,
      currency: typeof raw.amountTotal?.currency === "string" ? raw.amountTotal.currency : config.lavaCurrency,
    },
  };
}

/** Re-fetch an invoice by id — reconciliation when the webhook is missing. */
export async function getLavaInvoice(invoiceId: string): Promise<LavaInvoice | undefined> {
  if (!config.lavaApiKey) return undefined;
  const response = await fetch(
    `${config.lavaGateUrl}/api/v1/invoices/${encodeURIComponent(invoiceId)}`,
    { headers: headers(), signal: AbortSignal.timeout(15_000) },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Lava invoice fetch failed: HTTP ${response.status}${text ? ` ${text.slice(0, 300)}` : ""}`);
  }
  const raw = (await response.json()) as CreateInvoiceV3Response;
  if (typeof raw.id !== "string") throw new Error("Lava invoice response is missing id");
  return {
    id: raw.id,
    status: typeof raw.status === "string" ? raw.status : "NEW",
    contractId: typeof raw.contractId === "string" ? raw.contractId : undefined,
    amountTotal: {
      amount: typeof raw.amountTotal?.amount === "number" ? raw.amountTotal.amount : 0,
      currency: typeof raw.amountTotal?.currency === "string" ? raw.amountTotal.currency : "",
    },
    paymentUrl: typeof raw.paymentUrl === "string" ? raw.paymentUrl : undefined,
  };
}

/**
 * Webhook authorization: Lava sends the configured secret in a header
 * (authType api_key -> `X-API-KEY: <value>`, basic -> `Authorization: Basic <b64>`).
 * We accept either, comparing in constant time.
 */
export function verifyLavaWebhookHeaders(get: (name: string) => string | undefined): boolean {
  const secret = config.lavaWebhookSecret;
  if (!secret) return false;
  const apiKey = get("x-api-key") ?? get("x-lava-signature") ?? get("x-signature");
  if (apiKey) return safeEqual(apiKey, secret);
  const auth = get("authorization");
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
    // user:password — either side may be the secret.
    const [user, pass] = decoded.split(":");
    return safeEqual(user ?? "", secret) || safeEqual(pass ?? "", secret);
  }
  if (auth) return safeEqual(auth.trim(), secret);
  return false;
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "lava-webhook").update(a).digest();
  const hb = createHmac("sha256", "lava-webhook").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Normalized webhook event the gateway reacts to. */
export type LavaWebhookEvent =
  | { kind: "success"; contractId: string | undefined; status: string }
  | { kind: "failed"; contractId: string | undefined; status: string }
  | { kind: "other"; eventType: string; contractId: string | undefined };

/** Map PurchaseWebhookLog eventType to the gateway's success/failed buckets. */
export function parseLavaWebhookEvent(body: unknown): LavaWebhookEvent {
  const eventType = typeof (body as { eventType?: unknown })?.eventType === "string"
    ? ((body as { eventType: string }).eventType)
    : "";
  const status = typeof (body as { status?: unknown })?.status === "string"
    ? ((body as { status: string }).status)
    : "";
  const contractId = typeof (body as { contractId?: unknown })?.contractId === "string"
    ? ((body as { contractId: string }).contractId)
    : undefined;
  if (eventType === "payment.success" || status === "completed" || status === "subscription-active") {
    return { kind: "success", contractId, status };
  }
  if (eventType === "payment.failed" || status === "failed" || status === "subscription-failed") {
    return { kind: "failed", contractId, status };
  }
  return { kind: "other", eventType: eventType || status || "unknown", contractId };
}

