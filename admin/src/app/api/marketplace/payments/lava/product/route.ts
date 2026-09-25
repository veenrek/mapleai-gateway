import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getLavaConfig } from "@/lib/marketplace/lava/config";
import { createLavaInvoice } from "@/lib/marketplace/lava/client";
import { createLavaPayment, attachInvoiceId, markLavaPaymentFailed } from "@/lib/db/lavaPayments";
import { usdToMicroUsd } from "@/lib/marketplace/pricing";

/**
 * POST /api/marketplace/payments/lava/product — PUBLIC shop checkout.
 * Sells the configured Lava product (LAVA_OFFER_ID, dynamic price).
 * Methods: CARD / PAYPAL (USD, EUR), PIX (BRL). RUB is intentionally not
 * offered on the site.
 *
 * This route creates anonymous purchase invoices by design (public shop
 * storefront). The /api/marketplace prefix is on the public-route allowlist;
 * abuse surface is limited to creating unpaid invoices, which expire unused.
 */
const METHODS = ["CARD", "PAYPAL", "PIX"] as const;
const CURRENCIES = ["USD", "EUR", "BRL"] as const;

const POST_SCHEMA = z.object({
  /** Amount in the chosen currency (dynamic price). */
  amount: z.number().positive().max(50_000),
  currency: z.enum(CURRENCIES),
  paymentMethod: z.enum(METHODS),
  email: z.string().email().optional(),
});

function methodCurrencyOk(method: string, currency: string): string | null {
  if (method === "PIX" && currency !== "BRL") return "PIX is available only for BRL";
  if (method === "PAYPAL" && currency === "BRL") return "PayPal is not available for BRL";
  if (method === "CARD" && currency === "BRL") return "For BRL use PIX";
  return null;
}

export async function POST(request: Request) {
  const config = getLavaConfig();
  if (!config.enabled) {
    return Response.json(
      {
        error: {
          message: "Lava.top is not configured (LAVA_API_KEY / LAVA_OFFER_ID / LAVA_PAYER_EMAIL)",
          type: "config_error",
        },
      },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request" } },
      { status: 400 }
    );
  }
  const parsed = POST_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: { message: "Invalid body", type: "invalid_request", issues: parsed.error.issues } },
      { status: 400 }
    );
  }

  const { amount, currency, paymentMethod, email } = parsed.data;
  const comboError = methodCurrencyOk(paymentMethod, currency);
  if (comboError) {
    return Response.json(
      { error: { message: comboError, type: "invalid_request" } },
      { status: 400 }
    );
  }

  const orderId = `lava-product-${randomUUID()}`;
  createLavaPayment({
    orderId,
    buyerKeyId: null,
    amountMicroUsd: usdToMicroUsd(amount),
    currency,
    offerId: config.offerId,
  });

  // Buyer lands on the public order page after payment; it polls for the
  // delivered code/link there.
  const origin = new URL(request.url).origin;

  try {
    const { id: invoiceId, paymentUrl } = await createLavaInvoice(config.baseUrl, config.apiKey!, {
      email: email ?? config.payerEmail!,
      offerId: config.offerId!,
      currency,
      amount: Math.round(amount * 100) / 100,
      paymentMethod,
      successfulReturnUrl: `${origin}/order/${orderId}`,
      // Let Lava pick the provider per its own matrix (UNLIMINT/PAYPAL for
      // USD/EUR, PAY2ME/SMART_GLOCAL for RUB) unless the method pins one.
      ...(paymentMethod === "PAYPAL" ? { paymentProvider: "PAYPAL" as const } : {}),
    });

    attachInvoiceId(orderId, invoiceId);

    if (!paymentUrl) {
      markLavaPaymentFailed(orderId, "failed");
      return Response.json(
        { error: { message: "Lava returned no paymentUrl", type: "gateway_error" } },
        { status: 502 }
      );
    }

    return Response.json(
      { orderId, invoiceId, paymentUrl, orderUrl: `${origin}/order/${orderId}` },
      { status: 201 }
    );
  } catch (error) {
    markLavaPaymentFailed(orderId, "failed");
    return Response.json(
      { error: { message: (error as Error).message, type: "gateway_error" } },
      { status: 502 }
    );
  }
}
