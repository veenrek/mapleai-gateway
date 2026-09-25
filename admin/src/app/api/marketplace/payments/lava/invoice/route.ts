import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getLavaConfig } from "@/lib/marketplace/lava/config";
import { createLavaInvoice } from "@/lib/marketplace/lava/client";
import { getMarketplaceBuyerKeyById } from "@/lib/db/marketplace";
import {
  attachInvoiceId,
  createLavaPayment,
  listLavaPayments,
  markLavaPaymentFailed,
} from "@/lib/db/lavaPayments";
import { usdToMicroUsd } from "@/lib/marketplace/pricing";

const POST_SCHEMA = z.object({
  buyerKeyId: z.string().min(1),
  amountUsd: z.number().positive().max(1_000_000),
  currency: z.string().min(3).max(3).optional(),
  /** Override the payer email (defaults to LAVA_PAYER_EMAIL). */
  email: z.string().email().optional(),
});

/**
 * POST /api/marketplace/payments/lava/invoice (management auth)
 * Create a Lava.top invoice that — when paid and reconciled — tops up the
 * given buyer key. Matches the tgshop bot integration (public API v1.22):
 * POST /api/v3/invoice with offerId/email/amount; payment is confirmed by
 * polling (see ../reconcile).
 * Body: { buyerKeyId, amountUsd, currency?, email? }
 * Returns: { orderId, invoiceId, paymentUrl }
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

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

  const { buyerKeyId, amountUsd, currency, email } = parsed.data;
  const buyerKey = getMarketplaceBuyerKeyById(buyerKeyId);
  if (!buyerKey) {
    return Response.json(
      { error: { message: "Buyer key not found", type: "not_found" } },
      { status: 404 }
    );
  }

  const orderId = `lava-${buyerKeyId}-${randomUUID()}`;

  createLavaPayment({
    orderId,
    buyerKeyId,
    amountMicroUsd: usdToMicroUsd(amountUsd),
    currency: currency ?? "USD",
  });

  try {
    const { id: invoiceId, paymentUrl } = await createLavaInvoice(config.baseUrl, config.apiKey!, {
      email: email ?? config.payerEmail!,
      offerId: config.offerId!,
      currency: currency ?? "USD",
      // Dynamic pricing must be enabled on the offer for amount to apply.
      amount: Math.round(amountUsd * 100) / 100,
    });

    attachInvoiceId(orderId, invoiceId);

    if (!paymentUrl) {
      markLavaPaymentFailed(orderId, "failed");
      return Response.json(
        {
          error: {
            message: "Lava returned no paymentUrl (check offer periodicity — must be one-time)",
            type: "gateway_error",
          },
        },
        { status: 502 }
      );
    }

    return Response.json({ orderId, invoiceId, paymentUrl }, { status: 201 });
  } catch (error) {
    markLavaPaymentFailed(orderId, "failed");
    return Response.json(
      { error: { message: (error as Error).message, type: "gateway_error" } },
      { status: 502 }
    );
  }
}

/** GET — list recent lava payments (management auth). */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return Response.json({ payments: listLavaPayments() }, { status: 200 });
}
