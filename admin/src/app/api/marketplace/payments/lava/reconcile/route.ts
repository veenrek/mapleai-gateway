import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getLavaConfig } from "@/lib/marketplace/lava/config";
import { reconcileAllPendingLavaPayments } from "@/lib/marketplace/lava/reconcile";

/**
 * POST /api/marketplace/payments/lava/reconcile (management auth)
 *
 * Lava.top webhooks are not configured for this shop (the tgshop bot uses
 * plain status polling), so payment confirmation is done by polling
 * GET /api/v2/invoices/{id} here. Idempotent by design; safe to call on
 * every “refresh” click or from a cron.
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

  const result = await reconcileAllPendingLavaPayments({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey!,
  });

  return Response.json(result, { status: 200 });
}
